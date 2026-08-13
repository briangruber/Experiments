#!/usr/bin/env node
// Print the JSON chunk highlights of a .glb: meshes, materials, animation
// names, texture sizes and the POSITION bounds (which is the model's bbox in
// its own node space). Enough to normalise an asset without a browser.
//
//   node tools/glb-info.mjs assets/*.glb

import { readFile } from 'node:fs/promises';

for (const path of process.argv.slice(2)) {
  const buf = await readFile(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) { console.log(`${path}: not a glb`); continue; }
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = gltf.accessors?.[prim.attributes?.POSITION];
      if (!acc?.min) continue;
      for (let i = 0; i < 3; i++) {
        bounds.min[i] = Math.min(bounds.min[i], acc.min[i]);
        bounds.max[i] = Math.max(bounds.max[i], acc.max[i]);
      }
    }
  }
  const size = bounds.max.map((v, i) => +(v - bounds.min[i]).toFixed(3));
  const tris = (gltf.meshes ?? []).flatMap((m) => m.primitives ?? [])
    .reduce((n, p) => n + Math.round((gltf.accessors?.[p.indices]?.count ?? 0) / 3), 0);

  console.log(`\n${path}  (${(buf.length / 1e6).toFixed(2)} MB)`);
  console.log(`  meshes ${gltf.meshes?.length ?? 0}  prims ${(gltf.meshes ?? []).reduce((n, m) => n + m.primitives.length, 0)}  tris ${tris}  skins ${gltf.skins?.length ?? 0}  nodes ${gltf.nodes?.length ?? 0}`);
  console.log(`  bbox min ${bounds.min.map((v) => +v.toFixed(3))}  max ${bounds.max.map((v) => +v.toFixed(3))}  size ${size}`);
  console.log(`  materials ${(gltf.materials ?? []).map((m) => m.name).join(', ') || '—'}`);
  console.log(`  images ${(gltf.images ?? []).map((im) => im.mimeType ?? '?').join(', ') || '—'}`);
  if (gltf.animations?.length) {
    console.log(`  animations ${gltf.animations.map((a, i) => `${i}:${a.name ?? 'unnamed'}(${a.channels.length}ch)`).join(', ')}`);
  }
  const roots = (gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []).map((i) => gltf.nodes[i]?.name ?? `#${i}`);
  console.log(`  scene roots ${roots.join(', ')}`);
}
