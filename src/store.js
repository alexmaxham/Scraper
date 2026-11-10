// Scan history kept in one JSON file, plus saved picture files beside it.
//
// images:  sku -> {
//   firstSeen, scanId, isNew,   isNew: the SKU was checked earlier with no picture
//   etag,                       current main picture
//   history: [{ etag, until }], earlier main pictures, oldest first
//   event, eventAt,             'new' | 'revealed' | 'changed', for the gallery
//   removedAt,                  the picture disappeared after being seen
//   files: [{ suffix, etag, name }], saved copies under images/<sku>/
//   triage: { ... },            AI description, see triage.js
//   listed, name, listedAt,     Products API result, see catalog.js
// }
// missing: SKUs that have been checked and had no image. An image that shows
//          up for a SKU in this set is a genuinely new upload; an image found
//          on a SKU's very first check is only "already there" (baseline).
// holding: ETags learned to be holding pictures (from AI triage).

const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(file) {
    this.file = file;
    this.filesDir = path.join(path.dirname(file), 'images');
    this.images = {};
    this.missing = new Set();
    this.holding = {};
    this.scans = [];
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.images = raw.images || {};
      this.missing = new Set(raw.missing || []);
      this.holding = raw.holding || {};
      this.scans = raw.scans || [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        images: this.images,
        missing: [...this.missing],
        holding: this.holding,
        scans: this.scans,
      })
    );
    fs.renameSync(tmp, this.file);
  }

  // Saves one picture file for a SKU and returns its file name.
  saveFile(sku, name, data) {
    const dir = path.join(this.filesDir, String(sku));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
    return name;
  }

  filePath(sku, name) {
    return path.join(this.filesDir, String(sku), name);
  }
}

module.exports = { Store };
