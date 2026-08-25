// The water the wake is drawn on.
//
// Deliberately plain: a few sine swells plus a little chop, so that anything
// that looks interesting in a screenshot is coming from the wake and not from
// the ocean dressing it up.
//
// Everything the wake contributes arrives through one texture lookup, and the
// surface normal is central-differenced from the same height function used for
// displacement — so the ridge shading and the geometry can never disagree.

import * as THREE from 'three';
import { get } from './params.js';
import { NOISE_GLSL } from './noise.js';
import { SKY_GLSL } from './sky.js';

const HEIGHT_GLSL = /* glsl */`
  uniform sampler2D uWake;
  uniform vec2  uWakeCenter;
  uniform float uWakeExtent;
  uniform float uWakeTexels;
  uniform float uSwellAmp, uSwellLen, uChopAmp, uTime, uFlatten;
  uniform vec3  uEyePos;
  uniform float uVertexStep;
  uniform vec2  uPlaneC;
  uniform float uPlaneR;

  vec2 wakeUV(vec2 p){ return (p - uWakeCenter) / uWakeExtent * vec2(1.0, -1.0) + 0.5; }

  // Smoothed bilinear. Plain bilinear is only C0 -- its iso-contours run along
  // texel diagonals, and the foam threshold turns that into a sawtooth along
  // every edge as soon as a texel covers more than a pixel or two. Easing the
  // fractional part before the lookup makes the interpolation C1 for the cost
  // of a few instructions and one unchanged fetch.
  vec2 smoothUV(vec2 uv){
    vec2 t = uv * uWakeTexels - 0.5;
    vec2 i = floor(t), f = fract(t);
    f = f * f * (3.0 - 2.0 * f);
    return (i + 0.5 + f) / uWakeTexels;
  }

  vec4 wakeAt(vec2 p){
    vec2 uv = wakeUV(p);
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
    // Feather the field edge so the wake doesn't end on a straight cut.
    vec2 e = smoothstep(vec2(0.0), vec2(0.03), uv) * (1.0 - smoothstep(vec2(0.97), vec2(1.0), uv));
    return texture2D(uWake, smoothUV(uv)) * (e.x * e.y);
  }

  // px: the world-space width of one screen pixel here. Any wave shorter than a
  // couple of pixels is just a moire generator, so it is faded out.
  //
  // Returns height in .x and the surface gradient in .yz. The gradient is
  // analytic -- these are sums of sines, so differentiating them costs one cos
  // per term instead of four extra evaluations of the whole function.
  // Beyond this plane lies the flat far water. Fading the waves out towards the
  // rim makes the two meet without a square edge in the middle of the sea.
  float planeFade(vec2 p){
    return 1.0 - smoothstep(uPlaneR * 0.60, uPlaneR * 0.97, distance(p, uPlaneC));
  }

  vec3 swellHG(vec2 p, float px){
    // A wave carried by a mesh needs roughly eight vertices across it before it
    // stops looking like faceting, so the cutoff is tight: at 0.93 m spacing the
    // 4 m chop was scalloping into a visible corduroy across the whole plane.
    float lod  = 1.0 - smoothstep(0.055, 0.19, px / max(uSwellLen * 0.17, 0.5));
    float lodS = 1.0 - smoothstep(0.055, 0.19, px / max(uSwellLen, 1.0));
    float k  = 6.28318 / max(uSwellLen, 1.0);
    float kc = 6.28318 / (max(uSwellLen, 1.0) * 0.17);

    // Each wave: (kx, kz, amplitude, phase).
    vec2 k1 = vec2( 0.86,  0.51) * k;          float a1 = uSwellAmp * lodS;
    vec2 k2 = vec2(-0.42,  1.13) * k * 1.27;   float a2 = uSwellAmp * 0.55 * lodS;
    vec2 k7 = vec2( 1.19, -0.63) * k * 0.71;   float a7 = uSwellAmp * 0.42 * lodS;
    vec2 k8 = vec2(-0.94, -0.88) * k * 1.61;   float a8 = uSwellAmp * 0.30 * lodS;
    // Four chop components, not two, on deliberately unrelated headings and
    // incommensurate frequencies. Two crossed sines beat into a visible grid --
    // which stayed hidden only while the sun was switched off.
    vec2 k3 = vec2( 1.10,  0.70) * kc;         float a3 = uChopAmp * lod;
    vec2 k4 = vec2(-0.60,  1.40) * kc * 1.31;  float a4 = uChopAmp * 0.72 * lod;
    vec2 k5 = vec2( 0.24, -1.32) * kc * 0.79;  float a5 = uChopAmp * 0.62 * lod;
    vec2 k6 = vec2(-1.36, -0.31) * kc * 1.73;  float a6 = uChopAmp * 0.44 * lod;

    float p1 = dot(p, k1) - uTime * 0.55;
    float p2 = dot(p, k2) - uTime * 0.79;
    float p3 = dot(p, k3) - uTime * 2.40;
    float p4 = dot(p, k4) - uTime * 3.10;
    float p7 = dot(p, k7) - uTime * 0.63;
    float p8 = dot(p, k8) - uTime * 0.91;
    float p5 = dot(p, k5) - uTime * 2.07;
    float p6 = dot(p, k6) - uTime * 3.83;

    float h = a1 * sin(p1) + a2 * sin(p2) + a3 * sin(p3) + a4 * sin(p4)
            + a5 * sin(p5) + a6 * sin(p6) + a7 * sin(p7) + a8 * sin(p8);
    vec2 g = a1 * cos(p1) * k1 + a2 * cos(p2) * k2 + a3 * cos(p3) * k3
           + a4 * cos(p4) * k4 + a5 * cos(p5) * k5 + a6 * cos(p6) * k6
           + a7 * cos(p7) * k7 + a8 * cos(p8) * k8;
    float ef = planeFade(p);
    return vec3(h, g) * ef;
  }

  float swellAt(vec2 p, float px){ return swellHG(p, px).x; }

  // One height function, used for both displacement and normals.
  // Swell flattening is derived rather than stored: water is flattened because
  // it is churned, so foam and bubbles already say where. That frees the field
  // texture's B channel to carry how much of the bubble cloud has surfaced.
  float wakeFlatten(vec4 w){
    return clamp((w.r * 1.25 + w.a * 1.55) * uFlatten, 0.0, 1.0);
  }

  float heightAt(vec2 p, float px){
    vec4 w = wakeAt(p);
    return swellAt(p, px) * (1.0 - wakeFlatten(w)) + w.g;
  }
`;

const VERT = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  ${HEIGHT_GLSL}
  void main(){
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    wp.y = heightAt(wp.xz, uVertexStep);
    vWorld = wp;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  ${HEIGHT_GLSL}
  ${NOISE_GLSL}
  uniform vec3  uSunDir, uDeep, uSky, uHorizon;
  uniform float uSpecular, uExposure, uFar, uSheen, uHazeStart, uSunGlow, uReflect;
  uniform vec3  uZenith;
  ${SKY_GLSL}
  uniform float uFoamDensity, uTranslucency, uAeration, uRelief, uTroughBias, uWarmth;
  uniform float uLaceScale, uLaceAmt, uSoftness;
  uniform float uBubBright, uMilk, uDeepTint;
  uniform float uDrift, uRingAmt, uRingScale, uRingSpeed, uRingWidth, uRingRelief, uBoil;
  uniform float uCellGrow, uCoarsen, uRideWaves;
  uniform vec3  uBubCol;
  #define uEye uEyePos

  void main(){
    // How wide is one pixel, here, in metres? Everything that needs a level of
    // detail hangs off this rather than off distance -- which is what makes it
    // hold up both from 20 m up and from 400 m up.
    float px = max(length(vec2(dFdx(vWorld.x), dFdy(vWorld.x))),
                   length(vec2(dFdx(vWorld.z), dFdy(vWorld.z))));
    float dist = distance(vWorld.xz, uEye.xz);   // horizontal: this is a haze, not a depth fade
    // Two footprints, deliberately. Waves cannot be shown finer than the mesh
    // that carries them, so their level of detail is floored at the vertex
    // spacing. Foam lace is pure shading with no geometry behind it, so it uses
    // the true screen footprint and stays crisp at any zoom.
    float pxRaw = px;
    px = max(px, uVertexStep);
    float e = max(0.18, px * 1.2);

    // Swell: height and slope in one evaluation.
    vec3 sw = swellHG(vWorld.xz, px);

    // Wake: only the texture needs differencing, and these are cache-friendly
    // fetches from a small target rather than another pass over the waves.
    vec4 w  = wakeAt(vWorld.xz);
    vec2 tL = wakeAt(vWorld.xz - vec2(e, 0.0)).rg;
    vec2 tR = wakeAt(vWorld.xz + vec2(e, 0.0)).rg;
    vec2 tD = wakeAt(vWorld.xz - vec2(0.0, e)).rg;
    vec2 tU = wakeAt(vWorld.xz + vec2(0.0, e)).rg;
    float gL = tL.y, gR = tR.y, gD = tD.y, gU = tU.y;

    // d/dp [ swell * (1 - flatten) + wakeHeight ], with the flatten term
    // folded in as a scale on the swell slope.
    vec2 grad = sw.yz * (1.0 - wakeFlatten(w)) + vec2(gR - gL, gU - gD) / (2.0 * e);
    vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));

    // ------------------------------------------------------- ring ripples --
    // Bursting bubbles and surfacing eddies throw ripples that spread and die.
    // They exist in the water, so they are resolved here, BEFORE it is lit --
    // tilting the surface after the reflection has been computed would change
    // nothing. Gated on churn, which is both where ripples physically come from
    // and what keeps this off the open-water pixels.
    float churnMask = clamp(max(w.r * 1.6, w.a * 1.2), 0.0, 1.0);
    vec2 rings = vec2(0.0);
    if (churnMask > 0.004) {
      rings = ringWarp(vWorld.xz, uTime, uRingScale, uRingSpeed, uRingWidth, uCellGrow) * churnMask;
      N = normalize(N + vec3(rings.x, 0.0, rings.y) * uRingRelief * 0.5);
    }

    vec3 V = normalize(uEye - vWorld);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);

    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
    fres = mix(0.02, 1.0, fres);

    // ------------------------------------------------- subsurface bubbles --
    // These are IN the water, not on it, so they belong to the body colour --
    // resolved before the surface is applied. A bubble plume works like a
    // bright scattering floor: it stops light escaping down into the dark, so
    // the water reads shallow and turquoise, the same reason water over sand
    // does. Crucially the surface above is still water, so it goes on
    // reflecting the sky and catching the sun exactly as it did.
    // Foam floats. It is carried by the orbital motion of whatever is under it
    // -- and by far the biggest waves under it are the wake's OWN, not the
    // ambient swell. So the whole foam field is sampled at a position pushed by
    // the full surface slope, which is why it now surges with the Kelvin crests
    // instead of sitting frozen while they roll out from under it.
    // Scaled well past the literal orbital radius. A water particle really
    // only swings back and forth by about one wave amplitude -- well under a
    // metre here, which is invisible -- but foam sitting dead still while
    // crests roll out from under it reads as painted-on. This exaggerates the
    // surge until the foam is legibly attached to the surface.
    vec2 ride = grad * uRideWaves * 14.0;
    vec4 wF = uRideWaves > 0.001 ? wakeAt(vWorld.xz + ride) : w;

    float bub = clamp(w.a, 0.0, 3.0);
    float scat = 1.0 - exp(-bub * uBubBright * 1.5);

    // How much of this cloud has made it to the top. Light coming back from a
    // cloud still down in the water column has crossed metres of it twice, and
    // water takes the red out first and then the green -- so deep churn reads
    // dark blue-green and only turns pale turquoise once it surfaces.
    float surfaced = clamp(w.b / max(w.a, 1e-4), 0.0, 1.0);
    vec3 deepCol = mix(uBubCol, uDeep * 1.8 + vec3(0.01, 0.10, 0.13), uDeepTint);
    vec3 bubCol = mix(deepCol, uBubCol, surfaced);
    bubCol = mix(bubCol, vec3(0.66, 0.80, 0.82), uMilk * scat * surfaced);
    vec3 body = mix(uDeep, bubCol, scat);

    // Reflection direction, so the sky's own gradient varies with slope rather
    // than being a constant overhead colour.
    vec3 R = reflect(-V, N);
    // At a shallow angle almost all of what you see is reflected sky, which is
    // correct and also why the sea washes out and the wake stops reading. This
    // scales how mirror-like the water is, so that can be dialled back.
    vec3 col = mix(body, skyColour(R), fres * uReflect);

    // Seen from overhead the surface is near normal incidence, where Fresnel is
    // about 2% and hardly varies -- so waves would be invisible on reflection
    // alone. What actually shows them in aerial footage is the sun: a broad
    // sheen off faces tilted toward it, with a tight glint riding on top.
    float ndh = max(dot(N, H), 0.0);
    // Keyed off the RAW screen footprint, not the geometry-floored one. px is
    // floored at the vertex spacing (~0.9 m), which sits far above any sensible
    // cutoff here -- feeding it in switches the sun off completely, at every
    // zoom, and leaves the water matte.
    float lod = 1.0 - smoothstep(0.25, 1.10, pxRaw);
    // The narrow lobe is the mechanism, and it works precisely because it is
    // narrow: with the sun at ~50 degrees and the camera overhead, FLAT water
    // is nowhere near the mirror direction, while a face tilted toward the sun
    // is exactly in it. That is sun glitter, and it separates crests from calm
    // water far better than a broad lobe, which mostly just lifts everything.
    // Specular is a REFLECTION, so it obeys Fresnel like the sky term does.
    // Added unweighted it lit the water at every angle, and from a low chase
    // view that washed the whole sea to a pale grey the wake could not be seen
    // against. Not driven all the way to Fresnel, though: glitter off wave
    // facets is genuinely visible from overhead, where Fresnel is ~2%.
    // Faded at the rim along with the waves: the far sea beyond has no
    // specular at all, so carrying it to the plane's edge leaves a step in
    // brightness exactly on the join.
    float specW = mix(0.30, 1.0, fres) * lod * planeFade(vWorld.xz);
    col += uSky * pow(ndh, 70.0) * uSpecular * specW;
    col += uSky * pow(ndh, 26.0) * uSheen * specW;
    col += body * max(dot(N, L), 0.0) * 0.25;

    // ------------------------------------------------------------------ foam --
    // Foam is a scattering layer sitting IN the water, not a white decal laid
    // over it. Three things follow from that, and together they are what make
    // it mesh with the surface instead of being pasted onto it.

    // 1. Bubbles pool in the troughs and thin over the crests, so the lace
    //    drapes over the swell rather than ignoring it.
    float trough = clamp(-sw.x / max(uSwellAmp, 0.02), -1.0, 1.0);
    float foam = clamp(wF.r, 0.0, 2.0) * (1.0 + trough * uTroughBias);

    // 2. Thin aeration scatters light back as pale teal long before there is
    //    enough of it to read as white. This halo is the wake's soft edge.
    vec3 aerated = mix(uDeep, vec3(0.26, 0.55, 0.60), 0.72);
    col = mix(col, aerated, clamp(foam * 2.2, 0.0, 1.0) * uAeration * 0.55);

    // 3. The lace, shaded per-pixel. Coverage slides a threshold down through a
    //    fine bubble field: dense foam takes all of it, thin foam keeps only the
    //    cell walls, and the transition between the two is the lacy fringe.
    //    Done here rather than baked into the field texture because it is finer
    //    than a texel, and because at this scale it costs nothing on the ~90%
    //    of the screen that is open water.
    float alpha = 0.0;
    vec3 fN = N;
    if (foam > 0.004) {
      // --- motion -------------------------------------------------------
      // Every term here is a bounded local offset. None of them translate, so
      // the lace still belongs to the water rather than sliding over it.

      // Surge with the passing swell. Water in a wave moves in orbits, and the
      // horizontal part of that orbit goes with the surface slope -- which is
      // already in hand from the normal, so this costs nothing.
      // The full surface slope, not just the ambient swell: the wake's own
      // waves are the ones actually passing under this foam.
      vec2 orbit = grad * uDrift * 5.0;

      // The lace is shoved outward as each wavefront sweeps past. Every push
      // returns to zero once its ring has passed, so this distorts the foam
      // without ever transporting it.
      vec2 lp = (vWorld.xz + orbit + rings * uRingAmt) * uLaceScale;

      // Cells burst and re-form in place, by the same circling trick.
      vec2 boil = vec2(cos(uTime * uBoil * 1.7), sin(uTime * uBoil * 1.7)) * uBoil * 0.85;

      // Thinning foam is old foam, and a bubble raft coarsens as it ages -- but
      // that must NOT be done by scaling the sample position by foam. Scaling
      // coordinates by a spatially varying quantity warps the noise along that
      // quantity's gradient, and the lace snaps onto iso-contours of foam,
      // reading as a contour map. Widening the cell walls is safe: it changes
      // how the pattern looks without moving where it is.
      float wall = 0.125 + uCoarsen * 0.085 * (1.0 - clamp(foam, 0.0, 1.0));
      float cells = lattice1(lp + boil, wall);
      float grain = fbm3(lp * 2.6 + 7.0 - boil);
      // Grain-dominant on purpose. The lattice is a ridge function -- bright ON
      // the contour and dark either side -- so thresholding it directly yields
      // nested outlines like a contour map, not cells. It belongs here as an
      // accent on smooth noise; cell SIZE comes from the sampling scale.
      float detail = clamp(grain * 0.68 + cells * 0.46, 0.0, 1.0);

      // Sub-pixel lace would alias into sparkle, so it fades toward flat
      // coverage as a cell drops below a couple of pixels.
      float cell = 1.0 / max(uLaceScale, 0.001);
      float crisp = 1.0 - smoothstep(0.22, 0.75, pxRaw / cell);
      detail = mix(0.5, detail, crisp);

      float b = max(uSoftness, 0.02);
      float lace = smoothstep(1.0 - foam - b, 1.0 - foam + b, detail);

      // Opacity accumulates exponentially with how much foam is present
      // (Beer-Lambert), so it approaches white asymptotically and never lands
      // on a hard cut-out edge the way a bare threshold does.
      alpha = 1.0 - exp(-lace * foam * uFoamDensity * mix(1.0, 1.6, uLaceAmt));

      // The cell walls stand slightly proud, so they catch the light.
      vec2 lgrad = vec2(dFdx(lace), dFdy(lace)) / max(pxRaw, 1e-4);
      fN = normalize(N + vec3(-lgrad.x, 0.0, -lgrad.y) * uRelief * 0.06);
    }

    float fLambert = 0.55 + 0.45 * max(dot(fN, L), 0.0);

    // Foam keeps some of the colour of the water beneath it, which is what
    // stops thin lace from reading as paint.
    vec3 white = mix(vec3(0.94, 0.965, 0.99), vec3(1.0, 0.97, 0.92), uWarmth);
    vec3 foamCol = mix(white, col, uTranslucency * (1.0 - smoothstep(0.45, 1.3, foam)));
    foamCol *= fLambert;

    col = mix(col, foamCol, alpha);

    // Haze on the SAME schedule as the far water behind it -- keyed over
    // kilometres, not hundreds of metres. Tied to the plane's own size it
    // saturated a few hundred metres out, turning the whole sea flat grey the
    // moment the camera gained any altitude, and leaving the detail plane a
    // visibly different colour from the water beyond its edge.
    col = mix(col, uHorizon, smoothstep(uHazeStart, uHazeStart * 9.0, dist));

    gl_FragColor = vec4(tonemap(col), 1.0);
  }
`;

export class Ocean {
  constructor(wakeField, size = 520, seg = 560) {
    this.size = size;
    this.uniforms = {
      uWake: { value: wakeField.rt.texture },
      uWakeCenter: { value: wakeField.center },
      uWakeExtent: { value: wakeField.extent },
      uWakeTexels: { value: wakeField.rt.width },
      uSwellAmp: { value: 0 }, uSwellLen: { value: 20 }, uChopAmp: { value: 0 },
      uTime: { value: 0 },
      uEyePos: { value: new THREE.Vector3() },
      uVertexStep: { value: size / seg },  // reset by setDetail()
      uPlaneC: { value: new THREE.Vector2() }, uPlaneR: { value: size * 0.5 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDeep: { value: new THREE.Color() },
      uSky: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() },
      uSunGlow: { value: 0.5 },
      uSpecular: { value: 1 }, uExposure: { value: 1 }, uSheen: { value: 0 }, uReflect: { value: 1 },
      uFoamDensity: { value: 2 }, uTranslucency: { value: 0 }, uAeration: { value: 1 },
      uRelief: { value: 0 }, uTroughBias: { value: 0 }, uWarmth: { value: 0 },
      uLaceScale: { value: 1 }, uLaceAmt: { value: 0 }, uSoftness: { value: 0.3 },
      uBubBright: { value: 1 }, uMilk: { value: 0 }, uBubCol: { value: new THREE.Color() },
      uDeepTint: { value: 0 }, uFlatten: { value: 0.7 },
      uDrift: { value: 0 }, uBoil: { value: 0 },
      uRingAmt: { value: 0 }, uRingScale: { value: 5 }, uRingSpeed: { value: 0.4 },
      uRingWidth: { value: 1 }, uRingRelief: { value: 0 },
      uCellGrow: { value: 0 }, uCoarsen: { value: 0 }, uRideWaves: { value: 0 },
      uFar: { value: size * 0.55 }, uHazeStart: { value: 1400 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.setDetail(seg);
  }

  /** Retessellate. The vertex spacing is also the level-of-detail floor, since
   *  the surface cannot show detail finer than its own geometry.
   *
   *  `size` shrinks when the camera comes close: at 520 m across, the vertices
   *  sit 0.93 m apart, which is nearly sixty pixels in a close-up and terraces
   *  the whole wake. Quantised, so this rebuilds a handful of times rather than
   *  every frame, and the far water covers whatever the smaller plane leaves. */
  setDetail(seg, size = this.size) {
    seg = Math.max(32, Math.round(seg));
    if (seg === this.seg && size === this.size) return;
    this.seg = seg;
    this.size = size;
    this.uniforms.uFar.value = size * 0.55;
    this.mesh.geometry?.dispose();
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    this.mesh.geometry = g;
    this.uniforms.uVertexStep.value = size / seg;
  }

  update(t, eye, focusX, focusZ, wakeField) {
    const u = this.uniforms;
    u.uTime.value = t;
    u.uSwellAmp.value = get('ocean.swellAmp');
    u.uSwellLen.value = get('ocean.swellLen');
    u.uChopAmp.value = get('ocean.chopAmp');
    u.uWakeExtent.value = wakeField.extent;
    u.uWakeTexels.value = wakeField.rt.width;
    u.uEyePos.value.copy(eye);

    const el = get('ocean.sunElev') * Math.PI / 180;
    const az = get('ocean.sunAzim') * Math.PI / 180;
    u.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));

    const lum = get('ocean.deepColor');
    const tint = get('ocean.tint');
    u.uDeep.value.setRGB(lum * 0.55, lum * (0.9 + tint * 0.5), lum * (1.6 - tint * 0.35));
    u.uSky.value.setRGB(0.42, 0.55, 0.72);
    u.uHorizon.value.setRGB(0.26, 0.35, 0.46);
    u.uZenith.value.setRGB(0.09, 0.20, 0.42);
    u.uSunGlow.value = get('ocean.sunGlow');
    u.uSpecular.value = get('ocean.specular');
    u.uSheen.value = get('ocean.sheen');
    u.uReflect.value = get('ocean.reflectivity');
    u.uHazeStart.value = get('ocean.hazeStart');
    u.uExposure.value = get('ocean.exposure');
    u.uFoamDensity.value = get('foamMix.density');
    u.uTranslucency.value = get('foamMix.translucency');
    u.uAeration.value = get('foamMix.aeration');
    u.uRelief.value = get('foamMix.relief');
    u.uTroughBias.value = get('foamMix.troughBias');
    u.uWarmth.value = get('foamMix.warmth');
    u.uLaceScale.value = get('foamLook.lace') * 0.55;
    u.uLaceAmt.value = get('foamLook.laceAmount');
    u.uSoftness.value = get('foamLook.softness');
    u.uDrift.value = get('foamMotion.drift');
    u.uRingAmt.value = get('foamMotion.ringAmount');
    u.uRingScale.value = get('foamMotion.ringScale');
    u.uRingSpeed.value = get('foamMotion.ringSpeed');
    u.uRingWidth.value = get('foamMotion.ringWidth');
    u.uRingRelief.value = get('foamMotion.ringRelief');
    u.uCellGrow.value = get('foamMotion.cellGrowth');
    u.uCoarsen.value = get('foamLook.coarsen');
    u.uRideWaves.value = get('foamMotion.rideWaves');
    u.uBoil.value = get('foamMotion.boil');
    u.uBubBright.value = get('bubbles.brightness');
    u.uDeepTint.value = get('bubbles.deepTint');
    u.uFlatten.value = get('inner.flatten');
    u.uMilk.value = get('bubbles.milkiness');
    // Green through blue-green: the colour a bubble cloud scatters back up
    // depends on how much water is still above it.
    const bt = get('bubbles.tint');
    u.uBubCol.value.setRGB(0.06 + bt * 0.06, 0.40 + bt * 0.07, 0.34 + bt * 0.30);

    // Follow the boat, snapped to the vertex grid so the mesh doesn't crawl.
    const step = this.size / this.seg * 8;
    this.mesh.position.set(Math.round(focusX / step) * step, 0, Math.round(focusZ / step) * step);
    u.uPlaneC.value.set(this.mesh.position.x, this.mesh.position.z);
    u.uPlaneR.value = this.size * 0.5;
  }
}
