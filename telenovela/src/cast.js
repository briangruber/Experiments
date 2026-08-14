// The company. Same rig, five silhouettes — in a wordless piece the audience
// has to tell them apart in one frame, in the dark, during lightning.

import * as THREE from '../vendor/three/three.module.min.js';
import { makeChicken } from './chicken.js';
import { Actor } from './acting.js';
import { TAU, deg } from './util.js';

function flower(color, petals = 6, r = 0.032) {
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

function monocle(size) {
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

function eyepatch(size) {
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

function hat(size, color) {
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
function shawl(size, color) {
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
function lashes(size, color) {
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

export const CAST_SPECS = {
  rosalinda: {
    name: 'Rosalinda', role: 'la inocente',
    plumage: 0xf2ebdd, accent: 0xfffaf0, comb: 0xdf6079, beak: 0xe8b95f, legs: 0xe0a95a,
    iris: 0xd9a44e, eyeRing: 0xc48a72, size: 1.0, breast: 1.05, rump: 0.9, seed: 3,
  },
  esteban: {
    name: 'Esteban', role: 'el galán',
    plumage: 0xb06a35, accent: 0xd99447, comb: 0xd2333c, beak: 0xdcb057, legs: 0xd6a04c,
    iris: 0xe0a437, eyeRing: 0xa06a44, size: 1.14, rooster: true, sheen: true, sickle: 0x16352b, breast: 1.06, seed: 11,
  },
  valentina: {
    name: 'Valentina', role: 'la villana',
    plumage: 0x2b2331, accent: 0x4b3452, comb: 0xb52436, beak: 0x4a3d3a, legs: 0x8a6a52,
    iris: 0xe06a44, eyeRing: 0x7d5a66, size: 1.02, breast: 0.97, rump: 0.95, seed: 23,
  },
  donGallo: {
    name: 'Don Gallo', role: 'el patrón',
    plumage: 0x6c6974, accent: 0x9b98a2, comb: 0x9c2b34, beak: 0xc9b27a, legs: 0xb09a63,
    iris: 0xd8c47a, eyeRing: 0x8d8a93, size: 1.32, rooster: true, breast: 1.12, rump: 1.0, sickle: 0x3a3742, seed: 41,
  },
  ricardo: {
    name: 'Ricardo', role: 'el gemelo',
    plumage: 0x8d5330, accent: 0x6b3b25, comb: 0x8f1f27, beak: 0xb08a45, legs: 0xa87c42,
    iris: 0xe8752c, eyeRing: 0xb08a5a, size: 1.14, rooster: true, sheen: true, sickle: 0x0f1915, breast: 1.06, seed: 11,
  },
  pollito: {
    name: 'Pollito', role: 'el secreto',
    plumage: 0xf3d571, accent: 0xf8e5a2, comb: 0xe8a05a, beak: 0xe8a840, legs: 0xe0a95a,
    iris: 0x3a2410, eyeRing: 0xd9b45e, brow: 0xe6c65c, size: 0.4, breast: 1.2, rump: 1.1, seed: 77,
  },
};

// Wardrobe. Anchored to the head group so it inherits every flinch.
const WARDROBE = {
  rosalinda(rig) {
    const f = flower(0xe86a8c, 6, 0.03 * rig.size);
    f.position.set(-0.055 * rig.size, 0.055 * rig.size, -0.005 * rig.size);
    f.rotation.set(deg(20), 0, deg(-38));
    rig.propAnchor.add(f);
    for (const e of rig.eyes) e.group.add(lashes(rig.size, 0x4a3320));
  },
  valentina(rig) {
    const f = flower(0x9c1728, 5, 0.034 * rig.size);
    f.position.set(0.06 * rig.size, 0.045 * rig.size, -0.01 * rig.size);
    f.rotation.set(deg(14), 0, deg(46));
    rig.propAnchor.add(f);
    // A black lace mantilla trailing off the back of the skull.
    const v = shawl(rig.size * 0.9, 0x191221);
    v.position.set(0, 0.05 * rig.size, -0.075 * rig.size);
    v.rotation.set(deg(24), 0, 0);
    rig.propAnchor.add(v);
    for (const e of rig.eyes) e.group.add(lashes(rig.size, 0x150e18));
  },
  donGallo(rig) {
    const m = monocle(rig.size);
    m.position.set(0.062 * rig.size, 0.028 * rig.size, 0.046 * rig.size);
    m.rotation.y = deg(46);
    rig.propAnchor.add(m);
    const h = hat(rig.size, 0x4a3b32);
    h.position.set(0, 0.085 * rig.size, -0.012 * rig.size);
    h.rotation.z = deg(-5);
    rig.propAnchor.add(h);
  },
  ricardo(rig) {
    const p = eyepatch(rig.size);
    p.position.set(-0.062 * rig.size, 0.028 * rig.size, 0.044 * rig.size);
    p.rotation.y = deg(-46);
    rig.propAnchor.add(p);
    // A scar across the comb, which is as close as a chicken gets to a past.
    const scar = new THREE.Mesh(
      new THREE.BoxGeometry(0.006 * rig.size, 0.05 * rig.size, 0.02 * rig.size),
      new THREE.MeshStandardMaterial({ color: 0x6b2a2a, roughness: 0.6 }),
    );
    scar.position.set(0.05 * rig.size, 0.03 * rig.size, 0.03 * rig.size);
    scar.rotation.z = deg(28);
    rig.propAnchor.add(scar);
  },
  esteban(rig) {
    // A neckerchief: the only thing separating a hero from his evil twin.
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.072 * rig.size, 0.016 * rig.size, 8, 20),
      new THREE.MeshStandardMaterial({ color: 0xc4342f, roughness: 0.78 }),
    );
    band.rotation.x = deg(90);
    band.position.y = 0.015 * rig.size;
    band.castShadow = true;
    rig.neck.add(band);
    const knot = new THREE.Mesh(
      new THREE.ConeGeometry(0.03 * rig.size, 0.07 * rig.size, 6),
      new THREE.MeshStandardMaterial({ color: 0xc4342f, roughness: 0.78 }),
    );
    knot.position.set(0, -0.015 * rig.size, 0.07 * rig.size);
    knot.rotation.x = deg(150);
    rig.neck.add(knot);
  },
};

export function buildCast(scene) {
  const actors = {};
  for (const key of Object.keys(CAST_SPECS)) {
    const rig = makeChicken(CAST_SPECS[key]);
    WARDROBE[key]?.(rig);
    scene.add(rig.root);
    const a = new Actor(rig);
    a.key = key;
    a.role = CAST_SPECS[key].role;
    actors[key] = a;
  }
  return actors;
}

// --- the prop that drives the plot -----------------------------------------

export function makeEgg(size = 1) {
  const g = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xf4e4c8, roughness: 0.55, metalness: 0.02 });
  const geo = new THREE.SphereGeometry(0.055 * size, 20, 16);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y / (0.055 * size)) * 0.5 + 0.5;
    const s = 1 - 0.22 * Math.pow(t, 2.2);       // taper the top into an egg
    pos.setXYZ(i, pos.getX(i) * s, y * 1.32, pos.getZ(i) * s);
  }
  geo.computeVertexNormals();
  const shell = new THREE.Mesh(geo, shellMat);
  shell.castShadow = shell.receiveShadow = true;
  g.add(shell);

  // The crack: two thin dark slabs that scale in when the secret gets out.
  const crackMat = new THREE.MeshStandardMaterial({ color: 0x2a1d12, roughness: 0.9 });
  const cracks = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.004 * size, 0.02 * size, 0.004 * size), crackMat);
    const a = (i / 5) * TAU;
    c.position.set(Math.cos(a) * 0.05 * size, 0.01 * size + (i % 2) * 0.02 * size, Math.sin(a) * 0.05 * size);
    c.rotation.set(0, -a, deg(18 * (i % 2 ? 1 : -1)));
    cracks.add(c);
  }
  cracks.scale.setScalar(0.001);
  g.add(cracks);
  g.userData.cracks = cracks;
  g.userData.shell = shell;
  return g;
}
