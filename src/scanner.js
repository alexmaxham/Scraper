// Walks a window of SKU numbers around the newest known image, records which
// ones have a picture now, and notices when a picture appears, changes or
// disappears. New and changed pictures are then saved and, optionally,
// described by AI.

const bestbuy = require('./bestbuy');
const catalog = require('./catalog');
const { capture } = require('./capture');
const { triage } = require('./triage');

const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dense SKUs thin out gradually, so one stray image far above the rest must
// not drag the window away. The edge is the highest SKU that still has
// `minNeighbours` other images within `span` below it.
function findEdge(skus, { span = 2000, minNeighbours = 3 } = {}) {
  const sorted = [...skus].sort((a, b) => a - b);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const j = i - minNeighbours;
    if (j >= 0 && sorted[i] - sorted[j] <= span) return sorted[i];
  }
  return sorted.length ? sorted[sorted.length - 1] : 0;
}

function windowFor(store, config) {
  const known = Object.keys(store.images).map(Number).filter((s) => s >= config.startSku - config.lookback);
  const edge = Math.max(findEdge(known), config.startSku);
  return { from: edge - config.lookback, to: edge + config.lookahead };
}

// ETag -> label for every holding picture: the known ones, ones AI triage
// flagged, and any picture shared by many SKUs (no real product picture is).
function holdingPictures(store, minSkus = 10) {
  const labels = { ...bestbuy.KNOWN_HOLDING, ...store.holding };
  const counts = new Map();
  for (const img of Object.values(store.images)) counts.set(img.etag, (counts.get(img.etag) || 0) + 1);
  for (const [etag, n] of counts) if (n >= minSkus && !labels[etag]) labels[etag] = `Shared by ${n} SKUs`;
  return labels;
}

// Pictures worth saving and describing: anything with an event whose current
// picture hasn't been handled yet.
const needsCapture = (img) => img.event && !img.removedAt && img.capturedEtag !== img.etag;
const needsTriage = (img) => img.event && img.files?.length && img.triage?.etag !== img.etag;

class Scanner {
  constructor(store, config, { fetchImpl = fetch, now = () => Date.now(), triageImpl = triage } = {}) {
    this.store = store;
    this.config = {
      holdingMinSkus: 10,
      recheckDays: 7,
      maxCapturesPerScan: 200,
      saveMaxSize: 2000,
      ...config,
    };
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.triageImpl = triageImpl;
    this.current = null; // progress of the running scan
    this.lastError = null;
    this.catalogError = null;
    this.triageError = null;
  }

  get running() {
    return this.current !== null;
  }

  // A catalog failure must not throw away the scan that just finished.
  async refreshCatalog() {
    if (!this.config.apiKey) return;
    try {
      await catalog.refresh(this.store, this.config.apiKey, { fetchImpl: this.fetchImpl, now: this.now });
      this.catalogError = null;
    } catch (err) {
      this.catalogError = err.message;
    }
  }

  // Already-known SKUs in the window that are worth asking about again.
  needsRecheck(img, holding) {
    if (holding[img.etag] || img.removedAt) return true;
    return Boolean(img.event) && this.now() - img.eventAt < this.config.recheckDays * DAY;
  }

  record(sku, info, placeholders, holding, scan) {
    const { store } = this;
    const now = this.now();
    const img = store.images[sku];
    const present = bestbuy.hasImage(info, placeholders);

    if (!img) {
      if (!present) return store.missing.add(sku);
      const isNew = store.missing.has(sku);
      store.missing.delete(sku);
      const entry = { firstSeen: now, scanId: scan.id, isNew, etag: info.etag, history: [] };
      if (isNew && !holding[info.etag]) Object.assign(entry, { event: 'new', eventAt: now });
      store.images[sku] = entry;
      if (isNew) scan.newImages++;
      else scan.baselineImages++;
      return;
    }

    if (!present) {
      if (!img.removedAt) {
        img.removedAt = now;
        scan.removed++;
      }
      return;
    }
    delete img.removedAt;
    if (info.etag === img.etag) return;

    img.history = img.history || [];
    img.history.push({ etag: img.etag, until: now });
    const wasHolding = holding[img.etag];
    img.etag = info.etag;
    if (holding[info.etag]) return; // swapped to (another) holding picture
    img.event = wasHolding ? 'revealed' : 'changed';
    img.eventAt = now;
    if (wasHolding) scan.revealed++;
    else scan.changed++;
  }

  // Saves every view of new and changed pictures, then has AI describe them.
  async processEvents(placeholders, scan) {
    const { store, config } = this;
    const queue = Object.keys(store.images)
      .filter((sku) => needsCapture(store.images[sku]))
      .sort((a, b) => store.images[b].eventAt - store.images[a].eventAt)
      .slice(0, config.maxCapturesPerScan);
    Object.assign(this.current, { phase: 'saving pictures', done: 0, total: queue.length });
    for (const sku of queue) {
      const img = store.images[sku];
      try {
        await capture(store, sku, placeholders, {
          fetchImpl: this.fetchImpl,
          intervalMs: config.requestIntervalMs,
          maxSize: config.saveMaxSize,
        });
        img.capturedEtag = img.etag;
        delete img.captureError;
        scan.captured++;
      } catch (err) {
        if (err instanceof bestbuy.BlockedError) throw err;
        img.captureError = err.message;
      }
      this.current.done++;
      store.save();
    }

    if (!config.aiEnabled) return;
    const toTriage = Object.keys(store.images)
      .filter((sku) => needsTriage(store.images[sku]))
      .slice(0, config.maxCapturesPerScan);
    Object.assign(this.current, { phase: 'describing pictures', done: 0, total: toTriage.length });
    for (const sku of toTriage) {
      const img = store.images[sku];
      try {
        img.triage = { ...(await this.triageImpl(store, sku, { model: config.aiModel, fetchImpl: this.fetchImpl })), etag: img.etag };
        if (img.triage.is_placeholder) store.holding[img.etag] = 'Stand-in picture (flagged by AI)';
        this.triageError = null;
        scan.described++;
      } catch (err) {
        if (err instanceof bestbuy.BlockedError) throw err;
        this.triageError = err.message;
        // A bad key or exhausted credit fails every call, so stop asking.
        if (err.status === 401 || err.status === 403) break;
      }
      this.current.done++;
      store.save();
    }
  }

  async scan() {
    if (this.running) return null;
    const { store, config } = this;
    const scan = {
      id: (store.scans.at(-1)?.id || 0) + 1,
      startedAt: this.now(),
      finishedAt: null,
      from: 0,
      to: 0,
      checked: 0,
      newImages: 0,
      baselineImages: 0,
      revealed: 0,
      changed: 0,
      removed: 0,
      captured: 0,
      described: 0,
      errors: 0,
      stopped: null,
    };
    this.current = { ...scan, phase: 'checking SKUs', total: 0 };
    this.lastError = null;

    try {
      const placeholders = bestbuy.placeholderEtags(await bestbuy.head(bestbuy.PLACEHOLDER_SKU, this.fetchImpl));
      // Drop records an older version (or a newly listed stand-in) let through.
      for (const [sku, img] of Object.entries(store.images)) {
        if (img.etag && !placeholders.has(img.etag)) continue;
        delete store.images[sku];
        if (img.etag) store.missing.add(Number(sku));
      }
      const holding = holdingPictures(store, config.holdingMinSkus);
      const { from, to } = windowFor(store, config);
      Object.assign(scan, { from, to });
      const todo = [];
      for (let sku = from; sku <= to; sku++) {
        const img = store.images[sku];
        if (!img || this.needsRecheck(img, holding)) todo.push(sku);
      }
      this.current.total = todo.length;

      let next = 0;
      let slot = Date.now();
      let blocked = null;
      const worker = async () => {
        while (next < todo.length && !blocked) {
          const sku = todo[next++];
          // One shared clock keeps the overall request rate fixed regardless
          // of how many workers are waiting on slow responses.
          const wait = slot - Date.now();
          slot = Math.max(slot, Date.now()) + config.requestIntervalMs;
          if (wait > 0) await sleep(wait);
          try {
            this.record(sku, await bestbuy.head(sku, this.fetchImpl), placeholders, holding, scan);
          } catch (err) {
            if (err instanceof bestbuy.BlockedError) blocked = err;
            else scan.errors++; // left unrecorded, so the next scan retries it
          }
          scan.checked++;
          Object.assign(this.current, scan);
          if (scan.checked % 500 === 0) store.save();
        }
      };
      await Promise.all(Array.from({ length: config.concurrency }, worker));
      if (blocked) throw blocked;
      store.save();
      await this.processEvents(placeholders, scan);
      await this.refreshCatalog();
    } catch (err) {
      scan.stopped = err.message;
      this.lastError = err.message;
    } finally {
      scan.finishedAt = this.now();
      store.scans.push(scan);
      if (store.scans.length > 200) store.scans.splice(0, store.scans.length - 200);
      store.save();
      this.current = null;
    }
    return scan;
  }
}

module.exports = { Scanner, findEdge, windowFor, holdingPictures };
