// The palette. Every colour in the game comes from here.
//
// A handful of hand-authored keyframes across 24 hours, interpolated. The
// keyframes are read off the concept art, not off a physical sky model — the
// sun stays in the right half of frame all day because that is where the art
// puts its light path on the water, and the water absorption is tuned so the
// reef reads through the surface at midday and merely suggests itself at night.
//
// Colours are written as sRGB hex because that is how you pick them; they are
// converted to the linear working space on load and stay linear from then on.

import * as THREE from 'three';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * Keyframes. `hour` must be ascending; the table wraps around midnight.
 * Any field omitted from a keyframe is inherited from the previous one, which
 * keeps the table readable — only write down what actually changes.
 */
const KEYS = [
  // ---------------------------------------------------------------- night --
  {
    hour: 0.0, key: 'night',
    sun: { az: 250, el: -58 }, moon: { az: 58, el: 27 },
    sunColor: 0x2A3A66, sunIntensity: 0.0,
    moonColor: 0xC8DCFF, moonIntensity: 0.95, moonPhase: 1.0,
    skyZenith: 0x04091E, skyMid: 0x0A1740, skyHorizon: 0x152C58,
    sunDiscColor: 0xEDF4FF, sunHalo: 0x7FA4E8, sunHaloSize: 0.30,
    starOpacity: 1.0, milkyWayOpacity: 0.55,
    cloudLit: 0x63799F, cloudShadow: 0x101C40, cloudRim: 0xA9C2E8,
    cloudCover: 0.44, cloudOpacity: 0.92,
    ambientSky: 0x18294F, ambientGround: 0x050A18, ambientIntensity: 0.42,
    fogColor: 0x0C1A3A, fogNear: 70, fogFar: 1250, hazeStrength: 0.5, horizonGlow: 0.30,
    waterShallow: 0x0E5A6E, waterMid: 0x093A5E, waterDeep: 0x03102A,
    waterAbsorption: V(0.40, 0.13, 0.075), waterScatter: 0x0A4258,
    causticStrength: 0.30, foamBrightness: 0.55, foamTint: 0xBBD4F2,
    specularStrength: 1.15, roughness: 0.045, glitterStrength: 0.95, glitterSize: 1.25,
    reflectionStrength: 1.0, sunGlitterColor: 0xB9D4FF,
    windowLight: 0xFFB755, windowIntensity: 1.35, lanternIntensity: 1.45,
    lighthouseIntensity: 1.30, beamOpacity: 0.34,
    exposure: 1.18, bloomStrength: 0.80, bloomThreshold: 0.52, bloomRadius: 0.78,
    saturation: 1.04, contrast: 1.10, vignette: 0.42, grainStrength: 0.020,
    lift: 0x060B1A, gain: 0xEAF0FF,
  },
  // ----------------------------------------------------------------- dawn --
  {
    hour: 5.4, key: 'dawn',
    sun: { az: 78, el: -5 }, moon: { az: 288, el: 14 },
    sunColor: 0xFF8E62, sunIntensity: 0.35,
    moonColor: 0xBFD2F0, moonIntensity: 0.30,
    skyZenith: 0x1B2C63, skyMid: 0x5A5490, skyHorizon: 0xE2896E,
    sunDiscColor: 0xFFD9A0, sunHalo: 0xFF9A62, sunHaloSize: 0.26,
    starOpacity: 0.35, milkyWayOpacity: 0.12,
    cloudLit: 0xE2A292, cloudShadow: 0x453A6E, cloudRim: 0xFFC6A0,
    cloudCover: 0.48, cloudOpacity: 0.95,
    ambientSky: 0x4C5A94, ambientGround: 0x201E38, ambientIntensity: 0.55,
    fogColor: 0x8A7C9E, fogNear: 90, fogFar: 1400, hazeStrength: 0.62, horizonGlow: 0.85,
    waterShallow: 0x2B8E92, waterMid: 0x186480, waterDeep: 0x0A2148,
    waterAbsorption: V(0.38, 0.11, 0.06), waterScatter: 0x175E76,
    causticStrength: 0.5, foamBrightness: 0.75, foamTint: 0xE8D8DC,
    specularStrength: 1.1, roughness: 0.05, glitterStrength: 0.9, glitterSize: 1.15,
    reflectionStrength: 0.98, sunGlitterColor: 0xFFA878,
    windowIntensity: 0.85, lanternIntensity: 0.95, lighthouseIntensity: 0.75, beamOpacity: 0.20,
    exposure: 1.10, bloomStrength: 0.62, bloomThreshold: 0.68, bloomRadius: 0.72,
    saturation: 1.12, contrast: 1.07, vignette: 0.36, grainStrength: 0.015,
    lift: 0x0A0C1C, gain: 0xFFF2E8,
  },
  // --------------------------------------------------------------- sunrise --
  {
    hour: 6.6, key: 'sunrise',
    sun: { az: 74, el: 5 },
    sunColor: 0xFFB878, sunIntensity: 1.45,
    moonIntensity: 0.06,
    skyZenith: 0x2F63B4, skyMid: 0x84A6D8, skyHorizon: 0xFFC59A,
    sunDiscColor: 0xFFF0C8, sunHalo: 0xFFBE7A, sunHaloSize: 0.20,
    starOpacity: 0.0, milkyWayOpacity: 0.0,
    cloudLit: 0xFFD9BE, cloudShadow: 0x8290B8, cloudRim: 0xFFE6C4,
    cloudCover: 0.44,
    ambientSky: 0x7FA6D8, ambientGround: 0x2A4650, ambientIntensity: 0.80,
    fogColor: 0xC0BCC8, fogNear: 140, fogFar: 1650, hazeStrength: 0.52, horizonGlow: 0.80,
    waterShallow: 0x44BDBA, waterMid: 0x1D93AE, waterDeep: 0x0D3A76,
    waterAbsorption: V(0.36, 0.09, 0.05), waterScatter: 0x1A88A0,
    causticStrength: 0.8, foamBrightness: 0.92, foamTint: 0xFFF0E4,
    glitterStrength: 0.9, glitterSize: 1.05, sunGlitterColor: 0xFFD09A,
    windowIntensity: 0.35, lanternIntensity: 0.45, lighthouseIntensity: 0.30, beamOpacity: 0.10,
    exposure: 1.04, bloomStrength: 0.50, bloomThreshold: 0.82,
    saturation: 1.14, contrast: 1.05, vignette: 0.28, grainStrength: 0.012,
    lift: 0x080A12, gain: 0xFFF6EC,
  },
  // --------------------------------------------------------------- morning --
  {
    hour: 8.5, key: 'morning',
    sun: { az: 66, el: 28 },
    sunColor: 0xFFEBC8, sunIntensity: 2.5,
    moonIntensity: 0.0,
    skyZenith: 0x1260CE, skyMid: 0x3F8FE0, skyHorizon: 0xC6E4F6,
    sunDiscColor: 0xFFFBEC, sunHalo: 0xFFF4D8, sunHaloSize: 0.09,
    cloudLit: 0xFFFFFF, cloudShadow: 0xB0C6DE, cloudRim: 0xFFFFFF,
    cloudCover: 0.40,
    ambientSky: 0x90C0EA, ambientGround: 0x286674, ambientIntensity: 0.76,
    fogColor: 0xAAD8F0, fogNear: 260, fogFar: 2000, hazeStrength: 0.36, horizonGlow: 0.48,
    waterShallow: 0x55D2C8, waterMid: 0x1298AE, waterDeep: 0x093C8C,
    waterAbsorption: V(0.40, 0.090, 0.052), waterScatter: 0x1A94A8,
    causticStrength: 0.95, foamBrightness: 1.0, foamTint: 0xFFFFFF,
    specularStrength: 1.0, roughness: 0.06, glitterStrength: 0.85, glitterSize: 1.0,
    reflectionStrength: 0.92, sunGlitterColor: 0xFFFCF0,
    windowIntensity: 0.0, lanternIntensity: 0.15, lighthouseIntensity: 0.0, beamOpacity: 0.0,
    exposure: 1.0, bloomStrength: 0.34, bloomThreshold: 1.0, bloomRadius: 0.62,
    saturation: 1.12, contrast: 1.05, vignette: 0.22, grainStrength: 0.010,
    lift: 0x060810, gain: 0xFFFFFF,
  },
  // ------------------------------------------------------------------ day --
  {
    hour: 12.0, key: 'day',
    sun: { az: 44, el: 66 },
    sunColor: 0xFFF6E2, sunIntensity: 2.85,
    skyZenith: 0x0B57C8, skyMid: 0x2F86E2, skyHorizon: 0xBCE2F6,
    sunDiscColor: 0xFFFFF4, sunHalo: 0xFFFAE8, sunHaloSize: 0.06,
    cloudLit: 0xFFFFFF, cloudShadow: 0xB6CCE4, cloudRim: 0xFFFFFF,
    cloudCover: 0.42, cloudOpacity: 1.0,
    ambientSky: 0x93C4EE, ambientGround: 0x2A6A78, ambientIntensity: 0.78,
    fogColor: 0xA2D6F0, fogNear: 300, fogFar: 2200, hazeStrength: 0.30, horizonGlow: 0.42,
    waterShallow: 0x5AD8CC, waterMid: 0x14A0B4, waterDeep: 0x083E92,
    waterAbsorption: V(0.40, 0.088, 0.050), waterScatter: 0x1C9CAE,
    causticStrength: 1.0,
    exposure: 1.0, bloomStrength: 0.30, bloomThreshold: 1.05,
    saturation: 1.20, contrast: 1.11, vignette: 0.24,
  },
  // ------------------------------------------------------------ afternoon --
  {
    hour: 16.2, key: 'afternoon',
    sun: { az: 56, el: 34 },
    sunColor: 0xFFEAC0, sunIntensity: 2.65,
    skyZenith: 0x1462C6, skyMid: 0x458DD8, skyHorizon: 0xCEDEEC,
    sunHaloSize: 0.10, sunHalo: 0xFFEEC8,
    cloudLit: 0xFFF6EA, cloudShadow: 0xA8BCD6, cloudRim: 0xFFFAF0,
    cloudCover: 0.46,
    ambientSky: 0x8EBCE6, ambientGround: 0x286470, ambientIntensity: 0.74,
    fogColor: 0xB4D2E4, fogNear: 240, fogFar: 2000, hazeStrength: 0.36, horizonGlow: 0.55,
    waterShallow: 0x4BC8C4, waterMid: 0x1A8EA8, waterDeep: 0x0A3A86,
    causticStrength: 0.95, sunGlitterColor: 0xFFF2D8,
    exposure: 1.0, bloomStrength: 0.38, bloomThreshold: 0.96,
    saturation: 1.20, contrast: 1.11, vignette: 0.26,
  },
  // --------------------------------------------------------------- golden --
  {
    hour: 18.5, key: 'golden',
    sun: { az: 60, el: 11 },
    sunColor: 0xFFB061, sunIntensity: 2.9,
    skyZenith: 0x2E4C9E, skyMid: 0x8A72C0, skyHorizon: 0xFFB472,
    sunDiscColor: 0xFFF0BC, sunHalo: 0xFFB264, sunHaloSize: 0.17,
    cloudLit: 0xFFC894, cloudShadow: 0x6E5C9A, cloudRim: 0xFFE0A8,
    cloudCover: 0.52, cloudOpacity: 0.97,
    ambientSky: 0x6E74BE, ambientGround: 0x2C2E48, ambientIntensity: 0.74,
    fogColor: 0xC98E82, fogNear: 175, fogFar: 1750, hazeStrength: 0.46, horizonGlow: 0.95,
    waterShallow: 0x33A0A6, waterMid: 0x156E8C, waterDeep: 0x0B2C5C,
    waterAbsorption: V(0.41, 0.115, 0.062), waterScatter: 0x186C86,
    causticStrength: 0.72, foamBrightness: 0.95, foamTint: 0xFFE8D4,
    specularStrength: 1.1, roughness: 0.05, glitterStrength: 1.0, glitterSize: 1.15,
    reflectionStrength: 0.98, sunGlitterColor: 0xFFB25A,
    windowIntensity: 0.55, lanternIntensity: 0.75, lighthouseIntensity: 0.55, beamOpacity: 0.15,
    exposure: 1.02, bloomStrength: 0.52, bloomThreshold: 0.88, bloomRadius: 0.72,
    saturation: 1.18, contrast: 1.09, vignette: 0.30, grainStrength: 0.013,
    lift: 0x0A0810, gain: 0xFFF4E6,
  },
  // --------------------------------------------------------------- sunset --
  {
    hour: 19.5, key: 'sunset',
    sun: { az: 63, el: 1.6 },
    sunColor: 0xFF8A3E, sunIntensity: 2.05,
    skyZenith: 0x452B76, skyMid: 0xBE5080, skyHorizon: 0xFF9040,
    sunDiscColor: 0xFFE9A6, sunHalo: 0xFF963A, sunHaloSize: 0.22,
    starOpacity: 0.05,
    cloudLit: 0xFFA874, cloudShadow: 0x54356A, cloudRim: 0xFFCE86,
    cloudCover: 0.56, cloudOpacity: 0.96,
    // The ambient stays violet-blue while the key goes orange. That split is the
    // whole trick of ref/02: lit faces burn warm, shaded faces fall to cool
    // twilight. A warm ambient collapses the two and the town turns into one
    // red silhouette.
    ambientSky: 0x5C4C9E, ambientGround: 0x241C3A, ambientIntensity: 0.66,
    fogColor: 0xA05A72, fogNear: 130, fogFar: 1600, hazeStrength: 0.50, horizonGlow: 1.05,
    waterShallow: 0x247E88, waterMid: 0x115A78, waterDeep: 0x0A2148,
    waterAbsorption: V(0.42, 0.135, 0.075), waterScatter: 0x125C74,
    causticStrength: 0.5, foamBrightness: 0.9, foamTint: 0xFFDCC8,
    specularStrength: 1.2, roughness: 0.048, glitterStrength: 1.05, glitterSize: 1.25,
    reflectionStrength: 1.0, sunGlitterColor: 0xFFA23C,
    windowIntensity: 1.0, lanternIntensity: 1.05, lighthouseIntensity: 0.95, beamOpacity: 0.24,
    exposure: 1.04, bloomStrength: 0.64, bloomThreshold: 0.80, bloomRadius: 0.76,
    saturation: 1.20, contrast: 1.10, vignette: 0.33, grainStrength: 0.015,
    lift: 0x0B0812, gain: 0xFFF0E2,
  },
  // ----------------------------------------------------------------- dusk --
  {
    hour: 20.4, key: 'dusk',
    sun: { az: 66, el: -6 }, moon: { az: 58, el: 22 },
    sunColor: 0xE0603E, sunIntensity: 0.5,
    moonColor: 0xC6D8FA, moonIntensity: 0.35,
    skyZenith: 0x1A1C4E, skyMid: 0x6B3A72, skyHorizon: 0xE4713F,
    sunDiscColor: 0xFFC888, sunHalo: 0xD9663C, sunHaloSize: 0.28,
    starOpacity: 0.45, milkyWayOpacity: 0.12,
    cloudLit: 0xB4708A, cloudShadow: 0x2A2350, cloudRim: 0xFF9C6A,
    cloudCover: 0.50, cloudOpacity: 0.94,
    ambientSky: 0x35407E, ambientGround: 0x131024, ambientIntensity: 0.56,
    fogColor: 0x5A4064, fogNear: 110, fogFar: 1450, hazeStrength: 0.50, horizonGlow: 0.72,
    waterShallow: 0x1C7480, waterMid: 0x0F4E70, waterDeep: 0x081C40,
    waterAbsorption: V(0.39, 0.125, 0.07), waterScatter: 0x0E526A,
    causticStrength: 0.36, foamBrightness: 0.7, foamTint: 0xD8CCDC,
    glitterStrength: 1.0, glitterSize: 1.2, sunGlitterColor: 0xE07A48,
    windowIntensity: 1.25, lanternIntensity: 1.30, lighthouseIntensity: 1.15, beamOpacity: 0.30,
    exposure: 1.12, bloomStrength: 0.74, bloomThreshold: 0.62, bloomRadius: 0.78,
    saturation: 1.10, contrast: 1.09, vignette: 0.38, grainStrength: 0.018,
    lift: 0x070A18, gain: 0xF0F2FF,
  },
  // ---------------------------------------------------------------- night --
  {
    hour: 22.0, key: 'night',
    sun: { az: 200, el: -40 }, moon: { az: 58, el: 28 },
    sunIntensity: 0.0, sunColor: 0x2A3A66,
    moonColor: 0xC8DCFF, moonIntensity: 0.95, moonPhase: 1.0,
    skyZenith: 0x04091E, skyMid: 0x0A1740, skyHorizon: 0x152C58,
    sunDiscColor: 0xEDF4FF, sunHalo: 0x7FA4E8, sunHaloSize: 0.30,
    starOpacity: 1.0, milkyWayOpacity: 0.55,
    cloudLit: 0x63799F, cloudShadow: 0x101C40, cloudRim: 0xA9C2E8,
    cloudCover: 0.44, cloudOpacity: 0.92,
    ambientSky: 0x18294F, ambientGround: 0x050A18, ambientIntensity: 0.42,
    fogColor: 0x0C1A3A, fogNear: 70, fogFar: 1250, hazeStrength: 0.5, horizonGlow: 0.30,
    waterShallow: 0x0E5A6E, waterMid: 0x093A5E, waterDeep: 0x03102A,
    waterAbsorption: V(0.40, 0.13, 0.075), waterScatter: 0x0A4258,
    causticStrength: 0.30, foamBrightness: 0.55, foamTint: 0xBBD4F2,
    specularStrength: 1.15, roughness: 0.045, glitterStrength: 0.95, glitterSize: 1.25,
    reflectionStrength: 1.0, sunGlitterColor: 0xB9D4FF,
    windowLight: 0xFFB755, windowIntensity: 1.35, lanternIntensity: 1.45,
    lighthouseIntensity: 1.30, beamOpacity: 0.34,
    exposure: 1.18, bloomStrength: 0.80, bloomThreshold: 0.52, bloomRadius: 0.78,
    saturation: 1.04, contrast: 1.10, vignette: 0.42, grainStrength: 0.020,
    lift: 0x060B1A, gain: 0xEAF0FF,
  },
];

export const PRESET_HOURS = {
  midnight: 0.4, dawn: 5.4, sunrise: 6.6, morning: 8.5, day: 12.0,
  noon: 12.0, afternoon: 16.2, golden: 18.5, sunset: 19.5, dusk: 20.4, night: 22.5,
};

// --- keyframe table plumbing ------------------------------------------------

const COLOR_FIELDS = [
  'sunColor', 'moonColor', 'skyZenith', 'skyMid', 'skyHorizon', 'sunDiscColor', 'sunHalo',
  'cloudLit', 'cloudShadow', 'cloudRim', 'ambientSky', 'ambientGround', 'fogColor',
  'waterShallow', 'waterMid', 'waterDeep', 'waterScatter', 'foamTint', 'sunGlitterColor',
  'windowLight', 'lift', 'gain',
];
const VEC_FIELDS = ['waterAbsorption'];
const NUM_FIELDS = [
  'sunIntensity', 'moonIntensity', 'moonPhase', 'sunHaloSize', 'starOpacity', 'milkyWayOpacity',
  'cloudCover', 'cloudOpacity', 'ambientIntensity', 'fogNear', 'fogFar', 'hazeStrength',
  'horizonGlow', 'causticStrength', 'foamBrightness', 'specularStrength', 'roughness',
  'glitterStrength', 'glitterSize', 'reflectionStrength', 'windowIntensity', 'lanternIntensity',
  'lighthouseIntensity', 'beamOpacity', 'exposure', 'bloomStrength', 'bloomThreshold',
  'bloomRadius', 'saturation', 'contrast', 'vignette', 'grainStrength',
];

// Resolve inheritance: every keyframe ends up with every field.
const FRAMES = (() => {
  const out = [];
  let prev = null;
  for (const k of KEYS) {
    const f = {
      hour: k.hour,
      key: k.key,
      sun: k.sun ?? prev.sun,
      moon: k.moon ?? prev.moon,
    };
    for (const n of COLOR_FIELDS) f[n] = k[n] !== undefined ? C(k[n]) : prev[n];
    for (const n of VEC_FIELDS) f[n] = k[n] !== undefined ? k[n] : prev[n];
    for (const n of NUM_FIELDS) f[n] = k[n] !== undefined ? k[n] : prev[n];
    out.push(f);
    prev = f;
  }
  return out;
})();

function dirFrom(az, el, out) {
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  const ce = Math.cos(e);
  return out.set(Math.sin(a) * ce, Math.sin(e), -Math.cos(a) * ce).normalize();
}

function angleLerp(a, b, t) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Create the environment state. `env` is a single mutable object — modules hold
 * a reference to it and read whatever is current; they are told via `applyEnv`
 * when it has changed enough to matter.
 */
export function createTimeOfDay({ hour = 12, seed = 1 } = {}) {
  const env = {
    key: 'day', hour, dayFactor: 1, nightFactor: 0,
    sunDir: new THREE.Vector3(), moonDir: new THREE.Vector3(), keyDir: new THREE.Vector3(),
    keyColor: new THREE.Color(), keyIntensity: 1,
    seed,
  };
  for (const n of COLOR_FIELDS) env[n] = new THREE.Color();
  for (const n of VEC_FIELDS) env[n] = new THREE.Vector3();
  for (const n of NUM_FIELDS) env[n] = 0;

  const state = { hour, target: hour, speed: 0, dirty: true, version: 0 };

  function bracket(h) {
    const t = ((h % 24) + 24) % 24;
    let i = 0;
    for (let k = 0; k < FRAMES.length; k++) if (FRAMES[k].hour <= t) i = k;
    const a = FRAMES[i];
    const b = FRAMES[(i + 1) % FRAMES.length];
    const span = (b.hour - a.hour + 24) % 24 || 24;
    const f = span > 0 ? (((t - a.hour) + 24) % 24) / span : 0;
    return [a, b, Math.min(1, Math.max(0, f))];
  }

  function evaluate(h) {
    const [a, b, raw] = bracket(h);
    const f = smootherstep(raw);
    env.hour = ((h % 24) + 24) % 24;
    env.key = f < 0.5 ? a.key : b.key;

    for (const n of COLOR_FIELDS) env[n].copy(a[n]).lerp(b[n], f);
    for (const n of VEC_FIELDS) env[n].copy(a[n]).lerp(b[n], f);
    for (const n of NUM_FIELDS) env[n] = a[n] + (b[n] - a[n]) * f;

    dirFrom(angleLerp(a.sun.az, b.sun.az, f), a.sun.el + (b.sun.el - a.sun.el) * f, env.sunDir);
    dirFrom(angleLerp(a.moon.az, b.moon.az, f), a.moon.el + (b.moon.el - a.moon.el) * f, env.moonDir);

    // Fade the key light out as its body sinks; keep a sliver of it so the
    // horizon does not snap when the sun crosses zero.
    const sunUp = Math.min(1, Math.max(0, (env.sunDir.y + 0.10) / 0.16));
    const moonUp = Math.min(1, Math.max(0, (env.moonDir.y + 0.05) / 0.12));
    env.sunIntensity *= sunUp;
    env.moonIntensity *= moonUp;

    env.dayFactor = Math.min(1, Math.max(0, (env.sunDir.y + 0.06) / 0.22));
    env.nightFactor = 1 - env.dayFactor;

    const sunWins = env.sunIntensity >= env.moonIntensity;
    env.keyDir.copy(sunWins ? env.sunDir : env.moonDir);
    env.keyColor.copy(sunWins ? env.sunColor : env.moonColor);
    env.keyIntensity = sunWins ? env.sunIntensity : env.moonIntensity;
    state.version++;
    return env;
  }

  evaluate(hour);

  return {
    env,
    get hour() { return state.hour; },
    get version() { return state.version; },
    /** Jump straight to an hour or a named preset. */
    set(hourOrName) {
      const h = typeof hourOrName === 'string' ? (PRESET_HOURS[hourOrName] ?? 12) : hourOrName;
      state.hour = state.target = h;
      evaluate(h);
    },
    /** Ease toward an hour over `seconds` — used by the time-of-day key. */
    glideTo(hourOrName, seconds = 2.5) {
      const h = typeof hourOrName === 'string' ? (PRESET_HOURS[hourOrName] ?? 12) : hourOrName;
      state.target = h;
      state.glide = seconds;
      state.glideT = 0;
      state.glideFrom = state.hour;
    },
    /** Hours per real second. 0 freezes the sky, which is what captures want. */
    setRate(hoursPerSecond) { state.speed = hoursPerSecond; },
    get rate() { return state.speed; },
    update(dt) {
      if (state.glide !== undefined) {
        state.glideT += dt;
        const t = Math.min(1, state.glideT / state.glide);
        let d = ((state.target - state.glideFrom + 36) % 24) - 12;
        state.hour = state.glideFrom + d * smootherstep(t);
        if (t >= 1) { state.hour = state.target; state.glide = undefined; }
        evaluate(state.hour);
      } else if (state.speed !== 0) {
        state.hour += state.speed * dt;
        evaluate(state.hour);
      }
    },
  };
}
