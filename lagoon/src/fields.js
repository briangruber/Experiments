// Shared shading fields: the uniform block every material reads from, the wave
// train (in both its GPU and CPU forms), the caustic pattern, the sky, and the
// boat's wake.
//
// The rule here is that a phenomenon is described once. The wave train is a
// table of five Gerstner components; the shader unrolls it and the buoyancy code
// walks the same table, so the boat cannot bob out of step with the surface it
// is sitting on.
//
// Note on smoothstep: every edge pair below is written ascending and inverted
// with .oneMinus() where a falloff is wanted. WGSL leaves smoothstep(hi, lo, x)
// undefined, and a shader that renders on one driver and not another is not
// worth the two characters saved.

import { Color, Vector2, Vector3, Vector4 } from 'three';
import {
  Fn, float, vec2, vec3, vec4, uniform, uniformArray, texture,
  sin, cos, exp, pow, max, min, abs, clamp, mix, smoothstep, dot, normalize,
  length, floor, sqrt, Loop, int, mx_noise_float, mx_fractal_noise_float,
} from 'three/tsl';
import { FIELD_EXTENT, depthAt } from './terrain.js';

export const WAKE_POINTS = 40;

// -------------------------------------------------------------------- uniforms
export const U = {
  time: uniform(0),
  sunDir: uniform(new Vector3(0.4, 0.7, 0.5)),
  sunColor: uniform(new Color(1, 0.93, 0.78)),
  skyColor: uniform(new Color(0.30, 0.55, 0.92)),

  shallow: uniform(new Color(0.16, 0.72, 0.70)),
  deep: uniform(new Color(0.015, 0.13, 0.30)),
  clarity: uniform(1.15),
  turbidity: uniform(0.45),
  refraction: uniform(1.0),

  waveHeight: uniform(0.115),
  waveLength: uniform(1.0),
  waveSpeed: uniform(1.0),
  chop: uniform(0.55),
  ripple: uniform(1.0),
  wind: uniform(new Vector2(-0.9, -0.42)),

  gloss: uniform(0.16),
  sparkle: uniform(1.0),
  reflectivity: uniform(1.0),

  shoreFoam: uniform(1.0),
  shoreFoamDepth: uniform(0.55),
  crestFoam: uniform(0.85),
  wakeFoam: uniform(1.0),

  caustics: uniform(1.15),
  causticScale: uniform(1.0),
  sandColor: uniform(new Color(0.86, 0.78, 0.58)),
  reefColor: uniform(new Color(0.22, 0.38, 0.22)),
  floorDepth: uniform(4.2),

  stylize: uniform(0.42),
  saturation: uniform(1.12),
  vignette: uniform(0.35),

  // Wake trail: (x, z, heading, life in [0,1]).
  wake: uniformArray(Array.from({ length: WAKE_POINTS }, () => new Vector4(0, 0, 0, 0))),
};

// The baked depth field. Materials are built after it exists, so a plain
// module-level handle is enough.
const depthMap = { tex: null };
export function setDepthMap(tex) { depthMap.tex = tex; }

// ------------------------------------------------------------------ wave train
// [heading offset (rad), wavelength (m), relative amplitude, steepness]
export const WAVES = [
  [0.00, 11.0, 1.00, 0.90],
  [0.48, 6.30, 0.62, 0.80],
  [-0.66, 4.10, 0.40, 0.68],
  [1.10, 2.55, 0.24, 0.55],
  [-1.24, 1.55, 0.14, 0.42],
];
const G = 9.81;

// Depth kills the swell as it runs into the shallows - the water goes glassy at
// the waterline, which is most of why the shore reads as shore.
const shoalCPU = (depth) => {
  const t = Math.max(0, Math.min(1, (depth - 0.04) / 1.15));
  return t * t * (3 - 2 * t);
};
const shoal = (depth) => smoothstep(0.04, 1.19, depth);

// Per-wave direction, built by rotating the wind vector by a fixed offset.
const waveDir = (ang) => vec2(
  U.wind.x.mul(Math.cos(ang)).sub(U.wind.y.mul(Math.sin(ang))),
  U.wind.x.mul(Math.sin(ang)).add(U.wind.y.mul(Math.cos(ang))),
).normalize();

// Water depth in metres at a world XZ, read from the baked field.
export const depthField = /*@__PURE__*/ Fn(([p]) => {
  const uvp = clamp(p.div(FIELD_EXTENT).add(0.5), vec2(0.001), vec2(0.999));
  return texture(depthMap.tex, uvp).r.negate();
});

// Gerstner sum. Returns the surface offset (x, y, z) for a point on the plane.
export const waveDisplace = /*@__PURE__*/ Fn(([p, depth]) => {
  const att = shoal(depth).mul(U.waveHeight);
  const t = U.time.mul(U.waveSpeed);
  const off = vec3(0).toVar();
  for (const [ang, len, rel, q] of WAVES) {
    const d = waveDir(ang);
    const k = float(Math.PI * 2).div(U.waveLength.mul(len));
    const w = sqrt(k.mul(G));
    const a = att.mul(rel);
    const ph = k.mul(dot(d, p)).sub(w.mul(t));
    const qa = a.mul(q).mul(U.chop);
    off.addAssign(vec3(d.x.mul(qa).mul(cos(ph)), a.mul(sin(ph)), d.y.mul(qa).mul(cos(ph))));
  }
  return off;
});

// Analytic normal of the same sum, plus a crest term (1 where the surface is
// pinched into a peak) that the foam and the specular both lean on.
export const waveNormal = /*@__PURE__*/ Fn(([p, depth]) => {
  const att = shoal(depth).mul(U.waveHeight);
  const t = U.time.mul(U.waveSpeed);
  const nx = float(0).toVar(), nz = float(0).toVar(), ny = float(1).toVar();
  for (const [ang, len, rel, q] of WAVES) {
    const d = waveDir(ang);
    const k = float(Math.PI * 2).div(U.waveLength.mul(len));
    const w = sqrt(k.mul(G));
    const a = att.mul(rel);
    const ph = k.mul(dot(d, p)).sub(w.mul(t));
    const wa = k.mul(a);
    nx.subAssign(d.x.mul(wa).mul(cos(ph)));
    nz.subAssign(d.y.mul(wa).mul(cos(ph)));
    ny.subAssign(wa.mul(q).mul(U.chop).mul(sin(ph)).mul(0.55));
  }
  const crest = smoothstep(0.02, 0.55, ny).oneMinus();
  return vec4(normalize(vec3(nx, max(ny, 0.08), nz)), crest);
});

// The CPU mirror of the two functions above: same table, same phases.
export function sampleWave(x, z, t, params) {
  const depth = Math.max(0, depthAt(x, z, params.floorDepth));
  const att = shoalCPU(depth) * params.waveHeight;
  const a0 = (params.windDir * Math.PI) / 180;
  const wx = -Math.sin(a0), wz = -Math.cos(a0);
  const wl = Math.hypot(wx, wz);
  let y = 0, nx = 0, nz = 0;
  const tt = t * params.waveSpeed;
  for (const [ang, len, rel] of WAVES) {
    const dx = (wx * Math.cos(ang) - wz * Math.sin(ang)) / wl;
    const dz = (wx * Math.sin(ang) + wz * Math.cos(ang)) / wl;
    const L = params.waveLength * len;
    const k = (Math.PI * 2) / L;
    const w = Math.sqrt(k * G);
    const a = att * rel;
    const ph = k * (dx * x + dz * z) - w * tt;
    y += a * Math.sin(ph);
    nx -= dx * k * a * Math.cos(ph);
    nz -= dz * k * a * Math.cos(ph);
  }
  return { y, nx, nz, depth };
}

// --------------------------------------------------------------------- caustics
// Caustics are the zero crossings of a wavefront, not the cells of a Worley
// pattern: what the eye recognises is a net of thin bright filaments that
// brighten hard where two of them cross. So each layer is a ridge - noise folded
// about zero and sharpened - and the layers are added *and* multiplied, the
// product being the crossings.
//
// The three channels are sampled at slightly different scales, which splits the
// filaments into faint colour fringes the way real caustics disperse. It is the
// cheapest half of the effect and the half people notice.
export const caustics = /*@__PURE__*/ Fn(([p, depth]) => {
  const t = U.time.mul(0.35);
  const q = p.mul(U.causticScale).mul(0.85);

  const ridge = (scale, ox, oz, timeDir, sharp, shift) => {
    const n = mx_noise_float(vec3(q.mul(scale).add(vec2(ox, oz)).add(shift), t.mul(timeDir)), 1.0, 0.0);
    return pow(clamp(abs(n).oneMinus(), 0, 1), sharp);
  };

  // Dispersion is a small *displacement* of the same pattern per channel, not a
  // different pattern per channel: change the scale instead and the fringes turn
  // into an oil slick.
  const net = (shift) => {
    const a = ridge(2.3, 0.0, 0.0, 1.0, 11.0, shift);
    const b = ridge(3.7, 5.3, 2.1, -0.8, 11.0, shift);
    return a.add(b).mul(0.3).add(a.mul(b).mul(3.4));
  };

  // Light that has travelled further through water is smeared out and dimmer,
  // and there is nothing to land on above the waterline.
  const fade = exp(depth.mul(-0.30)).mul(smoothstep(0.0, 0.30, depth));
  return vec3(net(0.0), net(0.05), net(0.11)).mul(fade).mul(U.caustics).mul(1.15);
});

// -------------------------------------------------------------------------- sky
// Cheap enough to evaluate per pixel inside the water's reflection, which is
// what it is mostly for; the dome uses the same function so the two agree.
export const skyColor = /*@__PURE__*/ Fn(([dir]) => {
  const d = normalize(dir);
  const up = clamp(d.y, -1, 1);
  const horizon = mix(U.skyColor, vec3(0.88, 0.93, 0.97), 0.55);
  const base = mix(horizon, U.skyColor, pow(clamp(up, 0, 1), 0.48)).toVar();

  // A warm bloom around the sun, and a hard little disc inside it.
  const sd = clamp(dot(d, U.sunDir), -1, 1);
  base.addAssign(U.sunColor.mul(pow(max(sd, 0), 7.0)).mul(0.35));
  base.addAssign(U.sunColor.mul(smoothstep(0.9994, 0.99975, sd)).mul(9.0));

  // Soft banked cloud, thickening towards the horizon.
  const q = d.xz.div(max(abs(d.y), 0.08)).mul(0.055);
  const c = mx_fractal_noise_float(vec3(q, U.time.mul(0.012)), 4, 2.0, 0.55, 1.0);
  const cloud = smoothstep(0.05, 0.42, c)
    .mul(smoothstep(0.02, 0.30, up))
    .mul(smoothstep(0.45, 0.95, up).oneMinus());
  base.assign(mix(base, mix(vec3(0.95, 0.96, 0.99), U.sunColor, 0.25).mul(1.15), cloud.mul(0.7)));

  // Below the horizon the reflection should see haze, not a hole.
  return mix(mix(horizon, vec3(0.72, 0.80, 0.84), 0.35), base, smoothstep(-0.08, 0.02, up));
});

// -------------------------------------------------------------------------- wake
// The trail is a ring buffer of recent hull positions. Each one contributes two
// foam arms that spread and fade with age, which is the Kelvin V without the
// cost of solving for it. The gradient is accumulated in the same loop so the
// surface normal can be bent by the wake as well as whitened by it.
export const wakeField = /*@__PURE__*/ Fn(([p]) => {
  const foam = float(0).toVar();
  const gx = float(0).toVar();
  const gz = float(0).toVar();

  Loop({ start: int(0), end: int(WAKE_POINTS), type: 'int' }, ({ i }) => {
    const e = U.wake.element(i);
    const life = e.w;
    const age = life.oneMinus();
    const c = vec2(e.x, e.y);
    const dir = vec2(cos(e.z), sin(e.z));
    const perp = vec2(dir.y.negate(), dir.x);
    const spread = float(0.45).add(age.mul(2.4));
    const width = float(0.26).add(age.mul(0.85));

    for (let s = -1; s <= 1; s += 2) {
      const cc = c.add(perp.mul(spread.mul(s))).sub(dir.mul(age.mul(0.6)));
      const dv = p.sub(cc);
      const r = length(dv).add(1e-4);
      const f = smoothstep(width.mul(0.15), width, r).oneMinus().mul(life).mul(life);
      foam.addAssign(f);
      const grad = f.div(r.add(0.25)).mul(0.4);
      gx.subAssign(dv.x.mul(grad));
      gz.subAssign(dv.y.mul(grad));
    }

    // The churned water directly behind the transom, which is only ever a
    // couple of hull widths long before it settles into the arms.
    const dd = length(p.sub(c.sub(dir.mul(0.35))));
    const churn = smoothstep(0.05, float(0.55).add(age.mul(0.5)), dd).oneMinus();
    foam.addAssign(churn.mul(pow(life, 3.0)).mul(0.7));
  });

  return vec4(clamp(foam, 0, 1.6), gx, gz, 0);
});

// ------------------------------------------------------------------- utilities
export const saturate3 = (c, amount) => mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, amount);

// Gentle posterisation towards a painted look: bands the value, then only walks
// part of the way there, so gradients stay readable.
export const band = (v, steps, amount) => mix(v, floor(v.mul(steps)).add(0.5).div(steps), amount);
