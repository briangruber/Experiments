// Everything solid in the cove: the dock, the boat, the reef heads, the odd
// crate and buoy.
//
// All of it is generated - no assets, no loader - and merged down into a handful
// of geometries with vertex colours carrying the paint, so the whole scene is a
// few draw calls and one material. The props exist to give the water something
// to be measured against: a piling refracting into a bent stick is worth more
// than another parameter on the surface shader.

import {
  BufferGeometry, BufferAttribute, Mesh, MeshBasicNodeMaterial, DoubleSide,
  BoxGeometry, CylinderGeometry, IcosahedronGeometry, TorusGeometry, SphereGeometry,
  Matrix4, Euler, Vector3, Quaternion, Color, Group,
} from 'three';
import {
  Fn, vec3, vec4, float, attribute, positionWorld, normalWorld, cameraPosition,
  normalize, dot, max, clamp, mix, smoothstep, pow, length, frontFacing,
  mx_noise_float,
} from 'three/tsl';
import { U, caustics, skyColor, saturate3 } from './fields.js';
import { lightThroughWater } from './scene.js';
import { terrainHeight, MOUNDS } from './terrain.js';

// ------------------------------------------------------------------- material
// One material for every solid object. It is deliberately not a PBR material:
// the target look is painted, so the shading is a soft wrap term, a sky ambient,
// a rim, and - the part that matters - caustics and light loss below the
// waterline, so a piling darkens as it goes down exactly like the floor does.
export function createPropMaterial() {
  const material = new MeshBasicNodeMaterial();
  material.side = DoubleSide;
  material.vertexColors = true;

  material.colorNode = Fn(() => {
    const P = positionWorld;
    const depth = P.y.negate().toVar();
    const albedo = attribute('color', 'vec3').toVar();
    const N = normalize(normalWorld.mul(frontFacing.select(1.0, -1.0))).toVar();
    const V = normalize(cameraPosition.sub(P));

    // Weathering: a little noise so flat paint does not stay flat.
    albedo.mulAssign(float(0.92).add(mx_noise_float(vec3(P.mul(3.1)), 1.0, 0.5).mul(0.16)));

    // The dark, wet, slightly green band where a piling or a hull meets water.
    const wet = smoothstep(-0.10, 0.18, depth).mul(smoothstep(0.25, 1.1, depth).oneMinus());
    albedo.assign(mix(albedo, albedo.mul(vec3(0.55, 0.62, 0.52)), clamp(wet, 0.0, 1.0).mul(0.8)));

    const ndl = max(dot(N, U.sunDir), 0.0);
    const wrap = float(0.30).add(pow(ndl, 0.85).mul(0.80));
    const amb = skyColor(vec3(N.x.mul(0.5), max(N.y, 0.0).add(0.35), N.z.mul(0.5))).mul(0.38);
    const lit = albedo.mul(U.sunColor.mul(wrap).add(amb)).toVar();

    // Below the surface: lose light with depth, gain caustics.
    const sub = smoothstep(0.0, 0.12, depth);
    lit.assign(mix(lit, lit.mul(lightThroughWater(depth)), sub));
    const cw = float(0.35).add(max(N.y, 0.0).mul(0.65));
    lit.addAssign(caustics(P.xz, max(depth, 0.0)).mul(albedo.add(0.2)).mul(U.sunColor).mul(cw).mul(sub));

    // A cool rim keeps silhouettes off the background without a light rig.
    const rim = pow(clamp(float(1.0).sub(max(dot(N, V), 0.0)), 0, 1), 3.0);
    lit.addAssign(skyColor(vec3(0, 1, 0)).mul(rim).mul(0.16).mul(sub.oneMinus()));

    return vec4(saturate3(lit, U.saturation), 1.0);
  })();

  return material;
}

// -------------------------------------------------------------------- builder
// Accumulates transformed geometries into one indexed buffer with a colour per
// vertex. Everything below draws into one of these.
class Build {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.idx = []; }

  // `baseShade` darkens the underside of a piece by that fraction, which is the
  // contact shadow a coral head or a rock would sit in. It is baked into the
  // vertex colour rather than computed, because nothing here casts shadows.
  add(geometry, matrix, color, tint = 0, baseShade = 0) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = g.attributes.position.array;
    const nrm = g.attributes.normal ? g.attributes.normal.array : null;
    const base = this.pos.length / 3;
    const nm = new Matrix4().extractRotation(matrix);
    const v = new Vector3();
    let minY = Infinity, maxY = -Infinity;
    if (baseShade) {
      for (let i = 1; i < pos.length; i += 3) {
        if (pos[i] < minY) minY = pos[i];
        if (pos[i] > maxY) maxY = pos[i];
      }
    }
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(matrix);
      this.pos.push(v.x, v.y, v.z);
      if (nrm) {
        v.set(nrm[i], nrm[i + 1], nrm[i + 2]).applyMatrix4(nm).normalize();
        this.nrm.push(v.x, v.y, v.z);
      } else this.nrm.push(0, 1, 0);
      let j = 1 + (tint ? (Math.random() * 2 - 1) * tint : 0);
      if (baseShade) {
        const t = maxY > minY ? (pos[i + 1] - minY) / (maxY - minY) : 1;
        j *= 1 - baseShade * (1 - t * t);
      }
      this.col.push(color[0] * j, color[1] * j, color[2] * j);
    }
    for (let i = 0; i < pos.length / 3; i++) this.idx.push(base + i);
    if (g !== geometry) g.dispose();
    return this;
  }

  // Raw triangle soup, for the hand-built hull.
  tri(a, b, c, color) {
    const n = normalOf(a, b, c);
    const base = this.pos.length / 3;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(color[0], color[1], color[2]);
    }
    this.idx.push(base, base + 1, base + 2);
    return this;
  }

  quad(a, b, c, d, color) { return this.tri(a, b, c, color).tri(a, c, d, color); }

  toGeometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(new BufferAttribute(new Uint32Array(this.idx), 1));
    return g;
  }
}

function normalOf(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

const M = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(rx, ry, rz)),
    new Vector3(sx, sy, sz),
  );

const rgb = (hex) => { const c = new Color(hex); return [c.r, c.g, c.b]; };

// Palette. Linear values via Color, so these are the sRGB hexes an artist would
// pick and the shader still gets light-linear numbers.
const PAINT = {
  hullWhite: rgb(0xf2ece0),
  hullBoot: rgb(0x2e5f6b),
  hullBelow: rgb(0x1d3d4a),
  woodWarm: rgb(0xa9743f),
  woodDark: rgb(0x6f4526),
  woodPale: rgb(0xc79a63),
  plank: rgb(0xb98a54),
  piling: rgb(0x966f45),
  pilingWet: rgb(0x3f4436),
  crateGreen: rgb(0x4f7a3e),
  crateRed: rgb(0xa8432f),
  metal: rgb(0x59616b),
  metalDark: rgb(0x2b3138),
  rope: rgb(0xd8c49a),
  ring: rgb(0xd94f3d),
  ringWhite: rgb(0xf4f1ea),
  buoy: rgb(0xe07a3a),
  // Reef paint is deliberately light. Anything under two metres of water loses
  // most of its red and a third of its brightness before it reaches the eye, so
  // a colour picked to look right on the swatch reads as a black stain in the
  // water; these are picked to look right after that loss, not before it.
  rock: rgb(0x8d8779),
  coral: rgb(0x6fae72),
  coralWarm: rgb(0xb08a52),
  coralPink: rgb(0xc27f7a),
  weed: rgb(0x82a350),
  scrub: rgb(0x4c7038),
  scrubDry: rgb(0x7d8a4a),
  lamp: rgb(0xffd08a),
};

// ------------------------------------------------------------------ the dock
export function buildDock(floorDepth) {
  const B = new Build();
  const x0 = -19.5, x1 = -10.0, z0 = -9.0, z1 = 5.5;
  const deck = 1.32;

  // Deck planks, laid across the pier with a gap between them.
  const plankW = 0.30;
  for (let z = z0; z < z1; z += plankW + 0.045) {
    const len = x1 - x0;
    B.add(new BoxGeometry(len, 0.09, plankW), M((x0 + x1) / 2, deck, z + plankW / 2), PAINT.plank, 0.09);
  }
  // Stringers under the deck.
  for (const x of [x0 + 0.7, x1 - 0.7]) {
    B.add(new BoxGeometry(0.22, 0.26, z1 - z0), M(x, deck - 0.18, (z0 + z1) / 2), PAINT.woodDark, 0.05);
  }

  // Pilings, planted on the floor wherever they land.
  const cyl = new CylinderGeometry(0.17, 0.20, 1, 10, 1);
  for (let z = z0 + 0.6; z < z1; z += 2.6) {
    for (const x of [x0 + 0.7, x1 - 0.7]) {
      const bed = terrainHeight(x, z, floorDepth) - 0.4;
      const h = deck - bed;
      B.add(cyl, M(x, bed + h / 2, z, 0, 0, 0, 1, h, 1), PAINT.piling, 0.07);
      // The dark, weathered collar where it has been in and out of the water.
      B.add(new CylinderGeometry(0.205, 0.215, 0.55, 10, 1), M(x, -0.12, z), PAINT.pilingWet, 0.05);
      // Cross brace.
      B.add(new BoxGeometry(x1 - x0 - 1.4, 0.13, 0.13), M((x0 + x1) / 2, -0.45, z), PAINT.woodDark, 0.05);
    }
  }

  // Bollards, a crate stack, two barrels and a lamp post: the dressing that
  // makes it read as a working dock rather than a platform.
  for (const z of [z0 + 1.2, z0 + 6.0, z1 - 1.0]) {
    B.add(new CylinderGeometry(0.13, 0.15, 0.52, 8), M(x1 - 0.45, deck + 0.26, z), PAINT.woodWarm, 0.06);
  }
  const crate = new BoxGeometry(0.62, 0.58, 0.62);
  B.add(crate, M(x0 + 1.6, deck + 0.33, z0 + 2.2, 0, 0.3), PAINT.crateGreen, 0.08);
  B.add(crate, M(x0 + 1.5, deck + 0.92, z0 + 2.3, 0, 0.1), PAINT.crateGreen, 0.08);
  B.add(crate, M(x0 + 2.3, deck + 0.33, z0 + 2.9, 0, -0.4), PAINT.woodWarm, 0.08);
  B.add(new CylinderGeometry(0.32, 0.30, 0.78, 12), M(x0 + 1.4, deck + 0.44, z0 + 5.4), PAINT.crateRed, 0.06);
  B.add(new CylinderGeometry(0.32, 0.30, 0.78, 12), M(x0 + 2.1, deck + 0.44, z0 + 5.9), PAINT.woodDark, 0.06);
  B.add(new CylinderGeometry(0.07, 0.07, 2.6, 8), M(x1 - 0.6, deck + 1.3, z0 + 3.4), PAINT.metalDark, 0.05);
  B.add(new BoxGeometry(0.34, 0.4, 0.34), M(x1 - 0.6, deck + 2.7, z0 + 3.4), PAINT.lamp, 0.03);

  const g = B.toGeometry();
  const mesh = new Mesh(g, null);
  mesh.name = 'dock';
  return mesh;
}

// -------------------------------------------------------------------- the boat
// A parametric clinker dinghy: stations along the keel, a U section at each,
// swept into a shell. Everything else - transom, sole, gunwale, motor - hangs
// off the same station table.
export function buildBoat() {
  const B = new Build();
  const L = 3.95, beam = 1.62, keel = 0.58;
  const STA = 22, RING = 12;

  const station = (t) => {
    const taper = 1 - 0.93 * Math.pow(t, 5.5);
    const halfW = (beam / 2) * Math.min(1, (0.60 + 0.55 * Math.sin(Math.PI * Math.pow(t, 0.75)))) * taper;
    const d = keel * (0.45 + 0.55 * Math.sin(Math.PI * Math.pow(t, 0.85)));
    const rise = 0.30 * Math.pow(t, 2.6);
    const sheer = 0.34 + 0.22 * Math.pow(t, 2.4) + 0.05 * Math.pow(1 - t, 2);
    return { halfW: Math.max(halfW, 0.05), d, rise, sheer, z: -L / 2 + t * L };
  };

  const pt = (s, u) => {
    const a = Math.pow(Math.abs(u), 1.65);
    return [u * s.halfW, s.rise + (-s.d) * (1 - a) + s.sheer * a, s.z];
  };

  const paintAt = (y) => (y < -0.20 ? PAINT.hullBelow : y < 0.02 ? PAINT.hullBoot : PAINT.hullWhite);

  for (let i = 0; i < STA; i++) {
    const s0 = station(i / STA), s1 = station((i + 1) / STA);
    for (let k = 0; k < RING; k++) {
      const u0 = -1 + (2 * k) / RING, u1 = -1 + (2 * (k + 1)) / RING;
      const a = pt(s0, u0), b = pt(s1, u0), c = pt(s1, u1), d = pt(s0, u1);
      B.quad(a, b, c, d, paintAt((a[1] + c[1]) / 2));
    }
  }

  // Transom: flat cap across the stern.
  const s0 = station(0);
  for (let k = 0; k < RING; k++) {
    const u0 = -1 + (2 * k) / RING, u1 = -1 + (2 * (k + 1)) / RING;
    const a = pt(s0, u0), b = pt(s0, u1);
    B.tri(a, [0, s0.sheer * 0.35 - s0.d * 0.3, s0.z], b, PAINT.hullWhite);
  }

  // Gunwale: a warm timber rim following the sheer line, which is the line the
  // eye actually reads the hull's shape from.
  for (let i = 0; i < STA; i++) {
    const a = station(i / STA), b = station((i + 1) / STA);
    for (const sgn of [-1, 1]) {
      const p0 = pt(a, sgn), p1 = pt(b, sgn);
      const o0 = [p0[0] * 1.06, p0[1], p0[2]], o1 = [p1[0] * 1.06, p1[1], p1[2]];
      const t0 = [p0[0] * 0.86, p0[1] + 0.075, p0[2]], t1 = [p1[0] * 0.86, p1[1] + 0.075, p1[2]];
      B.quad(o0, o1, t1, t0, PAINT.woodWarm);
      // Inner face of the rim, a shade darker so the rail reads as thickness.
      const i0 = [p0[0] * 0.80, p0[1] - 0.02, p0[2]], i1 = [p1[0] * 0.80, p1[1] - 0.02, p1[2]];
      B.quad(t0, t1, i1, i0, PAINT.woodDark);
    }
  }

  // Sole, thwarts, and the working clutter.
  for (let i = 0; i < 5; i++) {
    const z = -1.35 + i * 0.52;
    const s = station((z + L / 2) / L);
    B.add(new BoxGeometry(s.halfW * 1.55, 0.06, 0.46), M(0, -0.10 + s.rise, z), PAINT.woodPale, 0.07);
  }
  for (const z of [-0.95, 0.35]) {
    const s = station((z + L / 2) / L);
    B.add(new BoxGeometry(s.halfW * 1.95, 0.09, 0.30), M(0, s.sheer - 0.14 + s.rise, z), PAINT.woodWarm, 0.05);
  }

  // Outboard: block, cowling, shaft and skeg, hung off the transom.
  B.add(new BoxGeometry(0.42, 0.46, 0.36), M(0, 0.30, -L / 2 - 0.20), PAINT.metal, 0.05);
  B.add(new BoxGeometry(0.34, 0.14, 0.30), M(0, 0.58, -L / 2 - 0.20), PAINT.metalDark, 0.04);
  B.add(new BoxGeometry(0.12, 0.62, 0.14), M(0, -0.10, -L / 2 - 0.20), PAINT.metalDark, 0.04);
  B.add(new BoxGeometry(0.10, 0.20, 0.34), M(0, -0.42, -L / 2 - 0.24), PAINT.metalDark, 0.04);

  B.add(new BoxGeometry(0.44, 0.40, 0.44), M(0.30, 0.10, -1.05, 0, 0.4), PAINT.crateGreen, 0.08);
  B.add(new BoxGeometry(0.36, 0.34, 0.36), M(-0.32, 0.06, -0.55, 0, -0.2), PAINT.woodDark, 0.08);
  B.add(new TorusGeometry(0.22, 0.075, 8, 16), M(0.52, 0.28, -1.55, Math.PI / 2, 0, 0.2), PAINT.ring, 0.05);
  B.add(new CylinderGeometry(0.09, 0.10, 0.34, 8), M(-0.52, 0.34, -1.5), PAINT.lamp, 0.04);
  // A rod, because a boat this size in a cove is always fishing.
  B.add(new CylinderGeometry(0.012, 0.03, 2.9, 6), M(0.42, 0.95, 0.55, -0.55, 0, 0.30), PAINT.woodDark, 0.03);

  const mesh = new Mesh(B.toGeometry(), null);
  mesh.name = 'boat';
  return mesh;
}

// --------------------------------------------------------- reef, rocks, buoys
// Lumps, not spikes: the radius is modulated by a few smooth harmonics rather
// than per-vertex noise, so a coral head reads as something grown and rounded.
function displaced(geometry, amount, seed = 1) {
  const p = geometry.attributes.position;
  const a = 1.7 + (seed % 7) * 0.31, b = 2.3 + (seed % 5) * 0.44, c = 3.1 + (seed % 3) * 0.27;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const l = Math.hypot(x, y, z) || 1;
    const nx = x / l, ny = y / l, nz = z / l;
    const f = 1 + amount * (
      0.55 * Math.sin(nx * a + seed) * Math.cos(nz * b - seed * 0.7)
      + 0.30 * Math.sin(ny * c + nx * 2.1 + seed * 1.3)
      + 0.20 * Math.cos((nx + nz) * 4.2 + seed)
    );
    p.setXYZ(i, x * f, y * f, z * f);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function buildReef(floorDepth) {
  const B = new Build();
  let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };

  const reefPaint = [PAINT.coral, PAINT.coral, PAINT.coralWarm, PAINT.weed, PAINT.coralPink];
  for (const [mx, mz, mr, mh] of MOUNDS) {
    if (mr > 15) continue;                       // islets get their own treatment
    const heads = 5 + Math.floor(rnd() * 9);
    for (let i = 0; i < heads; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * mr * 0.85;
      const hx = mx + Math.cos(a) * r, hz = mz + Math.sin(a) * r;
      const coral = rnd() < 0.72;
      const c = coral ? reefPaint[Math.floor(rnd() * reefPaint.length)] : PAINT.rock;
      // A head is a clump of two to four lobes, not one ball. One ball at this
      // scale reads as a pebble; a clump reads as something growing.
      const lobes = coral ? 2 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
      for (let k = 0; k < lobes; k++) {
        const ox = (rnd() - 0.5) * 0.9, oz = (rnd() - 0.5) * 0.9;
        const x = hx + ox, z = hz + oz;
        const y = terrainHeight(x, z, floorDepth);
        if (y > -0.30 || y < -5.5) continue;
        const s = (0.22 + rnd() * 0.5) * (0.6 + mh * 0.35) * (k === 0 ? 1 : 0.75);
        const geo = displaced(new IcosahedronGeometry(s, 1), coral ? 0.42 : 0.28, 3 + i * 7 + k);
        B.add(geo, M(x, y + s * 0.38, z, 0, rnd() * 6.28, 0, 1, coral ? 0.55 + rnd() * 0.4 : 0.7, 1), c, 0.12, 0.45);
        geo.dispose();
      }
    }
  }

  // Islets: big displaced blocks sitting on the far mounds, plus a rubble skirt.
  for (const [mx, mz, mr, mh] of MOUNDS) {
    if (mr <= 15) continue;
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * mr * 0.55;
      const x = mx + Math.cos(a) * r, z = mz + Math.sin(a) * r;
      const y = terrainHeight(x, z, floorDepth);
      const s = 2.5 + rnd() * 5.5;
      const geo = displaced(new IcosahedronGeometry(s, 2), 0.34, 31 + i * 5);
      // An islet is rock at the waterline and scrub on top, and the shift
      // between them is what makes it read as land rather than as a big pebble.
      const c = y > 4.5 ? PAINT.scrub : y > 2.2 ? PAINT.scrubDry : y > 0.2 ? PAINT.rock : PAINT.coral;
      B.add(geo, M(x, y + s * 0.25, z, 0, rnd() * 6.28, 0, 1, 0.8, 1), c, 0.12, 0.35);
      geo.dispose();
      void mh;
    }
  }

  const mesh = new Mesh(B.toGeometry(), null);
  mesh.name = 'reef';
  return mesh;
}

export function buildBuoys(floorDepth) {
  const B = new Build();
  const spots = [[-6.5, 3.2], [4.5, -6.0], [-2.0, 8.5]];
  for (const [x, z] of spots) {
    B.add(new SphereGeometry(0.34, 12, 8), M(x, 0.06, z, 0, 0, 0, 1, 1.15, 1), PAINT.buoy, 0.05);
    B.add(new CylinderGeometry(0.05, 0.05, 0.5, 6), M(x, 0.5, z), PAINT.metalDark, 0.04);
    B.add(new SphereGeometry(0.09, 8, 6), M(x, 0.78, z), PAINT.ringWhite, 0.03);
    void terrainHeight(x, z, floorDepth);
  }
  const mesh = new Mesh(B.toGeometry(), null);
  mesh.name = 'buoys';
  return mesh;
}

// Everything that is pinned to the floor, in one group. Split from the boat
// because the floor can be rebuilt at runtime (the depth slider) and the boat,
// which floats, has no reason to be rebuilt with it.
export function buildStatics(floorDepth, material) {
  const group = new Group();
  for (const m of [buildDock(floorDepth), buildReef(floorDepth), buildBuoys(floorDepth)]) {
    m.material = material;
    group.add(m);
  }
  return group;
}
