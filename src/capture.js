// Saves copies of every view of a SKU, so a picture that Best Buy later pulls
// or replaces is still on disk. File names carry the ETag, so a replaced
// picture is kept alongside the new one rather than overwritten.
//
// Originals can be 4K PNGs of 3-4 MB each, so by default the CDN is asked for
// a copy at most `maxSize` pixels on its longest side (0 keeps the original).

const bestbuy = require('./bestbuy');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(store, sku, placeholders, { fetchImpl = fetch, intervalMs = 150, maxSize = 2000 } = {}) {
  const img = store.images[sku];
  img.files = img.files || [];
  const have = new Set(img.files.map((f) => `${f.suffix}:${f.etag}`));

  const grab = async (suffix) => {
    await sleep(intervalMs);
    const pic = await bestbuy.download(sku, suffix, { fetchImpl, maxSize });
    if (!bestbuy.hasImage(pic, placeholders)) return false;
    if (!have.has(`${suffix}:${pic.etag}`)) {
      const name = `${suffix.replace(/^_/, '')}-${pic.etag.slice(0, 12)}.${EXT[pic.type] || 'jpg'}`;
      store.saveFile(sku, name, pic.data);
      img.files.push({ suffix, etag: pic.etag, name, savedAt: Date.now() });
      have.add(`${suffix}:${pic.etag}`);
    }
    return true;
  };

  await grab('_sd');
  for (const suffix of bestbuy.FIXED_ANGLES) await grab(suffix);
  let gaps = 0;
  for (let n = 1; n <= bestbuy.MAX_GALLERY && gaps < 2; n++) {
    gaps = (await grab(`cv${n}d`)) ? 0 : gaps + 1;
  }
  return img.files;
}

module.exports = { capture };
