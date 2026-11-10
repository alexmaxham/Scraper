// Best Buy image CDN specifics: how a SKU maps to an image URL, and how to
// tell a real product image from the "no image" placeholder.
//
// The CDN answers 200 for every SKU. A SKU with no image gets a fixed PNG
// placeholder; a real product image is a JPEG. The placeholder is fingerprinted
// at the start of each scan from a SKU that cannot exist.

const HOST = 'https://pisces.bbystatic.com';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PLACEHOLDER_SKU = 9999999;

function imageUrl(sku, suffix = '_sd') {
  const s = String(sku);
  return `${HOST}/image2/BestBuy_US/images/products/${s.slice(0, 4)}/${s}${suffix}.jpg`;
}

function productUrl(sku) {
  return `https://www.bestbuy.com/site/searchpage.jsp?st=${sku}`;
}

class BlockedError extends Error {}

// Returns { type, bytes } for a SKU's main image.
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
    type: (res.headers.get('content-type') || '').split(';')[0].trim(),
    bytes: Number(res.headers.get('content-length')) || 0,
  };
}

function isPlaceholder(info, placeholder) {
  return info.type === placeholder.type && info.bytes === placeholder.bytes;
}

function hasImage(info, placeholder) {
  return info.type.startsWith('image/') && !isPlaceholder(info, placeholder);
}

module.exports = { imageUrl, productUrl, head, hasImage, BlockedError, PLACEHOLDER_SKU };
