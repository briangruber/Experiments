// The wave runner itself: a procedurally lofted hull, so third person has
// something to chase. No mesh file - the whole page still loads no assets.

import { program, setUniforms, FS_VERT } from './gl.js';
import { mat4 } from './math.js';

// One closed cross-section in (half-width, height) units. Runs keel -> chine ->
// gunwale -> deck centre; the port side is mirrored from it.
const SECTION = [
  [0.00, -1.00],  // keel
  [0.42, -0.86],
  [0.76, -0.46],
  [0.98, -0.08],  // chine, where the planing surface breaks away
  [1.00, 0.22],   // gunwale
  [0.74, 0.52],
  [0.34, 0.70],
  [0.00, 0.76],   // deck centre
];

// Stations bow -> stern: z along the hull, then width / depth / deck scales.
const STATIONS = [
  [-1.00, 0.05, 0.10, 0.86],   // stem: narrow and raked well clear of the water
  [-0.88, 0.24, 0.34, 0.95],
  [-0.68, 0.55, 0.62, 1.00],
  [-0.34, 0.86, 0.82, 0.96],
  [0.04, 1.00, 0.92, 0.88],
  [0.42, 0.99, 0.90, 0.82],
  [0.76, 0.92, 0.80, 0.76],
  [1.00, 0.80, 0.66, 0.70],    // transom
];

function buildHull(len, beam, draft, deck) {
  const ring = [];
  for (let i = 0; i < SECTION.length; i++) ring.push([SECTION[i][0], SECTION[i][1]]);
  for (let i = SECTION.length - 2; i >= 1; i--) ring.push([-SECTION[i][0], SECTION[i][1]]);
  const R = ring.length;

  const pos = [], nrm = [], idx = [];
  for (const [z, w, d, h] of STATIONS) {
    for (const [u, v] of ring) {
      const y = v < 0 ? v * d * draft : v * h * deck;
      pos.push(u * w * beam * 0.5, y, z * len * 0.5);
    }
  }
  for (let s = 0; s < STATIONS.length - 1; s++) {
    for (let i = 0; i < R; i++) {
      const j = (i + 1) % R;
      const a = s * R + i, b = s * R + j, c = (s + 1) * R + i, d2 = (s + 1) * R + j;
      idx.push(a, c, b, b, c, d2);
    }
  }
  // Cap the transom so the stern is not an open tube.
  const base = pos.length / 3;
  const last = (STATIONS.length - 1) * R;
  const zc = STATIONS[STATIONS.length - 1][0] * len * 0.5;
  pos.push(0, 0, zc);
  for (let i = 0; i < R; i++) idx.push(base, last + i, last + ((i + 1) % R));

  // Area-weighted vertex normals: the cross product of the two triangle edges is
  // already proportional to twice the area, so summing them unnormalised gives
  // the smooth normal for free.
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const [i0, i1, i2] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
    const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const i of [i0, i1, i2]) { n[i] += cx; n[i + 1] += cy; n[i + 2] += cz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  nrm.push(...n);
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
}

// Axis-aligned box, used for the seat and the handlebar column.
function box(cx, cy, cz, sx, sy, sz, out) {
  const base = out.pos.length / 3;
  const F = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const faces = [[0, 1, 2, 3, 0, 0, -1], [5, 4, 7, 6, 0, 0, 1], [4, 0, 3, 7, -1, 0, 0],
                 [1, 5, 6, 2, 1, 0, 0], [3, 2, 6, 7, 0, 1, 0], [4, 5, 1, 0, 0, -1, 0]];
  for (const f of faces) {
    const start = out.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      const v = F[f[k]];
      out.pos.push(cx + v[0] * sx, cy + v[1] * sy, cz + v[2] * sz);
      out.nrm.push(f[4], f[5], f[6]);
    }
    out.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  return base;
}

const CRAFT_VS = /* glsl */`
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in float aPart;   // 0 hull, 1 seat, 2 bars
uniform mat4 uViewProj, uModel;
out vec3 vN, vW;
out float vPart;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz;
  vN = mat3(uModel) * aNrm;
  vPart = aPart;
  gl_Position = uViewProj * w;
}
`;

const CRAFT_FS = /* glsl */`
in vec3 vN, vW;
in float vPart;
uniform sampler2D uSkyLUT;
uniform vec3 uCamPos, uSunDir, uSunColor;
uniform vec3 uHullColor, uAccentColor, uSeatColor;
uniform float uGloss, uWetLine, uAtmoExp;
out vec4 fragColor;

vec2 dirToSkyUv(vec3 d){
  float az = atan(d.z, d.x) / 6.28318530718 + 0.5;
  float l = clamp(d.y, -1.0, 1.0);
  return vec2(az, 0.5 + 0.5*sign(l)*sqrt(abs(l)));
}

void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vW);
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = uSunDir;

  vec3 albedo = vPart > 1.5 ? vec3(0.045)
              : vPart > 0.5 ? uSeatColor
              : mix(uHullColor, uAccentColor, smoothstep(0.06, -0.06, vW.y - uWetLine));
  float rough = vPart > 0.5 ? 0.55 : mix(0.14, 0.42, 1.0 - uGloss);

  vec3 sky = textureLod(uSkyLUT, dirToSkyUv(reflect(-V, N)), rough*6.0).rgb;
  vec3 amb = textureLod(uSkyLUT, dirToSkyUv(vec3(0.0,1.0,0.0)), 5.0).rgb * 3.14159;

  float NoL = max(dot(N, L), 0.0);
  float NoV = max(dot(N, V), 1e-3);
  vec3 H = normalize(L + V);
  float a = rough*rough;
  float d = (dot(N,H)*a - dot(N,H))*dot(N,H) + 1.0;
  float D = a*a / max(3.14159*d*d, 1e-6);
  // Grazing Fresnel on a full sky reflection is what made the hull read as dark
  // glass with the sea showing through it. A gelcoat is a coated dielectric:
  // cap the rim term and keep the diffuse body dominant.
  float F = 0.04 + 0.36*pow(1.0 - NoV, 5.0);

  vec3 col = albedo * (uSunColor*NoL + amb*0.85) * (1.0/3.14159);
  col += uSunColor * D * F * NoL * 0.35;
  col += sky * F * 0.6;
  fragColor = vec4(col * uAtmoExp, 1.0);
}
`;

export class Craft {
  constructor(gl) {
    this.gl = gl;
    this.model = mat4();
    this.prog = program(gl, CRAFT_VS, CRAFT_FS, 'craft');

    const len = 3.15, beam = 1.02, draft = 0.38, deck = 0.34;
    const hull = buildHull(len, beam, draft, deck);
    const out = { pos: [...hull.pos], nrm: [...hull.nrm], idx: [...hull.idx] };
    const part = new Array(hull.pos.length / 3).fill(0);

    const seatStart = out.pos.length / 3;
    box(0, deck * 0.62, 0.42, beam * 0.24, 0.11, len * 0.20, out);
    while (part.length < out.pos.length / 3) part.push(1);

    // Handlebar column and crossbar, set forward on the deck.
    box(0, deck * 1.05, -0.62, 0.042, 0.22, 0.042, out);
    box(0, deck * 1.42, -0.64, beam * 0.30, 0.030, 0.030, out);
    while (part.length < out.pos.length / 3) part.push(2);

    this.count = out.idx.length;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = (data, loc, size) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    buf(new Float32Array(out.pos), 0, 3);
    buf(new Float32Array(out.nrm), 1, 3);
    buf(new Float32Array(part), 2, 1);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(out.idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  // Orthonormal basis straight into the matrix columns: local +X starboard,
  // +Y up, +Z aft, so the bow sits at -Z and world forward is -Z local.
  setTransform(pos, yaw, pitch, roll, scale) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const f = [cp * sy, sp, -cp * cy];
    let r = [cy, 0, sy];
    let u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
    u = [-u[0], -u[1], -u[2]];
    const r2 = r.map((v, i) => v * cr + u[i] * sr);
    const u2 = u.map((v, i) => v * cr - r[i] * sr);
    const m = this.model;
    m[0] = r2[0] * scale; m[1] = r2[1] * scale; m[2] = r2[2] * scale; m[3] = 0;
    m[4] = u2[0] * scale; m[5] = u2[1] * scale; m[6] = u2[2] * scale; m[7] = 0;
    m[8] = -f[0] * scale; m[9] = -f[1] * scale; m[10] = -f[2] * scale; m[11] = 0;
    m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
  }

  draw(p, ctx, skyLut) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    setUniforms(gl, this.prog, {
      uViewProj: ctx.viewProj, uModel: this.model,
      uSkyLUT: skyLut, uCamPos: ctx.camPos,
      uSunDir: ctx.sunDir, uSunColor: p.sunIrradiance,
      uHullColor: p.craftHullColor, uAccentColor: p.craftAccentColor,
      uSeatColor: p.craftSeatColor,
      uGloss: p.craftGloss, uWetLine: this.wetLine ?? 0, uAtmoExp: p.atmoExposure,
    });
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
  }
}
