const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/store');
const { Scanner, findEdge } = require('../src/scanner');
const catalog = require('../src/catalog');

// Fake CDN: SKUs in `live` return their own picture, SKUs in `standIns` the
// clapperboard, everything else "Image Unavailable". Like the real CDN, the
// content type says nothing about which one it is.
function fakeCdn(live, standIns = new Set()) {
  return async (url) => {
    const sku = Number(url.match(/\/(\d+)_sd\.jpg$/)[1]);
    const etag = live.has(sku)
      ? `"real${sku}"`
      : standIns.has(sku)
        ? '"02617e257ecb18c1ba7911df022ff7ecb"'
        : '"0ef3719b210d43a44edde27fac5ee08b9"';
    return { status: 200, headers: new Map([['content-type', 'image/jpeg'], ['etag', etag]]) };
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

test('stand-in pictures are not images, and stored ones are cleaned out', async () => {
  const live = new Set([1000]);
  const store = new Store(tmpFile());
  // Left behind by a version that could not tell stand-ins apart.
  store.images[1002] = { firstSeen: 1, scanId: 0, isNew: false, etag: '02617e257ecb18c1ba7911df022ff7ecb' };
  store.images[1003] = { firstSeen: 1, scanId: 0, isNew: false, bytes: 85092 };
  const scanner = new Scanner(store, config, { fetchImpl: fakeCdn(live, new Set([1002, 1007])) });

  await scanner.scan();
  assert.deepEqual(Object.keys(store.images), ['1000']);
  assert.ok(store.missing.has(1002) && store.missing.has(1003) && store.missing.has(1007));

  live.add(1002);
  const second = await scanner.scan();
  assert.equal(second.newImages, 1);
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

test('catalog check marks listed and unlisted, and notices when one gets listed', async () => {
  const store = new Store(tmpFile());
  store.images[1000] = { firstSeen: 1, scanId: 1, isNew: true, etag: 'a' };
  store.images[1001] = { firstSeen: 1, scanId: 1, isNew: true, etag: 'b' };
  const inCatalog = new Map([[1000, 'Some TV']]);
  const urls = [];
  const fakeApi = async (url) => {
    urls.push(url);
    const asked = decodeURI(url).match(/sku in\(([\d,]+)\)/)[1].split(',').map(Number);
    const products = asked.filter((s) => inCatalog.has(s)).map((s) => ({ sku: s, name: inCatalog.get(s) }));
    return { status: 200, json: async () => ({ products }) };
  };

  await catalog.refresh(store, 'KEY', { fetchImpl: fakeApi, intervalMs: 0 });
  assert.equal(store.images[1000].listed, true);
  assert.equal(store.images[1000].name, 'Some TV');
  assert.equal(store.images[1000].listedAt, undefined);
  assert.equal(store.images[1001].listed, false);
  assert.match(urls[0], /apiKey=KEY/);

  inCatalog.set(1001, 'Secret phone');
  await catalog.refresh(store, 'KEY', { fetchImpl: fakeApi, intervalMs: 0, now: () => 42 });
  assert.equal(store.images[1001].listed, true);
  assert.equal(store.images[1001].listedAt, 42);
  assert.ok(!decodeURI(urls[1]).includes('1000'), 'listed SKUs are not asked about again');
});
