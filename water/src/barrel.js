// The barrel model, baked by tools/barrel.mjs into src/barrel-asset.js and
// inlined by the bundler so the artifact needs no fetches. Attributes are
// quantised and read back as normalised integers, which three feeds to the GPU
// as-is — nothing is expanded to float on the CPU.

import { BARREL } from './barrel-asset.js';

function decode(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

// The model's half extents once decoded: the largest is exactly 1, so a mesh
// scaled by `s` is `s * BARREL_HALF[k]` across on each axis.
export const BARREL_HALF = BARREL.half;

// Positions are centred and scaled so the largest half extent is 1; the caller
// scales the mesh to whatever size the barrel should be.
export function barrelGeometry(THREE) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position',
    new THREE.Int16BufferAttribute(decode(BARREL.positions, Int16Array), 3, true));
  g.setAttribute('normal',
    new THREE.Int8BufferAttribute(decode(BARREL.normals, Int8Array), 3, true));
  g.setAttribute('uv',
    new THREE.Uint16BufferAttribute(decode(BARREL.uvs, Uint16Array), 2, true));
  g.setIndex(new THREE.BufferAttribute(decode(BARREL.indices, Uint16Array), 1));
  g.computeBoundingSphere();
  return g;
}

export function barrelTexture(THREE) {
  const t = new THREE.TextureLoader().load(BARREL.texture);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;             // glTF's uv origin is top-left
  t.anisotropy = 4;
  return t;
}
