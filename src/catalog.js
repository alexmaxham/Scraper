// Asks Best Buy's official Products API which SKUs are in the public catalog.
// A SKU that has an image on the CDN but is absent from the catalog is a
// product Best Buy has not put on sale or announced yet.
//
// Needs a free API key from https://developer.bestbuy.com (BESTBUY_API_KEY).

const API = 'https://api.bestbuy.com/v1';
const BATCH = 100; // the API's maximum page size

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns Map(sku -> product name) for the SKUs that are in the catalog.
async function lookup(skus, apiKey, fetchImpl = fetch) {
  const query = `products(sku in(${skus.join(',')}))`;
  const params = new URLSearchParams({ apiKey, format: 'json', show: 'sku,name', pageSize: String(BATCH) });
  const res = await fetchImpl(`${API}/${encodeURI(query)}?${params}`, { signal: AbortSignal.timeout(20000) });
  if (res.status === 403) throw new Error('Best Buy API rejected the key (or its daily limit is used up)');
  if (res.status !== 200) throw new Error(`Best Buy API answered ${res.status}`);
  const body = await res.json();
  return new Map((body.products || []).map((p) => [Number(p.sku), p.name]));
}

// Updates `listed` on every stored image that is not yet known to be listed.
// Unlisted ones are asked about again each time, so they flip when announced.
async function refresh(store, apiKey, { fetchImpl = fetch, intervalMs = 300, now = () => Date.now() } = {}) {
  const pending = Object.keys(store.images).map(Number).filter((sku) => !store.images[sku].listed);
  let listed = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const found = await lookup(batch, apiKey, fetchImpl);
    for (const sku of batch) {
      const img = store.images[sku];
      if (found.has(sku)) {
        // Only an image we watched while unlisted has a meaningful listing date.
        if (img.listed === false) img.listedAt = now();
        img.listed = true;
        img.name = found.get(sku);
        listed++;
      } else {
        img.listed = false;
      }
    }
    if (i + BATCH < pending.length) await sleep(intervalMs);
  }
  return { checked: pending.length, listed };
}

module.exports = { lookup, refresh };
