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

// Skinning, done here rather than with THREE.SkinnedMesh.
//
// The rig data out of the bake is exact — reconstructing the bind pose from it
// reproduces every vertex to 0.000000, with the four-influence truncation
// included — so the maths is not in question. What was in question is the
// contract SkinnedMesh expects: its shader computes
// bindMatrixInverse * boneMatrixWorld * bindMatrix * position and then applies
// modelMatrix, which means the object's own transform can land in the result
// twice depending on where the bones are parented. Rather than keep guessing at
// that, this builds the same matrices the glTF spec defines — jointWorld * IBM
// — and hands them to a vertex shader as plain rows. Nothing implicit is left.
//
// Bones are ordinary Object3Ds: all that is wanted from three is matrix
// composition down the hierarchy.
export function riggedModel(THREE, asset, material) {
  const geo = modelGeometry(THREE, asset);
  const rig = asset.rig;
  if (!rig) return { mesh: new THREE.Mesh(geo, material), bones: null, sync: () => {} };

  geo.setAttribute('skinIndex',
    new THREE.Uint16BufferAttribute(decode(rig.skinIndex, Uint16Array), 4));
  geo.setAttribute('skinWeight',
    new THREE.Uint16BufferAttribute(decode(rig.skinWeight, Uint16Array), 4, true));

  const bones = rig.joints.map((j) => {
    const b = new THREE.Object3D();
    b.name = j.name;
    b.position.fromArray(j.t);
    b.quaternion.fromArray(j.r);
    b.scale.fromArray(j.s);
    b.matrixAutoUpdate = true;
    return b;
  });
  const root = new THREE.Object3D();
  rig.joints.forEach((j, i) => (j.parent >= 0 ? bones[j.parent] : root).add(bones[i]));

  const inv = decode(rig.inverseBind, Float32Array);
  const bind = bones.map((_, i) => new THREE.Matrix4().fromArray(inv, i * 16));

  // The bind matrices describe the model in the FILE's units; the baked
  // positions have been centred and rescaled so the largest half extent is
  // exactly 1, which is what lets them survive as int16. So the two spaces have
  // to be reconciled, and the only safe place to do it is here, in the bone
  // matrices.
  //
  // Doing it the obvious way instead — geo.scale() and geo.translate() to put
  // the vertices back in file units — is what tore the mesh apart through
  // every previous attempt at this, including the SkinnedMesh ones. Those
  // helpers transform the position attribute in place, and the attribute is
  // NORMALISED int16: three denormalises to ±1, applies the matrix, then
  // requantises. The bake guarantees the extremes sit at exactly ±1, so
  // scaling by 1.17 and shifting by 0.85 sends them past what an int16 can
  // hold and they wrap to the far side of the model — 3105 of 24168
  // components, up to a full model-width out of place. Silent, and it looks
  // exactly like broken skinning.
  //
  // Folded in here it costs nothing: the uniform scale cancels in the rotation
  // part, so normals need no special handling, and the mesh keeps its original
  // scale semantics because the shader still reads and writes baked units.
  const s = asset.posScale;
  const toFile = new THREE.Matrix4()
    .makeTranslation(asset.posOffset[0], asset.posOffset[1], asset.posOffset[2])
    .multiply(new THREE.Matrix4().makeScale(s, s, s));
  const fromFile = toFile.clone().invert();

  // Three rows per bone: the affine part is all a rigid deform needs, and rows
  // of vec4 are the one uniform-array shape both backends agree on.
  const rows = new Array(bones.length * 3);
  for (let i = 0; i < rows.length; i++) rows[i] = new THREE.Vector4();
  const tmp = new THREE.Matrix4();

  function sync() {
    root.updateMatrixWorld(true);
    for (let i = 0; i < bones.length; i++) {
      // baked units -> file units -> deform -> back to baked units
      tmp.multiplyMatrices(bones[i].matrixWorld, bind[i])
        .premultiply(fromFile).multiply(toFile);
      const e = tmp.elements;   // column-major
      rows[i * 3 + 0].set(e[0], e[4], e[8], e[12]);
      rows[i * 3 + 1].set(e[1], e[5], e[9], e[13]);
      rows[i * 3 + 2].set(e[2], e[6], e[10], e[14]);
    }
  }
  sync();

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;   // the silhouette moves with the bones
  return { mesh, bones, root, rows, sync };
}

export const DIVER_HALF = DIVER.half;
export const DIVER_UNIT = DIVER.posScale;
export const diverModel = (THREE, material) => riggedModel(THREE, DIVER, material);
export const diverGeometry = (THREE) => modelGeometry(THREE, DIVER);
export const diverTexture = (THREE) => modelTexture(THREE, DIVER);
