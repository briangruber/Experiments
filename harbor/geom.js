// Procedural low-poly geometry.
//
// Every object in the harbour is built from these primitives - there is no
// asset pipeline and nothing to download. The look wants chunky flat-shaded
// facets and hand-picked paint colours, which is exactly what a builder like
// this gives you: each face carries its own normal, so silhouettes stay crisp
// and the toon shader has clean planes to band across.
//
// Conventions: boxes are centred on the origin, cylinders/cones stand on it.
// Colours are authored in sRGB (the numbers you'd pick in a paint program) and
// converted to linear here, once, at build time.

import { mat4, mul } from '../src/math.js';

// ---------------------------------------------------------------- colour
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const CACHE = new Map();
export function rgb(hex) {
  let v = CACHE.get(hex);
  if (v) return v;
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  v = [
    toLinear(((n >> 16) & 255) / 255),
    toLinear(((n >> 8) & 255) / 255),
    toLinear((n & 255) / 255),
  ];
  CACHE.set(hex, v);
  return v;
}

// Tints a colour towards white/black without leaving the palette - used for
// plank-to-plank variation so large wooden surfaces don't read as one slab.
export function shade(hex, k) {
  const c = rgb(hex);
  return k >= 0
    ? [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k]
    : [c[0] * (1 + k), c[1] * (1 + k), c[2] * (1 + k)];
}

// ---------------------------------------------------------------- builder
const FLOATS = 10; // pos3 nrm3 col3 emissive1

export class MeshBuilder {
  constructor() {
    this.data = [];
    this.m = mat4();
    this.stack = [];
    this.emissive = 0;
  }

  // -- transform stack
  save() { this.stack.push(this.m.slice()); return this; }
  restore() { this.m = this.stack.pop(); return this; }
  apply(t) { mul(this.m, t, this.m); return this; }

  translate(x, y, z) {
    const t = mat4(); t[12] = x; t[13] = y; t[14] = z;
    return this.apply(t);
  }
  scale(x, y = x, z = x) {
    const t = mat4(); t[0] = x; t[5] = y; t[10] = z;
    return this.apply(t);
  }
  rotY(a) {
    const c = Math.cos(a), s = Math.sin(a), t = mat4();
    t[0] = c; t[2] = -s; t[8] = s; t[10] = c;
    return this.apply(t);
  }
  rotX(a) {
    const c = Math.cos(a), s = Math.sin(a), t = mat4();
    t[5] = c; t[6] = s; t[9] = -s; t[10] = c;
    return this.apply(t);
  }
  rotZ(a) {
    const c = Math.cos(a), s = Math.sin(a), t = mat4();
    t[0] = c; t[1] = s; t[4] = -s; t[5] = c;
    return this.apply(t);
  }

  xf(p, o = [0, 0, 0]) {
    const m = this.m, [x, y, z] = p;
    o[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    o[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    o[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return o;
  }

  // -- faces (flat shaded: the normal comes from the transformed triangle)
  // Colours may be given as a palette hex string or as an already-linear
  // triple; hex lookups are cached, so authoring with names stays cheap.
  tri(a, b, c, col, emis = this.emissive) {
    if (typeof col === 'string') col = rgb(col);
    const A = this.xf(a), B = this.xf(b), C = this.xf(c);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return this;
    nx /= l; ny /= l; nz /= l;
    const d = this.data;
    for (const P of [A, B, C]) {
      d.push(P[0], P[1], P[2], nx, ny, nz, col[0], col[1], col[2], emis);
    }
    return this;
  }

  quad(a, b, c, d, col, emis = this.emissive) {
    this.tri(a, b, c, col, emis);
    this.tri(a, c, d, col, emis);
    return this;
  }

  // -- primitives
  // Centred box. `taper` scales the top face (roofs, chimneys, buoys).
  box(w, h, d, col, { taper = 1, emis = this.emissive, skipBottom = false } = {}) {
    const x = w / 2, y = h / 2, z = d / 2, tx = x * taper, tz = z * taper;
    const p = [
      [-x, -y, z], [x, -y, z], [x, -y, -z], [-x, -y, -z],
      [-tx, y, tz], [tx, y, tz], [tx, y, -tz], [-tx, y, -tz],
    ];
    this.quad(p[4], p[5], p[6], p[7], col, emis);              // top
    if (!skipBottom) this.quad(p[3], p[2], p[1], p[0], col, emis);
    this.quad(p[0], p[1], p[5], p[4], col, emis);              // +z
    this.quad(p[2], p[3], p[7], p[6], col, emis);              // -z
    this.quad(p[1], p[2], p[6], p[5], col, emis);              // +x
    this.quad(p[3], p[0], p[4], p[7], col, emis);              // -x
    return this;
  }

  // Gable roof / wedge. Ridge runs along z, apex offset lets it lean.
  wedge(w, h, d, col, { overhangY = 0, ridge = 0 } = {}) {
    const x = w / 2, z = d / 2;
    const a = [-x, overhangY, z], b = [x, overhangY, z];
    const c = [x, overhangY, -z], e = [-x, overhangY, -z];
    const r1 = [ridge, h, z], r2 = [ridge, h, -z];
    this.quad(a, r1, r2, e, col);   // -x slope
    this.quad(b, c, r2, r1, col);   // +x slope
    this.tri(a, b, r1, col);        // +z gable
    this.tri(c, e, r2, col);        // -z gable
    this.quad(e, c, b, a, col);     // underside
    return this;
  }

  // Stands on the origin, grows +y. r may be a number or [bottom, top].
  cyl(r, h, seg, col, { capTop = true, capBottom = false, emis = this.emissive, phase = 0 } = {}) {
    const r0 = Array.isArray(r) ? r[0] : r;
    const r1 = Array.isArray(r) ? r[1] : r;
    const P = (rad, i, y) => {
      const a = phase + (i / seg) * Math.PI * 2;
      return [Math.cos(a) * rad, y, Math.sin(a) * rad];
    };
    for (let i = 0; i < seg; i++) {
      const a0 = P(r0, i, 0), a1 = P(r0, i + 1, 0);
      const b0 = P(r1, i, h), b1 = P(r1, i + 1, h);
      if (r1 < 1e-5) this.tri(a0, a1, b0, col, emis);
      else if (r0 < 1e-5) this.tri(a0, b1, b0, col, emis);
      else this.quad(a0, a1, b1, b0, col, emis);
      if (capTop && r1 > 1e-5) this.tri([0, h, 0], b0, b1, col, emis);
      if (capBottom && r0 > 1e-5) this.tri([0, 0, 0], a1, a0, col, emis);
    }
    return this;
  }

  // Low-poly ball, flat shaded. Good for foliage blobs, floats, fish heads.
  ball(r, seg, rings, col, { squash = 1, emis = this.emissive } = {}) {
    const P = (i, j) => {
      const th = (j / rings) * Math.PI, ph = (i / seg) * Math.PI * 2;
      return [Math.sin(th) * Math.cos(ph) * r, Math.cos(th) * r * squash, Math.sin(th) * Math.sin(ph) * r];
    };
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
        if (j === 0) this.tri(a, c, d, col, emis);
        else if (j === rings - 1) this.tri(a, b, c, col, emis);
        else this.quad(a, b, c, d, col, emis);
      }
    }
    return this;
  }

  torus(R, r, segMajor, segMinor, col, { arc = Math.PI * 2 } = {}) {
    const P = (i, j) => {
      const u = (i / segMajor) * arc, v = (j / segMinor) * Math.PI * 2;
      const cr = R + Math.cos(v) * r;
      return [Math.cos(u) * cr, Math.sin(v) * r, Math.sin(u) * cr];
    };
    const closed = Math.abs(arc - Math.PI * 2) < 1e-6;
    const n = closed ? segMajor : segMajor;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < segMinor; j++) {
        this.quad(P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j), col);
      }
    }
    return this;
  }

  // Lofts cross-sections along z. The hull, the fish and the gulls are all
  // this function with different profiles. `closed` wraps the last point back
  // to the first (a tube); leave it off for an open shell like a boat, and use
  // `flip` for the inner skin of one.
  loft(sections, col, { capEnds = true, emis = this.emissive, closed = true, flip = false } = {}) {
    for (let s = 0; s < sections.length - 1; s++) {
      const A = sections[s], B = sections[s + 1];
      const n = A.pts.length;
      const last = closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const j = (i + 1) % n;
        const p = [
          [A.pts[i][0], A.pts[i][1], A.z], [A.pts[j][0], A.pts[j][1], A.z],
          [B.pts[j][0], B.pts[j][1], B.z], [B.pts[i][0], B.pts[i][1], B.z],
        ];
        if (flip) this.quad(p[3], p[2], p[1], p[0], col, emis);
        else this.quad(p[0], p[1], p[2], p[3], col, emis);
      }
    }
    if (!closed) capEnds = false;
    if (capEnds) {
      for (const [S, flip] of [[sections[0], true], [sections[sections.length - 1], false]]) {
        const n = S.pts.length;
        let cx = 0, cy = 0;
        for (const p of S.pts) { cx += p[0] / n; cy += p[1] / n; }
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const a = [S.pts[i][0], S.pts[i][1], S.z], b = [S.pts[j][0], S.pts[j][1], S.z];
          this.tri([cx, cy, S.z], flip ? b : a, flip ? a : b, col, emis);
        }
      }
    }
    return this;
  }

  // Heightfield patch (seabed, island caps). fn(x,z) -> [y, colour].
  field(w, d, nx, nz, fn) {
    const P = (i, j) => {
      const x = (i / nx - 0.5) * w, z = (j / nz - 0.5) * d;
      const [y, c] = fn(x, z);
      return { p: [x, y, z], c };
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d2 = P(i, j + 1);
        const col = a.c;
        this.tri(a.p, b.p, c.p, col);
        this.tri(a.p, c.p, d2.p, col);
      }
    }
    return this;
  }

  // A flat card standing in the xy plane - leaves, sails, fins, kelp blades.
  card(w, h, col, { emis = this.emissive, twoSided = true } = {}) {
    const x = w / 2;
    const a = [-x, 0, 0], b = [x, 0, 0], c = [x, h, 0], d = [-x, h, 0];
    this.quad(a, b, c, d, col, emis);
    if (twoSided) this.quad(d, c, b, a, col, emis);
    return this;
  }

  // Element-wise on purpose: these arrays run to millions of floats and a
  // spread would blow the argument stack.
  concat(other) {
    const d = this.data, s = other.data;
    for (let i = 0; i < s.length; i++) d.push(s[i]);
    return this;
  }

  get vertexCount() { return this.data.length / FLOATS; }

  build() { return new Float32Array(this.data); }
}

// ---------------------------------------------------------------- gpu mesh
export function uploadMesh(gl, data) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = FLOATS * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36);
  gl.bindVertexArray(null);
  return { vao, vbo, count: data.length / FLOATS };
}
