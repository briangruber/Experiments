// Baked models: the barrel and the thing that lives in the dark at the back of
// the tank. Both come from tools/bake-glb.mjs as ES modules and are inlined by
// the bundler, so the artifact needs no fetches. Attributes are quantised and
// read back as NORMALISED integers, which three feeds to the GPU as-is —
// nothing is expanded to float on the CPU.

import { BARREL } from './barrel-asset.js';
import { DIVER } from './diver-asset.js';

function decode(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

// Positions are centred and scaled so the largest half extent is exactly 1, so
// a mesh scaled by `s` is `s * asset.half[k]` across on each axis and one
// number sets its size.
export function modelGeometry(THREE, asset) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position',
    new THREE.Int16BufferAttribute(decode(asset.positions, Int16Array), 3, true));
  g.setAttribute('normal',
    new THREE.Int8BufferAttribute(decode(asset.normals, Int8Array), 3, true));
  g.setAttribute('uv',
    new THREE.Uint16BufferAttribute(decode(asset.uvs, Uint16Array), 2, true));
  g.setIndex(new THREE.BufferAttribute(decode(asset.indices, Uint16Array), 1));
  g.computeBoundingSphere();
  return g;
}

export function modelTexture(THREE, asset) {
  const t = new THREE.TextureLoader().load(asset.texture);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;             // glTF's uv origin is top-left
  t.anisotropy = 4;
  return t;
}

export const BARREL_HALF = BARREL.half;
export const barrelGeometry = (THREE) => modelGeometry(THREE, BARREL);
export const barrelTexture = (THREE) => modelTexture(THREE, BARREL);

export const DIVER_HALF = DIVER.half;
export const diverGeometry = (THREE) => modelGeometry(THREE, DIVER);
export const diverTexture = (THREE) => modelTexture(THREE, DIVER);
