// Best Buy image CDN specifics: how a SKU maps to an image URL, and how to
// tell a real product image from the "no image" placeholder.
//
// The CDN answers 200 for every SKU, and a SKU with no image gets a stand-in
// picture. The CDN re-encodes images per request, so content type and size
// vary for the same picture; only the ETag (a hash of the original file) is
// stable. The main "Image Unavailable" stand-in is fingerprinted at the start
// of each scan from a SKU that cannot exist; other stand-ins are listed here.

const HOST = 'https://pisces.bbystatic.com';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PLACEHOLDER_SKU = 9999999;
const KNOWN_PLACEHOLDER_ETAGS = [
  '0ef3719b210d43a44edde27fac5ee08b9', // "Image Unavailable"
  '02617e257ecb18c1ba7911df022ff7ecb', // grey clapperboard (movies with no cover art)
];

function imageUrl(sku, suffix = '_sd') {
  const s = String(sku);
  return `${HOST}/image2/BestBuy_US/images/products/${s.slice(0, 4)}/${s}${suffix}.jpg`;
}

function productUrl(sku) {
  return `https://www.bestbuy.com/site/searchpage.jsp?st=${sku}`;
}

class BlockedError extends Error {}

// Returns { etag, type, bytes } for a SKU's main image.
async function head(sku, fetchImpl = fetch) {
  const res = await fetchImpl(imageUrl(sku), {
    method: 'HEAD',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 403 || res.status === 429) {
    throw new BlockedError(`Best Buy answered ${res.status}; stopping so we don't make it worse`);
  }
  if (res.status !== 200) throw new Error(`unexpected status ${res.status} for SKU ${sku}`);
  return {
    etag: (res.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, ''),
    type: (res.headers.get('content-type') || '').split(';')[0].trim(),
    bytes: Number(res.headers.get('content-length')) || 0,
  };
}

// The set of ETags that mean "no real image", given the one seen for PLACEHOLDER_SKU.
function placeholderEtags(calibrated) {
  return new Set([...KNOWN_PLACEHOLDER_ETAGS, calibrated.etag].filter(Boolean));
}

function hasImage(info, placeholders) {
  return info.type.startsWith('image/') && info.etag !== '' && !placeholders.has(info.etag);
}

module.exports = { imageUrl, productUrl, head, hasImage, placeholderEtags, BlockedError, PLACEHOLDER_SKU };
