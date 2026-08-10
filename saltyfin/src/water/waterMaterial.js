// The surface shader.
//
// A NodeMaterial with a hand-written `vertexNode` and `fragmentNode` — the same
// algorithm, the same constants and the same tuning as the GLSL original, built
// as TSL graphs instead of shader source. It does its own lighting and its own
// distance fade, so it needs neither of three's.
//
// What happens per pixel, in order:
//   normal      shared Gerstner train, each component weighted by its own
//               depth ramp so the sea gets rougher as it deepens, + three
//               drifting layers of a tiling gradient map + the boat's ripple
//               field, flattened with distance
//   refraction  screen-space, offset by the view-space normal, rejected when
//               the offset lands on something nearer than the surface
//   column      the seabed's world position reconstructed from the refraction
//               depth buffer -> a real water-column length for Beer-Lambert and
//               a real world XZ to project the caustics onto
//   reflection  the mirrored-camera target, U-flipped, blended by Schlick and
//               then by how deep the water is: a metre of water over sand
//               returns light from the bottom that a single-interface Fresnel
//               term knows nothing about, and without that the shallows mirror
//               the sky harder than the deeps do
//   light path  a specular lobe toward the key plus a world-anchored stochastic
//               glitter that twinkles as the wave passes under it
//   foam        shore (thin column), crest (Gerstner Jacobian), wake
//
// Every colour is env's. The only things this file chooses are how much of each.
//
// Two structural notes on the port:
//
//   * the old shader returned early for `!gl_FrontFacing`. Here both sides of
//     the surface are evaluated and `select`ed between at the very end, so every
//     texture read sits in uniform control flow — which WGSL requires and which
//     costs nothing, because the underwater branch reads no textures of its own.
//   * the wave table never changes at runtime, so `packWaves()` is evaluated
//     once at build time and the six waves are baked into the graph as
//     constants rather than carried in a uniform array. water/waves.js is still
//     the single definition of the train.

import * as THREE from 'three';
import {
  Fn, texture, uniform, vec2, vec3, vec4, float,
  max, min, clamp, mix, pow, dot, step, smoothstep, fract, floor,
  sin, cos, abs, exp, normalize, length, reflect, select, If,
  screenUV, frontFacing, cameraPosition, cameraViewMatrix, cameraProjectionMatrix,
  modelWorldMatrix, positionGeometry, varyingProperty,
} from 'three/tsl';
import { WAVE_COUNT, packWaves, WAVE_DEEP, WAVE_RAMP, WAVE_Q_REF } from './waves.js';
import { makeRng } from '../core/rng.js';

// ---------------------------------------------------------------------------
// A seamlessly tiling ripple field, built from a sum of integer-frequency
// sinusoids so it wraps exactly and so its gradient is analytic.
//   RG  gradient (dh/du, dh/dv), signed, packed to [0,1]
//   B   height
//   A   a second, uncorrelated field used to break up foam edges
// ---------------------------------------------------------------------------
function buildDetailTexture(size, seed) {
  const rng = makeRng(seed >>> 0);

  const band = (n, maxF, exponent) => {
    const fx = new Float32Array(n), fz = new Float32Array(n);
    const ph = new Float32Array(n), am = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = Math.round(rng.range(-maxF, maxF));
      let b = Math.round(rng.range(-maxF, maxF));
      if (a === 0 && b === 0) b = 1;
      fx[i] = a; fz[i] = b;
      ph[i] = rng.range(0, Math.PI * 2);
      am[i] = 1 / Math.pow(Math.hypot(a, b), exponent);
    }
    return { n, fx, fz, ph, am };
  };

  const main = band(22, 13, 1.30);
  const alt = band(10, 7, 1.10);

  const gx = new Float32Array(size * size);
  const gz = new Float32Array(size * size);
  const hh = new Float32Array(size * size);
  const nn = new Float32Array(size * size);

  const TAU = Math.PI * 2;
  let gMax = 1e-6, hMin = 1e9, hMax = -1e9, nMin = 1e9, nMax = -1e9;

  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      let dx = 0, dz = 0, h = 0;
      for (let k = 0; k < main.n; k++) {
        const p = TAU * (main.fx[k] * u + main.fz[k] * v) + main.ph[k];
        const a = main.am[k];
        h += Math.sin(p) * a;
        const c = Math.cos(p) * a * TAU;
        dx += c * main.fx[k];
        dz += c * main.fz[k];
      }
      let s = 0;
      for (let k = 0; k < alt.n; k++) {
        s += Math.sin(TAU * (alt.fx[k] * u + alt.fz[k] * v) + alt.ph[k]) * alt.am[k];
      }
      const idx = j * size + i;
      gx[idx] = dx; gz[idx] = dz; hh[idx] = h; nn[idx] = s;
      const m = Math.max(Math.abs(dx), Math.abs(dz));
      if (m > gMax) gMax = m;
      if (h < hMin) hMin = h; if (h > hMax) hMax = h;
      if (s < nMin) nMin = s; if (s > nMax) nMax = s;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const gs = 0.5 / gMax;
  const hs = 1 / Math.max(1e-6, hMax - hMin);
  const ns = 1 / Math.max(1e-6, nMax - nMin);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.max(0, Math.min(255, Math.round((0.5 + gx[i] * gs) * 255)));
    data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((0.5 + gz[i] * gs) * 255)));
    data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round((hh[i] - hMin) * hs * 255)));
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round((nn[i] - nMin) * ns * 255)));
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// The shared GLSL chunks this shader used, as node graphs. Same constants.
// ---------------------------------------------------------------------------

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** core/glsl.js `sat` — clamp to the unit range. */
const sat = (x) => clamp(x, 0, 1);

const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

const hash22 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

/** Voronoi returning (distance to nearest, distance to second, cell id). */
const worley = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const d1 = float(8.0).toVar();
  const d2 = float(8.0).toVar();
  const id = float(0.0).toVar();
  // The 3x3 neighbourhood is unrolled here rather than looped: the graph is
  // built in JS, so a fixed count costs nothing to spell out.
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const g = vec2(x, y);
      const o = hash22(i.add(g));
      const d = length(g.add(o).sub(f)).toVar();
      If(d.lessThan(d1), () => {
        d2.assign(d1); d1.assign(d); id.assign(hash12(i.add(g)));
      }).ElseIf(d.lessThan(d2), () => {
        d2.assign(d);
      });
    }
  }
  return vec3(d1, d2, id);
});

const fresnelSchlick = Fn(([cosT, f0]) => {
  const m = clamp(cosT.oneMinus(), 0, 1).toVar();
  const m2 = m.mul(m).toVar();
  return f0.add(f0.oneMinus().mul(m2).mul(m2).mul(m));
});

// mat2(0.8253, -0.5647, 0.5647, 0.8253), column major as GLSL reads it.
const CAUSTIC_ROT = [0.8253, -0.5647, 0.5647, 0.8253];
const causticRot = (v) => vec2(
  v.x.mul(CAUSTIC_ROT[0]).add(v.y.mul(CAUSTIC_ROT[2])),
  v.x.mul(CAUSTIC_ROT[1]).add(v.y.mul(CAUSTIC_ROT[3])),
);

// The six waves, resolved once. dir is already unit; k, amplitude, steepness and
// omega are exactly what the GLSL read out of uWaveA/uWaveB.
const packed = packWaves(1, 1);
const WAVES = [];
for (let i = 0; i < WAVE_COUNT; i++) {
  WAVES.push({
    dx: packed.a[i * 4 + 0], dz: packed.a[i * 4 + 1],
    k: packed.a[i * 4 + 2], amp: packed.a[i * 4 + 3],
    steep: packed.b[i * 4 + 0], omega: packed.b[i * 4 + 1],
    // Each wave's own L/20 and L/2 — the depths at which it is fully
    // shallow-water and at which it stops feeling the bottom. Literals in the
    // graph because they come from the same baked table k and omega do.
    rampLo: WAVE_RAMP[i][0], rampHi: WAVE_RAMP[i][1],
    // How much taller this component is in deep water. The DEFAULT only; the
    // live value is a uniform component so the whole spectrum can be swept.
    deep: WAVE_DEEP[i],
  });
}

/** k * dot(d, p) - omega * t, for one wave. */
const wavePhase = (w, p, t) => float(w.k).mul(p.x.mul(w.dx).add(p.y.mul(w.dz))).sub(t.mul(w.omega));

/** 1x1 stand-ins so every texture node is valid before setTargets runs. */
function blankTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * The surface material. `depthTexture` is the coarse seabed map built by
 * surface.js; everything else arrives later through setTargets/applyEnv.
 */
export function createWaterMaterial({
  renderer, seed = 1, quality = null,
  depthTexture = null, depthExtent = 1120, depthMax = 64,
  wakeSize = 256, wakeWorld = 128, detailSize = 256,
} = {}) {
  // Same predicate surface.js uses to size the wake sim — a geometry budget, not
  // a tier name, so an unlisted tier cannot fall through into the rich branch.
  const lean = (quality?.geometry ?? 1) < 0.6;
  const detail = buildDetailTexture(detailSize, seed ^ 0x5f3a91);
  // The node renderer answers getMaxAnisotropy() itself; the classic
  // `renderer.capabilities` object does not exist on it.
  const maxAniso = renderer?.getMaxAnisotropy?.()
    ?? (renderer?.capabilities?.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
  detail.anisotropy = Math.min(8, maxAniso || 1);

  const placeholders = [];
  const blank = () => { const t = blankTexture(); placeholders.push(t); return t; };
  const blankDepth = () => {
    const t = new THREE.DepthTexture(1, 1, THREE.FloatType);
    t.needsUpdate = true;
    placeholders.push(t);
    return t;
  };

  // --- uniforms ------------------------------------------------------------
  // Same names, same defaults as the WebGL build. Each is a TSL uniform node,
  // so `uniforms.uFoo.value` still reads and writes exactly as it did.
  const uTime = uniform(0);
  const uWind = uniform(1);

  const tRefraction = texture(blank());
  const tRefractionDepth = texture(blankDepth());
  const tReflection = texture(blank());
  const tCaustic = texture(blank());
  const tDetail = texture(detail);
  const tWake = texture(blank());
  const tDepthMap = texture(depthTexture ?? blank());

  const uDepthOrigin = uniform(new THREE.Vector2(0, 0));
  const uDepthInvExtent = uniform(1 / depthExtent);
  const uDepthMax = uniform(depthMax);

  const uResolution = uniform(new THREE.Vector2(1280, 720));
  const uNear = uniform(0.35);
  const uFar = uniform(6000);

  // Extinction per metre, per channel. Red goes first, which is what makes
  // clear water turquoise rather than grey. Lowered from (0.33, 0.07, 0.042):
  // that was a defensible number for real seawater and it put the sand out of
  // reach by about four metres, which is most of the lagoon. The whole promise
  // of this bay is that you can see the bottom of it.
  const uAbsorb = uniform(new THREE.Vector3(0.255, 0.054, 0.033));
  const uScatter = uniform(new THREE.Color(0x22acbc));
  const uShallow = uniform(new THREE.Color(0x63e2d4));
  const uMid = uniform(new THREE.Color(0x23bec6));
  const uDeep = uniform(new THREE.Color(0x0a4ea4));

  const uFogColor = uniform(new THREE.Color(0xaadaf2));
  const uFogNear = uniform(260);
  const uFogFar = uniform(2000);
  const uSkyZenith = uniform(new THREE.Color(0x1361d2));
  const uSkyHorizon = uniform(new THREE.Color(0xc6e7f8));
  const uHorizonGlow = uniform(0.48);

  const uKeyDir = uniform(new THREE.Vector3(0.4, 0.8, -0.45));
  const uKeyColor = uniform(new THREE.Color(0xfff6e2));
  const uKeyIntensity = uniform(3.7);
  const uAmbient = uniform(new THREE.Color(0xa2cef2));
  const uAmbIntensity = uniform(1);
  const uDayFactor = uniform(1);

  const uSpecular = uniform(1);
  const uRoughness = uniform(0.06);
  const uGlitter = uniform(0.85);
  const uGlitterSize = uniform(1);
  const uGlitterColor = uniform(new THREE.Color(0xfffcf0));
  const uReflStrength = uniform(0.92);
  const uReflEnabled = uniform(quality && quality.reflections === false ? 0 : 1);
  const uCaustic = uniform(1);
  const uCausticScale = uniform(1 / 8.5);
  const uFoamTint = uniform(new THREE.Color(0xffffff));
  const uFoamBright = uniform(1);

  const uWakeCenter = uniform(new THREE.Vector2());
  const uWakeWorld = uniform(wakeWorld);
  const uWakeTexel = uniform(1 / wakeSize);
  // Central differences of the wake field are raw texel-to-texel deltas, and a
  // texel is 0.5 m at high/med and 1.0 m at low/mobile (surface.js:153). Divide
  // by the span so every gain below is "per metre" and reads the same on a
  // phone as on a desktop; without it the low tier got twice the slope and twice
  // the foam-rim gain for free.
  const uWakeGrad = uniform(1 / (2 * (wakeWorld / wakeSize)));
  // 5.5 and 1.6 on the RAW delta was a 79 degree surface tilt at the worst
  // measured point, with 20% of the wake footprint past 45 degrees — for scale
  // the whole six-wave Gerstner train contributes 0.14 of tangent and the three
  // detail layers at most 0.38. That is where the mirrored tan/blue plates and
  // the onion-ring contours around the boat came from: the reflection and
  // refraction lookups were being thrown a fifth of the screen sideways. These
  // land the wake's peak added slope near 1.0, still ~2.5x the detail layers.
  // The ripple channel's tilt, and the ceiling it saturates against. Scaling
  // this down was how the mirrored tan/blue plates behind the boat were killed,
  // but the R channel is also where water.disturb() writes — a breaching
  // leviathan, a jumping fish, the quest's churned patch — so a flat 16x cut
  // silenced all of those to fix an artefact only the boat produced. A soft
  // limit does both jobs: a distant low-amplitude ring keeps the full gain, and
  // the boat's own near-field, which is an order of magnitude steeper, folds
  // over into the ceiling instead of turning the surface into onion rings.
  const uWakeSlope = uniform(2.4);
  const uWakeSlopeMax = uniform(0.16);
  const uWakeArmSlope = uniform(0.12);
  // Gains on the two foam LOCATORS below — |grad B| for the trail rims and the
  // compressed A for the Kelvin arms. Not the same quantities the old 1.25/0.32
  // multiplied, so the numbers are not comparable to the ones they replace.
  const uWakeFoam = uniform(1.05);
  const uWakeArmFoam = uniform(0.44);
  // Erosion depth, coarse threshold wander, and the threshold itself. Coverage
  // is the thing to retune here, never brightness: the paintings have no grey
  // foam anywhere, only fewer and shorter white strokes.
  // Reinhard knees. Smaller = the foam holds its brightness further astern.
  const uWakeSoft = uniform(1.80);
  const uWakeArmSoft = uniform(0.85);
  // How much of the foam's alpha the churn texture is allowed to take away. At
  // 1.0 the noise reaches zero and the trail breaks into filaments again, which
  // is the thing this is not.
  const uWakeMottle = uniform(0.88);
  // The breaking crest along the arm's outer edge, and how fine the churn is.
  const uWakeRim = uniform(0.80);
  const uWakeHalo = uniform(0.42);
  // 1.60 put the churn's features at about 60 cm, which is under a pixel of
  // variation by the time the trail is 25 m from the eye — the distance the
  // chase camera actually sits at. Coarser reads as brushwork; finer reads as
  // noise, and then as nothing.
  const uWakeChurnScale = uniform(0.70);
  // How opaque the wake foam is allowed to get. foamCol lands near 2.25 in
  // linear at the day preset, so a fully opaque strand reads as 96% sRGB after
  // the tonemap and feeds the bloom; measured on ref/01 the foam's p99 is 75%
  // and its p99.9 is 85%, and solving mix(water, target, a) per channel against
  // the painting gives alpha 0.35 at the strand edges and 0.72-0.96 at the very
  // hottest cores — the water colour reads through everywhere. This caps the
  // wake alone rather than trimming foamCol, which shore and crest foam share
  // and which is tuned where it is for them.
  const uWakeBright = uniform(0.62);
  // Master switch on the wake's VISIBLE foam, and the only thing that turns it
  // off. Everything above stays wired: the ripple channel that bends the normal
  // is a separate term (uWakeSlope, forty lines up) and water.disturb() writes
  // into it, so a breaching leviathan, a jumping fish and the quest's churned
  // patch all still dent the surface with the foam at zero. Off by default —
  // four rebuilds in and the trail still read as a decal rather than as water,
  // and no wake is better than a bad one — but it is a uniform rather than a
  // deletion so the ocean panel can bring it back without a rebuild.
  const uWakeVisible = uniform(0);

  // 1 when the eye is under the surface. Two things in this shader have to know
  // — see the gloom and the horizon below — and neither can work it out for
  // itself: `frontFacing` tells you which side of a TRIANGLE you are on, and on
  // a wave field a long way off you are looking at the tops of the far faces
  // even though your head is underwater. surface.js writes it from
  // ctx.cameraUnderwater, so it ramps with the same curve post.js uses.
  const uSubmerged = uniform(0);

  // --- how much sky the shallows are allowed to mirror ---------------------
  // The single-interface Fresnel term above assumes nothing comes back from
  // below the surface. Over two metres of water on bright sand that is simply
  // false: light that reflects off the UNDERSIDE of the surface bounces off the
  // seabed and comes back up, and that bottom-coupled term is missing from this
  // shader entirely. It scales with the round trip exp(-2*absorb*d) — with the
  // day preset's green absorption of 0.07 that is 0.87 / 0.66 / 0.43 / 0.25 /
  // 0.14 at 1 / 3 / 6 / 10 / 14 m, which a smoothstep over 0.8-9.0 m tracks to
  // within about 0.1 without an exp per pixel. So this is an approximation of a
  // real missing term, not a fudge.
  //
  // Measured before it existed: F is IDENTICAL over 1.4 m and over 36 m of
  // water at matched grazing angles (0.636 / 0.437 / 0.288 at 4.2 / 8.0 / 11.8
  // degrees in both), and because the shallow flats are the FAR half of a chase
  // frame while the deep water is under the bow, the shallowest water in a
  // frame was carrying thirteen times the reflection of the deepest. That is
  // the player's "I can't see into the shallow water" stated as a number.
  //
  // 0.8 m at the near end: uShoreFoamDepth is 0.72 and the waterline spike is
  // dead by 0.35 m, so the floor sits just outside the foam band. 9.0 m at the
  // far end: the reef flats are 2.6 m at the origin and 5.6-7.8 m at r=200
  // while the shelf edge is already 12.6-18.7 m by r=250, so 9 puts the whole
  // reef inside the ramp and the shelf outside it — and it lines up with the
  // caustic fade (1.5-13.0) and the body-colour ramp (2.4-14.0), so "shallow"
  // ends at one depth in colour, caustics and reflection instead of three.
  // 0.22 is off ref/01: sky fraction -0.08..+0.14 in the shallow foreground
  // against 0.29 in the deep midground, i.e. the shallows carry about a fifth
  // of the deep water's sky. Usable band 0.15-0.30.
  const uReflBedMin = uniform(0.22);
  const uReflBedNear = uniform(0.8);
  const uReflBedFar = uniform(9.0);

  // --- rougher as it deepens ------------------------------------------------
  // Master gain on the per-wave depth ramp defined in waves.js. 0 reproduces
  // the flat train exactly, 1 is the shipped curve; it is a uniform so the
  // whole spectrum can be A/B'd from one page load. The per-wave deep-water
  // multipliers ride in two vec3s for the same reason — the six numbers are the
  // shape of the sea and wanting to try another set must not cost a pipeline.
  const uSwellGain = uniform(1);
  const uSwellDeepA = uniform(new THREE.Vector3(WAVE_DEEP[0], WAVE_DEEP[1], WAVE_DEEP[2]));
  const uSwellDeepB = uniform(new THREE.Vector3(WAVE_DEEP[3], WAVE_DEEP[4], WAVE_DEEP[5]));
  // Partial normalisation of the Gerstner Jacobian by the local steepness
  // budget, exponent p in (Qref/Q)^p, clamped so it can only ever REDUCE foam.
  // Crest foam is effectively absent today — the true minimum of vJac on the
  // shipped train is 0.9368 against a 0.905-0.975 threshold, so the comment
  // claiming "about 0.87" was wrong by a factor of two in (1-jac) — and the
  // depth ramp brings the deep-water train to exactly the 0.87 the threshold
  // assumes, about 10% coverage offshore. Photographed at (0,-380) in 34 m of
  // water, wide camera: p=0 is a broad milky wash over half the frame (mean
  // luma 156 against 131 for the water it replaces); p=0.20 is still a haze;
  // p=0.28 gives a handful of thin white dashes lying along the near crests,
  // which is what ref/04 and ref/05 show; p=0.35 is clean blue with no foam
  // visible at all. 0.35 shipped as the cautious default — a cosy sea that
  // reads as milk being the worse regression — and it turned out to be too
  // cautious: it is the value with NO whitecaps anywhere, so the open sea read
  // as a flat sheet and the only white in the frame was the boat's own wake.
  // 0.28 is the measured point where thin white dashes lie along the near
  // crests and nowhere else, which is what ref/04 and ref/05 actually show, and
  // it only fires where the depth ramp has let the swell grow — so the lagoon
  // stays glassy and the offshore water breaks.
  const uCrestNorm = uniform(0.26);

  // --- the ceiling, from below ---------------------------------------------
  // How far the surface slope swings the refracted sky inside Snell's window,
  // how bright the caustic web on the underside gets, and the ring at the
  // critical angle. All three only ever run when uSubmerged is up.
  const uWinDistort = uniform(0.55);
  const uUnderWeb = uniform(0.85);
  const uWinRim = uniform(0.30);

  // 0.22 was tuned when the finest octave was 3.5 m across, where more of it
  // just made the big soft shapes bigger and softer. With a 0.9 m octave in the
  // sum there is something worth turning up.
  const uDetailStrength = uniform(0.44);
  const uFineChop = uniform(0.95);
  const uRefractDistort = uniform(0.26);
  const uReflDistort = uniform(0.12);
  const uScatterStrength = uniform(0.85);
  const uShoreFoamDepth = uniform(0.72);
  // Ambient surface foam: how much, how fine, and where its threshold sits.
  // 0.74 leaves only the top of the octave above the line. The first pass sat
  // at 0.62 with three times the gain and painted the whole sea — open water is
  // mostly water, and this layer is a suggestion of old foam, not a covering.
  const uAmbFoam = uniform(0.13);
  // A 3 m tile, stretched to about 1.2 m across a streak by 4.5 m along it.
  // At 0.028 the features were FIFTY metres long, which is not foam at any
  // scale — real streaks are a few metres of filament.
  const uAmbFoamScale = uniform(0.22);
  const uAmbFoamThresh = uniform(0.87);
  // How hard the wave's own steepness pulls foam onto its face.
  const uAmbFoamSteep = uniform(0.9);

  const uniforms = {
    uTime, uWind,
    tRefraction, tRefractionDepth, tReflection, tCaustic, tDetail, tWake, tDepthMap,
    uDepthOrigin, uDepthInvExtent, uDepthMax,
    uResolution, uNear, uFar,
    uAbsorb, uScatter, uShallow, uMid, uDeep,
    uFogColor, uFogNear, uFogFar, uSkyZenith, uSkyHorizon, uHorizonGlow,
    uKeyDir, uKeyColor, uKeyIntensity, uAmbient, uAmbIntensity, uDayFactor,
    uSpecular, uRoughness, uGlitter, uGlitterSize, uGlitterColor,
    uReflStrength, uReflEnabled, uCaustic, uCausticScale, uFoamTint, uFoamBright,
    uWakeCenter, uWakeWorld, uWakeTexel, uWakeGrad, uWakeSlope, uWakeSlopeMax, uWakeArmSlope,
    uWakeFoam, uWakeArmFoam, uWakeSoft, uWakeArmSoft, uWakeMottle, uWakeBright,
    uWakeRim, uWakeChurnScale, uWakeHalo, uWakeVisible, uSubmerged,
    uDetailStrength, uFineChop, uRefractDistort, uReflDistort, uScatterStrength, uShoreFoamDepth,
    uAmbFoam, uAmbFoamScale, uAmbFoamThresh, uAmbFoamSteep,
    uReflBedMin, uReflBedNear, uReflBedFar,
    uSwellGain, uSwellDeepA, uSwellDeepB, uCrestNorm,
    uWinDistort, uUnderWeb, uWinRim,
  };

  // --- what the vertex stage hands the fragment stage ----------------------
  const vWorld = varyingProperty('vec3', 'vWaterWorld');
  const vFlat = varyingProperty('vec2', 'vWaterFlat');
  // The six per-wave amplitude weights, `shore` already folded in. This
  // replaces the old scalar vShore varying: the depth ramp needs a different
  // multiplier per component, and interpolating the WEIGHTS rather than the
  // depth is what keeps the fragment stage's shading normal consistent with the
  // geometry the vertex stage actually displaced — the precedent vShore set.
  const vWeightA = varyingProperty('vec3', 'vWaterWeightA');
  const vWeightB = varyingProperty('vec3', 'vWaterWeightB');
  const vBedDepth = varyingProperty('float', 'vWaterBedDepth');
  const vJac = varyingProperty('float', 'vWaterJac');
  const vCrest = varyingProperty('float', 'vWaterCrest');
  const vDist = varyingProperty('float', 'vWaterDist');

  // Window depth -> positive metres along the camera's forward axis.
  const linearDepth = Fn(([d]) => {
    const ndc = d.mul(2.0).sub(1.0);
    return float(2.0).mul(uNear).mul(uFar).div(uFar.add(uNear).sub(ndc.mul(uFar.sub(uNear))));
  });

  const skyAt = Fn(([dir]) => {
    const h = sat(dir.y).toVar();
    const c = mix(uSkyHorizon, uSkyZenith, pow(h, 0.42)).toVar();
    const fd = normalize(vec2(dir.x, dir.z).add(1e-5)).toVar();
    const kd = normalize(vec2(uKeyDir.x, uKeyDir.z).add(1e-5)).toVar();
    const g = pow(sat(dot(fd, kd)), 5.0).mul(h.oneMinus()).toVar();
    return c.add(uSkyHorizon.mul(g).mul(uHorizonGlow).mul(0.45));
  });

  // --- vertex --------------------------------------------------------------
  const vertexNode = Fn(() => {
    const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1.0)).xyz;
    const p = wp.xz.toVar();
    vFlat.assign(p);

    // Water depth from the coarse seabed map: waves flatten as they run up the
    // reef instead of clipping through it, and the CPU sampler uses the same
    // field so the hull floats on the crest you can see.
    const duv = p.sub(uDepthOrigin).mul(uDepthInvExtent).add(0.5).toVar();
    const depth = tDepthMap.sample(clamp(duv, vec2(0.0), vec2(1.0))).r.toVar();
    depth.assign(depth.mul(depth).mul(uDepthMax));
    const outside = step(vec2(1.0), abs(duv.sub(0.5)).mul(2.0)).toVar();
    depth.assign(mix(depth, uDepthMax, max(outside.x, outside.y)));
    const shore = float(0.10).add(smoothstep(0.20, 3.0, depth).mul(0.90)).toVar();
    vBedDepth.assign(depth);

    // Per-wave depth ramp. Each component ramps between its own L/20 and L/2 —
    // the depths at which it is fully shallow-water and at which it stops
    // feeling the bottom — so the long swell, which is what the shelf kills,
    // is what comes back offshore. waves.js:waveWeights() computes exactly this
    // for the CPU: same table, same smoothstep, same order.
    const deepMul = [uSwellDeepA.x, uSwellDeepA.y, uSwellDeepA.z,
      uSwellDeepB.x, uSwellDeepB.y, uSwellDeepB.z];
    const wgt = [];
    for (let i = 0; i < WAVES.length; i++) {
      const w = WAVES[i];
      const ramp = smoothstep(float(w.rampLo), float(w.rampHi), depth).toVar();
      wgt.push(shore.mul(float(1.0).add(deepMul[i].sub(1.0).mul(ramp).mul(uSwellGain))).toVar());
    }
    vWeightA.assign(vec3(wgt[0], wgt[1], wgt[2]));
    vWeightB.assign(vec3(wgt[3], wgt[4], wgt[5]));

    // Horizontal pinch plus vertical displacement — the crest sharpening that
    // makes a swell read as water rather than as a sine sheet. Alongside it, the
    // Jacobian of that pinch: where it collapses the crest is being squeezed to
    // a point, and that is where a real wave throws foam.
    let accX = float(0.0), accY = float(0.0), accZ = float(0.0);
    let jxx = float(1.0), jzz = float(1.0), jxz = float(0.0);
    // The local steepness budget sum(a*steep*k), for the crest-foam
    // normalisation below. Accumulated here because every term is already in a
    // register; recomputing it in the fragment stage would cost six more sines.
    let qAcc = float(0.0);
    for (let i = 0; i < WAVES.length; i++) {
      const w = WAVES[i];
      const a = float(w.amp).mul(uWind).mul(wgt[i]).toVar();
      qAcc = qAcc.add(a.mul(w.steep * w.k));
      const phase = wavePhase(w, p, uTime);
      const s = sin(phase).toVar();
      const c = cos(phase).toVar();
      accY = accY.add(a.mul(s));
      const pinch = a.mul(w.steep).mul(c).toVar();
      accX = accX.add(pinch.mul(w.dx));
      accZ = accZ.add(pinch.mul(w.dz));
      const q = a.mul(w.steep * w.k).mul(s).toVar();
      jxx = jxx.sub(q.mul(w.dx * w.dx));
      jzz = jzz.sub(q.mul(w.dz * w.dz));
      jxz = jxz.sub(q.mul(w.dx * w.dz));
    }
    const gx = accX.toVar(), gy = accY.toVar(), gz = accZ.toVar();
    const jx = jxx.toVar(), jz = jzz.toVar(), jc = jxz.toVar();

    const world = vec3(p.x.add(gx), gy, p.y.add(gz)).toVar();
    vCrest.assign(gy);
    // The Jacobian, partially normalised by how much steeper this water is than
    // the water the foam threshold downstream was tuned against. The ratio is
    // clamped to 1 so this can only ever REMOVE foam: inshore the shore damp
    // drives Q toward zero, and an unclamped ratio would paint the flats white.
    const qScale = pow(min(float(WAVE_Q_REF).div(max(qAcc, 1e-5)), 1.0), uCrestNorm).toVar();
    const jac = jx.mul(jz).sub(jc.mul(jc)).toVar();
    vJac.assign(float(1.0).sub(float(1.0).sub(jac).mul(qScale)));
    vWorld.assign(world);
    vDist.assign(length(world.sub(cameraPosition)));

    const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1.0))).toVar();
    // The disc runs past the far plane on purpose so the water reaches the true
    // horizon; clamp z so the far ring is never clipped into a sliver of sky.
    return vec4(clip.xy, min(clip.z, clip.w.mul(0.999995)), clip.w);
  });

  // --- fragment ------------------------------------------------------------
  const fragmentNode = Fn(() => {
    const suv = screenUV.toVar();
    const V = normalize(cameraPosition.sub(vWorld)).toVar();
    const L = normalize(uKeyDir).toVar();
    const dist = vDist.toVar();

    // --- surface normal ---------------------------------------------------
    // gerstnerNormal(vFlat, uTime, uWind, weights), unrolled. The weights are
    // the interpolated per-wave depth ramp from the vertex stage, so the normal
    // is the analytic normal of the surface that was actually displaced.
    const wgt = [vWeightA.x, vWeightA.y, vWeightA.z, vWeightB.x, vWeightB.y, vWeightB.z];
    let gradX = float(0.0), gradZ = float(0.0);
    for (let i = 0; i < WAVES.length; i++) {
      const w = WAVES[i];
      const a = float(w.amp).mul(uWind).mul(wgt[i]);
      const slope = a.mul(w.k).mul(cos(wavePhase(w, vFlat, uTime))).toVar();
      gradX = gradX.add(slope.mul(w.dx));
      gradZ = gradZ.add(slope.mul(w.dz));
    }
    const N = normalize(vec3(gradX.negate(), 1.0, gradZ.negate())).toVar();
    const ng = vec2(N.x.negate(), N.z.negate()).div(max(N.y, 1e-3)).toVar();

    // A fourth, much finer octave — a 0.9 m tile against the previous finest of
    // 3.5 m. This is the one that decides whether water reads as water. Without
    // it the surface carries nothing smaller than a car, so every reflection
    // lands on it soft and unbroken and the sea looks like a sheet of glass with
    // a picture painted on it. Real chop is 30 cm to a metre, it is what breaks
    // the sky reflection into thousands of pieces, and it is what the specular
    // has to bite on to give the glitter anywhere to live.
    const dF = tDetail.sample(vFlat.mul(1.10).add(vec2(0.041, -0.052).mul(uTime))).toVar();
    const d0 = tDetail.sample(vFlat.mul(0.285).add(vec2(0.021, -0.034).mul(uTime))).toVar();
    const d1 = tDetail.sample(vFlat.mul(0.110).add(vec2(-0.016, 0.012).mul(uTime))).toVar();
    const d2 = tDetail.sample(vFlat.mul(0.043).add(vec2(0.008, 0.006).mul(uTime))).toVar();
    const ripFade = smoothstep(140.0, 900.0, dist).oneMinus().toVar();
    // The fine octave fades out much sooner than the rest. A 0.9 m ripple is
    // well under a pixel by forty metres, and left in it turns the middle
    // distance into a boiling mess of aliasing rather than into chop.
    const fineFade = smoothstep(18.0, 95.0, dist).oneMinus().toVar();
    const grad = dF.rg.mul(2.0).sub(1.0).mul(uFineChop.mul(fineFade))
      .add(d0.rg.mul(2.0).sub(1.0).mul(0.85))
      .add(d1.rg.mul(2.0).sub(1.0).mul(0.55))
      .add(d2.rg.mul(2.0).sub(1.0).mul(0.34)).toVar();
    ng.addAssign(grad.mul(uDetailStrength.mul(ripFade)));
    const breakup = d0.a.mul(0.45).add(d1.a.mul(0.33)).add(d2.a.mul(0.22)).toVar();

    // --- the boat's ripple field ------------------------------------------
    const wuv = vFlat.sub(uWakeCenter).div(uWakeWorld).add(0.5).toVar();
    const wa = smoothstep(vec2(0.0), vec2(0.05), wuv).toVar();
    const wb = smoothstep(vec2(0.95), vec2(1.0), wuv).oneMinus().toVar();
    const wmask = wa.x.mul(wa.y).mul(wb.x).mul(wb.y).toVar();
    const wC = tWake.sample(wuv).toVar();
    const wL = tWake.sample(wuv.sub(vec2(uWakeTexel, 0.0))).toVar();
    const wR = tWake.sample(wuv.add(vec2(uWakeTexel, 0.0))).toVar();
    const wD = tWake.sample(wuv.sub(vec2(0.0, uWakeTexel))).toVar();
    const wU = tWake.sample(wuv.add(vec2(0.0, uWakeTexel))).toVar();
    // Per-metre, so the low tier's 1 m texels do not silently double the tilt.
    const wgrad = uWakeGrad.mul(wmask).toVar();
    // Soft limit, not a clamp: g / (1 + |g| / max) is smooth everywhere, so a
    // ripple that grows past the ceiling flattens instead of developing a hard
    // rim where it crosses it.
    const rip = vec2(wR.r.sub(wL.r), wU.r.sub(wD.r)).mul(uWakeSlope.mul(wgrad)).toVar();
    ng.addAssign(rip.div(length(rip).div(uWakeSlopeMax).add(1.0)));
    ng.addAssign(vec2(wR.a.sub(wL.a), wU.a.sub(wD.a)).mul(uWakeArmSlope.mul(wgrad)));

    N.assign(normalize(vec3(ng.x.negate(), 1.0, ng.y.negate())));
    // Filtered normal: flatten and roughen with distance or the far water boils.
    const flatten = smoothstep(90.0, 1500.0, dist).toVar();
    N.assign(normalize(mix(N, vec3(0.0, 1.0, 0.0), flatten.mul(0.88))));
    const rough = mix(uRoughness, float(0.34), smoothstep(30.0, 900.0, dist)).toVar();

    // Screen-space offsets must come from how far the normal has been bent away
    // from flat, not from the normal itself — the latter is a constant slide of
    // the whole image with no wobble in it at all.
    const Nv = cameraViewMatrix.mul(vec4(N, 0.0)).xyz.toVar();
    const bend = Nv.xy.sub(cameraViewMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xy).toVar();

    // Foam is a diffuse white scatterer lit by the whole dome, so it must not
    // collapse when the key drops to the horizon — at sunset the wake is still
    // the brightest thing outside the light path.
    const foamLight = uAmbIntensity.mul(0.85)
      .add(uKeyIntensity.mul(0.40).mul(sat(L.y.mul(1.5).add(0.12)))).toVar();
    const foamCol = vec3(uFoamTint.mul(uFoamBright.mul(float(0.45).add(foamLight)))).toVar();

    // --- the view from underneath -----------------------------------------
    // Snell's window: the whole sky squeezed into a 97 degree cone, and outside
    // it the underside of the surface turns into a mirror of the gloom below.
    const up = V.negate().toVar();
    const cw = sat(dot(up, N)).toVar();
    const win = smoothstep(0.52, 0.80, cw).toVar();
    // The sky inside the window, WAVE-DISTORTED. The lookup used to be a fixed
    // blend toward straight up with no N in it at all, so the window's contents
    // were frozen while its rim wobbled — which is the tell that gives a fake
    // one away. Refraction through a tilted surface swings the apparent
    // direction by roughly the surface slope, so feeding N.xz in is both the
    // cheap fix and the physical one.
    const winDir = normalize(
      mix(vec3(0.0, 1.0, 0.0), up, 0.6).add(vec3(N.x, 0.0, N.z).mul(uWinDistort)),
    ).toVar();
    const through = vec3(skyAt(winDir)).toVar();
    // The colour of the ceiling outside Snell's window. It is a MIRROR of the
    // water below it, not a hole into the deep — total internal reflection
    // sends the seabed's own light back down at you — so it is built from the
    // mid tone and the scattering colour and it is bright. Built from uDeep at
    // 0.7 it was near-black, which put a navy lid over every underwater frame
    // and made two metres of clear lagoon read as a flooded cellar.
    const gloom = vec3(uMid.mul(0.62).add(uScatter.mul(0.72)).add(uShallow.mul(0.18))).toVar();
    const under = vec3(mix(gloom, through.mul(1.15), win)).toVar();
    under.addAssign(uKeyColor.mul(uKeyIntensity).mul(pow(sat(dot(up, L)), 60.0)).mul(win).mul(1.2));

    // --- what the ceiling was missing -------------------------------------
    // All of it behind a uniform branch. `under` is computed for EVERY water
    // fragment whether the eye is below the surface or not — TSL evaluates both
    // sides of the select at the end of this function — so without the gate
    // these taps would be paid on the whole above-water sea for a term nobody
    // can see. The condition is a uniform, which is what WGSL needs for a
    // texture read inside control flow.
    If(uSubmerged.greaterThan(0.001), () => {
      // The caustic web, on the underside. This is the single biggest thing
      // the ceiling did not have, and it costs nothing to place: vFlat is
      // already a varying, so there is no depth read and no reconstruction.
      // It is also the SAME field the shafts march through and the same one
      // the sand is dappled with, so the web overhead, the beams hanging from
      // it and the pattern on the floor all agree — that coherence is what
      // reads as one body of water rather than three effects.
      const w0 = tCaustic.sample(vFlat.mul(uCausticScale)).r.toVar();
      const w1 = tCaustic.sample(causticRot(vFlat).mul(uCausticScale).mul(0.63)).r.toVar();
      const web = sat(w0.mul(2.5).mul(float(0.6).add(w1.mul(2.5).mul(0.7)))).toVar();
      under.mulAssign(float(1.0).add(pow(web, 1.6).mul(uUnderWeb)));

      // The bright ring at the critical angle. A real Snell window has one —
      // grazing rays from just inside the cone arrive along the rim and pile
      // up there — and it is the detail that turns a pale disc into a hole in
      // the ceiling. Two smoothsteps, no derivative, no extra tap.
      const rim = smoothstep(0.46, 0.53, cw).mul(smoothstep(0.66, 0.55, cw)).toVar();
      under.addAssign(mix(uSkyHorizon, vec3(1.0), 0.35).mul(rim).mul(uWinRim));
    });
    // Seen from below, the wake is a bright ceiling patch and nothing more — so
    // it takes the channel VALUES with their own constants. It deliberately does
    // not share uWakeFoam/uWakeArmFoam any more: those now scale a gradient and
    // a compressed ridge, and reusing them here silently gave the underside a
    // different wake shape than the top surface every time the top was retuned.
    const wf = sat(wC.b.mul(0.80).add(wC.a.mul(0.60))).mul(wmask).toVar();
    under.assign(mix(under, foamCol.mul(0.5), sat(wf).mul(0.55)));
    under.assign(mix(under, gloom.mul(0.86), smoothstep(10.0, 140.0, dist)));
    // Modulate after the distance blend, or the far ceiling reads as a flat wall.
    under.mulAssign(float(0.78).add(sat(N.y.mul(0.4).add(vCrest.mul(1.8)).add(0.45)).mul(0.52)));

    const RD = normalize(vWorld.sub(cameraPosition)).toVar();
    // dot(RD, cameraForward) without pulling a column out of the view matrix:
    // the camera looks down -Z in view space, so it is just -RD.z there.
    const cosA = max(cameraViewMatrix.mul(vec4(RD, 0.0)).z.negate(), 1e-3).toVar();

    // --- refraction --------------------------------------------------------
    const bed0 = linearDepth(tRefractionDepth.sample(suv)).div(cosA).toVar();
    const column0 = max(bed0.sub(dist), 0.0).mul(max(RD.y.negate(), 0.06)).toVar();

    const distort = uRefractDistort.mul(sat(column0.mul(0.7)))
      .div(float(1.0).add(dist.mul(0.045))).toVar();
    const ruv = clamp(suv.add(bend.mul(distort)), vec2(0.002), vec2(0.998)).toVar();
    const bed1 = linearDepth(tRefractionDepth.sample(ruv)).div(cosA).toVar();
    // If the offset sample sits in front of the surface it is something above the
    // water leaking in — fall back to the straight sample.
    const ok = step(dist, bed1).toVar();
    const fuv = mix(suv, ruv, ok).toVar();
    const bedDist = mix(bed0, bed1, ok).toVar();

    const refr = tRefraction.sample(fuv).rgb.toVar();
    const bedWorld = cameraPosition.add(RD.mul(bedDist)).toVar();
    const path = max(bedDist.sub(dist), 0.0).toVar();
    const column = max(vWorld.y.sub(bedWorld.y), 0.0).toVar();
    const hasBed = smoothstep(2200.0, 4200.0, bedDist).oneMinus().toVar();

    // --- caustics on the seabed, in world XZ -------------------------------
    const cuv = bedWorld.xz.mul(uCausticScale).toVar();
    const c1 = tCaustic.sample(cuv).rgb.toVar();
    const c2 = tCaustic.sample(causticRot(cuv).mul(0.61).add(vec2(0.37, 0.11))).rgb.toVar();
    // Caustics MODULATE the seabed, they do not add to it. Written as a gain
    // around 1.0: the bright filaments roughly double the sand, the gaps darken
    // it slightly, and the mean stays put. Adding an unbounded product instead
    // (which is the obvious way to write this) multiplies the reef by three or
    // four and the whole bay comes back as a sheet of white lace.
    const caus = c1.add(c2).mul(0.5).add(c1.mul(c2).mul(1.4)).toVar();
    const causFade = hasBed.mul(smoothstep(1.5, 13.0, column).oneMinus()).mul(sat(L.y.mul(2.4))).toVar();
    const causGain = caus.sub(0.42).mul(float(1.35).mul(uCaustic).mul(causFade)).add(1.0).toVar();
    refr.mulAssign(max(causGain, vec3(0.55)));
    refr.addAssign(max(caus.sub(0.55), vec3(0.0)).mul(uKeyColor).mul(float(0.10).mul(uCaustic).mul(causFade)));

    // --- the water column ---------------------------------------------------
    const trans = exp(uAbsorb.negate().mul(path.add(column.mul(0.65)))).toVar();
    // Hold the bright shallow colour further out before the mid and deep bands
    // take over. At 0.15-2.4 m the lagoon had turned to mid-blue by the time it
    // was waist deep, so the turquoise the whole place is built around only
    // existed in a narrow ring around the sand.
    const body = mix(mix(uShallow, uMid, smoothstep(0.40, 3.6, column)),
      uDeep, smoothstep(3.6, 18.0, column)).toVar();
    // Less of the scatter colour mixed into the shallow body, so what comes back
    // out of a metre of water is mostly the SAND, not the water's own tint.
    const inScatter = vec3(mix(body, uScatter, 0.22)).toVar();
    const col = vec3(refr.mul(trans).add(inScatter.mul(trans.oneMinus()))).toVar();

    // A body the size of the leviathan blocks the light coming up through the
    // column, so the water directly above it scatters less back at the camera.
    // Without this the animal is physically correct and dramatically useless:
    // twenty metres of water absorbs ninety per cent of its silhouette and ref/04
    // never happens. The test is deliberately narrow — it fires only where the
    // thing under the water is far darker than the water itself, which is true of
    // the creature and of nothing else in the bay. Sand and reef sit well above
    // the deep-water body colour and never trip it.
    const refrL = dot(refr, LUMA).toVar();
    const scatL = dot(inScatter, LUMA).toVar();
    const bodyDark = sat(refrL.div(max(scatL, 1e-4)).oneMinus()).toVar();
    const bodyOcc = smoothstep(0.42, 0.86, bodyDark).mul(hasBed)
      .mul(smoothstep(24.0, 46.0, column).oneMinus()).toVar();
    col.mulAssign(bodyOcc.mul(0.60).oneMinus());

    // --- reflection ---------------------------------------------------------
    const R0 = reflect(V.negate(), N).toVar();
    const R = vec3(R0.x, max(R0.y, 0.010), R0.z).toVar();
    const sky = vec3(skyAt(R)).toVar();
    // Reflections stretch vertically at grazing incidence; without the stretch a
    // mirrored island reads as a hard-edged decal lying on the water.
    const rd = uReflDistort.div(float(1.0).add(dist.mul(0.012))).toVar();
    const rv = clamp(suv.add(vec2(bend.x, bend.y.mul(1.8)).mul(rd)), vec2(0.002), vec2(0.998)).toVar();
    const refl = vec3(tReflection.sample(vec2(rv.x.oneMinus(), rv.y)).rgb).toVar();
    refl.assign(mix(sky, refl, uReflEnabled.mul(uReflStrength)));

    const F = fresnelSchlick(max(dot(N, V), 0.0), float(0.02)).toVar();
    // Bottom coupling: how much of the reflection the water column is deep
    // enough to justify. See uReflBedMin. This is applied HERE and nowhere else
    // — the raw F still drives `grazing` down at the light path, because
    // ramping that too would cut the sun glitter over the reef by 37% and the
    // paintings keep their sparkle right across the flats.
    //
    // Two alternatives were measured and rejected. Scaling uReflStrength only
    // crossfades the reflection TARGET toward skyAt(R), which at grazing R is
    // 71% uSkyHorizon — the brightest part of the sky — so the shallows would
    // keep the same sheen with cloud shapes swapped for a flat wash. And
    // lifting the refracted term needs ~2.2x to restore contrast under F=0.55,
    // which drives the caustic gain past 1.0 into the bloom and still leaves
    // the cloud shapes lying on top, because a lerp's structure does not go
    // away when you brighten the other side.
    //
    // vBedDepth is READ, never written: colEff below, the shore foam band and
    // the waterline spike are all bit-identical to before.
    const gBed = uReflBedMin.add(uReflBedMin.oneMinus()
      .mul(smoothstep(uReflBedNear, uReflBedFar, vBedDepth))).toVar();
    col.assign(mix(col, refl, F.mul(gBed)));

    // --- back-lit crests: the jade glow inside a wave ----------------------
    const wrap = sat(dot(V, L.negate()).mul(0.6).add(0.4)).toVar();
    const sss = pow(wrap, 3.0).mul(sat(vCrest.mul(2.6))).mul(sat(N.y.mul(0.4).oneMinus())).toVar();
    col.addAssign(uScatter.mul(sss.mul(uScatterStrength).mul(float(0.5).add(uKeyIntensity.mul(0.7)))));

    // --- foam ---------------------------------------------------------------
    // Shore foam asks the SEABED how deep it is here, not the refraction buffer.
    // The refraction pass contains the boat's own submerged hull, so a column
    // reconstructed from it reads a few centimetres deep right around the
    // waterline and every hull in the bay wore a white foam blob.
    const colEff = vBedDepth.sub(vCrest.mul(0.8)).toVar();
    const shore = smoothstep(0.0, uShoreFoamDepth, colEff).oneMinus().toVar();
    shore.assign(smoothstep(0.42, 0.88, shore.mul(1.2).sub(breakup.mul(0.5)).add(0.14)));
    // The bright line right at the waterline. Narrow — it is an edge, not a band.
    shore.addAssign(exp(abs(colEff.sub(0.06)).mul(-16.0)).mul(0.42));
    shore.mulAssign(hasBed);

    // The threshold has to sit inside the range the Jacobian actually reaches
    // or crest foam never fires, and too low fires it across the whole bay and
    // the water turns to milk. Careful: the old comment here claimed the
    // sheltered train "only dips to about 0.87" — searching three million
    // random (x, z, t) says the true minimum was 0.9368, so 0.905 sat almost
    // entirely below it and crest foam fired essentially nowhere. The depth
    // ramp is what makes this line do anything at all: offshore the train
    // reaches jac 0.869, i.e. exactly the 0.87 the threshold was written for.
    // uCrestNorm above is the brake if that reads as milk rather than as the
    // handful of thin streaks ref/04 and ref/05 show on near crests.
    const crest = smoothstep(0.905, 0.975, vJac).oneMinus().toVar();
    // Break the crest harder than the shore foam is broken. A shoreline's foam
    // is a continuous band because the beach holds it there; a whitecap is torn
    // apart by the same wave that made it, so it wants to read as separate
    // flecks lying along the crest rather than as a stripe painted on it.
    crest.assign(smoothstep(0.34, 0.90, crest.mul(1.22).sub(breakup.mul(0.72)).add(0.13)).mul(0.80));

    // --- the wake -----------------------------------------------------------
    // The wake field is a WHERE and never a WHAT. It is 0.5 m per texel on
    // desktop and 1.0 m on mobile, and the foam flakes measured in ref/01 are
    // 10-15 cm across with 10-20 cm of clear water between them — so the field
    // can carry the envelope and the filament has to be cut out of it with
    // world-space noise. Locate, erode, threshold. Never multiply.
    //
    // What this replaces, and what it looked like:
    //   smoothstep(0.32, 1.10, B*1.25*lace)*0.9 + smoothstep(0.26, 0.80, A*0.32*lace)
    // Read back off the GPU, B reaches 1.43 near the transom, so the first term
    // ran 2-3x past the top of its own smoothstep for the first ~25 m of trail.
    // A gain cannot break a plateau: the noise it was multiplied by had nothing
    // to bite on and the trail rendered as one flat 205-237 luma lozenge welded
    // to the transom, 46% of the region behind the boat painted white where the
    // paintings paint 7%. The second term's LOWER edge, 0.26, sat above A*0.32
    // everywhere except the arm vertex where A peaks at 1.05 — the Kelvin V was
    // rebuilt correctly by wake.js every single frame and then thresholded to
    // nothing. Zeroing uWakeFoam and leaving the arms on left no white on screen
    // at all. The two terms were mistuned in opposite directions by about 3x.
    // Shore foam twenty lines up already does it the right way round (subtract
    // the noise, then threshold) and that is the vocabulary borrowed here.

    // Foam from the field's VALUE, softened, textured, never cut.
    //
    // The version this replaces located foam by the GRADIENT of the churn
    // channel and then cut it with the ridged contour of a noise octave. On
    // paper that gives thin meandering filaments like the ones in ref/01. On a
    // phone it gives white squiggles scattered across the bay that read as
    // scribbles rather than water, and — because a plateau has no gradient —
    // nothing at all touching the hull, which is the one place a wake must
    // never be missing. Two lessons in it. A contour is a curve of zero width,
    // so its on-screen thickness is set by the field's slope rather than by
    // anything chosen, and it thins to single aliased pixels wherever the field
    // is flat. And subtracting a cut before a narrow threshold lets the CUT
    // decide where foam is, so noise alone can put a strand in open water.
    //
    // So: value, not gradient — the churn is stamped at the hull, so its value
    // is high exactly where the foam has to start. Reinhard rather than a
    // threshold, because B reaches 1.43 near the transom and 0.15 at the tail
    // and no single band spans 10:1 without either flooding or vanishing.
    // And the noise MULTIPLIES the result instead of being subtracted from it,
    // which is the whole difference: multiplied, it can only ever mottle foam
    // that the wake put there, so open water stays open.
    const wakeBody = wC.b.div(wC.b.add(uWakeSoft)).toVar();
    const armv = wC.a.div(wC.a.add(uWakeArmSoft)).toVar();
    // The lower edge sits above where the bilinear halo of overlapping stamp
    // tails lands (B and A both sit around 0.02-0.05 out there); below it that
    // halo comes back as a faint triangle of haze behind the boat.
    // Wider bands than a threshold wants. A narrow band is the crisp, graphic
    // answer and it is what a renderer reaches for; a painter lays foam down
    // with a loaded brush and the edge of the stroke is where the paint thins,
    // not where it stops. Widening these is the difference between a decal with
    // a clean rim and a mark that was made.
    // Back to a band tight enough to keep a shape. Widening it softened the
    // edge and took the form with it — the arms came back as featureless white
    // lozenges, which is blurry, not painterly. What makes a mark read as
    // painted is VALUE VARIATION INSIDE it and a soft fringe at its edge, not a
    // soft everything: see uWakeMottle below and the halo further down.
    const bodyF = smoothstep(0.12, 0.55, wakeBody).mul(uWakeFoam).toVar();
    const armF = smoothstep(0.15, 0.60, armv).mul(uWakeArmFoam).toVar();
    // A brighter rim along the outside of each arm. A wake's crest is where the
    // water is actually breaking, and without it the arms read as two smooth
    // painted ribbons — correct in shape, dead in the water. Taking the band
    // between two smoothsteps costs nothing and needs no derivative, which
    // matters because a derivative of this field is what produced filaments.
    const armEdge = smoothstep(0.26, 0.52, armv)
      .mul(smoothstep(0.52, 0.86, armv).oneMinus()).toVar();
    const wake = max(bodyF, armF).add(armEdge.mul(uWakeRim))
      .mul(wmask).mul(uWakeVisible).toVar();

    // Mottle it. Two scales, because one gives an obvious repeating pattern at
    // the size of its own tile: the coarse one breaks the trail into patches
    // the size of the boat, the fine one gives the surface its churn. Kept well
    // above zero — this is texture inside foam, not holes punched through it,
    // and anything that reaches zero starts reading as filaments again.
    const churn = lean
      ? d0.b.toVar()
      : mix(d0.b, tDetail.sample(vFlat.mul(uWakeChurnScale)).b, 0.6).toVar();
    wake.mulAssign(churn.mul(uWakeMottle).add(float(1.0).sub(uWakeMottle)));

    // Fade with distance. Even softened, foam held at full contrast to the
    // horizon aliases into bright dots that post's chromatic aberration paints
    // magenta and green — the glitter above fades for the same reason.
    wake.mulAssign(smoothstep(90.0, 340.0, dist).oneMinus());

    // The bloom of disturbed water around the foam, well below the foam's own
    // threshold. Water beside a wake is not the water further out — it is
    // lighter, milkier and it has no edge at all, and every painting of a boat
    // shows that halo before it shows a single white stroke. This is the term
    // that stops the wake sitting ON the sea and starts it belonging to it.
    // A FRINGE, not a wash. The first version keyed the halo on the field being
    // present at all, and the churn ribbon is seven metres wide — so it milked
    // the whole lane between the arms and the wake came back as a flat pale
    // sheet with two edges. Multiplying by (1 - wake) confines it to where
    // there is disturbance but no white: the fringe around each stroke, which
    // is where a painter would soften into the water. The arm channel is
    // weighted over the churn for the same reason — armv is the thin ridge,
    // wakeBody is the ribbon.
    const haloSrc = max(armv, wakeBody.mul(0.45)).toVar();
    const wakeHalo = smoothstep(0.03, 0.34, haloSrc)
      .mul(wake.oneMinus())
      .mul(uWakeHalo).mul(wmask).mul(uWakeVisible)
      .mul(smoothstep(90.0, 340.0, dist).oneMinus()).toVar();

    // --- ambient surface foam ------------------------------------------------
    // The third foam layer, and the one this water did not have. Whitecaps mark
    // where a wave is breaking NOW and shore foam marks where the land is; open
    // ocean is neither, and without a third term it renders as an unbroken
    // sheet however good the waves under it are. What is actually out there is
    // the residue of everything that broke minutes ago — long streaks drawn out
    // along the swell, drifting, dissolving, never bright.
    //
    // Built from the coarse detail octave already in a register, at a long tile
    // and crawling with the wind rather than with the wave phase, because this
    // stuff is older than the wave it is lying on. Thresholded hard so it reads
    // as streaks and not as haze, and keyed on the SAME swell the whitecaps use
    // so the lagoon stays glass and only the offshore water gets a skin on it.
    // ANISOTROPIC, because ocean foam is not spots. Foam is torn off a breaking
    // crest and then dragged by the same orbital motion that made it, so it ends
    // up in long filaments lying ALONG the wave train and pooling in the troughs
    // behind it. An isotropic lookup gives blobs — which is what the first
    // version did, and why it read as scattered litter rather than as sea.
    // Stretching the sample five to one along the swell axis costs nothing and
    // is the whole difference between spots and streaks.
    // Isotropic again. Stretching the lookup to make filaments produced exactly
    // what stretching a tiling noise always produces: a regular diagonal comb
    // across the whole sea, reading as scratches or rain. The reference's
    // streaks come from an FFT simulation SPAWNING foam where a wave breaks and
    // then advecting it, and no static lookup imitates that — what it can do is
    // sit where the wave is steep, which is the term below. Foam that follows
    // the water beats foam that is shaped like foam.
    const driftUv = vFlat.mul(uAmbFoamScale).add(vec2(0.013, -0.009).mul(uTime));
    // Modulated by the much coarser d2 octave before thresholding. One octave on
    // its own draws its own tile: at 18 m the first attempt laid a regular
    // lattice of streaks across the whole sea, which reads as a texture error
    // rather than as foam and is worse than having none. Multiplying by a
    // second, far longer octave means coverage itself varies over tens of
    // metres, and the repeat stops being findable.
    const drift = tDetail.sample(driftUv).a.mul(d2.a.mul(0.9).add(0.55)).toVar();
    const swellHere = smoothstep(3.0, 13.0, vBedDepth).toVar();
    // And it collects where the surface is being COMPRESSED. vJac is the
    // Gerstner Jacobian: below one means the surface is bunching, which is the
    // front face of a wave about to break and exactly where the sea is white in
    // the reference. Without this the streaks lie across crests and troughs
    // alike and the foam has no relationship to the water carrying it.
    const steepF = sat(float(1.0).sub(vJac).mul(uAmbFoamSteep)).toVar();
    const ambient = smoothstep(uAmbFoamThresh, uAmbFoamThresh.add(0.20),
      drift.add(steepF)).mul(swellHere).mul(uAmbFoam).toVar();

    const foam = sat(sat(shore).add(crest).add(ambient).add(sat(wake).mul(uWakeBright))).toVar();
    // Texture inside the foam, so a splash reads as churned water and not a
    // plate. Capped below 1: solving mix(water, target, a) against ref/01 gives
    // a = 0.35 at the strand edges and 0.72-0.96 at the hottest cores, so the
    // water colour reads through everywhere — foam is never fully opaque.
    // Halo first, under the foam, so the foam sits in its own disturbed water.
    col.assign(mix(col, mix(col, foamCol, 0.62), wakeHalo));
    col.assign(mix(col, foamCol.mul(float(0.70).add(breakup.mul(0.58))), foam.mul(0.92)));

    // --- the light path -----------------------------------------------------
    const H = normalize(V.add(L)).toVar();
    const ndh = max(dot(N, H), 1e-5).toVar();
    const shin = min(float(2.0).div(max(rough.mul(rough), 1e-4)).sub(2.0), 2048.0).toVar();
    const core = pow(ndh, shin).mul(shin.add(2.0)).mul(0.02).toVar();
    const broad = pow(ndh, 28.0).toVar();
    const sheen = pow(ndh, 9.0).toVar();

    // Sparkles hold still in world space and twinkle as the wave passes under
    // them. Cubing the phase keeps most cells dark most of the time, which is
    // what makes a path read as a scatter of points rather than a wash.
    const gp = vFlat.div(max(uGlitterSize, 0.05)).toVar();
    const cell = worley(gp.mul(2.2).add(vec2(uTime.mul(0.021), uTime.mul(-0.017)))).toVar();
    const tw = sin(uTime.mul(float(2.6).add(cell.z.mul(11.0))).add(cell.z.mul(57.0)))
      .mul(0.5).add(0.5).toVar();
    const sparkle = pow(smoothstep(0.0, 0.20, cell.x).oneMinus(), 7.0).mul(tw).mul(tw).mul(tw).toVar();
    sparkle.mulAssign(smoothstep(140.0, 620.0, dist).oneMinus());
    // The water immediately around a wake is visibly rougher than open water in
    // every painting — fine bright filigree that never crosses the foam
    // threshold. `field` is the wake locator already sitting in a register, so
    // buying that is one multiply-add and no new mechanism. Kept small: at 0.9
    // the glitter — which the old blob used to suppress and which now runs right
    // up to the foam edge — took the whole wedge over and the wake read as a fan
    // of sparks rather than as foam.
    sparkle.mulAssign(wake.mul(0.35).add(1.0));

    const keyUp = sat(L.y.mul(8.0)).toVar();
    const grazing = mix(float(0.35), float(1.0), F).toVar();
    // Trimmed hard from where this started. The glitter has to survive being
    // pushed above 1.0 for the bloom, but at grazing angles the far half of the
    // bay is all glitter and it burns out into a white sheet.
    const spec = vec3(
      uKeyColor.mul(core.mul(uSpecular).mul(0.20))
        .add(uGlitterColor.mul(
          broad.mul(float(0.12).add(sparkle.mul(3.1))).add(sheen.mul(0.035)).mul(uGlitter),
        )),
    ).toVar();
    spec.mulAssign(uKeyIntensity.mul(keyUp).mul(grazing).mul(foam.mul(0.3).oneMinus()));

    // --- horizon ------------------------------------------------------------
    const fog = sat(dist.sub(uFogNear).div(max(uFogFar.sub(uFogNear), 1.0))).toVar();
    fog.assign(fog.mul(fog).mul(float(3.0).sub(fog.mul(2.0))));
    // Fog to the sky at the surface, to the water body from under it. Without
    // the second case the far water — whose wave faces are tilted enough that a
    // submerged eye sees their TOPS, so `frontFacing` picks this branch — was
    // fogged to the bright sky horizon and drew a hard white band right across
    // every underwater shot.
    col.assign(mix(col, mix(mix(uFogColor, uSkyHorizon, 0.42), gloom.mul(0.9), uSubmerged), fog));
    col.addAssign(spec.mul(fog.mul(0.55).oneMinus()));

    return vec4(max(select(frontFacing, col, under), vec3(0.0)), 1.0);
  });

  const material = new THREE.NodeMaterial();
  material.vertexNode = vertexNode();
  material.fragmentNode = fragmentNode();
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  material.fog = false;
  material.lights = false;
  material.name = 'SaltyFinWater';

  return {
    material,
    uniforms,
    detailTexture: detail,
    dispose() {
      material.dispose();
      detail.dispose();
      for (const t of placeholders) t.dispose();
    },
  };
}

export { buildDetailTexture };
