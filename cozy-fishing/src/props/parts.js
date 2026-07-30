// Tiny kit of rounded low-poly parts all the placeholders are built from.

import * as THREE from 'three';

const mats = new Map();

export function matte(hex, opts = {}) {
  const key = `m${hex}|${JSON.stringify(opts)}`;
  if (!mats.has(key)) {
    mats.set(key, new THREE.MeshStandardMaterial({
      color: hex, roughness: 0.92, metalness: 0, flatShading: true, ...opts,
    }));
  }
  return mats.get(key);
}

export function glow(hex, intensity = 2) {
  const key = `g${hex}|${intensity}`;
  if (!mats.has(key)) {
    mats.set(key, new THREE.MeshStandardMaterial({
      color: hex, emissive: hex, emissiveIntensity: intensity, roughness: 0.6,
    }));
  }
  return mats.get(key);
}

function finish(mesh, shadows) {
  if (shadows) { mesh.castShadow = true; mesh.receiveShadow = true; }
  return mesh;
}

export const box = (w, h, d, mat, shadows = true) =>
  finish(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), shadows);

export const cyl = (rt, rb, h, seg, mat, shadows = true) =>
  finish(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat), shadows);

export const cone = (r, h, seg, mat, shadows = true) =>
  finish(new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat), shadows);

export const sph = (r, mat, w = 10, h = 7, shadows = true) =>
  finish(new THREE.Mesh(new THREE.SphereGeometry(r, w, h), mat), shadows);

// Gable prism: triangular cross-section in XY, ridge running along Z.
export function prism(w, h, d, mat, shadows = true) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, h); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  return finish(new THREE.Mesh(geo, mat), shadows);
}

// Capsule stretched between two points — limbs, ropes, struts.
const UP = new THREE.Vector3(0, 1, 0);
export function limb(a, b, r, mat, shadows = true) {
  const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b);
  const dir = bv.clone().sub(av);
  const len = dir.length();
  const m = finish(new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 8), mat), shadows);
  m.position.copy(av).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  return m;
}

// Sagging rope through the given points (adds droop between each pair).
export function rope(points, radius, mat, sag = 0.25) {
  const pts = [];
  for (let i = 0; i < points.length; i++) {
    const p = new THREE.Vector3(...points[i]);
    pts.push(p);
    if (i < points.length - 1) {
      const q = new THREE.Vector3(...points[i + 1]);
      pts.push(p.clone().lerp(q, 0.5).add(new THREE.Vector3(0, -sag, 0)));
    }
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, pts.length * 6, radius, 5);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

// Soft dark ellipse that grounds a floating thing on the water.
export function contactShadow(rx, rz, opacity = 0.14) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x0a1418, transparent: true, opacity, depthWrite: false,
    })
  );
  m.scale.set(rx, 1, rz);
  m.renderOrder = 1;
  return m;
}
