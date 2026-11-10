# Scraper

Watches Best Buy's image CDN for newly uploaded product images and shows them in a web page.

## How it works

A CDN can't be asked "what's new", so the scanner guesses URLs. Best Buy's product images live at a URL built from the SKU number:

```
https://pisces.bbystatic.com/image2/BestBuy_US/images/products/<first 4 digits>/<SKU>_sd.jpg
```

The server answers 200 for every SKU; one with no image gets a stand-in picture ("Image Unavailable", or a grey clapperboard for movies). The server re-encodes pictures per request, so size and format can't tell them apart, but the ETag header can: the stand-ins have fixed ETags, listed in `src/bestbuy.js`. Best Buy hands out SKU numbers in order, in two separate series:

- **Best Buy's own stock** (phones, consoles, laptops, appliances, games) uses 7-digit SKUs. In November 2026 the newest were around 6,696,000, growing by roughly 125 a day. Only about 4 in 10 SKUs near the edge have an image, because a SKU is created well before its image arrives. This is the series scanned by default.
- **Third-party marketplace listings** (furniture, toys, accessories) use 8-digit SKUs, around 13,260,000 at the same date, with images on about 9 in 10. Set `START_SKU=13260000` to scan these instead.

Each scan walks a window of SKU numbers around the edge and records which have an image; the window moves up as new images are found.

## What it reports

The CDN's `Last-Modified` header is not a real upload date, so everything is based on what changed between scans:

- **New:** the SKU was checked before with no picture, and now has one.
- **Revealed:** the SKU had a *holding picture* and now has a real one. Some brands reserve the slot with a generic picture first (a LEGO "Coming Soon" box, a bare Apple logo, "Image Coming Soon"), and the swap to the real picture is the reveal. Holding pictures are recognised from a built-in list, by being shared by 10 or more SKUs, or by AI triage flagging them.
- **Picture changed:** a recently found picture was replaced by a different one (for example a render swapped for a photo).
- **Pulled:** a picture disappeared after being seen.

Pictures found on a SKU's first check are stored as "already there" and hidden by default, as are holding pictures. The first scan is therefore all baseline; new and revealed pictures show up from the second scan on. SKUs on a holding picture, and pictures found in the last 7 days, are re-checked every scan.

## Saved copies

For every new, revealed or changed picture, the scanner saves every view Best Buy has: the main picture, right, back and left (`_rd`, `_bd`, `ld`) and the numbered gallery shots (`cv1d`, `cv2d`, ...). They go in `data/images/<SKU>/`, named by view and fingerprint, so a replaced picture is kept next to its replacement and a pulled picture stays on disk.

Best Buy's originals are often 4K PNGs of 3-4 MB each, so copies are saved at most 2000 pixels on the longest side (set `SAVE_MAX_SIZE=0` to keep originals). In testing that came to roughly 1 MB per view, and products had between 1 and 17 views.

Click any picture in the gallery to see all saved views, the earlier pictures and the AI description.

## AI description and newsworthiness score

With an Anthropic API key, Claude looks at up to three views of each new, revealed or changed picture and records the brand, product, category, any readable text, and a newsworthiness score from 1 (routine) to 5 (flagship or unannounced product the tech press would cover). The page can then sort by score and hide low scores. It also flags generic stand-in pictures, which are then treated as holding pictures.

Get a key at https://console.anthropic.com and start with:

```
ANTHROPIC_API_KEY=yourkey npm start
```

It uses Claude Opus 5.5 by default. Each picture is roughly 3,000 tokens in and a few hundred out, so expect around 2 cents per picture; at about 125 new SKUs a day, that's a few dollars a day. This is an estimate, not a measurement. `AI_MODEL=claude-haiku-5-5` is much cheaper and less accurate.

## Only products not yet announced

An image alone doesn't say whether the product is public. With a key for Best Buy's official Products API, each scan also asks which SKUs are in the public catalog; the page then shows only images whose product is not on bestbuy.com yet, and keeps re-checking until it is.

Get a free key at https://developer.bestbuy.com and start with:

```
BESTBUY_API_KEY=yourkey npm start
```

On Windows Command Prompt: `set BESTBUY_API_KEY=yourkey` and then `npm start`.

Without a key everything else works; the filter just isn't offered.

## Run it

Needs Node 20 or later.

```
npm install
npm start
```

Open http://localhost:3000. A scan starts immediately and repeats every 6 hours; **Scan now** starts one on demand. Results are kept in `data/bestbuy.json`, and saved pictures in `data/images/`.

Saving pictures and asking AI happen at the end of each scan, at most 200 products per scan; anything left over is picked up by the next one.

## Settings

Set as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | Web page port |
| `START_SKU` | 6696000 | Where the newest SKUs are; only matters until images are found |
| `LOOKBACK` | 20000 | SKUs below the newest images to keep re-checking |
| `LOOKAHEAD` | 3000 | SKUs above the newest images to check |
| `REQUEST_INTERVAL_MS` | 150 | Minimum gap between requests |
| `CONCURRENCY` | 4 | Requests in flight at once |
| `SCAN_EVERY_MINUTES` | 360 | Time between scans |
| `BESTBUY_API_KEY` | none | Enables the not-yet-announced filter |
| `ANTHROPIC_API_KEY` | none | Enables AI descriptions and scores |
| `AI_MODEL` | `claude-opus-5-5` | Claude model used for descriptions |
| `SAVE_MAX_SIZE` | 2000 | Longest side of saved copies in pixels; 0 keeps originals |
| `MAX_CAPTURES_PER_SCAN` | 200 | Products saved and described per scan |
| `DATA_FILE` | `data/bestbuy.json` | Where results are stored |

A full default window is about 23,000 requests. A scan stops immediately if Best Buy answers 403 or 429.

## Tests

```
npm test
```
