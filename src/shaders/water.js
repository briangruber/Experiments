// Ocean surface: displaced radial grid + physically-motivated water BRDF.

import { NOISE_GLSL, ATMOSPHERE_GLSL, SKY_LUT_MAP_GLSL } from './sky.js';

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
layout(location=0) in vec2 aRT;      // x: radial parameter 0..1, y: angle 0..1

uniform mat4  uViewProj;
uniform vec3  uCamPos;
uniform vec2  uGridCenter;
uniform float uRMin, uRMax;
uniform float uHeightScale, uHorizScale;
uniform float uEarthCurve;
uniform float uSeaLevel;

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

  // Planet curvature drops the far surface away, which is what actually puts
  // the horizon at the right place and hides the end of the grid.
  pos.y -= uEarthCurve * (r*r) / (2.0 * R_EARTH);

  vWorld  = pos;
  vDist   = r;
  vHeight = disp.y;
  vRelief = relief;
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

export const WATER_FS = /* glsl */`
${CASCADE_COMMON}
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
uniform float uFoamSharp, uFoamStreak, uFoamOpacity, uFoamCrisp;
// Craft wake: a short polyline of where the hull has been, each point carrying
// how hard it was working when it passed. Cheaper and far more controllable than
// injecting into the foam sim, which is periodic per cascade and would smear the
// trail across every tile.
uniform vec4  uWake[28];          // xz position, z-> disturbance, w-> age (s)
uniform int   uWakeCount;
uniform vec2  uWakeCentre;
uniform float uWakeRadius, uWakeWidth, uWakeLife, uWakeStrength, uWakeSpread;
uniform float uWakeArmRate, uWakeArm, uWakeCentre2;
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
uniform float uWaveShadow, uShadowScale;
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
float sqrDist(float x, float w){ float t = x / max(w, 1e-3); return t*t; }

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

// Foam field. The streak term stretches clumps into downwind windrows; the
// bubble term is the close-range structure that stops whitewater looking painted.
float foamField(vec2 p, float t, float foot, out float bubbles){
  vec2 w = uWindDirV, q = windPerp();
  vec2 x = vec2(dot(p, w), dot(p, q));
  vec2 s = vec2(x.x * (1.0 - 0.80*uFoamStreak), x.y * (1.0 + 2.4*uFoamStreak));
  vec2 drift = w * t * 0.35;
  float a = fbm3(vec3(s*0.16 + drift.x, t*0.05), 3);
  // The 15 cm clump band has to converge on its own mean once a pixel spans
  // several clumps, or the mask it shapes turns into per-pixel confetti right
  // where the sea is most covered.
  float bf = 1.0 - smoothstep(0.09, 0.55, foot);
  bubbles = mix(0.5, fbm3(vec3((p - drift)*6.5, t*0.45), 2), bf);
  // Centred on its own mean and stretched to fill 0..1. The caller uses this
  // purely to decide WHERE inside the footprint the foam sits, so a field whose
  // mean is not 0.5 would silently rescale the coverage the sim computed.
  return clamp(0.5 + (a - 0.5)*1.6 + (bubbles - 0.5)*0.55, 0.0, 1.0);
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

  // Sub-cascade capillary detail, near field only.
  float capFade = uCapillary > 0.0
    ? 1.0 / (1.0 + (dist*dist) / (900.0 * uCapillaryScale * uCapillaryScale))
    : 0.0;
  // Crests a few centimetres apart cannot survive a pixel that spans tens of
  // them; point-sampling them anyway is pure aliasing.
  capFade *= 1.0 - smoothstep(0.06, 0.34, foot);
  if (capFade > 0.01){
    float amp = uCapillary * 0.16 * capFade * clamp(uWindSpeed/9.0, 0.15, 2.0);
    // They pile up on the face turned into the wind.
    amp *= clamp(0.45 + dot(slope, uWindDirV) * 2.0, 0.0, 1.8);
    slope += capillarySlope(vFlat.xz, uTime, amp);
  }

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  float var = max(msq - dot(slope, slope), 0.0) + lost;

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
  float b2   = uBaseRoughness * uBaseRoughness;
  // alpha^2 = 2*sigma^2 is the Beckmann->GGX slope-variance identity. Capping it
  // matters: a real sea tops out near mss 0.09 even in a hurricane, so alpha can
  // never legitimately reach 1 and turn the distant water Lambertian-white.
  float aAl  = clamp(sqrt(b2 + 2.0*vAl*uRoughnessGain), 1e-3, uRoughnessMax);
  float aCr  = clamp(sqrt(b2 + 2.0*vCr*uRoughnessGain), 1e-3, uRoughnessMax);
  float alpha = sqrt(aAl * aCr);

  vec3 wind3 = vec3(uWindDirV.x, 0.0, uWindDirV.y);
  vec3 T = normalize(wind3 - N * dot(N, wind3));
  vec3 B = cross(N, T);

  // ---- craft wake ----------------------------------------------------------
  float wake = 0.0;
  if (uWakeCount > 1 && uWakeStrength > 0.001 &&
      distance(vFlat.xz, uWakeCentre) < uWakeRadius) {
    for (int i = 0; i < 27; i++) {
      if (i >= uWakeCount - 1) break;
      vec4 a = uWake[i], b = uWake[i + 1];
      vec2 seg = b.xy - a.xy;
      float ll = max(dot(seg, seg), 1e-4);
      float t = clamp(dot(vFlat.xz - a.xy, seg) / ll, 0.0, 1.0);
      float dist = distance(vFlat.xz, a.xy + seg * t);
      float age = mix(a.w, b.w, t);
      float stir = mix(a.z, b.z, t);
      // A real wake is not a widening smear down the middle of the path. It is a
      // Kelvin pattern: two cusp arms that leave the hull at a fixed angle and
      // therefore stand at a lateral distance growing linearly with how long ago
      // the water was disturbed, with churned, aerated water between them. So the
      // arms are a ridge at |lateral| = rate * age, not a falloff from zero.
      float arm  = uWakeArmRate * age;
      float wdt  = uWakeWidth * (1.0 + uWakeSpread * age);
      float ridge  = exp(-sqrDist(dist - arm, wdt));
      // The churn between the arms is broad, soft and much shorter lived than
      // the arms themselves - it is entrained air, not a surface wave.
      float centre = exp(-sqrDist(dist, wdt * (1.0 + 1.6 * age)))
                   * uWakeCentre2 * max(1.0 - age / (uWakeLife * 0.45), 0.0);
      float fade = max(1.0 - age / max(uWakeLife, 0.1), 0.0);
      wake = max(wake, (ridge * uWakeArm + centre) * stir * fade);
    }
    wake = clamp(wake * uWakeStrength, 0.0, 1.0);
  }

  // ---- foam mask -----------------------------------------------------------
  float bubbles;
  float fd = foamField(vFlat.xz, uTime, foot, bubbles);
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
  float covR = clamp(foamR * uFoamAmount + wake, 0.0, 1.0);
  covF = clamp(covF + wake * 0.55, 0.0, 1.0);
  // Once the pixel is wider than a clump there is nothing left to resolve and
  // the contrast has to collapse onto the mean, or the far field turns into
  // per-pixel confetti.
  float clumpRes = 1.0 - smoothstep(0.4, 5.0, foot);
  float shape  = clamp(1.0 + (fd - 0.5) * 2.6 * max(uFoamSharp, 0.05), 0.0, 3.2);
  // The raft is what is left after the crest that made it has moved on, so it
  // sits where the field was high a moment ago: a shifted, softer version of the
  // same clumps, which is what draws the streaks out behind the whitecaps.
  float shapeR = clamp(1.0 + (fd - 0.62) * 1.7 * max(uFoamSharp, 0.05), 0.0, 2.4);
  // Multiplying a blurry coverage by a detail field keeps the blur: the sim's
  // foam lives at 1.5 m per texel, so close up the raft was a magnified smudge
  // with texture painted over it. Resolving the coverage *against* the detail
  // field instead - foam wherever the field exceeds 1 - coverage - puts the edge
  // at the bubble scale where it belongs, and because the threshold moves with
  // the coverage the area it selects still tracks what the sim computed.
  // Only worth doing while a pixel is narrower than a clump; past that there is
  // nothing to resolve and the multiplicative mean is the honest answer.
  float crisp = clumpRes * clamp(uFoamCrisp, 0.0, 1.0);
  float eF = 0.11, eR = 0.20;
  float maskF = mix(clamp(covF * mix(1.0, shape,  clumpRes), 0.0, 1.0),
                    smoothstep(1.0 - covF - eF, 1.0 - covF + eF, fd), crisp);
  float maskR = mix(clamp(covR * mix(1.0, shapeR, clumpRes), 0.0, 1.0),
                    smoothstep(1.0 - covR - eR, 1.0 - covR + eR, fd), crisp);
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

  vec3 Nfoam = N;
  if (foamMask > 0.003){
    // Bubble relief from a cheap analytic gradient, and a slight lift so the
    // raft sits proud of the water rather than being painted onto it.
    // Two scales of bubble: clumps of raft a hand's width across, and the
    // individual bubble caps inside them. One scale alone reads as a noise
    // texture rather than as whitewater.
    // Each band dies as its cells drop under the pixel footprint, and it dies
    // toward its own mean rather than to zero, so a distant raft becomes a flat
    // patch of the right brightness instead of a field of aliasing sparks.
    float cf = 1.0 - smoothstep(0.14, 0.85, foot);   // 25 cm clumps
    float bf = 1.0 - smoothstep(0.035, 0.20, foot);  // 6 cm bubble caps
    float e = 0.09;
    vec3 bp = vec3(vFlat.xz*4.0, uTime*0.45);
    vec3 bq = vec3(vFlat.xz*17.0, uTime*1.1);
    float base = 0.5*(1.0 - cf) + 0.25*(1.0 - bf);   // keeps the mean at 0.75
    float b0 = vnoise(bp)*cf + 0.5*vnoise(bq)*bf + base;
    float bx = vnoise(bp + vec3(e*4.0, 0.0, 0.0))*cf + 0.5*vnoise(bq + vec3(e*17.0, 0.0, 0.0))*bf + base;
    float bz = vnoise(bp + vec3(0.0, e*4.0, 0.0))*cf + 0.5*vnoise(bq + vec3(0.0, e*17.0, 0.0))*bf + base;
    vec2 bg = vec2(bx - b0, bz - b0) / e;
    // Replace the coarse mask-shaping noise with this finer field: from here on
    // the bubble term is shading structure, not coverage modulation.
    bubbles = clamp(b0*0.75, 0.0, 1.2);
    float relief = uFoamDetail * (0.3 + 0.9*fresh) * (1.0 / (1.0 + dist*0.02));
    Nfoam = normalize(vec3(-slope.x - bg.x*relief, 1.0, -slope.y - bg.y*relief));
    // A raft sits proud of the water, so it is a little flatter than the wave it
    // rides - but only a little, or it stops reading as part of the wave at all.
    Nfoam = normalize(mix(Nfoam, vec3(0.0, 1.0, 0.0), 0.12*foamMask));
  }

  float NoV = clamp(dot(N, V), 1e-4, 1.0);

  // ---- lights --------------------------------------------------------------
  vec3 sunTr = sunTransmittance(vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0), uSunDir);
  vec3 sunRad = uSunColor * sunTr * uAtmoExposure;
  sunRad *= smoothstep(-0.09, 0.02, uSunDir.y);
  // Every direct-sun term below sees the shadowed irradiance; only the sky
  // ambient reaches into a swell's lee.
  sunRad *= sunVisibility(vFlat.xz, vSwellH, dist);

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
    moonSpec = uMoonColor * Fm * (rawM / (1.0 + rawM/ceilv)) * NoLm
             * smoothstep(-0.05, 0.1, uMoonDir.y);
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
           + (sunSpec + moonSpec) * (1.0 - 0.9*foamMask);

  // ---- foam shading --------------------------------------------------------
  if (foamMask > 0.003){
    float fNoL = max(dot(Nfoam, L), 0.0);
    float fNoV = clamp(dot(Nfoam, V), 1e-4, 1.0);
    // Whitewater is an optically thick bubble raft: a near-Lambertian dielectric.
    // Measured whitecap reflectance is far lower than the eye assumes - a fresh
    // breaking crest is around 0.6-0.8, and the thin dissipated raft that covers
    // most of the sea is nearer 0.3, which is why a photographed streak is grey
    // where a painted one is white. Building it as albedo x irradiance is what
    // bounds it; the raft can never out-emit the sunlight falling on it.
    float albedo = clamp(0.28 + 0.44*fresh + 0.10*uFoamLift*fresh, 0.0, 0.82);
    albedo *= 0.72 + 0.50 * bubbles;
    albedo = min(albedo, 0.86);
    vec3 Efoam = skyIrr * ao + sunRad * fNoL;
    vec3 foamLit = uFoamColor * albedo * Efoam * (1.0/PI);
    // Bubble rafts scatter hard forward: a raft lights up when the sun is behind
    // it. That is transmitted light, so it is bounded by what was not reflected,
    // and a thin dissipated veil transmits far more than a dense fresh crest.
    float fwd = pow(clamp(dot(V, -L), 0.0, 1.0), 2.5);
    foamLit += uFoamColor * sunRad * fwd * (1.0 - albedo) * (0.5/PI) * (1.0 - 0.55*fresh);
    // Wet-sheen highlight off the bubble film, bounded by the same mirror
    // ceiling the water's own specular uses.
    float fa = clamp(uFoamRoughness*uFoamRoughness, 0.004, 1.0);
    vec3 Hf = normalize(L + V);
    float fD = D_GGX(clamp(dot(Nfoam,Hf), 0.0, 1.0), fa);
    float fV = V_SmithGGX(fNoV, fNoL, fa);
    foamLit += sunRad * min(fD*fV, mirrorCeil) * fNoL * 0.06;
    // Sky reflected off the raft keeps it tied to the light of the scene.
    foamLit += sampleSky(reflect(-V, Nfoam), 0.9) * 0.05;

    foamLit = mix(foamLit, foamLit * mix(vec3(1.0), uScatterColor*3.0, 0.5), uFoamTint);

    // Aged foam has thinned into a veil a handful of bubbles deep, so the sea
    // shows straight through it: a Beer-Lambert opacity in the raft's own
    // thickness, not a paint layer. Only the fresh crest is optically thick.
    float tau = 0.35 + 5.0 * fresh;
    float opacity = clamp(uFoamOpacity * (1.0 - exp(-tau)) * (0.55 + 0.7*bubbles), 0.0, 1.0);
    col = mix(col, mix(col, foamLit, opacity), foamMask);
  }

  // ---- aerial perspective ---------------------------------------------------
  if (uAerial > 0.0){
    vec3 ins, tr;
    vec3 ro = vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0);
    aerialPerspective(ro, normalize(vWorld - uCamPos), min(eyeDist, 60000.0), uSunDir, ins, tr);
    col = col * mix(vec3(1.0), tr, uAerial) + ins * uAerial;
  }

  fragColor = vec4(col, 1.0);
}
`;
