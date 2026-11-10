# Scraper

Watches Best Buy's image CDN for newly uploaded product images and shows them in a web page.

## How it works

A CDN can't be asked "what's new", so the scanner guesses URLs. Best Buy's product images live at a URL built from the SKU number:

```
https://pisces.bbystatic.com/image2/BestBuy_US/images/products/<first 4 digits>/<SKU>_sd.jpg
```

The server answers 200 for every SKU. A SKU with no image returns a fixed PNG placeholder; a real one returns a JPEG. Best Buy hands out SKU numbers in order. In November 2026 the newest were around 13,250,000, with images on roughly 9 in 10 SKUs below that point and almost none above it. Each scan walks a window of SKU numbers around that edge and records which have an image; the window moves up as new images are found.

The CDN's `Last-Modified` header is not a real upload date, so "new" means: this SKU was checked before and had no image, and now it does. Images found on a SKU's first check are stored as "already there" and hidden by default. The first scan is therefore all baseline; new images show up from the second scan on.

## Run it

Needs Node 20 or later. No dependencies.

```
npm start
```

Open http://localhost:3000. A scan starts immediately and repeats every 6 hours; **Scan now** starts one on demand. Results are kept in `data/bestbuy.json`.

## Settings

Set as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | Web page port |
| `START_SKU` | 13250000 | Where the newest SKUs are; only matters until images are found |
| `LOOKBACK` | 5000 | SKUs below the newest images to keep re-checking |
| `LOOKAHEAD` | 15000 | SKUs above the newest images to check |
| `REQUEST_INTERVAL_MS` | 150 | Minimum gap between requests |
| `CONCURRENCY` | 4 | Requests in flight at once |
| `SCAN_EVERY_MINUTES` | 360 | Time between scans |
| `DATA_FILE` | `data/bestbuy.json` | Where results are stored |

A full default window is about 20,000 requests. A scan stops immediately if Best Buy answers 403 or 429.

## Tests

```
npm test
```
