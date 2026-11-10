// Walks a window of SKU numbers around the newest known image and records
// which ones have an image now.

const bestbuy = require('./bestbuy');
const catalog = require('./catalog');

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

class Scanner {
  constructor(store, config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.store = store;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.current = null; // progress of the running scan
    this.lastError = null;
    this.catalogError = null;
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
      errors: 0,
      stopped: null,
    };
    this.current = { ...scan, total: 0 };
    this.lastError = null;

    try {
      const placeholders = bestbuy.placeholderEtags(await bestbuy.head(bestbuy.PLACEHOLDER_SKU, this.fetchImpl));
      // Drop records an older version (or a newly listed stand-in) let through.
      for (const [sku, img] of Object.entries(store.images)) {
        if (img.etag && !placeholders.has(img.etag)) continue;
        delete store.images[sku];
        if (img.etag) store.missing.add(Number(sku));
      }
      const { from, to } = windowFor(store, config);
      Object.assign(scan, { from, to });
      const todo = [];
      for (let sku = from; sku <= to; sku++) if (!store.images[sku]) todo.push(sku);
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
            const info = await bestbuy.head(sku, this.fetchImpl);
            if (bestbuy.hasImage(info, placeholders)) {
              const isNew = store.missing.has(sku);
              store.missing.delete(sku);
              store.images[sku] = { firstSeen: this.now(), scanId: scan.id, isNew, etag: info.etag };
              if (isNew) scan.newImages++;
              else scan.baselineImages++;
            } else {
              store.missing.add(sku);
            }
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

module.exports = { Scanner, findEdge, windowFor };
