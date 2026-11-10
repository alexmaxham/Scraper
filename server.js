// Web app: runs scans on a timer and serves the gallery of what turned up.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./src/store');
const { Scanner, windowFor } = require('./src/scanner');
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
};

const store = new Store(config.dataFile);
const scanner = new Scanner(store, config);
let nextScanAt = null;

function runScan() {
  scanner.scan().then((scan) => {
    if (!scan) return;
    console.log(
      `scan ${scan.id}: checked ${scan.checked}, new ${scan.newImages}, already there ${scan.baselineImages}` +
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

function listImages(url) {
  const onlyNew = url.searchParams.get('all') !== '1';
  const onlyUnlisted = url.searchParams.get('unlisted') === '1';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 2000);
  const rows = [];
  for (const [sku, img] of Object.entries(store.images)) {
    if (onlyNew && !img.isNew) continue;
    if (onlyUnlisted && img.listed !== false) continue;
    rows.push({ sku: Number(sku), ...img });
  }
  rows.sort((a, b) => b.firstSeen - a.firstSeen || b.sku - a.sku);
  return {
    total: rows.length,
    images: rows.slice(0, limit).map((r) => ({
      ...r,
      image: bestbuy.imageUrl(r.sku),
      product: bestbuy.productUrl(r.sku),
    })),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/status') {
    const counts = { new: 0, baseline: 0, unlisted: 0 };
    for (const img of Object.values(store.images)) {
      counts[img.isNew ? 'new' : 'baseline']++;
      if (img.listed === false) counts.unlisted++;
    }
    return json(res, 200, {
      running: scanner.running,
      progress: scanner.current,
      lastScan: store.scans.at(-1) || null,
      lastError: scanner.lastError,
      catalogEnabled: Boolean(config.apiKey),
      catalogError: scanner.catalogError,
      nextScanAt,
      window: windowFor(store, config),
      counts,
      scanEveryMinutes: config.scanEveryMinutes,
    });
  }
  if (url.pathname === '/api/images') return json(res, 200, listImages(url));
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
