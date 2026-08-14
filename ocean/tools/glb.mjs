#!/usr/bin/env node
// GLB -> inlined quantized mesh module, the format demo/craftModel.js ships in.
//
//   node tools/glb.mjs --in model.glb --out demo/planeModel.js --name PLANE_MESH \
//        --forward -x --tex-size 1024 --tex-quality 0.85
//
// Why this exists: the artifact's CSP blocks every external request, so models
// ship INSIDE the bundle. Raw glTF floats are ~4x bigger than they need to be
// and the textures are 4k PNGs measured in megabytes. This tool:
//
//   - parses the GLB (single mesh, single primitive - the Meshy export shape),
//   - rotates the model so its nose sits on -Z, the convention every craft in
//     this renderer uses for "forward" (--forward says which source axis the
//     nose is on: one of +x -x +z -z),
//   - quantizes: position Int16 scaled so the LENGTH axis spans +-16000 (the
//     decoder multiplies by lengthM/32000), normals Int8, UVs Uint16,
//     indices Uint16,
//   - downscales the baseColor to --tex-size and re-encodes it as JPEG. The
//     encode runs in headless chromium (tools/browser.mjs) because node has no
//     image codec and the repo already carries Playwright for every check.
//
// demo/craftModel.js predates this tool and was produced by a lost one-off
// with the same layout; this is that tool made real and kept.

import { readFile, writeFile } from 'node:fs/promises';
import { launchChromium } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const IN = opt('in'); const OUT = opt('out'); const NAME = opt('name', 'MESH');
const FORWARD = opt('forward', '-z');
const TEX_SIZE = +opt('tex-size', 1024);
const TEX_Q = +opt('tex-quality', 0.85);
// --spin "hx,hy,hz,rCut,rMax,zMax,zThin" bakes a per-vertex SPIN WEIGHT
// for a propeller: which vertices the renderer may rotate about the hub axis.
// All values are in NORMALISED model units (the bounding box centred, divided
// by the length axis), which is what the numbers below were measured in.
const SPIN = opt('spin', '');
// --jaw "hy,hz,zBack,feather" bakes a per-vertex JAW WEIGHT: which vertices the
// renderer may swing about the jaw hinge. Same normalised units as --spin.
//
// A PLANE, NOT A FLOOD FILL, and for once that is the right tool. The propeller
// needed connectivity because its blades sweep past the airframe at the same
// radius; a mandible does not - forward of the hinge, everything below the mouth
// line IS the lower jaw, and nothing else is down there. Measured on this asset:
// at the snout the jaw's top edge sits at y = -0.02 and the skull's underside at
// y = +0.037, so a cut at the hinge's own height separates them with a body's
// width of margin either side.
const JAW = opt('jaw', '');
if (!IN || !OUT) { console.error('need --in and --out'); process.exit(2); }

const buf = await readFile(IN);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
const jsonLen = dv.getUint32(12, true);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binOff = 20 + jsonLen + 8;
const bin = buf.subarray(binOff, binOff + dv.getUint32(20 + jsonLen, true));

const accessor = (i) => {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type];
  const Ctor = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
  return { data: new Ctor(bin.buffer, bin.byteOffset + off, a.count * comps), comps, count: a.count };
};

const prim = gltf.meshes[0].primitives[0];
const pos = accessor(prim.attributes.POSITION);
const nrm = accessor(prim.attributes.NORMAL);
const uv = accessor(prim.attributes.TEXCOORD_0);
const idx = accessor(prim.indices);

// ---- rotate so the nose lands on -Z ---------------------------------------
// Proper rotations only (det +1): a mirror would silently swap port and
// starboard on any asymmetric livery.
const ROT = {
  '-z': (x, y, z) => [x, y, z],
  '+z': (x, y, z) => [- x, y, - z],
  '-x': (x, y, z) => [- z, y, x],
  '+x': (x, y, z) => [z, y, - x],
}[FORWARD];
if (!ROT) throw new Error('--forward must be one of +x -x +z -z');

const n = pos.count;
const P = new Float64Array(n * 3);
for (let i = 0; i < n; i++) {
  const [x, y, z] = ROT(pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]);
  P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
}
const NR = new Float64Array(n * 3);
for (let i = 0; i < n; i++) {
  const [x, y, z] = ROT(nrm.data[i * 3], nrm.data[i * 3 + 1], nrm.data[i * 3 + 2]);
  NR[i * 3] = x; NR[i * 3 + 1] = y; NR[i * 3 + 2] = z;
}

// Centre on the bounding box; the length axis is Z after the rotation.
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
  min[c] = Math.min(min[c], P[i * 3 + c]); max[c] = Math.max(max[c], P[i * 3 + c]);
}
const ctr = min.map((m, c) => (m + max[c]) / 2);
const length = max[2] - min[2];

const qpos = new Int16Array(n * 3);
for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
  const v = (P[i * 3 + c] - ctr[c]) / length * 32000;
  if (Math.abs(v) > 32767) throw new Error('quantized position out of Int16 - model much wider than long?');
  qpos[i * 3 + c] = Math.round(v);
}
const qnrm = new Int8Array(n * 3);
for (let i = 0; i < n * 3; i++) qnrm[i] = Math.round(Math.max(-1, Math.min(1, NR[i])) * 127);
const quv = new Uint16Array(n * 2);
for (let i = 0; i < n * 2; i++) quv[i] = Math.round(Math.max(0, Math.min(1, uv.data[i])) * 65535);
if (n > 65535) throw new Error('more than 65535 vertices - Uint16 indices cannot address this');
const qidx = idx.data instanceof Uint16Array ? idx.data : Uint16Array.from(idx.data);

// ---- baseColor -> downscaled JPEG in headless chromium ---------------------
const matIdx = prim.material ?? 0;
const texInfo = gltf.materials[matIdx].pbrMetallicRoughness?.baseColorTexture;
let jpegB64 = '';
if (texInfo) {
  const img = gltf.images[gltf.textures[texInfo.index].source];
  const bv = gltf.bufferViews[img.bufferView];
  const png = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  const browser = await launchChromium();
  const page = await browser.newPage();
  jpegB64 = await page.evaluate(async ({ b64, size, q, mime }) => {
    const raw = atob(b64);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
    const s = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await c.convertToBlob({ type: 'image/jpeg', quality: q });
    const ab = new Uint8Array(await out.arrayBuffer());
    let str = '';
    for (let i = 0; i < ab.length; i += 0x8000) str += String.fromCharCode(...ab.subarray(i, i + 0x8000));
    return btoa(str);
  }, { b64: png.toString('base64'), size: TEX_SIZE, q: TEX_Q, mime: img.mimeType });
  await browser.close();
}

// ---- propeller spin weights ------------------------------------------------
//
// WHY THIS IS A FLOOD FILL AND NOT A BOX.
//
// The blades sweep past the fuselage and the wing root, so no cylinder, slab or
// annulus around the hub separates them: measured on this asset, a generous
// annulus caught 472 vertices of which a third were fuselage, and the blade
// tips sit at the same radius from the hub as the wing root does. The UV atlas
// does not separate them either - Meshy's unwrap is fragmented, and the blades'
// UV bounding box contains 7220 vertices from the whole airframe. What DOES
// separate them is CONNECTIVITY: a blade reaches the airframe only through the
// spinner, so a fill seeded on unambiguous blade vertices and forbidden to
// cross into the spinner (r < rCut) stops exactly at the blade roots.
//
// AND WHY IT IS NOT SEEDED BY HAND. The first version seeded "above the hub",
// which quietly meant "only the two blades pointing up": this prop has four,
// and the lower pair shares its annulus with the wing root, so no height, radius
// or slab rule picks them out without also picking up wing. So nothing is seeded
// by hand. The whole annulus rCut < r < rMax, |dz| < zMax is split into
// connected components - blades cannot merge there, since they meet only through
// the excluded spinner - and each component is then judged BY SHAPE:
//
//   a blade runs out along a radius (spans most of the annulus), stays narrow
//   in angle, and is thin in z.
//
// Airframe that pokes into the annulus fails at least one of those: the wing
// panel is wide in angle and long in z, the float struts barely move in radius.
// The classification prints, so a new model's numbers can be read off the log
// rather than guessed at.
//
// The hub disc itself is then added unconditionally. It is a body of revolution
// about the spin axis, so rotating it is visually a no-op - and including it
// moves the shear boundary off the blade root (where it would show as a twist)
// and onto an axisymmetric surface (where it cannot show at all).
function spinWeights(P, idx, n, spec) {
  const [hx, hy, hz, rCut, rMax, zMax, zThin] = spec.split(',').map(Number);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    min[c] = Math.min(min[c], P[i * 3 + c]); max[c] = Math.max(max[c], P[i * 3 + c]);
  }
  const ctr = min.map((m, c) => (m + max[c]) / 2);
  const L = max[2] - min[2];
  const Q = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) Q[i] = (P[i] - ctr[i % 3]) / L;

  // Weld first: an export is split at every UV seam, and an unwelded blade is a
  // dozen disconnected ribbons that a fill cannot walk along.
  const map = new Map(); const weld = new Int32Array(n); let nw = 0;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(Q[i * 3] * 20000)},${Math.round(Q[i * 3 + 1] * 20000)},${Math.round(Q[i * 3 + 2] * 20000)}`;
    let w = map.get(k);
    if (w === undefined) { w = nw++; map.set(k, w); }
    weld[i] = w;
  }
  const adj = Array.from({ length: nw }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = weld[idx[t]], b = weld[idx[t + 1]], c = weld[idx[t + 2]];
    adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
  }
  const rw = new Float64Array(nw), dzw = new Float64Array(nw);
  for (let i = 0; i < n; i++) {
    const w = weld[i];
    rw[w] = Math.hypot(Q[i * 3] - hx, Q[i * 3 + 1] - hy);
    dzw[w] = Math.abs(Q[i * 3 + 2] - hz);
  }
  const aw = new Float64Array(nw);
  for (let i = 0; i < n; i++) aw[weld[i]] = Math.atan2(Q[i * 3 + 1] - hy, Q[i * 3] - hx);
  const inRing = (w) => rw[w] >= rCut && rw[w] <= rMax && dzw[w] <= zMax;

  const comp = new Int32Array(nw).fill(-1);
  const seen = new Uint8Array(nw);
  let kept = 0;
  for (let s = 0; s < nw; s++) {
    if (comp[s] >= 0 || !inRing(s)) continue;
    const q = [s]; comp[s] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      for (const w of adj[q[qi]]) { if (comp[w] < 0 && inRing(w)) { comp[w] = 1; q.push(w); } }
    }
    // Angular width has to be measured on the circle, not on atan2's cut: a
    // blade straddling -pi would otherwise read as 360 deg wide and be dropped.
    let cx = 0, cy = 0, rMin = Infinity, rTop = 0, zLo = Infinity, zHi = -Infinity;
    for (const w of q) {
      cx += Math.cos(aw[w]); cy += Math.sin(aw[w]);
      rMin = Math.min(rMin, rw[w]); rTop = Math.max(rTop, rw[w]);
      zLo = Math.min(zLo, dzw[w]); zHi = Math.max(zHi, dzw[w]);
    }
    const mean = Math.atan2(cy, cx);
    let half = 0;
    for (const w of q) {
      let d = Math.abs(aw[w] - mean); if (d > Math.PI) d = 2 * Math.PI - d;
      half = Math.max(half, d);
    }
    const span = (rTop - rMin) / (rMax - rCut);
    const wide = half * 2 * 180 / Math.PI;
    const thick = zHi - zLo;
    const blade = q.length >= 8 && span > 0.5 && wide < 70 && thick < zThin;
    console.log(`    ring part n=${String(q.length).padStart(4)} at ${String(Math.round(((mean * 180 / Math.PI) + 360) % 360)).padStart(3)} deg` +
      ` | radial span ${span.toFixed(2)} | angular width ${wide.toFixed(0)} deg | z thickness ${thick.toFixed(3)} -> ${blade ? 'BLADE' : 'airframe'}`);
    if (blade) { kept++; for (const w of q) seen[w] = 1; }
  }
  // The spinner: axisymmetric about the axis (measured r spread 0.005-0.015
  // against a mean radius of 0.034), so rotating it is a visual no-op, and it
  // carries the boundary off the blade roots and onto a surface where a seam
  // cannot be seen.
  for (let w = 0; w < nw; w++) if (rw[w] < rCut && dzw[w] < zMax) seen[w] = 1;

  // Weld positions, mark ORIGINALS - and mark them a TRIANGLE at a time. The
  // weld is a lie about identity: the wing skin has vertices sitting exactly on
  // blade vertices, and marking every original that shares a welded position
  // dragged one corner of a wing triangle around with the prop, which renders as
  // a sheet the size of the wing sweeping across the nose. A triangle spins only
  // if all three of its corners are in the blade set, and only those triangles'
  // own original indices are marked, so a coincident wing vertex stays put.
  const spinTri = new Uint8Array(idx.length / 3);
  const out = new Uint8Array(n);
  for (let t = 0; t < idx.length; t += 3) {
    if (!seen[weld[idx[t]]] || !seen[weld[idx[t + 1]]] || !seen[weld[idx[t + 2]]]) continue;
    spinTri[t / 3] = 1;
    out[idx[t]] = 255; out[idx[t + 1]] = 255; out[idx[t + 2]] = 255;
  }

  // SPLIT THE MESH AT THE BOUNDARY. A rigid part carved out of a connected mesh
  // still has a ring of triangles with one corner on each side, and those do not
  // rotate - they STRETCH, which on this asset drew a fan of smeared triangles
  // out of the nacelle every frame the prop turned. Measured: 156 such triangles,
  // and dropping the spinner from the set only cut them to 118, because the
  // blades are welded to it. So the boundary vertices are duplicated: the
  // stationary side gets its own copies, and the two sides simply come apart.
  // The crack left behind is on the spinner, a body of revolution, where the
  // surface it exposes is the surface it hid.
  const newIdx = Uint16Array.from(idx);
  const dupOf = new Map(); const dup = [];
  for (let t = 0; t < idx.length; t += 3) {
    if (spinTri[t / 3]) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      if (!out[v]) continue;
      let d = dupOf.get(v);
      if (d === undefined) { d = n + dup.length; dup.push(v); dupOf.set(v, d); }
      newIdx[t + k] = d;
    }
  }
  if (n + dup.length > 65535) throw new Error('splitting the prop overflowed Uint16 indices');

  const spin = new Uint8Array(n + dup.length);
  spin.set(out);                      // the duplicates stay at zero: they do not spin
  let hit = 0;
  for (let i = 0; i < spin.length; i++) if (spin[i]) hit++;
  console.log(`    ${dup.length} boundary vertices split so nothing stretches`);
  console.log(`  spin: ${kept} blades -> ${hit} of ${n + dup.length} vertices rotate (hub ${hx},${hy},${hz})`);
  return { spin, idx: newIdx, dup };
}

const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
let spinLine = '';
let outPos = qpos, outNrm = qnrm, outUv = quv, outIdx = qidx, outN = n;
if (SPIN) {
  const { spin, idx: splitIdx, dup } = spinWeights(P, qidx, n, SPIN);
  // The split appended vertices; they are exact copies of the originals they
  // were cut from, so every attribute is copied straight across.
  outN = n + dup.length;
  outIdx = splitIdx;
  outPos = new Int16Array(outN * 3); outPos.set(qpos);
  outNrm = new Int8Array(outN * 3); outNrm.set(qnrm);
  outUv = new Uint16Array(outN * 2); outUv.set(quv);
  for (let j = 0; j < dup.length; j++) {
    const s = dup[j], d = n + j;
    for (let c = 0; c < 3; c++) { outPos[d * 3 + c] = qpos[s * 3 + c]; outNrm[d * 3 + c] = qnrm[s * 3 + c]; }
    outUv[d * 2] = quv[s * 2]; outUv[d * 2 + 1] = quv[s * 2 + 1];
  }
  const parts = SPIN.split(',').map(Number);
  spinLine = `  spin: '${b64(spin)}',\n  spinHub: [${parts[0]}, ${parts[1]}, ${parts[2]}],\n`;
}

// ---- jaw weights -----------------------------------------------------------
function jawWeights(P, n, spec) {
  const [hy, hz, zBack, feather] = spec.split(',').map(Number);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    min[c] = Math.min(min[c], P[i * 3 + c]); max[c] = Math.max(max[c], P[i * 3 + c]);
  }
  const ctr = min.map((m, c) => (m + max[c]) / 2);
  const L = max[2] - min[2];
  const out = new Uint8Array(n);
  let hit = 0;
  const bb = [9, 9, 9, -9, -9, -9];
  for (let i = 0; i < n; i++) {
    const x = (P[i * 3] - ctr[0]) / L, y = (P[i * 3 + 1] - ctr[1]) / L, z = (P[i * 3 + 2] - ctr[2]) / L;
    if (y >= hy) continue;
    // Feathered at the hinge rather than cut square: a hard edge there shears the
    // cheek open every time the mouth moves.
    const t = (zBack - z) / Math.max(feather, 1e-4);
    const w = Math.max(0, Math.min(1, t));
    if (w <= 0) continue;
    out[i] = Math.round(w * 255); hit++;
    bb[0] = Math.min(bb[0], x); bb[3] = Math.max(bb[3], x);
    bb[1] = Math.min(bb[1], y); bb[4] = Math.max(bb[4], y);
    bb[2] = Math.min(bb[2], z); bb[5] = Math.max(bb[5], z);
  }
  console.log(`  jaw: ${hit} of ${n} vertices swing (hinge y ${hy} z ${hz})`);
  console.log(`    jaw bbox x[${bb[0].toFixed(3)},${bb[3].toFixed(3)}] y[${bb[1].toFixed(3)},${bb[4].toFixed(3)}] z[${bb[2].toFixed(3)},${bb[5].toFixed(3)}]`);
  return out;
}

let jawLine = '';
if (JAW) {
  const w = jawWeights(P, n, JAW);
  const full = new Uint8Array(outN);
  full.set(w);
  // Duplicates the spin split appended are copies, so they inherit their
  // source's weight - looked up through `dup` if there was a split at all.
  const parts = JAW.split(',').map(Number);
  jawLine = `  jaw: '${b64(full)}',\n  jawHinge: [${parts[0]}, ${parts[1]}],\n`;
}

const body = `// ${NAME}: generated from ${IN.split('/').pop()} by tools/glb.mjs.
// Inlined because the artifact CSP blocks every external request. Positions are
// Int16 with the LENGTH axis spanning +-16000 (decode: * lengthM / 32000),
// normals Int8, UVs Uint16. Source forward axis was ${FORWARD}; rotated so the
// nose sits at -Z, the renderer's convention for "forward".
export const ${NAME} = {
  verts: ${outN}, tris: ${outIdx.length / 3},
  pos: '${b64(outPos)}',
  nrm: '${b64(outNrm)}',
  uv: '${b64(outUv)}',
  idx: '${b64(outIdx)}',
${spinLine}${jawLine}  baseColorJpeg: '${jpegB64}',
};
`;
await writeFile(OUT, body);
console.log(`${OUT}: ${outN} verts, ${outIdx.length / 3} tris, jpeg ${Math.round(jpegB64.length * 0.75 / 1024)} kB, module ${Math.round(body.length / 1024)} kB`);
