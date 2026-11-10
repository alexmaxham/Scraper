// Best Buy image CDN specifics: how a SKU maps to an image URL, and how to
// tell a real product picture from the stand-ins the CDN serves instead.
//
// The CDN answers 200 for every SKU. The CDN re-encodes pictures per request,
// so content type and size vary for the same picture; only the ETag (a hash
// of the original file) is stable, so everything here works on ETags.
//
// Two kinds of stand-in:
// - "no image": nothing uploaded for the SKU at all. The main one is
//   fingerprinted at the start of each scan from a SKU that cannot exist.
// - "holding picture": a generic picture uploaded to reserve the slot, such
//   as LEGO's "Coming Soon" box or a bare Apple logo. The real picture
//   replaces it later; that swap is the reveal worth catching.

const HOST = 'https://pisces.bbystatic.com';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PLACEHOLDER_SKU = 9999999;

const NO_IMAGE_ETAGS = [
  '0ef3719b210d43a44edde27fac5ee08b9', // "Image Unavailable"
  '02617e257ecb18c1ba7911df022ff7ecb', // grey clapperboard (movies with no cover art)
];

// Holding pictures seen in November 2026. Others are recognised because many
// SKUs share them (see Scanner) or because AI triage says so.
const KNOWN_HOLDING = {
  '051fe6855f6608355080753f6064fe8ec': 'LEGO "Coming Soon" box',
  '0c8b025a45ee20c8eedf4ca6633cdfb62': 'LEGO "Coming Soon" box',
  '03cdac7b959c1a6f36c3ae89f338d049b': '"Image Coming Soon"',
  '0dc54c6d15a69980af9c3ed634d21456a': 'Apple logo',
};

// Extra views. `_sa`/`_sb` only repeat the main picture, so they are skipped.
// cv1d, cv2d... are numbered gallery shots; checking stops after two gaps.
const FIXED_ANGLES = ['_rd', '_bd', 'ld'];
const MAX_GALLERY = 15;

function imageUrl(sku, suffix = '_sd', maxSize = 0) {
  const s = String(sku);
  const resize = maxSize ? `;maxHeight=${maxSize};maxWidth=${maxSize}` : '';
  return `${HOST}/image2/BestBuy_US/images/products/${s.slice(0, 4)}/${s}${suffix}.jpg${resize}`;
}

function productUrl(sku) {
  return `https://www.bestbuy.com/site/searchpage.jsp?st=${sku}`;
}

class BlockedError extends Error {}

function checkStatus(res, sku) {
  if (res.status === 403 || res.status === 429) {
    throw new BlockedError(`Best Buy answered ${res.status}; stopping so we don't make it worse`);
  }
  if (res.status !== 200) throw new Error(`unexpected status ${res.status} for SKU ${sku}`);
}

const etagOf = (res) => (res.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '');
const typeOf = (res) => (res.headers.get('content-type') || '').split(';')[0].trim();

// Returns { etag, type } for one picture of a SKU without downloading it.
async function head(sku, fetchImpl = fetch, suffix = '_sd') {
  const res = await fetchImpl(imageUrl(sku, suffix), {
    method: 'HEAD',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  checkStatus(res, sku);
  return { etag: etagOf(res), type: typeOf(res) };
}

// Downloads one picture, retrying a dropped connection twice.
// Returns { etag, type, data: Buffer }.
async function download(sku, suffix = '_sd', { fetchImpl = fetch, maxSize = 0, attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(imageUrl(sku, suffix, maxSize), {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(30000),
      });
      checkStatus(res, sku);
      return { etag: etagOf(res), type: typeOf(res), data: Buffer.from(await res.arrayBuffer()) };
    } catch (err) {
      if (err instanceof BlockedError || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// The set of ETags that mean "nothing uploaded", given the one seen for PLACEHOLDER_SKU.
function placeholderEtags(calibrated) {
  return new Set([...NO_IMAGE_ETAGS, calibrated.etag].filter(Boolean));
}

function hasImage(info, placeholders) {
  return info.type.startsWith('image/') && info.etag !== '' && !placeholders.has(info.etag);
}

module.exports = {
  imageUrl,
  productUrl,
  head,
  download,
  hasImage,
  placeholderEtags,
  BlockedError,
  PLACEHOLDER_SKU,
  KNOWN_HOLDING,
  FIXED_ANGLES,
  MAX_GALLERY,
};
