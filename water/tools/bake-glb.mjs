#!/usr/bin/env node
// Bake a GLB into src/<name>-asset.js — a small ES module the app imports and
// the bundler inlines, so the artifact stays self-contained with no fetches.
//
//   node tools/bake-glb.mjs <model.glb> [name] [texture-px]
//
// The source model is ~7 MB, almost all of it three 2K JPEG textures. Only the
// base colour is kept, downscaled; the mesh itself is a few thousand vertices
// and is quantised (positions to int16 over the bounding box, normals to int8,
// uvs to uint16, indices to uint16) which costs nothing visible on an object
// this small on screen.

import { readFile, writeFile } from 'node:fs/promises';

const SRC = process.argv[2];
const NAME = process.argv[3] || 'barrel';
const TEX = +(process.argv[4] || 256);   // baked texture size, px
const OUT = new URL(`../src/${NAME}-asset.js`, import.meta.url);
const CONST = NAME.toUpperCase().replace(/[^A-Z0-9]/g, '_');
if (!SRC) { console.error('usage: bake-glb.mjs <model.glb> [name] [texture-px]'); process.exit(1); }

const buf = await readFile(SRC);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb');
const total = buf.readUInt32LE(8);
let off = 12, json = null, bin = null;
while (off < total) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const body = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
  else if (type === 0x004e4942) bin = body;
  off += 8 + len;
}

const view = (i) => {
  const v = json.bufferViews[i];
  return bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
};
const readAccessor = (i) => {
  const a = json.accessors[i];
  const v = json.bufferViews[a.bufferView];
  const start = (v.byteOffset || 0) + (a.byteOffset || 0);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const n = a.count * comps;
  if (a.componentType === 5126) return new Float32Array(bin.buffer, bin.byteOffset + start, n);
  if (a.componentType === 5125) return new Uint32Array(bin.buffer, bin.byteOffset + start, n);
  if (a.componentType === 5123) return new Uint16Array(bin.buffer, bin.byteOffset + start, n);
  throw new Error('unhandled componentType ' + a.componentType);
};

const prim = json.meshes[0].primitives[0];
const pos = readAccessor(prim.attributes.POSITION);
const nrm = readAccessor(prim.attributes.NORMAL);
const uv = readAccessor(prim.attributes.TEXCOORD_0);
const idx = readAccessor(prim.indices);
const vertexCount = pos.length / 3;
if (vertexCount > 65535) throw new Error('too many vertices for uint16 indices');

// The exporter writes the barrel Z-up, but the app spins each barrel with its
// own mesh.rotation, so the asset has to arrive standing on Y. Rotate -90deg
// about X once here — (x, y, z) -> (x, z, -y) — rather than paying for a base
// orientation on every mesh at runtime.
// (--zup only: the barrel's exporter wrote it that way, the character's did not)
if (process.argv.includes('--zup')) {
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1];
    pos[i + 1] = pos[i + 2];
    pos[i + 2] = -y;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const y = nrm[i + 1];
    nrm[i + 1] = nrm[i + 2];
    nrm[i + 2] = -y;
  }
}

// Centre on the origin and scale by the LARGEST half-extent, so no axis
// clamps against the int16 range (dividing by the height alone flattened the
// widest ring of a barrel that is fractionally wider than it is tall). The
// resulting per-axis half sizes ship with the asset so the app can scale to a
// target height without having to know the model's proportions.
let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3)
  for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], pos[i + k]);
    hi[k] = Math.max(hi[k], pos[i + k]);
  }
const mid = lo.map((v, k) => (v + hi[k]) / 2);
const halfAxis = lo.map((v, k) => (hi[k] - v) / 2);
const scale = Math.max(...halfAxis);
const half = halfAxis.map((v) => v / scale);
const qpos = new Int16Array(pos.length);
for (let i = 0; i < pos.length; i += 3)
  for (let k = 0; k < 3; k++)
    qpos[i + k] = Math.round(Math.max(-1, Math.min(1, (pos[i + k] - mid[k]) / scale)) * 32767);

const qnrm = new Int8Array(nrm.length);
for (let i = 0; i < nrm.length; i++) qnrm[i] = Math.round(Math.max(-1, Math.min(1, nrm[i])) * 127);
const quv = new Uint16Array(uv.length);
for (let i = 0; i < uv.length; i++) quv[i] = Math.round(Math.max(0, Math.min(1, uv[i])) * 65535);
const qidx = new Uint16Array(idx);

const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');

// base colour only, downscaled in a real browser (no image libraries here)
const texIdx = json.materials[0].pbrMetallicRoughness.baseColorTexture.index;
const imgIdx = json.textures[texIdx].source;
const jpeg = view(json.images[imgIdx].bufferView);
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch();
const page = await browser.newPage();
const dataUrl = await page.evaluate(async ([src, size]) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}, [`data:image/jpeg;base64,${jpeg.toString('base64')}`, TEX]);
await browser.close();

const out = `// Generated by tools/bake-glb.mjs — do not edit.
// Quantised mesh + base-colour texture, small enough to inline in the artifact.
export const ${CONST} = {
  vertexCount: ${vertexCount},
  // half extents in the asset's own units: positions are centred and scaled so
  // the largest of the three is exactly 1
  half: [${half.map((v) => v.toFixed(4)).join(', ')}],
  // int16 positions
  positions: '${b64(qpos)}',
  normals: '${b64(qnrm)}',   // int8
  uvs: '${b64(quv)}',        // uint16
  indices: '${b64(qidx)}',   // uint16
  texture: '${dataUrl}',
};
`;
await writeFile(OUT, out);
console.log(`vertices ${vertexCount}, tris ${qidx.length / 3}`);
console.log(`geometry ${(qpos.byteLength + qnrm.byteLength + quv.byteLength + qidx.byteLength) / 1024 | 0} KiB`
  + `, texture ${dataUrl.length / 1024 | 0} KiB`);
console.log(`wrote src/${NAME}-asset.js  ${(out.length / 1024) | 0} KiB`);
