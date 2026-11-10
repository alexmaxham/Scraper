// Asks Claude what a newly found product picture shows and how newsworthy it
// is, so the gallery can put a new console above a new phone case.
//
// Needs ANTHROPIC_API_KEY (or another credential the Anthropic SDK finds).

const Anthropic = require('@anthropic-ai/sdk');
const bestbuy = require('./bestbuy');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_PICTURES = 3; // main picture plus two other views
const PICTURE_SIZE = 800;

const SCHEMA = {
  type: 'object',
  properties: {
    is_placeholder: {
      type: 'boolean',
      description: 'True if the picture is a generic stand-in (logo, "coming soon", blank box) rather than this product.',
    },
    brand: { type: 'string', description: 'Brand, or "" if it cannot be told.' },
    product: { type: 'string', description: 'Short product name as specific as the pictures allow, e.g. "PlayStation 5 Pro controller".' },
    category: { type: 'string', description: 'Product type, e.g. phone, laptop, TV, console, game, headphones, appliance, accessory, toy, other.' },
    visible_text: { type: 'string', description: 'Model names, specs or other text readable in the pictures, or "".' },
    newsworthiness: {
      type: 'integer',
      description: '1 = routine (cables, cases, furniture, reissues). 3 = notable new model from a known brand. 5 = flagship or unannounced product tech press would cover.',
    },
    reason: { type: 'string', description: 'One sentence on why it got that score.' },
  },
  required: ['is_placeholder', 'brand', 'product', 'category', 'visible_text', 'newsworthiness', 'reason'],
  additionalProperties: false,
};

const PROMPT = `These pictures were just uploaded to Best Buy's product image server for SKU {sku}. The product may not be announced yet.

Identify the product from the pictures alone and rate how newsworthy it would be for a consumer-tech news site. Read any text on the product or box. If you can't tell something, say so rather than guessing a specific model.`;

let client = null;

// Picks the main picture first, then other views, from the saved copies.
function choosePictures(store, sku) {
  const files = store.images[sku].files || [];
  const etag = store.images[sku].etag;
  const main = files.filter((f) => f.suffix === '_sd' && f.etag === etag);
  const others = files.filter((f) => f.suffix !== '_sd');
  return [...main, ...others].slice(0, MAX_PICTURES);
}

async function triage(store, sku, { model = DEFAULT_MODEL, fetchImpl = fetch, anthropic } = {}) {
  client = anthropic || client || new Anthropic();
  const pictures = choosePictures(store, sku);
  if (!pictures.length) throw new Error('no saved pictures to look at');

  // Smaller copies keep the request cheap; the full-size files stay on disk.
  const content = [];
  for (const f of pictures) {
    const pic = await bestbuy.download(sku, f.suffix, { fetchImpl, maxSize: PICTURE_SIZE });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: pic.type || 'image/jpeg', data: pic.data.toString('base64') },
    });
  }
  content.push({ type: 'text', text: PROMPT.replace('{sku}', sku) });

  const response = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to describe this picture');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before answering');
  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error('Claude returned no answer');
  return { ...JSON.parse(text.text), model: response.model, at: Date.now() };
}

module.exports = { triage, choosePictures, DEFAULT_MODEL };
