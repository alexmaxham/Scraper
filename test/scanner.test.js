const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/store');
const { Scanner, findEdge } = require('../src/scanner');

// Fake CDN: SKUs in `live` return a JPEG, everything else the placeholder.
function fakeCdn(live) {
  return async (url) => {
    const sku = Number(url.match(/\/(\d+)_sd\.jpg$/)[1]);
    const real = live.has(sku);
    return {
      status: 200,
      headers: new Map([
        ['content-type', real ? 'image/jpeg' : 'image/png'],
        ['content-length', real ? String(50000 + sku % 100) : '14867'],
      ]),
    };
  };
}

const config = { startSku: 1000, lookback: 20, lookahead: 20, requestIntervalMs: 0, concurrency: 2 };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-')), 'state.json');

test('first scan is baseline; images that appear later are new', async () => {
  const live = new Set([990, 995, 1000]);
  const file = tmpFile();
  const store = new Store(file);
  const scanner = new Scanner(store, config, { fetchImpl: fakeCdn(live) });

  const first = await scanner.scan();
  assert.equal(first.baselineImages, 3);
  assert.equal(first.newImages, 0);

  live.add(1004);
  const second = await scanner.scan();
  assert.equal(second.newImages, 1);
  assert.equal(store.images[1004].isNew, true);
  assert.equal(store.images[995].isNew, false);

  const reloaded = new Store(file);
  assert.equal(reloaded.images[1004].isNew, true);
  assert.ok(reloaded.missing.has(1005));
});

test('a blocked response stops the scan and is reported', async () => {
  const store = new Store(tmpFile());
  const scanner = new Scanner(store, config, { fetchImpl: async () => ({ status: 403, headers: new Map() }) });
  const scan = await scanner.scan();
  assert.match(scan.stopped, /403/);
  assert.equal(Object.keys(store.images).length, 0);
});

test('findEdge ignores a stray image far above the dense SKUs', () => {
  assert.equal(findEdge([100, 150, 200, 260, 300, 900000]), 300);
  assert.equal(findEdge([]), 0);
});
