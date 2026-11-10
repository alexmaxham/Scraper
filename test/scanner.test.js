const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/store');
const { Scanner, findEdge, holdingPictures } = require('../src/scanner');
const catalog = require('../src/catalog');

const UNAVAILABLE = '0ef3719b210d43a44edde27fac5ee08b9';
const CLAPPERBOARD = '02617e257ecb18c1ba7911df022ff7ecb';
const LEGO_SOON = '051fe6855f6608355080753f6064fe8ec';

// Fake CDN. `pics` maps SKU -> { suffix: etag }; a number in `live` is
// shorthand for a SKU with only a main picture, and `standIns` SKUs get the
// clapperboard. Everything else is "Image Unavailable". Like the real CDN,
// the content type says nothing about which picture it is.
function fakeCdn(live, standIns = new Set(), pics = {}) {
  const fn = async (url) => {
    fn.calls.push(url);
    const [, sku, suffix] = url.match(/\/(\d+)(_sd|_rd|_bd|ld|cv\d+d)\.jpg/);
    const etag =
      pics[sku]?.[suffix] ||
      (suffix === '_sd' && live.has(Number(sku)) ? `real${sku}` : null) ||
      (suffix === '_sd' && standIns.has(Number(sku)) ? CLAPPERBOARD : UNAVAILABLE);
    return {
      status: 200,
      headers: new Map([['content-type', 'image/jpeg'], ['etag', `"${etag}"`]]),
      arrayBuffer: async () => Buffer.from(`picture ${etag}`),
    };
  };
  fn.calls = [];
  return fn;
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
  assert.equal(store.images[1004].event, 'new');
  assert.equal(store.images[995].event, undefined);

  const reloaded = new Store(file);
  assert.equal(reloaded.images[1004].isNew, true);
  assert.ok(reloaded.missing.has(1005));
});

test('stand-in pictures are not images, and stored ones are cleaned out', async () => {
  const live = new Set([1000]);
  const store = new Store(tmpFile());
  // Left behind by a version that could not tell stand-ins apart.
  store.images[1002] = { firstSeen: 1, scanId: 0, isNew: false, etag: CLAPPERBOARD };
  store.images[1003] = { firstSeen: 1, scanId: 0, isNew: false, bytes: 85092 };
  const scanner = new Scanner(store, config, { fetchImpl: fakeCdn(live, new Set([1002, 1007])) });

  await scanner.scan();
  assert.deepEqual(Object.keys(store.images), ['1000']);
  assert.ok(store.missing.has(1002) && store.missing.has(1003) && store.missing.has(1007));

  live.add(1002);
  const second = await scanner.scan();
  assert.equal(second.newImages, 1);
});

test('a holding picture swapped for a real one is a reveal, and every view is saved', async () => {
  const pics = { 1001: { _sd: LEGO_SOON } };
  const store = new Store(tmpFile());
  const cdn = fakeCdn(new Set([1000]), new Set(), pics);
  const described = [];
  const triageImpl = async (st, sku) => {
    described.push(sku);
    return { is_placeholder: false, brand: 'LEGO', product: 'Star Wars set', newsworthiness: 3 };
  };
  const scanner = new Scanner(store, { ...config, aiEnabled: true }, { fetchImpl: cdn, triageImpl });

  await scanner.scan();
  assert.equal(store.images[1001].event, undefined, 'a holding picture is not an event');

  // The real picture lands, with gallery shots that skip cv4d.
  pics[1001] = { _sd: 'lego-final', _rd: 'right', ld: 'left', cv1d: 'g1', cv2d: 'g2', cv3d: 'g3', cv5d: 'g5' };
  const scan = await scanner.scan();
  const img = store.images[1001];
  assert.equal(scan.revealed, 1);
  assert.equal(img.event, 'revealed');
  assert.deepEqual(img.history.map((h) => h.etag), [LEGO_SOON]);
  assert.deepEqual(img.files.map((f) => f.suffix), ['_sd', '_rd', 'ld', 'cv1d', 'cv2d', 'cv3d', 'cv5d']);
  assert.ok(cdn.calls.some((u) => u.includes('1001cv7d')), 'one gap is not the end');
  assert.ok(!cdn.calls.some((u) => u.includes('1001cv8d')), 'stops after two missing gallery shots in a row');
  assert.ok(fs.existsSync(store.filePath(1001, img.files[0].name)));
  assert.deepEqual(described, ['1001']);
  assert.equal(img.triage.etag, 'lego-final');

  // Nothing changed: nothing is downloaded or described again.
  cdn.calls.length = 0;
  await scanner.scan();
  assert.ok(!cdn.calls.some((u) => !u.includes('_sd')), 'no views downloaded again');
  assert.equal(described.length, 1);
});

test('a picture that disappears is marked pulled, and AI-flagged stand-ins are hidden', async () => {
  const live = new Set([1000]);
  const store = new Store(tmpFile());
  const triageImpl = async (st, sku) =>
    sku === '1003' ? { is_placeholder: true, newsworthiness: 1 } : { is_placeholder: false, newsworthiness: 2 };
  const scanner = new Scanner(store, { ...config, aiEnabled: true }, { fetchImpl: fakeCdn(live), triageImpl });
  await scanner.scan();
  live.add(1002);
  live.add(1003);
  await scanner.scan();

  live.delete(1002);
  const scan = await scanner.scan();
  assert.equal(scan.removed, 1);
  assert.ok(store.images[1002].removedAt);
  assert.equal(holdingPictures(store)[store.images[1003].etag], 'Stand-in picture (flagged by AI)');
});

test('a picture shared by many SKUs counts as a holding picture', () => {
  const store = new Store(tmpFile());
  for (let i = 0; i < 10; i++) store.images[2000 + i] = { etag: 'shared' };
  store.images[3000] = { etag: 'own' };
  const holding = holdingPictures(store);
  assert.match(holding.shared, /10 SKUs/);
  assert.equal(holding.own, undefined);
  assert.equal(holding[LEGO_SOON], 'LEGO "Coming Soon" box');
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

test('AI triage sends up to three saved views and reads the JSON answer', async () => {
  const { triage } = require('../src/triage');
  const store = new Store(tmpFile());
  store.images[1001] = {
    etag: 'final',
    files: [
      { suffix: 'cv1d', etag: 'g1' },
      { suffix: '_sd', etag: 'old' },
      { suffix: '_sd', etag: 'final' },
      { suffix: 'ld', etag: 'left' },
    ],
  };
  const requests = [];
  const answer = { is_placeholder: false, brand: 'Sony', product: 'Headphones', category: 'headphones', visible_text: '', newsworthiness: 4, reason: 'New flagship.' };
  const anthropic = {
    beta: {
      messages: {
        create: async (params) => {
          requests.push(params);
          return { model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] };
        },
      },
    },
  };
  const cdn = fakeCdn(new Set(), new Set(), { 1001: { _sd: 'final', cv1d: 'g1', ld: 'left' } });

  const result = await triage(store, '1001', { anthropic, fetchImpl: cdn });
  assert.equal(result.product, 'Headphones');
  assert.equal(result.newsworthiness, 4);
  const req = requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.fallbacks, 'default');
  const pictures = req.messages[0].content.filter((c) => c.type === 'image');
  assert.equal(pictures.length, 3);
  assert.ok(cdn.calls[0].includes('1001_sd.jpg;maxHeight=800'), 'main picture first, downsized');
  assert.ok(!cdn.calls.some((u) => u.includes('old')));

  anthropic.beta.messages.create = async () => ({ stop_reason: 'refusal', content: [] });
  await assert.rejects(triage(store, '1001', { anthropic, fetchImpl: cdn }), /declined/);
});
