// Ocean surface: displaced radial grid + physically-motivated water BRDF.

import { NOISE_GLSL, ATMOSPHERE_GLSL, SKY_LUT_MAP_GLSL } from './sky.js';
import { WAKE_SAMPLE_GLSL } from '../wake.js';
import { HDR_OUTPUT_GUARD } from './output.js';

const CASCADE_COMMON = /* glsl */`
uniform sampler2DArray uDisp, uSlope, uFoam;
uniform float uPatch[4];
uniform float uFade[4];
uniform int   uCascadeCount;
uniform float uDetailScale;

// A cascade has to die out gradually or its fade prints a horizontal seam
// straight across the sea at the distance it switches off. The old window was
// half an octave wide and ended early enough that the last kilometre before the
// horizon had nothing left but the swell; running it from 0.55f to 1.6f is three
// times wider and reaches past the horizon of any sensible eye height. There is
// no aliasing cost: at that range the band's amplitude is far below one pixel,
// so it contributes nothing to the silhouette and everything to the statistics.
float cascadeWeight(int c, float dist){
  float f = uFade[c] * uDetailScale;
  return 1.0 - smoothstep(f*0.55, f*1.6, dist);
}
`;

export const WATER_VS = /* glsl */`
${CASCADE_COMMON}
${WAKE_SAMPLE_GLSL}
layout(location=0) in vec2 aRT;      // x: radial parameter 0..1, y: angle 0..1

uniform mat4  uViewProj;
uniform vec3  uCamPos;      // also read by the FS; one uniform, two stages
uniform vec2  uGridCenter;
uniform float uRMin, uRMax;
uniform float uHeightScale, uHorizScale;
uniform float uEarthCurve;
uniform float uSeaLevel;
uniform float uHorizonPin; // 1 = pin last ring to the sightline; 0 when looking down
// The craft displaces real water, not just foam: the hull presses a hollow into
// the surface and the water it moves stands up as a bow wave ahead of it and as
// shoulders either side. Geometry, so it catches light and shadow like the sea.
uniform vec3  uHullPos;
uniform vec2  uHullFwd;
uniform float uHullPush, uHullRadius, uHullBow, uHullPlane;
// ...and everything the hull has *already* done to the sea, which outlives it by
// tens of seconds. wakeAt() comes from wake.js, so the surface is displaced by
// exactly the pattern the fragment shader lights.

out vec3  vWorld;
out vec3  vFlat;
out float vDist;
out float vHeight;
out float vRelief;
out float vSwellH;

const float R_EARTH = 6371000.0;

void main(){
  float r = uRMin * pow(uRMax/uRMin, aRT.x);
  float a = aRT.y * 6.28318530718;
  vec2 xz = uGridCenter + vec2(cos(a), sin(a)) * r;

  vec3 pos = vec3(xz.x, uSeaLevel, xz.y);
  vFlat = pos;

  vec3 disp = vec3(0.0);
  float relief = 0.0;
  float swellH = 0.0;
  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    float w = cascadeWeight(c, r);
    if (w <= 0.001) continue;
    vec4 d = texture(uDisp, vec3(xz / uPatch[c], float(c)));
    vec3 dd = vec3(d.x*uHorizScale, d.y*uHeightScale, d.z*uHorizScale) * w;
    disp += dd;
    // Cascade 0 is the swell; everything above it is the local relief riding on
    // top of it. Occlusion and subsurface glow care about that relief, not about
    // how high the whole swell has lifted this patch of sea.
    if (c > 0) relief += dd.y;
    // The two longest cascades are the only ones that cast a shadow wider than
    // a pixel; the fragment shader marches exactly this height field.
    if (c < 2) swellH += d.y * uHeightScale;
  }
  vSwellH = swellH;
  pos += disp;

  if (uHullPush > 0.0005) {
    vec2 rel = xz - uHullPos.xz;
    float d2 = dot(rel, rel);
    float R = max(uHullRadius, 0.5);
    if (d2 < R*R*4.0) {
      float along = dot(rel, uHullFwd);
      float lat   = dot(rel, vec2(-uHullFwd.y, uHullFwd.x));
      // Anisotropic footprint: a hull is long and narrow, so the hollow it makes
      // is too. Squashing across the beam is what keeps this from reading as a
      // round dent following the craft.
      float g = exp(-(along*along/(R*R) + lat*lat/(R*R*0.30)));
      // Pressed down under and just aft of the hull...
      float press = -g * smoothstep(1.2, -1.6, along);
      // ...and the displaced water has to go somewhere: up at the bow and out
      // to the sides, which is the shoulder the wake arms grow out of.
      float bow  = g * smoothstep(-0.1, 1.3, along) * uHullBow;
      float side = g * smoothstep(0.25, 1.0, abs(lat)/R) * uHullBow * 0.5;
      pos.y += (press + bow + side) * uHullPush * uHullPlane;
    }
  }

  if (uWakeOn > 0.5) {
    // Far rings are coarse, so a wire ridge pops. A diverging wave
    // thickens with age, so those same triangles can carry height
    // farther aft — fade later than the old 0.16-0.42 cut.
    float wf = 1.0 - smoothstep(uWakeExtent * 0.18, uWakeExtent * 0.88, r);
    if (wf > 0.002) pos.y += wakeAt(xz).y * wf;
  }

  // Planet curvature drops the far surface away, which is what actually puts
  // the horizon at the right place and hides the end of the grid.
  pos.y -= uEarthCurve * (r*r) / (2.0 * R_EARTH);

  // THE OUTERMOST RING IS PINNED JUST ABOVE THE SIGHTLINE TANGENT.
  //
  // The curved surface approaches the eye's tangent ray asymptotically, so the
  // screen row at the exact horizon dip is a limit no triangle ever reaches -
  // a sub-pixel seam that whatever was drawn behind the sea leaks through. The
  // background's below-horizon limb is dark, so the leak prints a dark dashed
  // line along the horizon. Invisible at the 160x100 golden rig (the seam is
  // half a pixel there), plain at real resolutions from any elevated camera -
  // and proven to be a coverage gap, not shading: with this fragment shader
  // forced to constant magenta, the dashes kept their colour.
  //
  // So the last ring ignores the curvature drop and sits on the tangent line
  // OVERSHOT BY 2.5 MILLIRADIANS. The overshoot must be an angle, not a
  // fraction: a fractional lift moves the ring by a fraction of the dip - a
  // quarter of a pixel row at 42 km, measured to leave the dashes intact.
  // And the angle must clear a FULL pixel row at any plausible resolution: a
  // half-milliradian try landed the ring's edge at row 80.49 with the pixel
  // centers at 80.5 and changed not one pixel. 2.5e-3 rad clears 1.6 rows at fov 44 over 500 rows (the demo framing where
  // 1.2e-3 left faint residual dots) and ~3 rows on the hunt rig; the silhouette
  // rises 0.14 degrees above the true horizon, which is beneath notice. The
  // ring's fragments shade as extreme-grazing water, the mirror of the
  // horizon sky, which is exactly what belongs in that band. The dip*0.1
  // floor keeps a wading-height camera's ring below eye level.
  //
  // Crossing the waterline used to punch through a full-height crest
  // (and the last-ring pin followed the eye down). Above water this is
  // a no-op. Under it, displacement grows in over ~2.5 m.
  float under = uSeaLevel - uCamPos.y;
  if (under > 0.0) {
    float amt = smoothstep(0.0, 2.5, under);
    pos.y = mix(uSeaLevel, pos.y, amt);
  }

  // uHorizonPin is 0 when the geometric horizon is off the top of the
  // frame (src/horizon-pin.js, including the high-camera dip) or the
  // eye is at/under the sea. Blend so a wading fade is gradual.
  if (aRT.x > 0.9999) {
    float hEye = max(uCamPos.y - uSeaLevel, 1.0);
    float dip = sqrt(2.0 * hEye * max(uEarthCurve, 1e-3) / R_EARTH);
    float pinned = uCamPos.y - max(dip - 2.5e-3, dip * 0.1) * r;
    pos.y = mix(pos.y, pinned, uHorizonPin);
  }

  vWorld  = pos;
  vDist   = r;
  vHeight = disp.y;
  vRelief = relief;
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

export const WATER_FS = /* glsl */`
${HDR_OUTPUT_GUARD}
${CASCADE_COMMON}
${WAKE_SAMPLE_GLSL}
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}

in vec3  vWorld;
in vec3  vFlat;
in float vDist;
in float vHeight;
in float vRelief;
in float vSwellH;

uniform sampler2D uSkyLUT;
uniform vec3  uCamPos, uSunDir, uMoonDir;
uniform vec3  uSunColor, uMoonColor;
uniform float uTime;

uniform vec3  uScatterColor;      // volumetric scattering albedo
uniform vec3  uAbsorption;        // 1/m per channel
uniform float uScatterAmount;
uniform float uSSSStrength, uSSSPower, uSSSHeight, uSSSDepth;
uniform float uBaseRoughness, uRoughnessGain, uRoughnessMax;
uniform float uWindAniso, uWindSpeed;
uniform float uFoamAmount, uFoamRoughness, uFoamTint, uFoamDetail, uFoamLift;
uniform float uFoamSharp, uFoamStreak, uFoamOpacity, uFoamCrisp, uFoamDrift, uFoamFill, uFoamCell;
// Craft wake: wakeAt() above. The rest of the knobs are how it is shaded.
uniform float uWakeRelief, uWakeSlick;
uniform vec3  uFoamColor;
uniform float uSunAngularRadius, uSpecIntensity;
uniform float uSkyAmbient, uSkyBlur;
uniform float uGlitter, uGlitterScale;
uniform float uWaterIOR;
uniform float uAerial;
uniform vec2  uWindDirV;
uniform float uSpecClamp;
uniform float uHorizonBend, uInterReflect;
uniform float uWaveAO;
uniform float uSpecAA, uGrazeFocus, uSSSBias, uFoamFar;
uniform float uCapillary, uCapillaryScale;
uniform float uGust, uGustScale, uGustDrift;
uniform float uWaveShadow, uShadowScale;
// The craft's image in the sea and the shadow it throws on it. FRAGMENT stage:
// the first cut of this declared them in the VERTEX stage, which never used
// them, so the fragment shader referenced four undeclared identifiers and the
// raw-GL water program failed to compile outright. It went unnoticed because
// every check that ran drives the three.js path; "npm run check" is the one
// that compiles this file, and it is in AGENTS.md's table for exactly this.
// (And no backticks in here: this GLSL lives inside a JS template literal, so
// a backtick ends the shader and the file. Third time in this session.)
uniform vec3  uCraftReflPos, uCraftReflTint;
uniform float uCraftReflSize, uCraftReflAmount, uCraftShadow;
uniform float uHeightScale;      // the shadow march reads the same height field the VS displaced by

out vec4 fragColor;

const float PI = 3.14159265;

// The LUT wraps 2*pi of azimuth into 512 texels, so one texel subtends about
// 0.0123 rad. Matching the GGX lobe width to a mip level is what keeps the far
// sea a smooth blurred mirror instead of either boiling noise or a grey average.
vec3 sampleSky(vec3 rd, float alpha){
  float lod = clamp(log2(1.0 + alpha * 81.0 * uSkyBlur), 0.0, 7.0);
  return textureLod(uSkyLUT, dirToSkyUv(rd), lod).rgb;
}

// Anisotropic GGX. The two alphas come from the along-wind and cross-wind slope
// variances, and their inequality is precisely what stretches the glitter path.
float D_GGXAniso(float NoH, float ToH, float BoH, float ax, float ay){
  float d = ToH*ToH/(ax*ax) + BoH*BoH/(ay*ay) + NoH*NoH;
  return 1.0 / max(PI * ax * ay * d * d, 1e-9);
}
// Isotropic GGX. D_GGXAniso cannot stand in for this by passing zero tangential
// components: with ToH = BoH = 0 its denominator collapses to NoH^4, so D grows
// without bound as the half-vector tips toward the horizon instead of falling
// off. That is a five-order-of-magnitude error at grazing incidence, which is
// most of a seascape.
float D_GGX(float NoH, float a){
  float a2 = a*a;
  float d  = NoH*NoH*(a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-9);
}
float V_SmithGGX(float NoV, float NoL, float a){
  float a2 = a*a;
  float lv = NoL * sqrt(NoV*NoV*(1.0 - a2) + a2);
  float ll = NoV * sqrt(NoL*NoL*(1.0 - a2) + a2);
  return 0.5 / max(lv + ll, 1e-6);
}
float V_SmithAniso(float NoV, float NoL, float ToV, float BoV, float ToL, float BoL,
                   float ax, float ay){
  float lv = NoL * length(vec3(ax*ToV, ay*BoV, NoV));
  float ll = NoV * length(vec3(ax*ToL, ay*BoL, NoL));
  return 0.5 / max(lv + ll, 1e-6);
}

// Exact unpolarised dielectric Fresnel. Schlick agrees at normal incidence but
// drifts a few percent through 50-80 degrees, and that band is most of the sea's
// visible area at any camera height a human would use, so it is worth the sqrt.
float fresnelDielectric(float c, float eta){
  float g2 = eta*eta - 1.0 + c*c;
  if (g2 <= 0.0) return 1.0;
  float g = sqrt(g2);
  float a = (g - c) / (g + c);
  float b = (c*(g + c) - 1.0) / (c*(g - c) + 1.0);
  return clamp(0.5*a*a*(1.0 + b*b), 0.0, 1.0);
}

// Environment Fresnel. The usual split-sum fits (and the max(1-rough, f0) fudge)
// both collapse toward f0 at grazing on a rough surface, but a wind-blown sea is
// emphatically near-mirror at 85 degrees - that is the entire reason the far
// water reads as sky rather than as haze. The one real correction is that the
// facets you can still see at grazing are the ones tilted toward you, so the
// mean incidence is shallower than the macroscopic angle by roughly the slope
// spread. Widening the cosine by alpha^2 says exactly that, and it is why a
// glassy dawn mirrors the horizon while a storm sea stays grey there.
vec3 envFresnel(float NoV, float alpha, float eta){
  float c = clamp(NoV + 0.5*alpha*alpha*(1.0 - NoV), 0.0, 1.0);
  return vec3(fresnelDielectric(c, eta));
}

vec2 windPerp(){ return vec2(-uWindDirV.y, uWindDirV.x); }

// Sub-cascade facet scintillation. The mip chain averages the finest ripples
// into the slope variance, which correctly widens the GGX lobe but erases that a
// real glitter path is thousands of discrete flashes with dark water between
// them. This puts that structure back as a modulation of the *facet density*
// with an analytically unit mean, so the lobe's radiance is redistributed and
// never created - the peaks then clamp against a true mirror, not against an
// arbitrary number. Each octave dies as its wavelength falls under the pixel
// footprint, which is why the glints shrink with distance instead of turning
// into fixed-size aliasing confetti.
float scintillation(vec2 p, float foot){
  float gs = 1.0 / max(uGlitterScale, 0.05);
  float f1 = 1.7*gs, f2 = 6.1*gs;
  float w1 = 1.0 - smoothstep(0.25, 0.95, foot*f1);
  float w2 = 1.0 - smoothstep(0.25, 0.95, foot*f2);
  if (w1 + w2 < 1e-3) return 1.0;
  // Value noise sampled on one axis-aligned lattice prints its own grid as
  // diagonal rows once it multiplies a directional lobe, so the second octave
  // rides a rotated frame.
  mat2 rot = mat2(0.8253, 0.5647, -0.5647, 0.8253);
  float n1 = vnoise(vec3(p*f1, uTime*1.3)) - 0.5;
  float n2 = vnoise(vec3((rot*p)*f2 + 31.7, uTime*2.9)) - 0.5;
  float n  = n1*0.62*w1 + n2*0.38*w2;
  // Facet density is a positive quantity, so it modulates log-normally rather
  // than as a squared linear ramp. The old (1+g n)^2 with g near 2.7 swung the
  // lobe over a 40:1 range - most of the sea landed either at zero or hard
  // against the ceiling, which is binary speckle, not glitter. exp() cannot go
  // negative, is bounded because the noise is bounded, and its mean is corrected
  // exactly by the second moment, so the lobe's radiance is redistributed and
  // never created.
  float g  = 1.6 * clamp(uGlitter, 0.0, 3.0);
  float wv = 0.06 * (0.3844*w1*w1 + 0.1444*w2*w2);
  return exp(g*n - 0.5*g*g*wv);
}

// Large-scale self-shadowing from the swell. At low sun the backs of the long
// waves genuinely go dark, and that light/shade separation across the swell is
// most of what makes a photographed sea look like it has mass. Only the two
// longest cascades are marched: everything shorter shadows at a scale below one
// pixel and is already accounted for by the Smith masking term.
float sunVisibility(vec2 p, float h, float dist){
  if (uWaveShadow <= 0.0) return 1.0;
  vec2 sd = uSunDir.xz;
  float sl = length(sd);
  if (sl < 1e-3 || uSunDir.y > 0.55) return 1.0;
  sd /= sl;
  float sy = max(uSunDir.y, 0.02) / max(sl, 1e-3);   // rise per metre travelled
  float occ = 0.0;
  for (int i=1;i<=3;i++){
    float t = float(i*i) * 3.5 * max(uShadowScale, 0.05);
    vec2 q = p + sd*t;
    float hz = textureLod(uDisp, vec3(q/uPatch[0], 0.0), 0.0).y
             + textureLod(uDisp, vec3(q/uPatch[1], 1.0), 0.0).y;
    occ = max(occ, (hz*uHeightScale - h) / t);
  }
  float sh = smoothstep(sy*0.10, sy*0.95, occ);
  // Past a few hundred metres a swell shadow is finer than a pixel, so it is
  // already inside the mean radiance and re-applying it only causes aliasing.
  sh *= 1.0 - smoothstep(400.0, 2000.0, dist);
  return 1.0 - clamp(uWaveShadow, 0.0, 1.0) * 0.9 * sh;
}

// Parasitic capillary ripples ride the windward face of the short gravity waves
// and die out within tens of metres of the eye, where the pixel footprint starts
// averaging them away. They are what stops the first few metres reading as mush.
vec2 capillarySlope(vec2 p, float t, float amp){
  vec2 w = uWindDirV, q = windPerp();
  vec2 x = vec2(dot(p, w), dot(p, q));
  // Crests a few centimetres apart across the wind, stretched along it: well
  // below the finest cascade, which is why they have to be procedural.
  vec3 c = vec3(x.x*3.0, x.y*11.0, t*1.6);
  float e = 0.30;
  float n0 = fbm3(c, 2);
  float nx = fbm3(c + vec3(e, 0.0, 0.0), 2);
  float ny = fbm3(c + vec3(0.0, e, 0.0), 2);
  vec2 g = vec2(nx - n0, ny - n0) / e;
  // Cross-wind slope dominates: the ripples run along the wind.
  return (w*g.x*0.35 + q*g.y) * amp;
}

// 2D Worley F1/F2 plus nearest-site hash. Matches src/foam-lace.js and
// src/gpu/tsl/noise.js cellular3. Occupancy is NOT used as coverage
// (that was the disc look).
vec3 cellular3(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float F1 = 8.0, F2 = 8.0, occ = 0.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 cell = i + g;
      vec2 o = hash22(cell);
      vec2 r = g + o - f;
      float d = dot(r, r);
      float h = hash12(cell + vec2(19.7, 7.3));
      if (d < F1) occ = h;
      F2 = min(F2, max(F1, d));
      F1 = min(F1, d);
    }
  }
  return vec3(sqrt(F1), sqrt(F2), occ);
}

// Jacobian / fold answers WHERE. Structure inside that footprint is
// brightness, not a stencil. Unstretched regular F2−F1 was the hex tray;
// wake × walls was the honeycomb around the hull (wake is a milky film;
// fd mottles it). CPU twin: src/foam-lace.js.
float foamField(vec2 p, float t, float foot, float detail, out float thick){
  vec2 w = uWindDirV, q = windPerp();
  vec2 x = vec2(dot(p, w), dot(p, q));
  vec2 s = vec2(x.x * (1.0 - 0.38*uFoamStreak), x.y * (1.0 + 0.70*uFoamStreak));
  vec2 slide = w * t * max(uFoamDrift, 0.0);
  float flow = t * 0.08;
  float wx = vnoise(vec3(s*0.04, flow)) - 0.5;
  float wy = vnoise(vec3(s*0.04 + 17.3, flow + 3.1)) - 0.5;
  vec2 sp = s + vec2(wx*3.1, wy*2.7) - slide;
  float inv = 1.0 / max(uFoamCell, 0.2);
  float dens = vnoise(vec3(sp*0.07*inv, t*0.03));
  float localScale = mix(0.68, 1.34, dens);
  float fillK = clamp(uFoamFill, 0.0, 1.0);
  float raftN = fbm3(vec3(sp*0.10*inv*localScale, t*0.05), 3);
  float tearN = vnoise(vec3(sp*0.22*inv, t*0.07));
  float chewN = vnoise(vec3(sp*0.40*inv, t*0.11));
  float raft = smoothstep(mix(0.50, 0.26, fillK), 0.70, raftN)
             * mix(0.48, 1.0, smoothstep(0.12, 0.68, tearN))
             * mix(0.58, 1.0, smoothstep(0.10, 0.58, chewN));
  float grain = vnoise(vec3(sp*9.2*inv, t*0.55));
  float film = raft * (0.70 + 0.30*grain);
  float width = mix(0.20, 0.36, dens);
  float broken = smoothstep(0.20, 0.52, vnoise(vec3(sp*0.52*inv, t*0.08)));
  vec3 c0 = cellular3(sp * 0.72 * inv * localScale);
  float gap0 = c0.y - c0.x;
  float wallGate = mix(0.06, 1.0, smoothstep(0.18, 0.78, broken));
  float fil0 = smoothstep(width, 0.040, gap0) * wallGate;
  float core0 = smoothstep(width*0.38, 0.016, gap0) * wallGate;
  float fillN = fillK / 0.55;
  float extra = clamp((fillK - 0.55) / 0.45, 0.0, 1.0);
  float fineScale = mix(0.98, 1.52, 1.0 - dens);
  vec3 c1 = cellular3(sp * fineScale * inv + 8.1);
  float gap1 = c1.y - c1.x;
  float chordGate = smoothstep(0.46, 0.76, dens*0.58 + (1.0 - broken)*0.42);
  float fil1 = smoothstep(mix(0.16, 0.28, dens), 0.028, gap1) * chordGate
             * min(fillN, 1.0) * mix(1.0, 1.55, extra);
  float haze = smoothstep(mix(0.46, 0.68, extra), 0.10, gap0) * (1.0 - fil0)
             * mix(0.05, 0.30, dens) * (0.45 + 0.55*grain) * fillN;
  float accent = max(fil0, fil1) * mix(0.02, 0.10, fillK) + haze * 0.28;
  float lace = clamp(film * 0.90 + accent, 0.0, 1.0);
  float fineAmt = clamp(detail/1.85, 0.0, 2.4);
  float fineFade = (1.0 - smoothstep(0.08, 0.55, foot)) * fineAmt;
  float bub = 0.42 + 0.58 * mix(0.50, grain, min(fineFade, 1.0));
  float core = core0 * mix(0.45, 1.0, dens);
  float grainAmt = 0.28 * min(fineFade, 1.0);
  thick = clamp(film*0.78*bub + core*0.35*bub + fil0*0.18*bub + fil1*0.12*bub
                + haze*0.10*bub + grainAmt*grain*film, 0.0, 1.0);
  float near = 1.0 - smoothstep(0.12, 1.8, foot);
  return mix(0.5, clamp(lace, 0.0, 1.0), near);
}

void main(){
  vec3 toEye = uCamPos - vWorld;
  float eyeDist = max(length(toEye), 1e-4);
  vec3 V = toEye / eyeDist;
  float dist = vDist;

  // World metres covered by this pixel on the sea plane. Everything that has to
  // stop being resolved - capillaries, foam streaks, glitter facets - is gated
  // on this rather than on distance, because a grazing pixel a hundred metres
  // out already covers more sea than a nadir pixel a kilometre out.
  vec2  fpv  = fwidth(vFlat.xz);
  float foot = max(max(fpv.x, fpv.y), 1e-5);

  // ---- surface normal + microfacet statistics from the cascades -------------
  vec2  slope = vec2(0.0);
  float msq   = 0.0;     // mean square slope inside the pixel footprint
  float lost  = 0.0;     // variance removed by cascade fade-out
  float foamT = 0.0;     // total coverage
  float foamF = 0.0;     // dense crest foam, seconds old
  float foamR = 0.0;     // dissipated raft, the thin veil it decays into

  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    float w = cascadeWeight(c, dist);
    vec3 uvc = vec3(vFlat.xz / uPatch[c], float(c));
    vec4 sl = texture(uSlope, uvc);
    vec4 fo = texture(uFoam, uvc);
    slope += sl.xy * w;
    msq   += sl.w * w * w;
    // What the fade threw away still roughens the surface statistically.
    float full = textureLod(uSlope, uvc, 8.0).w;
    lost += max(full * (1.0 - w*w), 0.0);
    foamT += fo.x * w;
    foamF += fo.y * w;
    foamR += fo.z * w;
  }

  // ---- wind gusts: the cat's paws -------------------------------------------
  // Wind over water does not arrive evenly. It comes in gusts and lulls tens of
  // metres across, and each gust roughens its own patch of surface into a matte
  // "cat's paw" while the lull beside it stays a mirror. On sheltered water that
  // mottling IS the texture: photograph a marina in light air and the frame is
  // patches of dark ripple against bright smooth water, not waves.
  //
  // A slow noise field drifting downwind, scaling the local SHORT-WAVE energy:
  // the capillary ripples just below, and the slope variance that sets roughness
  // at every distance - which is what carries the mottling past the near field,
  // where the capillary layer has already faded out.
  //
  // Scaling "var" wholesale is an approximation, since the swell's share of it
  // is not gust-driven. It is a defensible one: mean-square slope is dominated
  // by the short end of the spectrum, and the short end is exactly what a gust
  // drives. uGust defaults to 0, so no existing preset moves.
  float gust = 1.0;
  if (uGust > 0.0){
    vec2 gq = (vFlat.xz - uWindDirV * (uTime * uGustDrift)) / max(uGustScale, 4.0);
    // fbm2 lands in 0..1 clustered near 0.5; this window spreads it into
    // distinct patches instead of a uniform haze.
    float g = smoothstep(0.35, 0.72, fbm2(gq, 3));
    gust = mix(1.0 - 0.85*uGust, 1.0 + 1.6*uGust, g);
  }

  // Sub-cascade capillary detail, near field only.
  float capFade = uCapillary > 0.0
    ? 1.0 / (1.0 + (dist*dist) / (900.0 * uCapillaryScale * uCapillaryScale))
    : 0.0;
  // Crests a few centimetres apart cannot survive a pixel that spans tens of
  // them; point-sampling them anyway is pure aliasing.
  capFade *= 1.0 - smoothstep(0.06, 0.34, foot);
  if (capFade > 0.01){
    float amp = uCapillary * 0.16 * capFade * clamp(uWindSpeed/9.0, 0.15, 2.0) * gust;
    // They pile up on the face turned into the wind.
    amp *= clamp(0.45 + dot(slope, uWindDirV) * 2.0, 0.0, 1.8);
    slope += capillarySlope(vFlat.xz, uTime, amp);
  }

  // ---- craft wake ----------------------------------------------------------
  // A Kelvin wedge is not a smear down the middle of the path: it is two cusp
  // arms leaving the hull at a fixed half-angle with churned, aerated water
  // between them, and once the hull has gone the arms keep travelling outward.
  // All of that lives in the world-space field wake.js maintains, so here it is
  // a fetch rather than a loop over the last few seconds of path.
  //
  // It has to be read before the normal is built: the wake deforms the surface
  // for real (the vertex shader displaces by the same field), and a ridge whose
  // shading normal does not know it is a ridge reads as a decal on flat water.
  float wake = 0.0;
  if (uWakeOn > 0.5) {
    // Once a pixel is wider than the pattern there is nothing left to resolve
    // and point-sampling it is pure aliasing, exactly as for the foam sim above.
    float k = 1.0 - smoothstep(1.2, 6.0, foot);
    if (k > 0.004) {
      vec3 wk = wakeAt(vFlat.xz);
      wake = wk.x * k;
      // A wake leaves a slick. Churned water has lost the short ripples and the
      // wind foam that were riding on it, and that smooth lane is most of why a
      // boat's path stays legible on a broken sea long after the white water
      // behind it has gone. Without it the wake is just more foam among foam.
      float slick = clamp(wk.z * k * uWakeSlick, 0.0, 1.0);
      foamF *= 1.0 - slick;
      foamR *= 1.0 - slick;
      msq   *= 1.0 - 0.6 * slick;
      // The ridge is real geometry - the vertex shader displaced by wk.y - so it
      // needs a normal that knows it is a ridge, or it reads as a decal lying on
      // flat water. Central differences at half a metre, which is inside the arm
      // width and wide enough not to be lost in the record's own quantisation.
      // Four extra fetches for the gradient, so only where there is actually a
      // wake to shade. Gating on the disturbance rather than on the buffer bounds
      // skips this for every water pixel that merely happens to be inside a
      // 320 m square, which is most of them.
      // Used to gate on wk.z (the slick BETWEEN the arms). The arms
      // themselves have almost no churn, so the ridge never got a
      // normal and read as foam stuck on flat water.
      if (uWakeRelief > 0.0 && abs(wk.y) > 0.22){
        float e = max(uWakeDepth * 0.45, 1.2);
        float hx = wakeAt(vFlat.xz + vec2(e, 0.0)).y - wakeAt(vFlat.xz - vec2(e, 0.0)).y;
        float hz = wakeAt(vFlat.xz + vec2(0.0, e)).y - wakeAt(vFlat.xz - vec2(0.0, e)).y;
        slope += vec2(hx, hz) / (2.0 * e) * uWakeRelief * k;
      }
    }
  }

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  float var = (max(msq - dot(slope, slope), 0.0) + lost) * gust;

  // The cascade mip chain filters each band over its own texels. It cannot know
  // about the pixel that straddles a crest, about the projection stretching that
  // pixel along the view ray at grazing, or about the procedural capillary layer
  // added above - and everything it misses reappears as sub-pixel highlights
  // with hard edges. The second moment of the slope across the pixel is exactly
  // that missing variance. Folding it into the lobe widens the NDF rather than
  // blurring the image, so the mean specular level is preserved while the
  // highlights stop aliasing. (Derivatives are per 2x2 quad, hence the quarter.)
  vec2 dsx = dFdx(slope), dsy = dFdy(slope);
  var += 0.25 * max(uSpecAA, 0.0) * (dot(dsx, dsx) + dot(dsy, dsy));

  // Cox-Munk: the sea's slope distribution is wider along the wind than across
  // it. Splitting the filtered variance on that ratio is what gives the glitter
  // path its elongated, wind-aligned shape instead of a round blob.
  float an   = max(uWindAniso, 0.05);
  float vAl  = var * an / (1.0 + an);
  float vCr  = var / (1.0 + an);
  // The gust roughens the UNRESOLVED micro-surface too, and on calm water that
  // is the term that matters: with a 3 m/s wind the resolved slope variance is
  // nearly nothing, so alpha is almost entirely baseRoughness and modulating
  // only the resolved variance leaves the mottling invisible (measured: max delta 0.029 before
  // this line). b2 is a variance, so scaling it by the same factor is
  // dimensionally the same operation applied to the part of the spectrum the
  // cascades never resolved.
  float b2   = uBaseRoughness * uBaseRoughness * gust;
  // alpha^2 = 2*sigma^2 is the Beckmann->GGX slope-variance identity. Capping it
  // matters: a real sea tops out near mss 0.09 even in a hurricane, so alpha can
  // never legitimately reach 1 and turn the distant water Lambertian-white.
  float aAl  = clamp(sqrt(b2 + 2.0*vAl*uRoughnessGain), 1e-3, uRoughnessMax);
  float aCr  = clamp(sqrt(b2 + 2.0*vCr*uRoughnessGain), 1e-3, uRoughnessMax);
  float alpha = sqrt(aAl * aCr);

  vec3 wind3 = vec3(uWindDirV.x, 0.0, uWindDirV.y);
  vec3 T = normalize(wind3 - N * dot(N, wind3));
  vec3 B = cross(N, T);

  // ---- foam mask -----------------------------------------------------------
  float bubbles;
  float fd = foamField(vFlat.xz, uTime, foot, uFoamDetail, bubbles);
  // Two optically different materials share this footprint and they must not be
  // shaded as one. Fresh crest foam is an optically thick bubble raft that hides
  // the water completely; the dissipated residue it decays into is a veil a few
  // bubbles deep that the sea shows straight through. In steady state the
  // residue covers several times the area of the breakers feeding it, so
  // treating the sim's *total* coverage as opaque whitewater is precisely what
  // turns a force 10 sea into a bucket of cream.
  //
  // These are areal fractions, so the noise only decides WHERE inside the
  // footprint each one lands; its shaping factor is centred on one and can never
  // inflate the coverage the sim computed.
  float covF = clamp(foamF * uFoamAmount, 0.0, 1.0);
  float covR = clamp(foamR * uFoamAmount, 0.0, 1.0);
  // Harder Jacobian gate (src/foam-lace.js jacobianGate). A leak of fold
  // used to sprinkle the lace across calm water. Fold 0 is empty.
  float gateF = smoothstep(0.02, 0.12, covF);
  float gateR = smoothstep(0.02, 0.12, covR);
  // Once the pixel is wider than a clump there is nothing left to resolve and
  // the contrast has to collapse onto the mean, or the far field turns into
  // per-pixel confetti.
  float clumpRes = 1.0 - smoothstep(0.12, 2.2, foot);
  // Film with brighter clumps. High foamSharp still contrasty; the floor
  // keeps covered water from collapsing to grit / wire.
  float sharpK = (min(max(uFoamSharp, 0.05), 2.4) - 0.05) / 2.35;
  float shape  = mix(mix(0.52, 0.16, sharpK), mix(1.12, 1.48, sharpK), smoothstep(0.10, 0.82, fd));
  float shapeR = mix(mix(0.48, 0.18, sharpK), mix(1.08, 1.36, sharpK), smoothstep(0.14, 0.86, fd));
  // Multiplying a blurry coverage by a detail field keeps the blur: the sim's
  // foam lives at 1.5 m per texel, so close up the raft was a magnified smudge
  // with texture painted over it. Resolving the coverage *against* the detail
  // field instead - foam wherever the field exceeds 1 - coverage - puts the edge
  // at the bubble scale where it belongs, and because the threshold moves with
  // the coverage the area it selects still tracks what the sim computed.
  // Only worth doing while a pixel is narrower than a clump; past that there is
  // nothing to resolve and the multiplicative mean is the honest answer.
  float crisp = clumpRes * clamp(uFoamCrisp, 0.0, 1.0) * 0.90;
  float eF = 0.22, eR = 0.34;
  // Crisp resolve tails past coverage 0 (smoothstep(1-e, 1+e, fd) still lights
  // the top of the noise field). Gate by coverage so a zeroed Foam amount is empty.
  float maskF = mix(clamp(covF * mix(1.0, shape,  clumpRes), 0.0, 1.0),
                    smoothstep(1.0 - covF - eF, 1.0 - covF + eF, fd) * smoothstep(0.0, eF, covF), crisp) * gateF;
  float maskR = mix(clamp(covR * mix(1.0, shapeR, clumpRes), 0.0, 1.0),
                    smoothstep(1.0 - covR - eR, 1.0 - covR + eR, fd) * smoothstep(0.0, eR, covR), crisp) * gateR;
  float foamMask = clamp(maskF + maskR * (1.0 - maskF), 0.0, 1.0);
  // What fraction of the covered area is dense crest foam rather than raft. It
  // drives albedo, opacity and forward scattering below, so it is the single
  // number that separates whitewater from a blue-white film. Taken before the
  // distance term, which scales both channels equally.
  float fresh = clamp(maskF / max(foamMask, 1e-4), 0.0, 1.0);
  // At a kilometre you are looking at the side of a raft that lies in and just
  // behind the crests, and the crest in front hides most of it. That is a real
  // geometric loss on top of the areal averaging, and it is what stops the
  // grazing band just under the horizon painting itself solid.
  foamMask *= 1.0 - clamp(uFoamFar, 0.0, 1.0) * smoothstep(0.5, 9.0, foot);

  // Wake foam is not wind foam, and running it through the machinery above is
  // what made forty metres of churned water indistinguishable from the sea it
  // was churned out of: the clump noise that breaks whitecaps into a field of
  // separate caps is exactly the wrong shaping for a coherent band with an edge.
  // So it composites over the top, only lightly textured, and it is fresh - a
  // hull aerates water far more thoroughly than a collapsing crest does.
  if (wake > 0.002){
    // Aerated film. fd mottles brightness; it does not punch Voronoi holes.
    // Twin: wakeFoamMask / wakeFoamThickness in src/foam-lace.js.
    float wakeMask = clamp(wake * mix(0.78, 1.0, smoothstep(0.00, 1.00, fd)), 0.0, 1.0);
    float wakeThick = clamp(wake * mix(0.55, 0.92, smoothstep(0.00, 1.00, fd)), 0.0, 1.0);
    // Fibrous film along the heading. Floor stays high (foam-lace.js).
    vec2 relW = vFlat.xz - uWakeHead;
    float alongW = dot(relW, uWakeFwd);
    float acrossW = relW.x * (-uWakeFwd.y) + relW.y * uWakeFwd.x;
    float fibre = vnoise2(vec2(alongW * 0.22, acrossW * 1.15));
    float thread = vnoise2(vec2(alongW * 0.07, acrossW * 2.6));
    wakeMask *= mix(0.86, 1.0, fibre);
    wakeThick *= mix(0.78, 1.12, smoothstep(0.48, 0.82, thread));
    bubbles = max(bubbles, wakeThick);
    float wakeFresh = mix(0.42, 0.92, smoothstep(0.10, 0.62, wake));
    fresh = mix(fresh, wakeFresh, wakeMask);
    foamMask = foamMask + wakeMask * (1.0 - foamMask);
  }

  // Covered water is an emulsion, not grit on lace cores.
  bubbles = max(bubbles, mix(0.16, 0.72, fresh) * smoothstep(0.01, 0.22, foamMask));

  vec3 Nfoam = N;
  if (foamMask > 0.003){
    // Thickness stays foamField's out-param. The old 25 cm / 6 cm vnoise
    // gradient is what read as sand. A matte film follows the wave.
    // Hull churn is a volume, same as a splash — saturate early so the
    // trail is milky water, not a lace-edge slope.
    float churn = smoothstep(0.12, 0.48, wake);
    bubbles = mix(bubbles, 0.90, churn);
    Nfoam = normalize(mix(N, vec3(0.0, 1.0, 0.0), foamMask * mix(0.03, 0.10, fresh)));
  }

  float NoV = clamp(dot(N, V), 1e-4, 1.0);

  // ---- lights --------------------------------------------------------------
  vec3 sunTr = sunTransmittance(vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0), uSunDir);
  vec3 sunRad = uSunColor * sunTr * uAtmoExposure;
  sunRad *= smoothstep(-0.09, 0.02, uSunDir.y);
  // Every direct-sun term below sees the shadowed irradiance; only the sky
  // ambient reaches into a swell's lee.
  sunRad *= sunVisibility(vFlat.xz, vSwellH, dist);

  // ---- THE CRAFT'S SHADOW ---------------------------------------------------
  //
  // The same proxy the reflection uses, tested along the SUN instead of along
  // the reflection ray: if the craft sits between this patch of water and the
  // sun, this patch is in its shadow. That is the whole of it - no shadow map,
  // no second pass, no cascade - and it lands on sunRad, which every direct-sun
  // term below reads, so the specular, the subsurface glow and the foam's
  // lighting all go dim together while the sky ambient still reaches in. Which
  // is what a shadow is.
  //
  // The penumbra grows with the distance the light has travelled past the
  // craft, at the sun's own angular radius, so a hull on the water throws a
  // hard-edged shadow and one at altitude throws a soft one that fades into
  // nothing by itself. No height fade is applied on top: the geometry already
  // does it, and doing it twice was how the reflection ended up invisible.
  //
  // THE THREE.JS PATH NO LONGER DOES THIS. src/gpu/tsl/water-surface.js takes a
  // real shadow map instead - the hull rendered from the sun, sampled here - so
  // the seaplane throws wings and floats rather than a circle. It was reported
  // as a blob because from the air, at the size an aircraft's shadow actually
  // is, a proxy sphere reads as exactly one. This renderer keeps the proxy: it
  // has no shadow-map plumbing, and the golden images that pin every other part
  // of the sea are taken through it. The two paths therefore differ HERE, and
  // only here, which is the trade the note in demo/three-main.js records.
  if (uCraftShadow > 0.001) {
    vec3 toC = uCraftReflPos - vWorld;
    float along = dot(toC, uSunDir);
    if (along > 0.0) {
      float perp = length(toC - uSunDir * along);
      float pen = uCraftReflSize + along * max(uSunAngularRadius, 1e-4) * 2.0;
      float sh = 1.0 - smoothstep(uCraftReflSize * 0.45, pen, perp);
      sunRad *= 1.0 - sh * uCraftShadow;
    }
  }

  vec3 L = uSunDir;
  float NoL = max(dot(N, L), 0.0);

  // The top of the LUT's mip chain is the average sky radiance; multiplying by
  // pi turns it into the diffuse irradiance arriving at the surface.
  vec3 skyAvg = textureLod(uSkyLUT, vec2(0.5, 0.78), 9.0).rgb;
  vec3 skyIrr = skyAvg * PI * uSkyAmbient;

  // Wave-scale occlusion: a trough between two short waves sees a fraction of
  // the sky a crest does. Driven by relief, not absolute height, so a swell
  // crest is not permanently brighter than a swell trough.
  float rn = vRelief / (abs(vRelief) + 0.55);          // -1..1
  // Once crest and trough share a pixel their occlusion has already been
  // averaged into the mean radiance; keeping it would darken the far sea below
  // the sky it is mirroring, which is the other half of the horizon step.
  float aoRes = 1.0 - smoothstep(1.5, 12.0, foot);
  float ao = 1.0 - uWaveAO * 0.42 * aoRes * (0.5 - 0.5*rn);

  // ---- environment reflection ----------------------------------------------
  vec3 body0 = uScatterColor * skyIrr * (uScatterAmount / PI);
  vec3 R = reflect(-V, N);
  float under = clamp(-R.y * 4.0, 0.0, 1.0);   // how far the ray dives under
  // A reflection ray that dives below the horizon has not left the sea, it has
  // hit the back of the next wave - so fold it back up and sample the sky that
  // face is itself reflecting. The old hard clamp to y=0 collapsed every
  // grazing fragment onto a single LUT row, which is precisely why the far
  // water rendered as one flat bar of the brightest horizon texel. Folding
  // keeps the slope-to-slope variation alive right up to the horizon line.
  R = normalize(vec3(R.x, mix(R.y, abs(R.y), uHorizonBend), R.z));
  // The LUT is a full sphere, so a little below horizontal is real data, not a
  // clamp - it is the darker sky/sea limb a downward ray actually sees. How far
  // below is set by the slope spread: a mirror-calm dawn cannot see under its
  // own horizon at all, and letting it do so is what pulls the last kilometre of
  // water away from the sky it is supposed to be mirroring.
  R.y = max(R.y, -0.35*alpha);
  // At grazing incidence the GGX lobe smears along the horizon but stays narrow
  // across it. An isotropic mip blur cannot represent that, and blurring the
  // bright horizon band into the darker sky above it is exactly what made the
  // far sea read darker than the sky it mirrors. Narrowing the effective alpha
  // toward grazing is the cheap stand-in for the anisotropic lookup.
  float grazeNarrow = mix(clamp(uGrazeFocus, 0.02, 1.0), 1.0, sqrt(NoV));
  vec3 skyRefl = sampleSky(normalize(R), alpha * grazeNarrow);
  // A ray that dove under the horizon really hit the next wave face. Feeding it
  // the neighbouring water's own radiance is the inter-reflection term, and it
  // is what gives troughs their deep colour instead of a flipped sky.
  skyRefl = mix(skyRefl, body0 * 6.0 + skyRefl * 0.25, uInterReflect * under);
  // A trough does not only see less sky diffusely, it reflects less of it: part
  // of its reflection cone is blocked by the wave in front. At low sun the
  // reflection is nearly the whole image, so without this the sea flattens into
  // a uniform sheet no matter how much crest-to-trough relief there really is.
  skyRefl *= mix(1.0, ao, 0.8);

  // ---- THE CRAFT IN THE WATER ----------------------------------------------
  //
  // The sea reflects the sky and nothing else, so a craft sitting on it had no
  // image in the water at all. This puts one there without a reflection pass:
  // R is already the direction this fragment is looking in the mirror, so if R
  // points at the craft, the craft is what this fragment reflects. A ray-sphere
  // test against a proxy sphere at the craft is the whole of it - no second
  // camera, no render target, and no flat-mirror assumption, because R comes
  // from the WAVY normal. The wobble in the reflection is therefore the real
  // wave field's, which is the part a planar reflection pass has to fake.
  //
  // The proxy is lit by sampleSky along the same R: the craft is under that
  // sky, so the reflection inherits the scene's exposure and colour for free -
  // orange at sunset, dim at night - instead of being a pasted-on constant.
  //
  // Softened by the surface roughness, so a glassy sea holds a sharp image and
  // a rough one smears it, and faded by uCraftReflAmount, which the app sets to
  // zero whenever there is no craft.
  if (uCraftReflAmount > 0.001) {
    vec3 toC = uCraftReflPos - vWorld;
    float dC = max(length(toC), 1e-3);
    float cosA = dot(normalize(R), toC / dC);
    // Angular radius of the proxy, widened by the GGX lobe.
    float angR = atan(uCraftReflSize / dC);
    float blur = angR * 0.35 + alpha * 0.9;
    float hit = 1.0 - smoothstep(angR * 0.55, angR + blur, acos(clamp(cosA, -1.0, 1.0)));
    // THE CRAFT'S OWN RADIANCE, not a tint on the sky behind it.
    //
    // The first version of this multiplied the sky reflection by the hull's
    // colour, which can only ever DARKEN it - a pale aircraft over bright water
    // came out as a 25% dimming of the sky, measurable but invisible, and
    // reported as "the plane does not give a reflection". A lambertian hull
    // under this sky has radiance albedo * E / pi, and E is the irradiance the
    // sea itself is standing in, so the reflection now brightens or darkens
    // against the water exactly as the real hull does - white against a dark
    // sea, dark against the sun's glare - and stays in the scene's exposure
    // because it is built from the same irradiance the water uses.
    vec3 craftRad = uCraftReflTint * (skyIrr + sunRad * max(uSunDir.y, 0.0) * 0.6) / PI;
    skyRefl = mix(skyRefl, craftRad, hit * uCraftReflAmount);
  }

  vec3 Fenv = envFresnel(NoV, alpha, uWaterIOR);

  // ---- sun specular (disc light, anisotropic lobe) --------------------------
  float sR   = max(uSunAngularRadius, 1e-4);
  float axS  = clamp(aAl + sR*0.5, 1e-4, 1.0);
  float ayS  = clamp(aCr + sR*0.5, 1e-4, 1.0);
  float energy = (aAl*aCr) / (axS*ayS);

  vec3  H   = normalize(L + V);
  float NoH = clamp(dot(N, H), 0.0, 1.0);
  float VoH = clamp(dot(V, H), 0.0, 1.0);
  float Dg  = D_GGXAniso(NoH, dot(T,H), dot(B,H), axS, ayS);
  float Vg  = V_SmithAniso(NoV, NoL, dot(T,V), dot(B,V), dot(T,L), dot(B,L), axS, ayS);
  // Fresnel on the direct highlight was missing before: without it the sea's sun
  // reflection is uniformly blown out instead of being faint underfoot and
  // blazing toward the horizon, which is the entire shape of a glitter path.
  vec3  Fs  = vec3(fresnelDielectric(VoH, uWaterIOR));

  // A perfect mirror returns the sun's own radiance, E/(pi*sR^2). Nothing on a
  // water surface can be brighter than that, so it is the only defensible
  // ceiling.
  float mirrorCeil = 1.0 / (PI * sR * sR);
  float raw = Dg*Vg*energy;
  if (uGlitter > 0.0){
    // Break the lobe up wherever there is genuine sub-pixel slope variance. The
    // ramp is wide so the transition never prints its own boundary across the
    // water, which a tight gate on var demonstrably does.
    float amt = smoothstep(0.0004, 0.018, var);
    // Sampled at the displaced surface point, not the undisplaced grid: the
    // flashes have to live on the water and be carried by it, otherwise the
    // whole pattern slides across the waves it is supposed to belong to.
    raw *= mix(1.0, scintillation(vWorld.xz, foot), amt);
  }
  // min() gives every facet above the limit exactly the same radiance, which is
  // what printed a molten plateau with a geometric edge where a glitter path
  // should have statistical wings that fade over many degrees. A reciprocal knee
  // is strictly monotonic: it never flattens, it approaches the mirror ceiling
  // asymptotically, and it leaves post's bloom a gradient to shape instead of an
  // already-flat slab.
  float ceilv = max(min(uSpecClamp, mirrorCeil), 1.0);
  float lobe = raw / (1.0 + raw / ceilv);
  vec3 sunSpec = sunRad * Fs * lobe * NoL * uSpecIntensity;

  // Moon acts as a dim second sun so night presets keep a specular path.
  vec3 moonSpec = vec3(0.0);
  {
    vec3 Hm = normalize(uMoonDir + V);
    float NoHm = clamp(dot(N, Hm), 0.0, 1.0);
    float NoLm = max(dot(N, uMoonDir), 0.0);
    float Dm = D_GGXAniso(NoHm, dot(T,Hm), dot(B,Hm), axS, ayS);
    float Vm = V_SmithAniso(NoV, NoLm, dot(T,V), dot(B,V), dot(T,uMoonDir), dot(B,uMoonDir), axS, ayS);
    vec3  Fm = vec3(fresnelDielectric(clamp(dot(V,Hm),0.0,1.0), uWaterIOR));
    float rawM = Dm*Vm*energy;
    if (uGlitter > 0.0){
      float amtM = smoothstep(0.0004, 0.018, var);
      rawM *= mix(1.0, scintillation(vWorld.xz + 71.3, foot), amtM);
    }
    // uSpecIntensity applies here too. Without it the only way to strengthen a
    // moon path was to raise moonIntensity, which also feeds the atmosphere LUT
    // and so lifts the whole sky - you got a brighter night rather than a
    // brighter path, which is the opposite of what a moonlit scene wants.
    moonSpec = uMoonColor * Fm * (rawM / (1.0 + rawM/ceilv)) * NoLm
             * smoothstep(-0.05, 0.1, uMoonDir.y) * uSpecIntensity;
  }

  // ---- subsurface / body colour --------------------------------------------
  vec3 Edown = sunRad * max(uSunDir.y, 0.0) + skyIrr;

  // Water-leaving radiance is a small fraction of what goes in - a couple of
  // percent - which is exactly why the sea reads as a mirror at grazing angles.
  // The more steeply you look in, the deeper the column you are looking through,
  // so the near field is the saturated dark blue and the far field is not.
  float pathLen = mix(0.8, 4.2, NoV);
  vec3 body = uScatterColor * Edown * (uScatterAmount / PI) * exp(-uAbsorption * pathLen) * ao;

  // Light that entered the far side of a wave, scattered forward inside it and
  // left toward the eye. Only a thin, steep, backlit crest survives the trip,
  // which is exactly where a real sea glows green at golden hour.
  float steep = clamp(1.0 - N.y, 0.0, 1.0);
  // Only the upper half of a wave is thin enough to be lit through. The old
  // ramp kept a 0.45 pedestal everywhere, so troughs glowed as hard as crests
  // and the effect read as paint on the water rather than light inside it.
  float crest = smoothstep(-0.20, 0.70, rn * max(uSSSHeight, 0.01));
  // Light crossing the crest travels along -L inside the water and refracts on
  // the way out, which bends the exit ray *away* from the outward normal by
  // roughly (n-1) times its tilt. So the lobe is centred a little to the far
  // side of -L, and only on a face that is genuinely turned away from the sun -
  // scaling the bias by how backlit the face is keeps a front-lit swell from
  // picking up a glow it has no business having.
  float away = clamp(-dot(N, L), 0.0, 1.0);
  vec3  Hs = normalize(L + N*max(uSSSBias, 0.0)*away);
  float back = pow(clamp(dot(V, -Hs), 0.0, 1.0), uSSSPower);
  // Optical thickness of the face: a steep crest is thin, a flat back is not.
  float thick = mix(2.2, 0.18, clamp(steep*4.0, 0.0, 1.0)) * max(uSSSDepth, 0.01);
  vec3 trans = exp(-uAbsorption * thick * 3.0);
  // Only a face turned away from the sun can be lit through from behind at all,
  // and the glow has to arrive with the crest rather than switch on across a
  // whole flank, so the ramp is smooth in the same quantity the bias uses.
  float lit = smoothstep(0.05, 0.45, away);
  // The old gate wanted 1-N.y past 0.3 - a 17 degree face - before the glow even
  // started, which is steeper than most of a real wind sea ever gets, so the
  // effect was invisible everywhere except on the handful of breaking crests.
  // A wide ramp on purpose: a hard steepness gate cuts the glow off along a
  // contour of the wave and prints the shape of the threshold rather than the
  // shape of the crest.
  vec3 sss = uScatterColor * sunRad * trans * back * lit * uSSSStrength
           * crest * smoothstep(0.02, 0.30, steep) * 0.30;

  vec3 diffuse = body + sss;

  // ---- composite water -----------------------------------------------------
  // A foam-covered facet is not a mirror, so it cannot carry the water's
  // glitter. Leaving the specular under the raft is what made whitecaps read as
  // glowing embers with sparkles inside them.
  vec3 col = diffuse * (1.0 - Fenv) + skyRefl * Fenv
           + (sunSpec + moonSpec) * (1.0 - foamMask * mix(0.38, 0.90, fresh));

  // ---- foam shading --------------------------------------------------------
  if (foamMask > 0.003){
    float fNoL = max(dot(Nfoam, L), 0.0);
    float fNoV = clamp(dot(Nfoam, V), 1e-4, 1.0);
    // bubbles is foamField's optical thickness. Do not redeclare thick —
    // main() already uses that name for the SSS path length. White only where
    // the lace is optically thick; filaments stay a grey-white veil.
    // A bubble cloud is a volume. Lambertian 0.22-wrap went charcoal at
    // golden hour while the water's GGX path stayed gold — dark grit on
    // the crests. Unoriented sun is light that entered the raft.
    float albedo = clamp(0.70 + 0.26*bubbles + 0.08*uFoamLift*fresh*bubbles, 0.62, 0.97);
    // Hull churn is a bubble volume (same idea as the TSL splash wrap).
    float thickK = smoothstep(0.18, 0.55, wake) * 0.62;
    float wrap = mix(0.48, 0.85, thickK);
    albedo = mix(albedo, 0.90, thickK);
    float fNoLw = max((dot(Nfoam, L) + wrap) / (1.0 + wrap), 0.0);
    vec3 Efoam = skyIrr * ao + sunRad * fNoLw + sunRad * 0.28 * (0.55 + 0.45*bubbles);
    vec3 foamLit = uFoamColor * albedo * Efoam * (1.0/PI);
    float fwd = pow(clamp(dot(V, -L), 0.0, 1.0), 2.5);
    foamLit += uFoamColor * sunRad * fwd * (1.0 - albedo) * (0.5/PI) * (1.0 - 0.55*fresh);
    // Matte foam vs glossy water. A whisper of sheen on thin films only.
    float fa = clamp(uFoamRoughness*uFoamRoughness, 0.004, 1.0);
    vec3 Hf = normalize(L + V);
    float fD = D_GGX(clamp(dot(Nfoam,Hf), 0.0, 1.0), fa);
    float fV = V_SmithGGX(fNoV, fNoL, fa);
    float sheen = 0.018 * (1.0 - bubbles*0.75);
    foamLit += sunRad * min(fD*fV, mirrorCeil) * fNoL * sheen;
    foamLit += sampleSky(reflect(-V, Nfoam), 0.9) * 0.04;

    // Sub-surface bubble cloud: cyan underglow. foamTint is the gain on this
    // scatter, not a dye on the foam albedo.
    float halo = sqrt(foamMask);
    float glowW = halo * smoothstep(0.06, 0.40, bubbles)
                * (0.50 + 0.50*(1.0 - fresh*0.35));
    vec3 cyan = uScatterColor * (skyIrr*0.55 + sunRad*0.30) * (1.0/PI)
              * glowW * (0.55 + 2.8*uFoamTint);

    float tau = 0.22 + 4.6 * bubbles * (0.40 + 0.60*fresh);
    float opFloor = mix(0.10, 0.38, fresh);
    float opacity = clamp(uFoamOpacity * (1.0 - exp(-tau)) * (opFloor + (1.0 - opFloor)*bubbles), 0.0, 1.0);
    foamLit = max(foamLit, col * mix(0.88, 1.12, fresh));
    vec3 under = col + cyan;
    float cover = foamMask * mix(0.38, 0.88, fresh);
    col = mix(col, mix(under, foamLit, opacity), cover);
  }

  // ---- aerial perspective ---------------------------------------------------
  if (uAerial > 0.0 && uCamPos.y >= uSeaLevel){
    vec3 ins, tr;
    vec3 ro = vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0);
    aerialPerspective(ro, normalize(vWorld - uCamPos), min(eyeDist, 60000.0), uSunDir, ins, tr);
    col = col * mix(vec3(1.0), tr, uAerial) + ins * uAerial;
  }

  // ---- underside (camera in the water) -------------------------------------
  if (uCamPos.y < uSeaLevel) {
    vec3 I = -V;
    float cosi = clamp(dot(N, I), 0.0, 1.0);
    float eta = max(uWaterIOR, 1.01);
    float invN = 1.0 / eta;
    float crit = sqrt(max(1.0 - invN * invN, 0.0));
    float win = smoothstep(crit - 0.08, crit + 0.04, cosi);
    float k = 1.0 - eta * eta * (1.0 - cosi * cosi);
    vec3 refr = normalize(I * eta + N * (eta * cosi - sqrt(max(k, 0.0))));
    vec3 sky = sampleSky(refr, mix(0.14, 0.30, 1.0 - win));
    float ph = uTime * 1.65;
    float caus = pow(sin(vFlat.x * 0.38 + ph) * sin(vFlat.z * 0.31 - ph * 1.15) * 0.5 + 0.5, 3.0) * 1.6;
    vec3 deep = (uScatterColor * 0.36 + sky * 0.08) * (1.0 + caus * 0.22);
    vec3 lit = sky * (1.55 + caus * 0.55);
    col = mix(deep, lit, win);
    float cling = smoothstep(0.60, 0.88, vnoise2(vec2(vFlat.x * 0.07 + uTime * 0.11, vFlat.z * 0.07))) * 0.38;
    float foamUw = max(foamMask * mix(0.28, 0.86, fresh), cling);
    vec3 foamCol = mix(vec3(0.70, 0.84, 0.93), vec3(0.94, 0.97, 1.0), max(fresh, cling))
      * (sky * 0.32 + 0.55);
    col = mix(col, foamCol, foamUw);
  }

  fragColor = ABYSSAL_OUT(col);
}
`;
