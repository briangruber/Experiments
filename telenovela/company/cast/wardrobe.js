// The wardrobe department: the pieces more than one character wears, or that
// are fiddly enough to keep out of the character files. Everything here is
// anchored to the head or neck group by the caller so it inherits every flinch.

import * as THREE from '../../vendor/three/three.module.min.js';
import { TAU, deg } from '../../engine/util.js';

export function flower(color, petals = 6, r = 0.032) {
  const g = new THREE.Group();
  const petalGeo = new THREE.SphereGeometry(r, 8, 6);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.62 });
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * TAU;
    const p = new THREE.Mesh(petalGeo, mat);
    p.scale.set(1, 0.42, 1.5);
    p.position.set(Math.cos(a) * r * 1.15, 0, Math.sin(a) * r * 1.15);
    p.rotation.y = -a;
    p.castShadow = true;
    g.add(p);
  }
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.5, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xf6d76b, roughness: 0.5 }),
  );
  core.scale.y = 0.5;
  g.add(core);
  return g;
}

export function monocle(size) {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xd9b34a, roughness: 0.25, metalness: 0.9 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.044 * size, 0.006 * size, 8, 24), gold);
  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(0.044 * size, 20),
    new THREE.MeshStandardMaterial({ color: 0xdff0ff, transparent: true, opacity: 0.2, roughness: 0.06, metalness: 0.2 }),
  );
  g.add(ring, glass);
  const link = new THREE.SphereGeometry(0.0055 * size, 5, 4);
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const m = new THREE.Mesh(link, gold);
    m.position.set(
      0.03 * size - t * 0.02 * size,
      -0.036 * size - t * 0.075 * size + Math.sin(t * Math.PI) * 0.018 * size,
      -0.01 * size * t,
    );
    g.add(m);
  }
  return g;
}

export function eyepatch(size) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x120f14, roughness: 0.85 });
  const patch = new THREE.Mesh(new THREE.CircleGeometry(0.046 * size, 16), mat);
  patch.scale.set(1, 1.1, 1);
  g.add(patch);
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.074 * size, 0.005 * size, 6, 22, Math.PI * 1.3), mat);
  strap.rotation.set(0, deg(90), deg(20));
  strap.position.set(-0.028 * size, 0.004 * size, -0.03 * size);
  g.add(strap);
  return g;
}

export function hat(size, color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.88 });
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.17 * size, 0.185 * size, 0.012 * size, 24), mat);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.074 * size, 0.088 * size, 0.095 * size, 20), mat);
  crown.position.y = 0.052 * size;
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.091 * size, 0.091 * size, 0.022 * size, 20),
    new THREE.MeshStandardMaterial({ color: 0x2b2129, roughness: 0.7 }),
  );
  band.position.y = 0.014 * size;
  brim.castShadow = crown.castShadow = true;
  g.add(brim, crown, band);
  return g;
}

// A widow's lace for the grieving. One draped triangle reads at this scale.
export function shawl(size, color) {
  const s = new THREE.Shape();
  s.moveTo(-0.15 * size, 0);
  s.quadraticCurveTo(0, 0.06 * size, 0.15 * size, 0);
  s.quadraticCurveTo(0.1 * size, -0.2 * size, 0, -0.26 * size);
  s.quadraticCurveTo(-0.1 * size, -0.2 * size, -0.15 * size, 0);
  const m = new THREE.Mesh(
    new THREE.ShapeGeometry(s, 12),
    new THREE.MeshStandardMaterial({
      color, roughness: 0.92, side: THREE.DoubleSide, transparent: true, opacity: 0.88,
    }),
  );
  m.castShadow = true;
  return m;
}

// Long lashes. Purely editorial, entirely load-bearing.
export function lashes(size, color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  for (let i = 0; i < 3; i++) {
    const l = new THREE.Mesh(new THREE.ConeGeometry(0.0038 * size, 0.034 * size, 5), mat);
    l.position.set((i - 1) * 0.016 * size, 0.031 * size, 0.018 * size);
    l.rotation.set(deg(-52), 0, (i - 1) * deg(19));
    g.add(l);
  }
  return g;
}

// The neckerchief both brothers wear, in the two colours that tell them apart.
export function neckerchief(rig, color) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.78 });
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.072 * rig.size, 0.016 * rig.size, 8, 20), mat,
  );
  band.rotation.x = deg(90);
  band.position.y = 0.015 * rig.size;
  band.castShadow = true;
  rig.neck.add(band);
  const knot = new THREE.Mesh(
    new THREE.ConeGeometry(0.03 * rig.size, 0.07 * rig.size, 6), mat,
  );
  knot.position.set(0, -0.015 * rig.size, 0.07 * rig.size);
  knot.rotation.x = deg(150);
  rig.neck.add(knot);
}
