#!/usr/bin/env node
// Repack the generated GLBs with smaller textures.
//
//   node tools/shrink-assets.mjs                       # in place, with a report
//   node tools/shrink-assets.mjs --base 512 --aux 256
//   node tools/shrink-assets.mjs --dir /path/to/glbs   # any directory of GLBs
//
// Tripo returns 2048x2048 for every map. These props are set dressing seen at a
// few hundred pixels through diffusion, bloom and grain, and the whole episode
// has to fit inside one 16 MiB HTML file, so the maps are worth an order of
// magnitude less than they cost. Base colour is kept larger than the normal and
// metallic-roughness maps, which is where the eye actually looks.
//
// There is no image library in this environment, so the resizing is done by the
// headless browser that is already here: draw to a canvas, read back a JPEG.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ASSETS = resolve(opt('dir', join(ROOT, 'company/props/assets')));

const BASE = +opt('base', 512);      // baseColorTexture and emissive
const AUX = +opt('aux', 256);        // normal, metallicRoughness, occlusion
const QUALITY = +opt('quality', 0.86);
const ONLY = opt('only', null);

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

// --- GLB container ----------------------------------------------------------

const MAGIC = 0x46546c67;   // 'glTF'
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB');
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(body.toString('utf8'));
    else if (type === BIN_CHUNK) bin = Buffer.from(body);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error('GLB missing a chunk');
  return { json, bin };
}

function pad4(buf, fill) {
  const n = (4 - (buf.length % 4)) % 4;
  return n ? Buffer.concat([buf, Buffer.alloc(n, fill)]) : buf;
}

function writeGlb(json, bin) {
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = pad4(bin, 0);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(JSON_CHUNK, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binChunk.length, 0);
  bh.writeUInt32LE(BIN_CHUNK, 4);
  return Buffer.concat([head, jh, jsonChunk, bh, binChunk]);
}

// Which images are base colour? Everything else is detail nobody will read.
function classify(json) {
  const roles = new Map();
  const mark = (texIndex, role) => {
    if (texIndex === undefined || texIndex === null) return;
    const tex = json.textures?.[texIndex];
    if (!tex || tex.source === undefined) return;
    // Base colour wins if an image is used for more than one thing.
    if (role === 'base' || !roles.has(tex.source)) roles.set(tex.source, role);
  };
  for (const m of json.materials || []) {
    mark(m.pbrMetallicRoughness?.baseColorTexture?.index, 'base');
    mark(m.emissiveTexture?.index, 'base');
    mark(m.pbrMetallicRoughness?.metallicRoughnessTexture?.index, 'aux');
    mark(m.normalTexture?.index, 'aux');
    mark(m.occlusionTexture?.index, 'aux');
  }
  return roles;
}

// --- go ---------------------------------------------------------------------

const files = (ONLY ? [ONLY.endsWith('.glb') ? ONLY : ONLY + '.glb']
  : (await readdir(ASSETS)).filter((f) => f.endsWith('.glb'))).sort();

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setContent('<!doctype html><meta charset=utf-8><title>resize</title>');
await page.evaluate(() => {
  window.__resize = async (dataUri, max, quality) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('decode failed'));
      img.src = dataUri;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale >= 1) return null;   // already small enough; leave it alone
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return { uri: c.toDataURL('image/jpeg', quality), w: c.width, h: c.height };
  };
});

let before = 0;
let after = 0;
for (const file of files) {
  const path = join(ASSETS, file);
  const original = await readFile(path);
  before += original.length;

  let json;
  let bin;
  try { ({ json, bin } = readGlb(original)); } catch (e) {
    console.log(`  ${file}: skipped (${e.message})`);
    after += original.length;
    continue;
  }

  const roles = classify(json);
  // Rebuild the binary chunk from scratch: image buffer views move, so every
  // other view has to be re-emitted at its new offset anyway.
  const chunks = [];
  let offset = 0;
  const notes = [];
  for (let i = 0; i < (json.bufferViews || []).length; i++) {
    const bv = json.bufferViews[i];
    let data = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);

    const image = (json.images || []).findIndex((im) => im.bufferView === i);
    if (image >= 0) {
      const mime = json.images[image].mimeType || 'image/png';
      const max = roles.get(image) === 'aux' ? AUX : BASE;
      const uri = `data:${mime};base64,${data.toString('base64')}`;
      const out = await page.evaluate(
        ([u, m, q]) => window.__resize(u, m, q), [uri, max, QUALITY],
      );
      if (out) {
        const shrunk = Buffer.from(out.uri.slice(out.uri.indexOf(',') + 1), 'base64');
        notes.push(`${roles.get(image) || 'base'} ${out.w}px ${(data.length / 1024).toFixed(0)}→${(shrunk.length / 1024).toFixed(0)}KB`);
        data = shrunk;
        json.images[image].mimeType = 'image/jpeg';
      }
    }

    // Accessors read from these views, so alignment has to survive the rewrite.
    const align = (4 - (offset % 4)) % 4;
    if (align) { chunks.push(Buffer.alloc(align)); offset += align; }
    bv.byteOffset = offset;
    bv.byteLength = data.length;
    chunks.push(data);
    offset += data.length;
  }

  const newBin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: newBin.length }];
  const out = writeGlb(json, newBin);
  after += out.length;
  await writeFile(path, out);
  console.log(`  ${file}: ${(original.length / 1048576).toFixed(2)} → ${(out.length / 1048576).toFixed(2)} MB${notes.length ? `  [${notes.join(', ')}]` : '  (nothing to shrink)'}`);
}

await browser.close();
console.log(`\ntotal: ${(before / 1048576).toFixed(2)} → ${(after / 1048576).toFixed(2)} MB`);
