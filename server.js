// Web app: runs scans on a timer and serves the gallery of what turned up.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./src/store');
const { Scanner, windowFor, holdingPictures } = require('./src/scanner');
const { DEFAULT_MODEL } = require('./src/triage');
const bestbuy = require('./src/bestbuy');

const num = (name, fallback) => (process.env[name] ? Number(process.env[name]) : fallback);

const config = {
  port: num('PORT', 3000),
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'bestbuy.json'),
  // Best Buy's own stock uses 7-digit SKUs, which had reached about 6,696,000
  // in November 2026 and grow by roughly 125 a day. SKUs there are created
  // well before their image arrives, so the window reaches a long way back.
  // (Third-party marketplace listings use 8-digit SKUs, about 13,260,000 at
  // the same date.) Only matters for the first scan; after that the window
  // follows the images found.
  startSku: num('START_SKU', 6696000),
  lookback: num('LOOKBACK', 20000),
  lookahead: num('LOOKAHEAD', 3000),
  requestIntervalMs: num('REQUEST_INTERVAL_MS', 150),
  concurrency: num('CONCURRENCY', 4),
  scanEveryMinutes: num('SCAN_EVERY_MINUTES', 360),
  // Optional. With a key, each image is marked as listed or not on bestbuy.com.
  apiKey: process.env.BESTBUY_API_KEY || '',
  // Optional. With an Anthropic key, Claude describes and rates each new picture.
  aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.AI_TRIAGE === '1'),
  aiModel: process.env.AI_MODEL || DEFAULT_MODEL,
  maxCapturesPerScan: num('MAX_CAPTURES_PER_SCAN', 200),
  // Longest side of saved copies in pixels; 0 keeps Best Buy's originals (often 4K PNGs).
  saveMaxSize: num('SAVE_MAX_SIZE', 2000),
};

const store = new Store(config.dataFile);
const scanner = new Scanner(store, config);
let nextScanAt = null;

function runScan() {
  scanner.scan().then((scan) => {
    if (!scan) return;
    console.log(
      `scan ${scan.id}: checked ${scan.checked}, new ${scan.newImages}, revealed ${scan.revealed}, ` +
        `changed ${scan.changed}, pulled ${scan.removed}, already there ${scan.baselineImages}` +
        (scan.stopped ? `, stopped: ${scan.stopped}` : '')
    );
  });
}

function schedule() {
  nextScanAt = Date.now() + config.scanEveryMinutes * 60000;
  setTimeout(() => {
    runScan();
    schedule();
  }, config.scanEveryMinutes * 60000);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const fileUrl = (sku, name) => `/files/${sku}/${encodeURIComponent(name)}`;

// What the gallery shows for one SKU.
function describe(sku, img, holding) {
  const files = (img.files || []).map((f) => ({ ...f, url: fileUrl(sku, f.name) }));
  const main = files.find((f) => f.suffix === '_sd' && f.etag === img.etag);
  return {
    sku: Number(sku),
    ...img,
    files,
    holding: holding[img.etag] || null,
    history: (img.history || []).map((h) => ({ ...h, holding: holding[h.etag] || null })),
    thumbnail: main ? main.url : bestbuy.imageUrl(sku, '_sd', 400),
    product: bestbuy.productUrl(sku),
  };
}

function listImages(url) {
  const all = url.searchParams.get('all') === '1';
  const onlyUnlisted = url.searchParams.get('unlisted') === '1';
  const minScore = Number(url.searchParams.get('minScore')) || 0;
  const byScore = url.searchParams.get('sort') === 'score';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 2000);
  const holding = holdingPictures(store, scanner.config.holdingMinSkus);
  const rows = [];
  for (const [sku, img] of Object.entries(store.images)) {
    if (!all && (!img.event || holding[img.etag])) continue;
    if (onlyUnlisted && img.listed !== false) continue;
    if (minScore && (img.triage?.newsworthiness || 0) < minScore) continue;
    rows.push(describe(sku, img, holding));
  }
  const when = (r) => r.eventAt || r.firstSeen;
  const score = (r) => r.triage?.newsworthiness || 0;
  rows.sort((a, b) => (byScore && score(b) - score(a)) || when(b) - when(a) || b.sku - a.sku);
  return { total: rows.length, images: rows.slice(0, limit) };
}

function sendFile(res, url) {
  const m = url.pathname.match(/^\/files\/(\d+)\/([^/]+)$/);
  const name = m && decodeURIComponent(m[2]);
  if (!m || !/^[\w.-]+$/.test(name)) return json(res, 404, { error: 'not found' });
  const file = store.filePath(m[1], name);
  if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
  const ext = path.extname(name).slice(1);
  res.writeHead(200, {
    'content-type': { png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg',
    'cache-control': 'max-age=31536000, immutable',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/status') {
    const holding = holdingPictures(store, scanner.config.holdingMinSkus);
    const counts = { events: 0, revealed: 0, waiting: 0, pulled: 0, baseline: 0, unlisted: 0, described: 0 };
    for (const img of Object.values(store.images)) {
      if (holding[img.etag]) counts.waiting++;
      else if (img.event) counts.events++;
      else counts.baseline++;
      if (img.event === 'revealed' && !holding[img.etag]) counts.revealed++;
      if (img.removedAt) counts.pulled++;
      if (img.triage) counts.described++;
      if (img.listed === false) counts.unlisted++;
    }
    return json(res, 200, {
      running: scanner.running,
      progress: scanner.current,
      lastScan: store.scans.at(-1) || null,
      lastError: scanner.lastError,
      catalogEnabled: Boolean(config.apiKey),
      catalogError: scanner.catalogError,
      aiEnabled: config.aiEnabled,
      aiModel: config.aiModel,
      triageError: scanner.triageError,
      nextScanAt,
      window: windowFor(store, config),
      counts,
      scanEveryMinutes: config.scanEveryMinutes,
    });
  }
  if (url.pathname === '/api/images') return json(res, 200, listImages(url));
  if (url.pathname.startsWith('/files/')) return sendFile(res, url);
  if (url.pathname === '/api/scan' && req.method === 'POST') {
    const started = !scanner.running;
    if (started) runScan();
    return json(res, 202, { started });
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }
  json(res, 404, { error: 'not found' });
});

server.listen(config.port, () => {
  console.log(`Scraper running at http://localhost:${config.port}`);
  runScan();
  schedule();
});
