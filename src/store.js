// Scan history kept in one JSON file.
//
// images:  sku -> { firstSeen, scanId, isNew, etag }
// missing: SKUs that have been checked and had no image. An image that shows
//          up for a SKU in this set is a genuinely new upload; an image found
//          on a SKU's very first check is only "already there" (baseline).

const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(file) {
    this.file = file;
    this.images = {};
    this.missing = new Set();
    this.scans = [];
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.images = raw.images || {};
      this.missing = new Set(raw.missing || []);
      this.scans = raw.scans || [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ images: this.images, missing: [...this.missing], scans: this.scans })
    );
    fs.renameSync(tmp, this.file);
  }

  highestSku() {
    let max = 0;
    for (const sku of Object.keys(this.images)) max = Math.max(max, Number(sku));
    return max;
  }
}

module.exports = { Store };
