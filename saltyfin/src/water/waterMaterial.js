// The surface shader.
//
// GLSL1 in a plain ShaderMaterial (three compiles it fine on WebGL2, and the
// GLSL3 path silently breaks three's own fog/shadow chunks). It does its own
// lighting and its own distance fade, so it needs neither.
//
// What happens per pixel, in order:
//   normal      shared Gerstner train + three drifting layers of a tiling
//               gradient map + the boat's ripple field, flattened with distance
//   refraction  screen-space, offset by the view-space normal, rejected when
//               the offset lands on something nearer than the surface
//   column      the seabed's world position reconstructed from the refraction
//               depth buffer -> a real water-column length for Beer-Lambert and
//               a real world XZ to project the caustics onto
//   reflection  the mirrored-camera target, U-flipped, blended by Schlick
//   light path  a specular lobe toward the key plus a world-anchored stochastic
//               glitter that twinkles as the wave passes under it
//   foam        shore (thin column), crest (Gerstner Jacobian), wake
//
// Every colour is env's. The only things this file chooses are how much of each.

import * as THREE from 'three';
import { GLSL } from '../core/glsl.js';
import { WAVES_GLSL, packWaves } from './waves.js';
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

const VERTEX = /* glsl */`
${WAVES_GLSL}

uniform float uTime;
uniform float uWind;
uniform sampler2D tDepthMap;
uniform vec2  uDepthOrigin;
uniform float uDepthInvExtent;
uniform float uDepthMax;

varying vec3  vWorld;
varying vec2  vFlat;
varying float vShore;
varying float vBedDepth;
varying float vJac;
varying float vCrest;
varying float vDist;

void main(){
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 p = wp.xz;
  vFlat = p;

  // Water depth from the coarse seabed map: waves flatten as they run up the
  // reef instead of clipping through it, and the CPU sampler uses the same
  // field so the hull floats on the crest you can see.
  vec2 duv = (p - uDepthOrigin) * uDepthInvExtent + 0.5;
  float depth = texture2D(tDepthMap, clamp(duv, vec2(0.0), vec2(1.0))).r;
  depth = depth * depth * uDepthMax;
  vec2 outside = step(vec2(1.0), abs(duv - 0.5) * 2.0);
  depth = mix(depth, uDepthMax, max(outside.x, outside.y));
  float shore = 0.10 + 0.90 * smoothstep(0.20, 3.0, depth);
  vShore = shore;
  vBedDepth = depth;

  vec3 g = gerstner(p, uTime, uWind, shore);
  vec3 world = vec3(p.x + g.x, g.y, p.y + g.z);
  vCrest = g.y;

  // Jacobian of the horizontal pinch. Where it collapses the crest is being
  // squeezed to a point — that is where a real wave throws foam.
  float jxx = 1.0, jzz = 1.0, jxz = 0.0;
  for(int i=0;i<WAVE_COUNT;i++){
    vec2 d = uWaveA[i].xy;
    float k = uWaveA[i].z;
    float a = uWaveA[i].w * uWind * shore;
    float q = uWaveB[i].x * a * k * sin(k*dot(d,p) - uWaveB[i].y*uTime);
    jxx -= q * d.x * d.x;
    jzz -= q * d.y * d.y;
    jxz -= q * d.x * d.y;
  }
  vJac = jxx * jzz - jxz * jxz;

  vWorld = world;
  vDist = length(world - cameraPosition);

  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  // The disc runs past the far plane on purpose so the water reaches the true
  // horizon; clamp z so the far ring is never clipped into a sliver of sky.
  gl_Position.z = min(gl_Position.z, gl_Position.w * 0.999995);
}
`;

const FRAGMENT = /* glsl */`
${GLSL.constants}
${GLSL.util}
${GLSL.hash}
${GLSL.worley}
${WAVES_GLSL}

uniform float uTime;
uniform float uWind;

uniform sampler2D tRefraction;
uniform sampler2D tRefractionDepth;
uniform sampler2D tReflection;
uniform sampler2D tCaustic;
uniform sampler2D tDetail;
uniform sampler2D tWake;

uniform vec2  uResolution;
uniform float uNear;
uniform float uFar;

uniform vec3  uAbsorb;
uniform vec3  uScatter;
uniform vec3  uShallow;
uniform vec3  uMid;
uniform vec3  uDeep;

uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform float uHorizonGlow;

uniform vec3  uKeyDir;
uniform vec3  uKeyColor;
uniform float uKeyIntensity;
uniform vec3  uAmbient;
uniform float uAmbIntensity;
uniform float uDayFactor;

uniform float uSpecular;
uniform float uRoughness;
uniform float uGlitter;
uniform float uGlitterSize;
uniform vec3  uGlitterColor;
uniform float uReflStrength;
uniform float uReflEnabled;
uniform float uCaustic;
uniform float uCausticScale;
uniform vec3  uFoamTint;
uniform float uFoamBright;

uniform vec2  uWakeCenter;
uniform float uWakeWorld;
uniform float uWakeTexel;
uniform float uWakeSlope;
uniform float uWakeArmSlope;
uniform float uWakeFoam;
uniform float uWakeArmFoam;

uniform float uDetailStrength;
uniform float uRefractDistort;
uniform float uReflDistort;
uniform float uScatterStrength;
uniform float uShoreFoamDepth;

varying vec3  vWorld;
varying vec2  vFlat;
varying float vShore;
varying float vBedDepth;
varying float vJac;
varying float vCrest;
varying float vDist;

const mat2 CAUSTIC_ROT = mat2(0.8253, -0.5647, 0.5647, 0.8253);

// Window depth -> positive metres along the camera's forward axis.
float linearDepth(float d){
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

vec3 skyAt(vec3 dir){
  float h = sat(dir.y);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(h, 0.42));
  vec2 fd = normalize(vec2(dir.x, dir.z) + 1e-5);
  vec2 kd = normalize(vec2(uKeyDir.x, uKeyDir.z) + 1e-5);
  float g = pow(sat(dot(fd, kd)), 5.0) * (1.0 - h);
  return c + uSkyHorizon * g * uHorizonGlow * 0.45;
}

void main(){
  vec2 suv = gl_FragCoord.xy / uResolution;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uKeyDir);
  float dist = vDist;

  // --- surface normal -----------------------------------------------------
  vec3 N = gerstnerNormal(vFlat, uTime, uWind, vShore);
  vec2 ng = vec2(-N.x, -N.z) / max(N.y, 1e-3);

  vec4 d0 = texture2D(tDetail, vFlat * 0.285 + vec2( 0.021, -0.034) * uTime);
  vec4 d1 = texture2D(tDetail, vFlat * 0.110 + vec2(-0.016,  0.012) * uTime);
  vec4 d2 = texture2D(tDetail, vFlat * 0.043 + vec2( 0.008,  0.006) * uTime);
  float ripFade = 1.0 - smoothstep(140.0, 900.0, dist);
  vec2 grad = (d0.rg * 2.0 - 1.0) * 0.85
            + (d1.rg * 2.0 - 1.0) * 0.55
            + (d2.rg * 2.0 - 1.0) * 0.34;
  ng += grad * (uDetailStrength * ripFade);
  float breakup = d0.a * 0.45 + d1.a * 0.33 + d2.a * 0.22;

  // --- the boat's ripple field --------------------------------------------
  vec2 wuv = (vFlat - uWakeCenter) / uWakeWorld + 0.5;
  vec2 wa = smoothstep(vec2(0.0), vec2(0.05), wuv);
  vec2 wb = 1.0 - smoothstep(vec2(0.95), vec2(1.0), wuv);
  float wmask = wa.x * wa.y * wb.x * wb.y;
  vec4 wC = texture2D(tWake, wuv);
  vec4 wL = texture2D(tWake, wuv - vec2(uWakeTexel, 0.0));
  vec4 wR = texture2D(tWake, wuv + vec2(uWakeTexel, 0.0));
  vec4 wD = texture2D(tWake, wuv - vec2(0.0, uWakeTexel));
  vec4 wU = texture2D(tWake, wuv + vec2(0.0, uWakeTexel));
  ng += vec2(wR.r - wL.r, wU.r - wD.r) * (uWakeSlope * wmask);
  ng += vec2(wR.a - wL.a, wU.a - wD.a) * (uWakeArmSlope * wmask);

  N = normalize(vec3(-ng.x, 1.0, -ng.y));
  // Filtered normal: flatten and roughen with distance or the far water boils.
  float flatten = smoothstep(90.0, 1500.0, dist);
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), flatten * 0.88));
  float rough = mix(uRoughness, 0.34, smoothstep(30.0, 900.0, dist));

  // Screen-space offsets must come from how far the normal has been bent away
  // from flat, not from the normal itself — the latter is a constant slide of
  // the whole image with no wobble in it at all.
  vec3 Nv = (viewMatrix * vec4(N, 0.0)).xyz;
  vec2 bend = Nv.xy - (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xy;

  // Foam is a diffuse white scatterer lit by the whole dome, so it must not
  // collapse when the key drops to the horizon — at sunset the wake is still
  // the brightest thing outside the light path.
  float foamLight = uAmbIntensity * 0.85 + uKeyIntensity * 0.40 * sat(L.y * 1.5 + 0.12);
  vec3  foamCol = uFoamTint * (uFoamBright * (0.45 + foamLight));

  // --- the view from underneath -------------------------------------------
  if (!gl_FrontFacing) {
    // Snell's window: the whole sky squeezed into a 97 degree cone, and outside
    // it the underside of the surface turns into a mirror of the gloom below.
    vec3 up = -V;
    float win = smoothstep(0.52, 0.80, sat(dot(up, N)));
    vec3 through = skyAt(normalize(mix(vec3(0.0, 1.0, 0.0), up, 0.6)));
    vec3 gloom = uDeep * 0.70 + uScatter * 0.30;
    vec3 col = mix(gloom, through * 1.15, win);
    col += uKeyColor * uKeyIntensity * pow(sat(dot(up, L)), 60.0) * win * 1.2;
    float wf = sat(wC.b * uWakeFoam + wC.a * uWakeArmFoam) * wmask;
    col = mix(col, foamCol * 0.5, sat(wf) * 0.55);
    col = mix(col, gloom * 0.55, smoothstep(10.0, 140.0, dist));
    // Modulate after the distance blend, or the far ceiling reads as a flat wall.
    col *= 0.78 + 0.52 * sat(N.y * 0.4 + vCrest * 1.8 + 0.45);
    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    return;
  }

  vec3 RD = normalize(vWorld - cameraPosition);
  vec3 camF = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float cosA = max(dot(RD, camF), 1e-3);

  // --- refraction ----------------------------------------------------------
  float bed0 = linearDepth(texture2D(tRefractionDepth, suv).x) / cosA;
  float column0 = max(bed0 - dist, 0.0) * max(-RD.y, 0.06);

  float distort = uRefractDistort * sat(column0 * 0.7) / (1.0 + dist * 0.045);
  vec2 ruv = clamp(suv + bend * distort, vec2(0.002), vec2(0.998));
  float bed1 = linearDepth(texture2D(tRefractionDepth, ruv).x) / cosA;
  // If the offset sample sits in front of the surface it is something above the
  // water leaking in — fall back to the straight sample.
  float ok = step(dist, bed1);
  vec2  fuv = mix(suv, ruv, ok);
  float bedDist = mix(bed0, bed1, ok);

  vec3 refr = texture2D(tRefraction, fuv).rgb;
  vec3 bedWorld = cameraPosition + RD * bedDist;
  float path = max(bedDist - dist, 0.0);
  float column = max(vWorld.y - bedWorld.y, 0.0);
  float hasBed = 1.0 - smoothstep(2200.0, 4200.0, bedDist);

  // --- caustics on the seabed, in world XZ ---------------------------------
  vec2 cuv = bedWorld.xz * uCausticScale;
  vec3 c1 = texture2D(tCaustic, cuv).rgb;
  vec3 c2 = texture2D(tCaustic, CAUSTIC_ROT * cuv * 0.61 + vec2(0.37, 0.11)).rgb;
  // Caustics MODULATE the seabed, they do not add to it. Written as a gain
  // around 1.0: the bright filaments roughly double the sand, the gaps darken
  // it slightly, and the mean stays put. Adding an unbounded product instead
  // (which is the obvious way to write this) multiplies the reef by three or
  // four and the whole bay comes back as a sheet of white lace.
  vec3 caus = (c1 + c2) * 0.5 + c1 * c2 * 1.4;
  float causFade = hasBed * (1.0 - smoothstep(1.5, 13.0, column)) * sat(L.y * 2.4);
  vec3 causGain = 1.0 + (caus - 0.42) * (1.35 * uCaustic * causFade);
  refr *= max(causGain, vec3(0.55));
  refr += max(caus - 0.55, vec3(0.0)) * uKeyColor * (0.10 * uCaustic * causFade);

  // --- the water column ----------------------------------------------------
  vec3 trans = exp(-uAbsorb * (path + column * 0.65));
  vec3 body = mix(mix(uShallow, uMid, smoothstep(0.15, 2.4, column)),
                  uDeep, smoothstep(2.4, 14.0, column));
  vec3 inScatter = mix(body, uScatter, 0.28);
  vec3 col = refr * trans + inScatter * (1.0 - trans);

  // A body the size of the leviathan blocks the light coming up through the
  // column, so the water directly above it scatters less back at the camera.
  // Without this the animal is physically correct and dramatically useless:
  // twenty metres of water absorbs ninety per cent of its silhouette and ref/04
  // never happens. The test is deliberately narrow — it fires only where the
  // thing under the water is far darker than the water itself, which is true of
  // the creature and of nothing else in the bay. Sand and reef sit well above
  // the deep-water body colour and never trip it.
  float refrL = dot(refr, vec3(0.2126, 0.7152, 0.0722));
  float scatL = dot(inScatter, vec3(0.2126, 0.7152, 0.0722));
  float bodyDark = sat(1.0 - refrL / max(scatL, 1e-4));
  float bodyOcc = smoothstep(0.42, 0.86, bodyDark) * hasBed
                * (1.0 - smoothstep(24.0, 46.0, column));
  col *= 1.0 - 0.60 * bodyOcc;

  // --- reflection ----------------------------------------------------------
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.010);
  vec3 sky = skyAt(R);
  // Reflections stretch vertically at grazing incidence; without the stretch a
  // mirrored island reads as a hard-edged decal lying on the water.
  float rd = uReflDistort / (1.0 + dist * 0.012);
  vec2 rv = clamp(suv + vec2(bend.x, bend.y * 1.8) * rd, vec2(0.002), vec2(0.998));
  vec3 refl = texture2D(tReflection, vec2(1.0 - rv.x, rv.y)).rgb;
  refl = mix(sky, refl, uReflEnabled * uReflStrength);

  float F = fresnelSchlick(max(dot(N, V), 0.0), 0.02);
  col = mix(col, refl, F);

  // --- back-lit crests: the jade glow inside a wave ------------------------
  float wrap = sat(dot(V, -L) * 0.6 + 0.4);
  float sss = pow(wrap, 3.0) * sat(vCrest * 2.6) * sat(1.0 - N.y * 0.4);
  col += uScatter * (sss * uScatterStrength * (0.5 + 0.7 * uKeyIntensity));

  // --- foam ----------------------------------------------------------------
  // Shore foam asks the SEABED how deep it is here, not the refraction buffer.
  // The refraction pass contains the boat's own submerged hull, so a column
  // reconstructed from it reads a few centimetres deep right around the
  // waterline and every hull in the bay wore a white foam blob.
  float colEff = vBedDepth - vCrest * 0.8;
  float shore = 1.0 - smoothstep(0.0, uShoreFoamDepth, colEff);
  shore = smoothstep(0.42, 0.88, shore * 1.2 - breakup * 0.5 + 0.14);
  // The bright line right at the waterline. Narrow — it is an edge, not a band.
  shore += exp(-abs(colEff - 0.06) * 16.0) * 0.42;
  shore *= hasBed;

  // The Jacobian of this (gentle, sheltered-bay) train only dips to about 0.87,
  // so the threshold has to sit inside that range or crest foam never fires —
  // but sitting too low fires it across the whole bay and the water turns to
  // milk. Only the sharpest few per cent of crests get foam.
  float crest = 1.0 - smoothstep(0.905, 0.975, vJac);
  crest = smoothstep(0.38, 0.92, crest * 1.15 - breakup * 0.55 + 0.16) * 0.75;

  // Churn is the persistent trail, arms are the current V. Both are cut into
  // curls by the world-space noise rather than filled — the art has a lace of
  // fine white loops behind the transom, never a solid streak.
  float lace = 0.40 + 1.25 * breakup;
  float churn = wC.b * uWakeFoam * wmask;
  float arms = wC.a * uWakeArmFoam * wmask;
  float wake = smoothstep(0.32, 1.10, churn * lace) * 0.9
             + smoothstep(0.26, 0.80, arms * lace);

  float foam = sat(sat(shore) + crest + sat(wake));
  // Texture inside the foam, so a splash reads as churned water and not a plate.
  col = mix(col, foamCol * (0.70 + 0.58 * breakup), foam);

  // --- the light path ------------------------------------------------------
  vec3 H = normalize(V + L);
  float ndh = max(dot(N, H), 1e-5);
  float shin = min(2.0 / max(rough * rough, 1e-4) - 2.0, 2048.0);
  float core = pow(ndh, shin) * (shin + 2.0) * 0.02;
  float broad = pow(ndh, 28.0);
  float sheen = pow(ndh, 9.0);

  // Sparkles hold still in world space and twinkle as the wave passes under
  // them. Cubing the phase keeps most cells dark most of the time, which is
  // what makes a path read as a scatter of points rather than a wash.
  vec2 gp = vFlat / max(uGlitterSize, 0.05);
  vec3 cell = worley(gp * 2.2 + vec2(uTime * 0.021, -uTime * 0.017));
  float tw = sin(uTime * (2.6 + cell.z * 11.0) + cell.z * 57.0) * 0.5 + 0.5;
  float sparkle = pow(1.0 - smoothstep(0.0, 0.20, cell.x), 7.0) * tw * tw * tw;
  sparkle *= 1.0 - smoothstep(140.0, 620.0, dist);

  float keyUp = sat(L.y * 8.0);
  float grazing = mix(0.35, 1.0, F);
  // Trimmed hard from where this started. The glitter has to survive being
  // pushed above 1.0 for the bloom, but at grazing angles the far half of the
  // bay is all glitter and it burns out into a white sheet.
  vec3 spec = uKeyColor * (core * uSpecular * 0.20)
            + uGlitterColor * ((broad * (0.12 + sparkle * 3.1) + sheen * 0.035) * uGlitter);
  spec *= uKeyIntensity * keyUp * grazing * (1.0 - foam * 0.3);

  // --- horizon -------------------------------------------------------------
  float fog = sat((dist - uFogNear) / max(uFogFar - uFogNear, 1.0));
  fog = fog * fog * (3.0 - 2.0 * fog);
  col = mix(col, mix(uFogColor, uSkyHorizon, 0.42), fog);
  col += spec * (1.0 - fog * 0.55);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

/**
 * The surface material. `depthTexture` is the coarse seabed map built by
 * surface.js; everything else arrives later through setTargets/applyEnv.
 */
export function createWaterMaterial({
  renderer, seed = 1, quality = null,
  depthTexture = null, depthExtent = 1120, depthMax = 64,
  wakeSize = 256, wakeWorld = 128, detailSize = 256,
} = {}) {
  const detail = buildDetailTexture(detailSize, seed ^ 0x5f3a91);
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
  detail.anisotropy = Math.min(8, maxAniso || 1);

  const packed = packWaves(1, 1);

  const uniforms = {
    uWaveA: { value: packed.a },
    uWaveB: { value: packed.b },
    uTime: { value: 0 },
    uWind: { value: 1 },

    tRefraction: { value: null },
    tRefractionDepth: { value: null },
    tReflection: { value: null },
    tCaustic: { value: null },
    tDetail: { value: detail },
    tWake: { value: null },
    tDepthMap: { value: depthTexture },

    uDepthOrigin: { value: new THREE.Vector2(0, 0) },
    uDepthInvExtent: { value: 1 / depthExtent },
    uDepthMax: { value: depthMax },

    uResolution: { value: new THREE.Vector2(1280, 720) },
    uNear: { value: 0.35 },
    uFar: { value: 6000 },

    uAbsorb: { value: new THREE.Vector3(0.33, 0.07, 0.042) },
    uScatter: { value: new THREE.Color(0x22acbc) },
    uShallow: { value: new THREE.Color(0x63e2d4) },
    uMid: { value: new THREE.Color(0x23bec6) },
    uDeep: { value: new THREE.Color(0x0a4ea4) },

    uFogColor: { value: new THREE.Color(0xaadaf2) },
    uFogNear: { value: 260 },
    uFogFar: { value: 2000 },
    uSkyZenith: { value: new THREE.Color(0x1361d2) },
    uSkyHorizon: { value: new THREE.Color(0xc6e7f8) },
    uHorizonGlow: { value: 0.48 },

    uKeyDir: { value: new THREE.Vector3(0.4, 0.8, -0.45) },
    uKeyColor: { value: new THREE.Color(0xfff6e2) },
    uKeyIntensity: { value: 3.7 },
    uAmbient: { value: new THREE.Color(0xa2cef2) },
    uAmbIntensity: { value: 1 },
    uDayFactor: { value: 1 },

    uSpecular: { value: 1 },
    uRoughness: { value: 0.06 },
    uGlitter: { value: 0.85 },
    uGlitterSize: { value: 1 },
    uGlitterColor: { value: new THREE.Color(0xfffcf0) },
    uReflStrength: { value: 0.92 },
    uReflEnabled: { value: quality && quality.reflections === false ? 0 : 1 },
    uCaustic: { value: 1 },
    uCausticScale: { value: 1 / 8.5 },
    uFoamTint: { value: new THREE.Color(0xffffff) },
    uFoamBright: { value: 1 },

    uWakeCenter: { value: new THREE.Vector2() },
    uWakeWorld: { value: wakeWorld },
    uWakeTexel: { value: 1 / wakeSize },
    uWakeSlope: { value: 5.5 },
    uWakeArmSlope: { value: 1.6 },
    uWakeFoam: { value: 1.25 },
    uWakeArmFoam: { value: 0.32 },

    uDetailStrength: { value: 0.22 },
    uRefractDistort: { value: 0.26 },
    uReflDistort: { value: 0.12 },
    uScatterStrength: { value: 0.85 },
    uShoreFoamDepth: { value: 0.72 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
    lights: false,
  });
  material.name = 'SaltyFinWater';

  return {
    material,
    uniforms,
    detailTexture: detail,
    dispose() {
      material.dispose();
      detail.dispose();
    },
  };
}

export { buildDetailTexture };
