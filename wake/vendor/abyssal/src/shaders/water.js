// Ocean surface: displaced radial grid + physically-motivated water BRDF.

import { NOISE_GLSL, ATMOSPHERE_GLSL, SKY_LUT_MAP_GLSL } from './sky.js';
import { WAKE_SAMPLE_GLSL } from '../wake.js';
import { FOAM_ENERGY_SAMPLE_GLSL } from '../foam-energy.js';
import { HDR_OUTPUT_GUARD } from './output.js';

const HULL_LIFT_GLSL = /* glsl */`
uniform vec3  uHullPos;
uniform vec2  uHullFwd;
uniform float uHullPush, uHullRadius, uHullBow, uHullPlane;
uniform float uHullCut, uHullCutLen, uHullCutBeam;
uniform float uHullFoam, uHullFoamW;
uniform vec2  uHullCutPos;   // the hull's MIDDLE; uHullPos is its stem

// THE HULL EXCLUDES WATER FROM THE SPACE IT OCCUPIES.
//
// The sea is one continuous sheet, so looking down into an open boat the water
// surface sits between the eye and the boat's floor and simply wins the depth
// test -- which is why an inflatable read as swamped while its tubes were
// plainly dry. No amount of render ordering fixes that: the water really IS in
// front of the floor. The only honest answer is not to draw sea inside a hull.
//
// An oriented ellipse in hull-local metres, inset a little so the tubes always
// overhang the hole and no gap opens at the waterline.
float hullInside(vec2 xz){
  if (uHullCut < 0.5) return 0.0;
  vec2 rel = xz - uHullCutPos;
  float along = dot(rel, uHullFwd) / max(uHullCutLen, 0.3);
  float lat   = dot(rel, vec2(-uHullFwd.y, uHullFwd.x)) / max(uHullCutBeam, 0.2);
  return along * along + lat * lat < 1.0 ? 1.0 : 0.0;
}

// The SAME ellipse, as a distance rather than as a yes or no: exactly 1.0 on
// the waterline the hull cuts, less inside it, more outside. hullInside()
// throws that number away at the comparison, and it is the one thing needed to
// hug the cut rather than merely test it. Negative when there is no cut to hug.
// along comes back too (no backticks in here -- this GLSL lives inside a JS
// template literal), because the bow shears water and the quarter does not.
float hullEdgeQ(vec2 xz, out float along){
  along = 0.0;
  if (uHullCut < 0.5) return -1.0;
  vec2 rel = xz - uHullCutPos;
  along = dot(rel, uHullFwd) / max(uHullCutLen, 0.3);
  float lat = dot(rel, vec2(-uHullFwd.y, uHullFwd.x)) / max(uHullCutBeam, 0.2);
  return sqrt(along * along + lat * lat);
}

// Twin of hullLift() in gpu/tsl/water-surface.js. The hollow, bow heap
// and shoulder mounds — signed metres — so both stages displace and
// light the same carve.
float hullLift(vec2 xz){
  if (uHullPush <= 0.0005) return 0.0;
  vec2 rel = xz - uHullPos.xz;
  float d2 = dot(rel, rel);
  float R = max(uHullRadius, 0.5);
  if (d2 >= R * R * 4.0) return 0.0;
  float along = dot(rel, uHullFwd);
  float lat   = dot(rel, vec2(-uHullFwd.y, uHullFwd.x));
  float g = exp(-(along * along / (R * R) + lat * lat / (R * R * 0.30)));
  float press = -g * smoothstep(1.2, -1.6, along);
  float bow  = g * smoothstep(-0.1, 1.3, along) * uHullBow;
  float side = g * smoothstep(0.25, 1.0, abs(lat) / R) * uHullBow * 0.5;
  return (press + bow + side) * uHullPush * uHullPlane;
}
`;

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

// Swell (cascade 0) is not wind-patch driven. Mid-sea and the shortest
// band are: that is the chop a look-down actually sees. gust is 1
// when uGust is 0, so storms stay even.
float cascadeGustWeight(int c, float gust){
  float shortK = c == 0 ? 0.0 : c == 1 ? 0.7 : 1.0;
  return mix(1.0, gust, shortK);
}
`;

export const WATER_VS = /* glsl */`
${CASCADE_COMMON}
${WAKE_SAMPLE_GLSL}
${HULL_LIFT_GLSL}
layout(location=0) in vec2 aRT;      // x: radial parameter 0..1, y: angle 0..1

uniform mat4  uViewProj;
uniform vec3  uCamPos;      // also read by the FS; one uniform, two stages
uniform vec2  uGridCenter;
uniform float uRMin, uRMax;
// How many rings the radial grid was actually built with, AFTER the adaptive
// controller has thinned it. The vertex spacing depends on it, and anything
// that has to respect Nyquist has to know it rather than assume it.
uniform float uGridRadial;
// How hard a wake flattens the chop riding through it. Used in the VS only:
// this is geometry, not shading.
uniform float uWakeCalm;
uniform float uGroupAmt, uGroupScale, uGroupLo, uGroupHi;
uniform float uRogueH, uRogueLen, uRoguePeriod, uRogueWidth, uRogueRun, uRogueSteep;
// The group field needs a clock and a direction to drift along. Both are
// already uniforms of this program for the fragment stage; declaring them here
// as well is one uniform seen by two stages, not two uniforms.
uniform float uTime;
uniform vec2  uWindDirV;

// Value noise, SELF-CONTAINED, because the vertex stage includes none of the
// fragment shader's noise chunk -- the first cut of the group field called
// fbm2() here and would not have linked. Two octaves is all a group envelope
// needs; it is a slow swelling, not a texture.
float gHash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1,0)), f.x),
             mix(gHash(i + vec2(0,1)), gHash(i + vec2(1,1)), f.x), f.y);
}
float gFbm(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 4; i++){
    if (i >= oct) break;
    s += a * gNoise(p); n += a; a *= 0.5; p = p * 2.03 + vec2(5.1, -3.7);
  }
  return s / max(n, 1e-4);
}
uniform float uHeightScale, uHorizScale;
uniform float uEarthCurve;
uniform float uSeaLevel;
uniform float uHorizonPin; // 1 = pin last ring to the sightline; 0 when looking down
// Hull uniforms live in HULL_LIFT_GLSL. The craft displaces real water,
// not just foam: hollow under the hull, bow heap, shoulder mounds.
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
  // The SHORT cascades kept apart from the swell, because a wake damps them and
  // does not damp the swell. See the calming block below.
  vec3 dispShort = vec3(0.0);
  float relief = 0.0;
  float swellH = 0.0;
  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    float w = cascadeWeight(c, r);
    if (w <= 0.001) continue;
    vec4 d = texture(uDisp, vec3(xz / uPatch[c], float(c)));
    vec3 dd = vec3(d.x*uHorizScale, d.y*uHeightScale, d.z*uHorizScale) * w;
    if (c > 0) dispShort += dd; else disp += dd;
    // Cascade 0 is the swell; everything above it is the local relief riding on
    // top of it. Occlusion and subsurface glow care about that relief, not about
    // how high the whole swell has lifted this patch of sea.
    if (c > 0) relief += dd.y;
    // The two longest cascades are the only ones that cast a shadow wider than
    // a pixel; the fragment shader marches exactly this height field.
    if (c < 2) swellH += d.y * uHeightScale;
  }
  vSwellH = swellH;
  // WAVE GROUPS -- sets, and the outliers inside them.
  //
  // An FFT sea is a sum of independent components, so its surface is Gaussian
  // and statistically the same everywhere at once. Real water is not: waves
  // arrive in GROUPS, a few big ones together and then a lull, because
  // components of slightly different wavelength beat against each other as they
  // travel. That beating is what makes a sea feel like it has moods, and it is
  // why every so often one wave stands well clear of its neighbours.
  //
  // A slow field, drifting downwind, scaling the whole displacement. Two
  // octaves an order apart: the slow one is the set, the faster one lets an odd
  // wave inside a set stand up on its own. Multiplying the displacement rather
  // than adding a wave keeps the sea's own shapes -- crests stay crests, they
  // just grow and subside as the group passes through them.
  if (uGroupAmt > 0.0005) {
    vec2 drift = uWindDirV * uTime * 1.4;
    float g1 = gFbm(xz * uGroupScale + drift * uGroupScale, 3) * 2.0 - 1.0;
    float g2 = gFbm(xz * uGroupScale * 4.3 - drift * uGroupScale * 2.0 + 37.0, 2) * 2.0 - 1.0;
    // EXPLICIT BOUNDS, so the range is something you state rather than infer.
    //
    // The field itself is a sum of two fbms, which is bell-shaped: most water
    // sits near the middle and the extremes are rare. That is the right shape
    // for a sea -- a genuine outlier should be uncommon -- so it is mapped
    // straight onto a 0..1 position between the smallest and largest a wave is
    // allowed to be, rather than being scaled by an amount whose reach you have
    // to work out from the coefficients.
    //
    // uGroupAmt stays the master: at 0 the sea is uniform and Gaussian again,
    // at 1 the full range is in play.
    float gn = g1 * 0.72 + g2 * 0.38 * max(g1, 0.0);
    float gt = clamp(gn * 0.5 + 0.5, 0.0, 1.0);
    float g = mix(1.0, mix(uGroupLo, uGroupHi, gt), uGroupAmt);
    float gk = max(g, 0.02);
    disp *= gk;
    dispShort *= gk;
    relief *= gk;
  }

  // A WAKE CALMS THE WATER, AND AS GEOMETRY -- not only as shading.
  //
  // Churned water is loaded with bubbles and with the surface-active film they
  // bring up with them, and both dissipate short gravity-capillary waves fast.
  // The swell rolls straight through, because a wave tens of metres long
  // carries far too much momentum to care; the centimetre-to-metre chop riding
  // on top of it is flattened. That is why a boat's track stays legible as a
  // smooth lane on broken water long after the white has gone, and it is one of
  // the most recognisable things about a real wake.
  //
  // The shading already knew this -- the fragment shader drops the wind foam
  // and cuts the mean-square slope inside the churn -- but the SURFACE did not:
  // the chop was still there in the geometry, at full height, being shaded as
  // though it were smooth. So the lane read as a paler stripe rather than as
  // calmer water, and at a glancing angle the unflattened ripples gave it away
  // completely.
  //
  // Only the short cascades are touched, which is the physics doing the
  // selecting rather than a look: cascade 0 is the swell and is left alone.
  if (uWakeOn > 0.5 && uWakeCalm > 0.001) {
    float calm = clamp(wakeAt(xz).z * uWakeCalm, 0.0, 1.0);
    float k = 1.0 - calm;
    dispShort *= k;
    relief *= k;
  }
  disp += dispShort;

  pos += disp;

  // ---- THE BIG ONE ----------------------------------------------------------
  //
  // A rogue set: one long-crested wave that rolls through and passes on.
  //
  // This cannot be done by scaling the sea, and that is worth being clear about
  // -- multiplying the whole field by a large number does not give you one big
  // wave, it gives you the same chaotic sea with everything in it enormous, and
  // the horizontal displacement folds through itself as it goes. What arrives
  // at a beach out of a calm sea is something else entirely: a PACKET, a few
  // crests long, travelling in one direction, with ordinary water either side.
  //
  // So: a band perpendicular to the wind, Gaussian-enveloped along the
  // direction of travel, sweeping across the scene once every uRoguePeriod
  // seconds. Its phase speed is the deep-water relation sqrt(g*lambda/2pi) --
  // the same physics the cascades run on -- so a long swell outruns a short one
  // exactly as it should.
  if (uRogueH > 0.001) {
    vec2 rd = normalize(uWindDirV + vec2(1e-5, 0.0));
    float T = max(uRoguePeriod, 4.0);
    float lam = max(uRogueLen, 3.0);
    // IT TRAVELS AT ITS OWN SPEED, which is the whole point and was the bug.
    //
    // cph was computed here and then never used: the packet's position came
    // from run/T instead, so a 485 m swell on an 8 s cycle crossed nearly six
    // kilometres in eight seconds -- 727 m/s, about Mach 2. It read as a
    // sweeping bar rather than as water because that is what it was.
    //
    // Two speeds, and they are different, which is what makes a real swell look
    // alive: the ENVELOPE moves at the group velocity, half the phase speed in
    // deep water, while the CRESTS inside it march through at the full phase
    // speed -- rising at the back of the group, running forward, dying out at
    // the front. One wave is never the same wave for long.
    float cph = sqrt(9.81 * lam / 6.28318530718);
    float cg = cph * 0.5;
    // The period sets how often one comes, and the group covers cg * T metres
    // in that time, which is what makes the speed right by construction rather
    // than by a number that has to be kept in step with it.
    float run = cg * T;
    float travel = fract(uTime / T) * run - run * 0.5;
    float sEnv = dot(xz, rd) - travel;
    float wdt = max(uRogueWidth, lam * 0.6);
    float env = exp(-(sEnv * sEnv) / (2.0 * wdt * wdt));
    if (env > 0.0015) {
      float k = 6.28318530718 / lam;
      // Crest phase on the FULL speed, so the crests move through the envelope.
      float ph = k * (dot(xz, rd) - cph * uTime);
      pos.y += cos(ph) * env * uRogueH;
      // Gerstner shift: water piles toward the crest and thins in the trough,
      // which is what makes a big wave look like it is ABOUT to break rather
      // than like a sine curve someone made tall.
      vec2 sh = - rd * sin(ph) * env * uRogueH * uRogueSteep;
      pos.x += sh.x;
      pos.z += sh.y;
    }
  }

  pos.y += hullLift(xz);

  if (uWakeOn > 0.5) {
    // NYQUIST, MEASURED -- not a fraction of the field's size.
    //
    // This grid is exponential in radius, r = rMin (rMax/rMin)^t, so the
    // spacing between rings is r ln(rMax/rMin) / rings: it grows in PROPORTION
    // to the distance. With the shipped 400 rings that is 2.9% of r, so a
    // vertex every 1.5 m at 50 m out and every 3 m at 100 m -- and on a device
    // the adaptive controller has thinned to 200 rings, twice that again.
    //
    // The narrowest thing the wake draws is a cusp arm, about 2 x uWakeArmW
    // across -- three metres with the shipped 1.5 m half-width. Displacing a
    // three-metre ridge with a vertex every three metres does not produce a
    // faint ridge, it produces a ZIGZAG: each ring catches the crest at a
    // different phase and the triangle edges themselves become the pattern.
    // That is the sawtooth in the mid-distance, and it is a sampling failure,
    // not a shading one.
    //
    // The old guard faded between 18% and 88% of the wake FIELD's extent,
    // which at the default 270 m meant 49 m to 237 m. Two things were wrong
    // with it: it is tied to a parameter that says how much water the buffer
    // remembers, which has nothing to do with how finely the surface is
    // tessellated, and it ignores the ring count entirely -- so thinning the
    // grid for performance made the aliasing worse and moved nothing. Worse,
    // that band IS the aliasing zone: it held the wake at partial strength
    // across exactly the range where the grid cannot represent it.
    //
    // So fade on the real quantity: local spacing against the arm width. The
    // wake stops being DISPLACED once a ring can no longer resolve it, while
    // the fragment shader goes on shading it (see wakeRecon) -- which is the
    // right split, because foam is a texture and needs no vertices.
    float spacing = r * log(uRMax / uRMin) / max(uGridRadial, 1.0);
    float nyq = 1.0 - smoothstep(0.55, 1.35, spacing / max(uWakeArmW, 0.2));
    // Still bounded by the buffer: past its extent there is nothing recorded.
    float wf = nyq * (1.0 - smoothstep(uWakeExtent * 0.55, uWakeExtent * 0.95, r));
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
${HULL_LIFT_GLSL}

${HDR_OUTPUT_GUARD}
${CASCADE_COMMON}
${WAKE_SAMPLE_GLSL}
${FOAM_ENERGY_SAMPLE_GLSL}
${NOISE_GLSL}

// ---- the prototype's foam lace ------------------------------------------
// FORKED IN for the wake lab. Upstream shades hull-wake foam by grading a
// packed coarse/fine/breakup PNG and stencilling it with the energy field.
// This is the prototype's method instead: a bubble raft is open cells with
// bright walls, which is what contours of a noise field give -- far cheaper
// than real Worley cells and, on this wake, considerably better looking.
//
// Two failure modes are designed out, both of which were hit while building it:
//   · thresholding the ridge function directly yields nested outlines, a
//     contour map rather than cells -- hence GRAIN-dominant weights;
//   · scaling the sample position by coverage warps the noise along coverage's
//     own gradient and snaps the lace onto iso-contours of foam. So coverage
//     widens the WALL and never moves the point.
uniform float uLabLace, uLabSoft, uLabCoarsen, uLabDensity, uLabGain;
uniform float uLabSea, uLabSeaBreak;

float labLattice(vec2 p, float w){
  return 1.0 - smoothstep(0.0, w, abs(fbm2(p, 3) - 0.50));
}

// The raw lace FIELD, before any threshold. Split out because the sea's own
// whitecaps threshold a detail field in exactly the same form the wake does --
// smoothstep(1-cover-e, 1-cover+e, detail) -- so once this is separate, both
// can be shaped by the same lace and the sea stops wearing a different foam
// from the boat.
float labDetail(vec2 world, float cover, float px){
  float scale = max(uLabLace, 0.001);
  // Thinning foam is old foam, and a bubble raft coarsens as it ages.
  float wall = 0.125 + uLabCoarsen * 0.085 * (1.0 - clamp(cover, 0.0, 1.0));
  vec2 lp = world * scale;
  float cells = labLattice(lp, wall);
  float grain = fbm2(lp * 2.6 + 7.0, 3);
  // Grain-dominant on purpose: the lattice is a ridge function and belongs
  // here as an accent on smooth noise. Cell SIZE comes from the scale.
  float detail = clamp(grain * 0.68 + cells * 0.46, 0.0, 1.0);
  // Sub-pixel lace aliases into sparkle, so fade it toward flat coverage.
  float cell = 1.0 / scale;
  return mix(0.5, detail, 1.0 - smoothstep(0.22, 0.75, px / cell));
}

// cover: how much of this water is aerated. px: the world width of one pixel.
float labLace(vec2 world, float cover, float px){
  float b = max(uLabSoft, 0.02);
  // Coverage slides a threshold down through the field: dense foam takes all
  // of it, thin foam keeps only the cell walls, and between them is the fringe.
  return smoothstep(1.0 - cover - b, 1.0 - cover + b, labDetail(world, cover, px));
}

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
uniform float uSeaLevel;
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
uniform sampler2D uFoamLace;
// Packed wake-only masks: R coarse cells, G fine lace, B sparse breakup.
uniform sampler2D uWakeFoamPack;
uniform float uFoamTextureAmount, uFoamTextureScale;
// CPU / TSL twins: foamLaceWarpOf() in src/foam-lace.js.
uniform float uFoamTextureCarry, uFoamTextureShear, uFoamTextureStrain;
uniform float uFoamLaceStretch, uFoamLaceStretchBlock;
uniform float uFoamLaceMorph, uFoamLaceMorphRate;
uniform float uWakeFoamRibbonVary;
// Twin of wakeFoamRibbonAmount() — recipe foam, not energy.
uniform float uFoamRibbon;
const float WAKE_FOAM_FRESH = 0.72;
const float WAKE_FOAM_RESIDUE = 0.48;
// Hand-mirrored from src/foam-lace.js. check-foam-lace.mjs asserts they match.
const float WAKE_FOAM_WASH = 0.55;
const float WAKE_FOAM_TAIL = 0.14;
const float WAKE_FOAM_BROKEN = 0.34;
// Craft wake: wakeAt() above. The rest of the knobs are how it is shaded.
uniform float uWakeRelief, uWakeSlick;
// Entrained air in the water column, as opposed to white foam on the surface.
// Hand-mirrored from gpu/tsl/water-surface.js.
uniform float uWakePlume;
const float WAKE_PLUME_GAIN = 6.5;
const float WAKE_PLUME_PATH = 0.26;
uniform vec3  uFoamColor;
uniform float uSunAngularRadius, uSpecIntensity;
uniform float uSkyAmbient, uSkyBlur;
uniform float uGlitter, uGlitterScale;
uniform float uWaterIOR;
uniform float uAerial;
uniform float uFloorDepth, uFloorDepthMin, uFloorDepthMax, uFloorTerrainScale, uFloorCaustic;
uniform float uFloorCausticSize;
uniform vec3  uBedSand, uBedWeed, uBedCoral;
uniform float uBedCoralAmt;
uniform float uBedGain;
// FORKED IN: screen-space refraction. The scene (hull, spray) is rendered to
// a colour+depth target BEFORE the water; the water then looks through itself
// into that image with wobbled UVs. Without it the submerged half of a hull
// simply loses the depth test at the waterline and is razored off.
// The scene as seen from a camera mirrored through the water plane, and the
// matrix that projects a world point into it.
uniform sampler2D uReflTex;
uniform mat4  uReflMat;
uniform float uReflOn, uReflAmt, uReflDistort, uReflBlur, uReflMaxLod;
uniform float uReflFade, uReflOpacity;
uniform vec2  uReflOrigin;
uniform sampler2D uRefrColor;
uniform highp sampler2D uRefrDepth;
uniform vec2  uRefrRes;
uniform float uRefrOn, uRefrAmt, uRefrNear, uRefrFar, uRefrMurk;
uniform vec3  uBubCol;
uniform float uBubOn, uBubBright, uBubMilk, uBubDeepTint;
uniform float uBedWeedAmt;
uniform float uRefractDistort;
uniform float uFloorCausticLod[4];
uniform float uFloorCausticSpan;
uniform float uShoreFoamAmount, uShoreFoamRange;
// FORKED IN: the real coastline's height field, so the sea can break on the
// rock that is actually there instead of on its own procedural bed.
uniform sampler2D uShoreMap;
uniform float uShoreOn, uShoreExtent, uSurge;
uniform float uSurfSpan, uSurfPeriod, uSurfDecay;
// FORKED: how hard the white reads. 0 keeps the vendor's paint-white raft;
// 1 is a grey-white aerated veil that still lets the water under it through.
uniform float uFoamSoft;
uniform float uWaveDebug, uWaveDebugScale;
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
// The craft's half-extents (athwartships, up, along) and which way it points,
// so its image in the water is the shape of a boat rather than of a ball.
uniform vec3  uCraftReflHalf;
uniform vec2  uCraftReflFwd;
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

// Look-down film / refraction. Skips the short chop cascade.
// Twin: sampleCascadeSlope().
vec2 cascadeSlopeAt(vec2 p, float dist){
  vec2 s = vec2(0.0);
  for (int c = 0; c < 4; c++){
    if (c >= uCascadeCount) break;
    if (uPatch[c] < 40.0) continue;
    float w = cascadeWeight(c, dist);
    s += textureLod(uSlope, vec3(p / uPatch[c], float(c)), 0.0).xy * w;
  }
  return s;
}

// Twin of floorDepthAt() in src/seafloor.js. 1 on the heightfield is a sandbar.
// Moved ABOVE floorTerrainDepth: GLSL requires a function to be declared
// before it is called, and the coral-head bump in the bed's height calls
// this from there. Defined after it, the whole water program failed to
// compile and the sea simply did not draw.
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

float floorTerrainDepth(float px, float pz, float lo, float hi, float scale){
  if (hi - lo < 0.05) return hi;
  float s = max(scale, 4.0);
  float u = px / s;
  float v = pz / s;
  // FORKED: the bed was three sine waves, which is fine at boat height and
  // unmistakable from altitude -- it tiles on a ~155 m grid, and a zoomed-out
  // lagoon turned into wallpaper. Sines still carry the SHAPE a sandy bottom
  // has (bars running one way, channels cutting across them), so they stay;
  // what they lacked was anything aperiodic to break the repeat.
  //
  // Two octaves of value-noise do that, at scales either side of the sines:
  // a slow one that wanders the whole pattern so no two stretches match, and
  // a finer one that roughens the crests. The sines carry about half the
  // weight now instead of all of it.
  // DOMAIN WARP, not just an added octave.
  //
  // Mixing noise INTO the result hides a repeat at close range and does
  // nothing to it at altitude: the sines still line up on their own grid, so
  // from height the bed reads as evenly spaced ribbons marching across the
  // frame. Warping their INPUT instead means the bars never reach the same
  // phase twice -- the pattern keeps its bar-and-channel character, which is
  // what a sandy bottom actually looks like, and loses its period.
  float wx = fbm2(vec2(u, v) * 0.17, 3) * 2.0 - 1.0;
  float wz = fbm2(vec2(u + 31.4, v - 17.2) * 0.17, 3) * 2.0 - 1.0;
  float uw = u + wx * 3.4;
  float vw = v + wz * 3.4;
  float bars = sin(uw * 1.7 + sin(vw * 0.9) * 0.65);
  float channels = sin(vw * 1.15 - sin(uw * 0.55) * 0.8);
  float dunes = sin(uw * 2.4 - vw * 1.3 + sin(uw * 0.7) * 0.45);
  float drift = fbm2(vec2(u, v) * 0.23, 3) * 2.0 - 1.0;   // broad basin shape
  float grain = fbm2(vec2(u, v) * 1.9, 2) * 2.0 - 1.0;    // roughens the crests
  // Coral heads stand PROUD. Painting them on a flat floor gives dark discs
  // with no shallowing over them -- and it is the shallowing that catches the
  // light and turns a head pale green in an otherwise blue bay. Twin of the
  // colour term in main(); same cell field, same scale, so the mound and its
  // colour are the same object.
  vec3 hcw = cellular3(vec2(px, pz) * 0.055);
  float hseed = fbm2(vec2(px, pz) * 0.03 + 71.0, 2);
  float heads = (1.0 - smoothstep(0.10, 0.34, hcw.x))
              * smoothstep(0.42, 0.58, hseed);
  // THE LAGOON-SCALE TERM, and the reason the open sea used to be a flat
  // plain with one bright square cut out of it. Everything above works in
  // units of the terrain scale -- tens of metres, so bars and channels and
  // ripples. None of it builds anything the size of a BAY, so away from the
  // baked coast map the bottom had texture and no shape.
  //
  // This one is in WORLD metres and slow enough to raise banks and drop basins
  // hundreds of metres across, everywhere, for ever. It carries more weight
  // than all the rest together on purpose: the fine work should ride on the
  // big shape rather than compete with it.
  //
  // TWIN: bedDepth() in src/bathymetry.js, which is what puts rocks on the
  // bottom. Change one and change the other.
  float basin = fbm2(vec2(px, pz) * 0.00085, 4) * 2.0 - 1.0;
  float w = clamp(0.5 + 0.5 * (bars * 0.20 + channels * 0.15 + dunes * 0.08
                             + drift * 0.42 + grain * 0.12
                             + basin * 1.25), 0.0, 1.0);
  // The heads lift the bed by up to a couple of metres, capped so they can
  // never break the surface and become invisible geometry the boat drives
  // through.
  return max(mix(hi, lo, w) - heads * 2.2, 0.8);
}

// FORKED. The bed FOLLOWS THE COAST where a coast has been handed over.
//
// This is the single biggest reason a lagoon reads as a swimming pool. The bed
// above is a procedural field between two depths and knows nothing about the
// land: right up against the rocks the water stayed as deep as it is in the
// middle of the bay, so there was no shallow rim, and with no depth ramp there
// is no colour ramp -- one flat cyan everywhere instead of pale mint at your
// feet going turquoise and then sapphire as it drops away. All the physics for
// that gradient was already here (absorption is per channel, and red dies about
// ten times faster than blue), it just never had a depth to work on.
//
// The coast's own height field is metres relative to the waterline, so the
// column above it is its negation. Feather to the procedural bed at the map's
// rim so the join is not a visible square.
float bedDepthAt(vec2 p, float lo, float hi){
  float proc = floorTerrainDepth(p.x, p.y, lo, hi, uFloorTerrainScale);
  if (uShoreOn < 0.5) return proc;
  vec2 suv = p / uShoreExtent + 0.5;
  vec2 e = min(suv, vec2(1.0) - suv);
  float edge = smoothstep(0.0, 0.05, min(e.x, e.y));
  if (edge <= 0.0) return proc;
  // Never zero: a bed exactly at the waterline makes the transmission term
  // degenerate. 0.05 m of water still reads as wet sand, which is right.
  float shore = max(-texture(uShoreMap, suv).r, 0.05);
  return mix(proc, shore, edge);
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

// One moving caustic sheet. Twin: floorLaceLayer() in seafloor.js.
float floorLaceLayer(float x, float z, float t, float scale, float driftX, float driftZ, float phase){
  float u = x * scale + driftX * t;
  float v = z * scale + driftZ * t;
  u += sin(v * 1.7 + t * 0.7 + phase) * 0.06 + sin(v * 0.55 + t * 0.21 + phase) * 0.04;
  v += cos(u * 1.4 + t * 0.55 + phase) * 0.06 + cos(u * 0.48 - t * 0.17 + phase) * 0.04;
  vec3 c = cellular3(vec2(u, v));
  float gap = c.y - c.x;
  float glow = pow(1.0 - smoothstep(0.02, 0.22, gap), 1.15);
  float ridge = pow(1.0 - smoothstep(0.0, 0.07, gap), 2.2);
  float broken = smoothstep(0.18, 0.58, c.z);
  float flare = pow(1.0 - smoothstep(0.0, 0.18, c.y), 2.6) * ridge;
  return (glow * 0.38 + ridge * 0.55) * broken + flare * 0.85;
}

// Focused sunlight on the bed. Twin: floorLace() in seafloor.js.
float floorLace(float x, float z, float t){
  float a = floorLaceLayer(x, z, t, 2.85, 0.11, -0.07, 0.0);
  float b = floorLaceLayer(x, z, t, 1.95, -0.08, 0.10, 2.1);
  float c = floorLaceLayer(x, z, t, 3.55, 0.04, 0.09, 4.4);
  float raw = min(1.2, a * 0.52 + b * 0.34 + c * 0.22);
  float field = smoothstep(0.04, 0.28, raw);
  float hot = pow(smoothstep(0.22, 0.74, raw), 1.7);
  return min(1.0, field * 0.42 + hot * 0.72);
}

// Sun-facing / focusing swell punches the web. Twin: floorSunGain().
float floorSunGain(vec2 s, vec3 sun, float depth){
  float sl = max(length(sun), 1e-4);
  vec3 L = sun / sl;
  float Ly = max(L.y, 0.0);
  vec3 Nf = normalize(vec3(-s.x, 1.0, -s.y));
  float NoL = max(dot(Nf, L), 0.0);
  float along = s.x * L.x + s.y * L.z;
  float focus = clamp(1.0 / max(1.0 - along * 1.85 * depth * 0.55, 0.22), 0.25, 2.8);
  float punch = 0.42 + 0.48 * focus;
  float face = 0.40 + 0.72 * NoL;
  float height = 0.16 + 0.84 * Ly;
  return clamp(face * punch * height, 0.0, 1.65);
}

// Jacobian / fold answers WHERE. Structure inside that footprint is
// brightness, not a stencil. Unstretched regular F2−F1 was the hex tray;
// wake × walls was the honeycomb around the hull. Wake leftover now
// writes extra foamF / foamR; fd is the same lace as whitecaps.
// CPU twin: src/foam-lace.js.
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
  // Before anything else is computed: there is no sea inside a hull. Discarding
  // leaves no depth behind either, so the boat's own interior draws through the
  // hole instead of losing the depth test to a sheet of water above it.
  //
  // But hullInside() is an ellipse on the FLAT WATER PLANE, and a hull is not
  // flat. Seen from anywhere but straight down the boat leans off part of its
  // own waterline footprint, and the sea was being cut there too -- so the hole
  // ran out from under the hull and the terrain behind showed through it raw,
  // as a grey-tan oval astern of the boat with no water colour on it at all.
  // It slid around as the camera moved because that is what parallax between a
  // hole in one plane and a solid above it does.
  //
  // The footprint says WHERE THE CRAFT MIGHT BE; the depth photograph taken for
  // the refraction says where it actually IS, per pixel. Cut only where both
  // agree. Inside the hull the scene fragment is the boat -- in front of the
  // water, or a metre or so behind it looking down into an open one. Where the
  // hull has leaned away the scene fragment is the SEABED, metres further down
  // the ray, and that is water we should be drawing.
  if (hullInside(vFlat.xz) > 0.5) {
    bool cut = true;
    if (uRefrOn > 0.5) {
      float dscene = texture(uRefrDepth, gl_FragCoord.xy / uRefrRes).r;
      float zs = (2.0*uRefrNear*uRefrFar)
               / (uRefrFar+uRefrNear-(2.0*dscene-1.0)*(uRefrFar-uRefrNear));
      float zw = (2.0*uRefrNear*uRefrFar)
               / (uRefrFar+uRefrNear-(2.0*gl_FragCoord.z-1.0)*(uRefrFar-uRefrNear));
      // Scaled off the hull the cut was built from, so it follows the boat:
      // a launch gets a couple of metres of slack, a ship gets more. The bed
      // under a lagoon is far outside it either way.
      cut = zs < zw + max(uHullCutLen * 0.35, 1.5);
    }
    if (cut) discard;
  }

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

  // ---- wind gusts: the cat's paws -------------------------------------------
  // Wind over water does not arrive evenly. It comes in gusts and lulls tens of
  // metres across, and each gust roughens its own patch of surface into a matte
  // "cat's paw" while the lull beside it stays a mirror. On sheltered water that
  // mottling IS the texture: photograph a marina in light air and the frame is
  // patches of dark ripple against bright smooth water, not waves.
  //
  // A slow noise field drifting downwind, scaling the local SHORT-WAVE energy:
  // the FFT slope of every cascade shorter than swell (that is the ripple a
  // look-down sees), the capillary ripples just below, and the slope variance
  // that sets roughness at every distance — which is what carries the mottling
  // past the near field, where the capillary layer has already faded out.
  //
  // Scaling "var" wholesale is an approximation, since the swell's share of it
  // is not gust-driven. It is a defensible one: mean-square slope is dominated
  // by the short end of the spectrum, and the short end is exactly what a gust
  // drives. uGust defaults to 0, so no existing preset moves.
  //
  // Evaluated BEFORE the cascade loop so short-band slope can ride the same
  // field. Swell stays even (cascadeGustWeight).
  float gust = 1.0;
  if (uGust > 0.0){
    vec2 gq = (vFlat.xz - uWindDirV * (uTime * uGustDrift)) / max(uGustScale, 4.0);
    // Two scales: wind-streak slicks, then smaller cat's paws on top.
    // fbm2 lands in 0..1 clustered near 0.5; the windows spread it into
    // distinct patches instead of a uniform haze.
    float large = smoothstep(0.32, 0.70, fbm2(gq, 3));
    float small = smoothstep(0.38, 0.76, fbm2(gq * 3.1 + vec2(17.2, -8.4), 2));
    float g = mix(large, small, 0.34);
    gust = mix(1.0 - 0.85*uGust, 1.0 + 1.6*uGust, g);
  }

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
    float gw = cascadeGustWeight(c, gust);
    vec3 uvc = vec3(vFlat.xz / uPatch[c], float(c));
    vec4 sl = texture(uSlope, uvc);
    vec4 fo = texture(uFoam, uvc);
    slope += sl.xy * w * gw;
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
  float wakeRecon = 0.0;
  float wakeK = 1.0 - smoothstep(1.2, 6.0, foot);
  float reconK = 1.0 - smoothstep(8.0, 28.0, foot);
  if (uWakeOn > 0.5) {
    // Once a pixel is wider than the pattern there is nothing left to resolve
    // and point-sampling it is pure aliasing, exactly as for the foam sim above.
    // Look-down is several metres per pixel — keep the 3-stripe on a
    // longer fade so the rails survive the overhead camera.
    float k = wakeK;
    if (reconK > 0.004) {
      vec3 wk = wakeAt(vFlat.xz);
      wakeRecon = wk.x * reconK;
      if (k > 0.004) {
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
      if (uWakeRelief > 0.0 && abs(wk.y) > 0.07){
        float e = clamp(max(uWakeArmW * 0.40, 0.28), 0.28, 0.9);
        float hx = wakeAt(vFlat.xz + vec2(e, 0.0)).y - wakeAt(vFlat.xz - vec2(e, 0.0)).y;
        float hz = wakeAt(vFlat.xz + vec2(0.0, e)).y - wakeAt(vFlat.xz - vec2(0.0, e)).y;
        slope += vec2(hx, hz) / (2.0 * e) * uWakeRelief * k;
      }
      }
    }
  }
  // Leftover is the energy field. Mixing 22% of the stamp back in
  // printed the record window as a rectangle of lace around the hull.
  float energyK = 1.0 - smoothstep(8.0, 28.0, foot);
  if (energyK > 0.004) {
    if (uFoamEnergyOn > 0.5) {
      float e = foamEnergyAt(vFlat.xz) * energyK;
      // wake may already hold the record's reconstructed wedge — the part
      // that opens with distance astern. Energy is the hull's own near film.
      // Assigning here erased the arms wherever the film reached.
      float film = smoothstep(0.32, 0.88, e);
      if (uWakeOn > 0.5) {
        vec4 rec = wakeAgeAt(vFlat.xz);
        if (rec.x >= 0.0) film *= rec.y;
      }
      wake = max(wake, film);
    }
    else wake *= energyK;
  }
  // Same channels, same lace, same foamCoord stretch as whitecaps.
  foamF += wake * WAKE_FOAM_FRESH;
  foamR += wake * WAKE_FOAM_RESIDUE;

  // THE WATERLINE ITSELF.
  //
  // Everything above is the wake -- water the hull has already dealt with and
  // left behind. None of it describes the one place a moving hull is most
  // obviously in the water: the line where the topsides go in. There the sea is
  // being sheared and turned over continuously, and it is white for a hand's
  // width all the way round, brightest at the stem and trailing back along the
  // quarter. Without it the hull reads as set INTO a hole in the water rather
  // than as cutting through it, however good the wake behind is.
  //
  // Hugging the hull's own cut ellipse, so the collar follows the shape the
  // water is actually being cut to instead of being a ring drawn near the boat.
  if (uHullFoam > 0.0005) {
    float alongN;
    float q = hullEdgeQ(vFlat.xz, alongN);
    if (q > 0.0) {
      // A band just OUTSIDE the cut. Inside it there is no sea to foam.
      float band = smoothstep(0.86, 1.0, q) * (1.0 - smoothstep(1.0, 1.0 + uHullFoamW, q));
      // The stem shears; the quarter is merely alongside water going past.
      float bow = mix(0.30, 1.0, smoothstep(-0.85, 0.75, alongN));
      // And a hull lying still has no waterline foam at all -- she has to be
      // pushing water for there to be anything to turn over.
      float way = smoothstep(0.3, 2.4, abs(uWakeSpeed));
      // Broken up, or it is an ellipse drawn round the boat, which is exactly
      // the tell that the arms had before their own break-up went in.
      float grain = mix(0.40, 1.30, fbm2(vFlat.xz * 1.9, 3));
      foamF += band * bow * way * grain * uHullFoam;
    }
  }

  // Same carve the vertex displaced by. Without this the hollow and
  // bow heap wear the flat sea's normals and vanish except in silhouette.
  if (uHullPush > 0.0005) {
    float h0 = hullLift(vFlat.xz);
    if (abs(h0) > 0.008) {
      float e = max(uHullRadius * 0.18, 0.22);
      float hx = hullLift(vFlat.xz + vec2(e, 0.0)) - h0;
      float hz = hullLift(vFlat.xz + vec2(0.0, e)) - h0;
      slope += vec2(hx, hz) / e;
    }
  }

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // Looking down, a roughness-only gust is a milky sheet — a cloud on
  // the water. Chase-cam mottling still uses gust. The nadir read is
  // the short-cascade slope (slicks flatten, paws chop).
  float lookDown = smoothstep(0.50, 0.80, V.y);
  float roughGust = mix(gust, 1.0, lookDown);
  float var = (max(msq - dot(slope, slope), 0.0) + lost) * roughGust;

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
  float b2   = uBaseRoughness * uBaseRoughness * roughGust;
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
  // Coverage stays indexed by vFlat. Only its visual structure takes a partial
  // FFT orbit plus slope shear, so neighbouring lace points stretch/compress
  // with waves and height-only wake rings can pull the detail as they pass.
  float foamStrain = length(slope);
  vec2 foamCoord = vFlat.xz
                 + (vWorld.xz - vFlat.xz) * uFoamTextureCarry
                 + slope * (uFoamTextureShear + foamStrain * uFoamTextureStrain);
  // Scale frequency along the face, pivoted on a stable parcel block.
  // An offset only slides the stamp — this is what actually elongates cells.
  vec2 foamStretched = foamCoord;
  if (foamStrain > 0.02 && uFoamLaceStretch > 0.0) {
    float B = max(uFoamLaceStretchBlock, 1.0);
    vec2 pivot = floor(vFlat.xz / B) * B + 0.5 * B;
    vec2 r = foamCoord - pivot;
    vec2 t = slope / foamStrain;
    float k = 1.0 + foamStrain * uFoamLaceStretch;
    float along = dot(r, t) / k;
    float across = (-r.x * t.y + r.y * t.x) * sqrt(1.0 / k);
    foamStretched = pivot + t * along + vec2(-t.y, t.x) * across;
  }
  float texK = clamp(uFoamTextureAmount, 0.0, 1.0);
  float proceduralFd = 0.5;
  bubbles = 0.5;
  if (texK < 0.995)
    proceduralFd = foamField(foamStretched, uTime, foot, uFoamDetail, bubbles);
  float clumpRes = 1.0 - smoothstep(0.12, 2.2, foot);
  float laceScale = max(uFoamTextureScale, 1.0);
  // Tile hide + a two-octave breathe (~12 s). Twin: foamLaceMorph().
  vec2 laceWarp = (vec2(vnoise2(foamStretched * 0.019),
                        vnoise2(foamStretched * 0.014 + vec2(23.7, 41.3))) - 0.5) * 0.22;
  if (uFoamLaceMorph > 0.0) {
    float morphT = uTime * uFoamLaceMorphRate;
    laceWarp += vec2(
      vnoise(vec3(foamStretched * 0.031, morphT)) - 0.5,
      vnoise(vec3(foamStretched * 0.027 + vec2(19.1, 7.4), morphT + 1.7)) - 0.5
    ) * (uFoamLaceMorph / laceScale);
    laceWarp += vec2(
      vnoise(vec3(foamStretched * 0.013, morphT * 0.45 + 4.2)) - 0.5,
      vnoise(vec3(foamStretched * 0.011 + vec2(31.0, 13.0), morphT * 0.45 + 6.8)) - 0.5
    ) * (uFoamLaceMorph * 0.65 / laceScale);
  }
  vec2 laceUv = (foamStretched - uWindDirV * uTime * max(uFoamDrift, 0.0)) / laceScale + laceWarp;
  // Two-tap detile, same as the wake pack below. This is the sample that
  // covers the wake sheet, so its repeat was the visible one. The blend is
  // a smoothstep so most area is wholly one tap and contrast survives.
  vec2 laceUvB = vec2(
    laceUv.x * 0.383 + laceUv.y * 0.924,
    laceUv.y * 0.383 - laceUv.x * 0.924
  ) * 1.531 + vec2(0.291, 0.733);
  float laceBlend = smoothstep(0.28, 0.72,
    vnoise2(vFlat.xz * 0.0093 + vec2(17.4, -31.8)));
  float lace = mix(
    texture(uFoamLace, laceUv).r,
    texture(uFoamLace, laceUvB).r,
    laceBlend);
  // The image is histogram-balanced, so resolving at 1-coverage retains the
  // physical area while giving that area bubble holes and filament edges.
  // Texture lace is the foam image. Far field goes to 0.5, not back to
  // the procedural web (that mixed swirly lines under the image).
  float fdNear = mix(proceduralFd, lace, texK);
  float fd = mix(0.5, fdNear, clumpRes);
  bubbles = mix(bubbles, lace, texK);
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
  // Wind fold only. Leftover wake is composited as a film after the lace
  // resolve — putting a thin trail through this gate made it pulsate.
  float covF = clamp((foamF - wake * WAKE_FOAM_FRESH) * uFoamAmount, 0.0, 1.0);
  float covR = clamp((foamR - wake * WAKE_FOAM_RESIDUE) * uFoamAmount, 0.0, 1.0);
  // Harder Jacobian gate (src/foam-lace.js jacobianGate). A leak of fold
  // used to sprinkle the lace across calm water. Fold 0 is empty.
  float gateF = smoothstep(0.02, 0.12, covF);
  float gateR = smoothstep(0.02, 0.12, covR);
  // Past the resolvable range clumpRes collapses contrast onto the mean.
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
  // FORKED: the sea's own foam gets the same lace the wake does.
  //
  // fd is Abyssal's Worley web. It thresholds in exactly the form our lace
  // does, so swapping the FIELD swaps the look without touching the coverage
  // logic around it -- which is why this is a crossfade of one term rather
  // than a rewrite of the block.
  if (uLabSea > 0.001) {
    fd = mix(fd, labDetail(vFlat.xz, max(covF, covR), foot), uLabSea);
  }
  // ...and coverage can come from the wave BREAKING, on the same criterion the
  // wake uses: steepness is amplitude times wavenumber, which for a surface is
  // just the magnitude of its slope, and past a critical value a crest spills.
  // Additive, because the FFT's own Jacobian fold is a genuinely good breaking
  // test too -- it catches where the surface folds over, which slope alone
  // cannot -- so this adds the steep-crest case rather than replacing it.
  if (uLabSeaBreak > 0.001) {
    float seaSteep = length(slope);
    float broke = smoothstep(0.28, 0.72, seaSteep) * uLabSeaBreak;
    covF = clamp(covF + broke, 0.0, 1.0);
  }
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
  // Wake-only anti-tile. The pack is sampled in a rotated, irrational-scale
  // frame, independent of the wind lace. Energy acts as age: dense suds at
  // the fresh transom, cellular foam mid-trail, sparse breakup as it fades.
  // One packed fetch replaces three texture bindings.
  // Raw energy — only says whether there is foam here and fetches the record.
  float wakeRaw = clamp(wake, 0.0, 1.0);
  // Real record age, not the coverage proxy. Foam thin because it is OLD and
  // foam thin because it has only just started used to shade identically.
  float wakeAgeN = 0.0;
  float wakeAgeOn = 0.0;
  // Across-track zone: prop wash, open water, thin arm crests. 1 = unshaped.
  float wakeZone = 1.0;
  float wakeLat = 0.0;
  float wakeVDist = 0.0;
  if (uWakeOn > 0.5) {
    vec4 rec = wakeAgeAt(vFlat.xz);
    if (rec.x >= 0.0) {
      wakeAgeN = rec.x;
      wakeZone = rec.y;
      wakeLat = rec.z;
      wakeVDist = rec.w;
      wakeAgeOn = 1.0;
    }
  }
  // Twin of wakeFoamFreshness(). No record falls back to coverage.
  float wakeFresh = mix(wakeRaw, 1.0 - wakeAgeN, wakeAgeOn);
  // Twin of wakeFoamGrade(). The field saturates a second after the hull
  // passes, so compositing the clamp painted the entire trail at one flat
  // coverage — an even sheet whose only variation was the foam image
  // repeating. Grade it: wash, then a broken band, then filaments.
  float wakeWash = smoothstep(WAKE_FOAM_WASH, 0.97, wakeFresh);
  float wakeBroken = smoothstep(0.04, WAKE_FOAM_WASH, wakeFresh);
  float wakeGrade = clamp(
    (WAKE_FOAM_TAIL + wakeBroken * WAKE_FOAM_BROKEN
      + wakeWash * (1.0 - WAKE_FOAM_TAIL - WAKE_FOAM_BROKEN))
    * smoothstep(0.0, 0.35, wakeRaw) * wakeZone, 0.0, 1.0);
  float wakeFilm = wakeGrade * max(uFoamRibbon, 0.0);
  float wakeCorridor = wakeAgeOn * wakeZone * (1.0 - smoothstep(0.62, 1.0, wakeAgeN)) * 0.92;
  float wakeSheet = clamp(max(wakeCorridor, wakeFilm), 0.0, 1.0);
  float wakePattern = 1.0;
  // Twin of wakeFoamRibbonVary() / wakeFoamRibbonBreak().
  float ribbonK = clamp(uWakeFoamRibbonVary, 0.0, 1.6);
  float nFill = vnoise2(vFlat.xz * 0.038);
  float nOpac = vnoise2(vFlat.xz * 0.027 + vec2(13.7, -8.2));
  float nFeat = vnoise2(vFlat.xz * 0.021 + vec2(5.4, 19.1));
  float nHole = vnoise2(vFlat.xz * 0.064 + vec2(-11.6, 4.8));
  float nStr  = vnoise2(vFlat.xz * 0.019 + vec2(2.3, -15.6));
  float nAni  = vnoise2(vFlat.xz * 0.033 + vec2(-7.1, 9.4));
  float nPatch = vnoise2(vFlat.xz * 0.028 + vec2(21.4, -9.6));
  float nChew = vnoise2(vFlat.xz * 0.09 + vec2(-4.2, 15.8));
  float nFine = vnoise2(vFlat.xz * 0.21 + vec2(6.6, -2.4));
  float nBreak = vnoise2(vFlat.xz * 0.016 + vec2(3.3, 7.7));
  float nIsland = vnoise2(vFlat.xz * 0.042 + vec2(17.2, -6.4));
  float ribbonFill = mix(1.0, mix(0.18, 1.04, nFill), ribbonK);
  float ribbonOpac = mix(1.0, mix(0.28, 1.0, nOpac), ribbonK);
  float ribbonHole = mix(1.0, mix(0.04, 1.0, smoothstep(0.10, 0.66, nHole)), ribbonK);
  if (wakeSheet > 0.003 && texK > 0.001) {
    // Fallback world-space UV:
    float stretchU = mix(1.0, mix(0.48, 1.72, nStr), ribbonK);
    float stretchV = stretchU * mix(1.0, mix(0.52, 1.62, nAni), ribbonK);
    vec2 detileWarp = vec2(
      vnoise2(vFlat.xz * 0.0071) - 0.5,
      vnoise2(vFlat.xz * 0.0071 + vec2(9.3, -4.1)) - 0.5
    ) * 0.90;
    vec2 laceUvVar = vec2(
      laceUv.x * stretchU + (nStr - 0.5) * 0.55 * ribbonK,
      laceUv.y * stretchV + (nAni - 0.5) * 0.42 * ribbonK
    ) + detileWarp;
    vec2 wakePackWorldUv = vec2(
      laceUvVar.x * 0.754 - laceUvVar.y * 0.657,
      laceUvVar.x * 0.657 + laceUvVar.y * 0.754
    ) * 0.73 + vec2(0.173, 0.419);
    vec2 wakePackWorldUvB = vec2(
      wakePackWorldUv.x * 0.431 + wakePackWorldUv.y * 0.902,
      wakePackWorldUv.y * 0.431 - wakePackWorldUv.x * 0.902
    ) * 1.673 + vec2(0.617, 0.244);

    // Path-aligned curvilinear coordinates:
    // U across the track (lat), V along the sailing track (vDist).
    // Textures naturally flow, bend and stretch with every turn the boat made.
    float pathU = wakeLat * 0.28;
    float pathV = wakeVDist * 0.12;

    vec2 pathUv1 = vec2(
      pathU + sin(pathV * 2.2) * 0.06,
      pathV + (nStr - 0.5) * 0.35 * ribbonK
    );
    vec2 pathUv2 = vec2(
      pathU * 1.37 + pathV * 0.31 + 0.43,
      pathV * 1.63 - pathU * 0.29 + 0.19
    );

    vec2 packUvA = (wakeAgeOn > 0.5) ? pathUv1 : wakePackWorldUv;
    vec2 packUvB = (wakeAgeOn > 0.5) ? pathUv2 : wakePackWorldUvB;

    float tileMix = smoothstep(0.26, 0.74,
      vnoise2(vFlat.xz * 0.0135 + vec2(-23.7, 41.2)));
    vec3 wakePack = mix(
      texture(uWakeFoamPack, packUvA).rgb,
      texture(uWakeFoamPack, packUvB).rgb,
      tileMix);
    float wakeCells = clamp(max(wakePack.r * 0.90, wakePack.g * 0.72), 0.0, 1.0);
    float wakeOld = clamp(wakePack.g * smoothstep(0.15, 0.75, wakePack.b) * 1.25 + 0.04, 0.0, 1.0);
    float wakeDense = clamp(max(wakePack.r, wakePack.g) * 0.45 + 0.65, 0.0, 1.0);
    wakePattern = mix(wakeOld, wakeCells, smoothstep(0.08, 0.34, wakeFresh));
    wakePattern = mix(wakePattern, wakeDense, smoothstep(0.52, 0.95, wakeFresh));
  }
  float sheetSoft = mix(wakeSheet,
    smoothstep(mix(0.004, 0.20, nFeat), mix(0.12, 0.70, nFeat), wakeSheet),
    ribbonK);
  float lookChew = nChew * 0.65 + nFine * 0.35;
  float lookDying = 1.0 - smoothstep(0.012, 0.08, wakeSheet);
  float lookBreak = mix(1.0, smoothstep(0.36, 0.64, nIsland), ribbonK)
    * mix(1.0, smoothstep(0.34, 0.62, nBreak), ribbonK)
    * mix(1.0, smoothstep(0.08, 0.58, lookChew), ribbonK)
    * mix(1.0, smoothstep(0.08, 0.62, nPatch), ribbonK)
    * mix(1.0, smoothstep(0.22, 0.78, lookChew), ribbonK * lookDying);
  // Opacity removers MULTIPLY — see the note in water-surface.js. Age
  // changes the PATTERN, not the opacity.
  float ribbonVary = ribbonFill * ribbonHole * ribbonOpac * lookBreak;
  float wakeWrinkle = sheetSoft * mix(1.0, wakePattern, texK) * ribbonVary;
  // FORKED: the prototype's lace replaces the graded PNG stencil above.
  //
  // The grading ladder that produced wakeWrinkle is tuned for Abyssal's own
  // energy field, which saturates near 1 a second after the hull passes. The
  // prototype's coverage peaks around 0.12 (measured), and 0.12 through that
  // ladder lands near 4% opacity -- a wake that is drawn and invisible. So
  // coverage is taken RAW, gained, and shaped by the lace, with Beer-Lambert
  // deciding opacity: it approaches white asymptotically and never lands on
  // the hard cut-out edge a bare threshold gives.
  float labCover = clamp(wakeRaw * uLabGain, 0.0, 1.6);
  float labFoam = 0.0;
  if (labCover > 0.004) {
    float lace = labLace(vFlat.xz, labCover, foot);
    labFoam = 1.0 - exp(-lace * labCover * max(uLabDensity, 0.0));
  }
  float wakeLook = mix(wakeWrinkle, labFoam, clamp(uLabGain > 0.0 ? 1.0 : 0.0, 0.0, 1.0));
  foamMask = clamp(foamMask + wakeLook * (1.0 - foamMask), 0.0, 1.0);
  // Bubble albedo tracks freshness: new suds are bright and opaque, an aged
  // streak is a thin grey film. The flat 0.55 was the same at every age.
  fresh = mix(fresh, mix(0.16, 0.86, smoothstep(0.06, 0.78, wakeFresh)), wakeLook);
  // At a kilometre you are looking at the side of a raft that lies in and just
  // behind the crests, and the crest in front hides most of it. That is a real
  // geometric loss on top of the areal averaging, and it is what stops the
  // grazing band just under the horizon painting itself solid.
  foamMask *= 1.0 - clamp(uFoamFar, 0.0, 1.0) * smoothstep(0.5, 9.0, foot);

  // Terrain-aware shore break. Depth decides where a crest can shoal; the
  // texture only resolves that coverage and cannot paint deep water.
  if (uShoreFoamAmount > 0.001 && max(uFloorDepth, uFloorDepthMax) > 0.1) {
    float rawLo = uFloorDepthMin > 0.1 ? uFloorDepthMin : max(uFloorDepth, uFloorDepthMax);
    float rawHi = uFloorDepthMax > 0.1 ? uFloorDepthMax : max(uFloorDepth, uFloorDepthMin);
    float lo = min(rawLo, rawHi);
    float hi = max(rawLo, rawHi);
    // One bed for the whole shader: bedDepthAt already consults the coast.
    float bedDepth = bedDepthAt(vFlat.xz, lo, hi);
    float column = max(bedDepth + vWorld.y - uSeaLevel, 0.02);
    // SETS. A break line pinned to one depth is a static ring of foam around
    // the island, which is the tell that gives away every lake-with-a-beach in
    // a game. Real surf arrives in groups: the depth at which water breaks
    // rises and falls as each set runs in, so the whole band advances and
    // retreats over the rock. Two periods well apart, so the pattern does not
    // read as a pulse.
    float surge = uSurge * (sin(uTime * 0.21) * 0.6 + sin(uTime * 0.083 + 1.7) * 0.4);
    float breakDepth = max(uShoreFoamRange * (1.0 + surge * 0.55), 0.25);
    float breakWidth = max(breakDepth * 0.16, 0.35);
    float breakOffset = (column - breakDepth) / breakWidth;
    float shallow = exp(-breakOffset * breakOffset);
    float crest = smoothstep(-0.12, 0.38, vRelief);
    // The set RUNS IN. Travel is measured in water column, not in metres of
    // ground, so each line follows the depth contour round the bay for free
    // however the rock is shaped.
    //
    // THE SIGN IS ADDITIVE, and the first version had it backwards. A line of
    // foam sits at constant phase, so with (column/S - t/T) constant phase
    // means column = S*(k + t/T): the crest moves into DEEPER water as time
    // runs, which is a set retreating out to sea. Adding the time term instead
    // gives column = S*(k - t/T), and depth falling with time is a crest
    // climbing the shelf -- surf coming in.
    // FOAM IS BORN AT THE CREST AND THEN ONLY AGES.
    //
    // This was a sine, and a sine fades out exactly as symmetrically as it
    // fades in -- which is oscillation, not surf. It read as the whole band
    // breathing back and forth in place, because that is precisely what it
    // was doing. Nothing in the water works that way: a crest arrives, it
    // breaks, and the white it leaves behind decays from that moment.
    //
    // So the envelope is a SAWTOOTH in the travel phase. fract() gives the
    // time since the crest passed this depth, in sets; the foam is created at
    // full strength at zero age and decays exponentially from there. The wrap
    // from a dying tail straight back to 1.0 is not a discontinuity to hide --
    // it is the next crest breaking, which is genuinely that sudden.
    float travel = column / max(uSurfSpan, 0.25)
                 + uTime / max(uSurfPeriod, 0.5);
    float age = fract(travel);
    float setEnv = exp(-age * max(uSurfDecay, 0.05));
    // Broken water does not stop where it broke. It runs on up the shallows as
    // swash and drains back, which is the second, thinner sheet of white you
    // see inshore of the break line -- and it inherits the same phase, so it
    // arrives after the crest that made it rather than sitting there.
    // Narrower than it was: 1.15 -> 0.12 of the break depth spans the WHOLE
    // shelf on the new bathymetry, which is what turned the shallows into a
    // solid white field rather than a tongue running up behind each crest.
    float swash = smoothstep(breakDepth * 0.85, breakDepth * 0.30, column);
    // Floor dropped 0.30 -> 0.10. A third of full coverage sitting on the
    // break line at ALL times is a permanent ring of white that the sets
    // merely brighten, and it was half of what made the band read as
    // pulsing in place rather than arriving.
    float rolled = max(shallow * mix(0.10, 1.0, setEnv), swash * setEnv * 0.45);
    // FORKED: no longer gated on uFoamAmount. Surf on a shore has nothing to
    // do with whitecaps in open water -- that gate is why turning the sea's
    // whitecaps off silently took the shore break with them.
    float shoreCov = clamp(rolled * mix(0.35, 1.0, crest)
                         * uShoreFoamAmount, 0.0, 0.82);
    // ONE FOAM. The shore used to be thresholded out of Abyssal's own
    // whitecap web, while the wake was built from labLace with
    // Beer-Lambert opacity. Two different generators meeting at the same
    // waterline is exactly why the surf never looked like it belonged to the
    // same sea as the boat's wake. Same call, same density, same law as the
    // wake block above.
    float shoreMask = 0.0;
    if (shoreCov > 0.004) {
      float sLace = labLace(vFlat.xz, shoreCov, foot);
      shoreMask = 1.0 - exp(-sLace * shoreCov * max(uLabDensity, 0.0));
    }
    bubbles = max(bubbles, shoreMask * 0.58);
    fresh = mix(fresh, 0.62, shoreMask);
    foamMask += shoreMask * (1.0 - foamMask);
  }

  // Covered water is an emulsion, not grit on lace cores.
  bubbles = max(bubbles, mix(0.16, 0.72, fresh) * smoothstep(0.01, 0.22, foamMask));

  vec3 Nfoam = N;
  if (foamMask > 0.003){
    // Thickness stays foamField's out-param. The old 25 cm / 6 cm vnoise
    // gradient is what read as sand. A matte film follows the wave.
    Nfoam = normalize(mix(N, vec3(0.0, 1.0, 0.0),
      foamMask * mix(0.03, 0.10, fresh) + wakeLook * 0.78));
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

  // ---- THE SCENE ITSELF, REFLECTED ------------------------------------------
  //
  // The proxy above gives a boat-shaped smear and can never give a mast, because
  // there is no geometry in a ray-quadric test. This is the real thing: the
  // scene rendered a second time from a camera mirrored through the water
  // plane, projected back onto the surface.
  //
  // Its known lie is that it assumes a FLAT mirror -- the reflection was
  // rendered for y = seaLevel, not for the wave actually under this fragment.
  // So the wobble has to be put back by hand: shift the lookup by the surface
  // normal's horizontal part, which is the same tilt that bends a real ray, and
  // damp it with distance so the far sea does not smear. That is the trade
  // against the proxy, which gets its wobble free from the true normal and has
  // no geometry at all.
  if (uReflOn > 0.5 && uReflAmt > 0.001) {
    vec4 rp = uReflMat * vec4(vWorld, 1.0);
    if (rp.w > 0.0) {
      vec2 ruv = rp.xy / rp.w;
      // The normal's horizontal part, damped with distance and scaled by how
      // far off-vertical the surface is here.
      ruv += N.xz * uReflDistort / (1.0 + dist * 0.05);
      if (ruv.x > 0.002 && ruv.x < 0.998 && ruv.y > 0.002 && ruv.y < 0.998) {
        // BLUR BY MIP LEVEL. Water is not a mirror: even a glassy sea
        // scatters a reflection slightly, and any chop turns a crisp image
        // into a soft column of colour. The roughness term is what makes that
        // automatic -- a rougher facet reaches further up the chain -- and the
        // slider is a floor under it for when you simply want it softer.
        float rlod = (uReflBlur + smoothstep(0.02, 0.34, alpha) * 0.55) * uReflMaxLod;
        vec4 rc = textureLod(uReflTex, ruv, clamp(rlod, 0.0, uReflMaxLod));
        // Alpha is coverage: the reflection target is cleared transparent, so
        // anything with alpha is scene and everything else is sky the LUT has
        // already done better. Blending on coverage is what stops this pass
        // painting a dim rectangle of cleared buffer over the whole sea.
        float cov = clamp(rc.a, 0.0, 1.0) * uReflAmt;
        // A rough sea scatters its reflections: at high roughness the mirror
        // image should give way to the sky it is sitting in, or a chop full of
        // crisp upside-down boats reads as glass.
        cov *= 1.0 - smoothstep(0.06, 0.40, alpha);
        // FADE ALONG THE REFLECTION'S OWN LENGTH, from the boat outward.
        //
        // The first cut of this faded on distance from the CAMERA, which is a
        // different quantity and the wrong one: it dims the whole far sea
        // whether or not there is a reflection in it, and it does nothing to
        // the long streak trailing away from a hull that happens to be close.
        // What matters is how far the image has travelled from the thing
        // casting it.
        //
        // Exponential, so the control is a RATE rather than a range: at 0 the
        // factor is exp(0) = 1 and nothing fades at all, and raising it makes
        // the image die back toward the boat. No special-casing of zero, which
        // is what a length-based fade needs and always gets wrong somewhere.
        cov *= exp(-length(vWorld.xz - uReflOrigin) * uReflFade);
        // And a straight ceiling on how much of the surface the mirror may
        // claim. Separate from strength on purpose: strength is how bright the
        // image is, this is how much of the water it is allowed to become. At
        // 1 the mirror can replace the sky entirely, which is right for glass
        // and wrong for almost anything else.
        cov = min(cov, uReflOpacity);
        skyRefl = mix(skyRefl, rc.rgb, cov);
      }
    }
  }

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
    // AN ELLIPSOID, not a sphere -- because a sphere can only ever reflect as a
    // circle, and a boat is not round.
    //
    // The test is still one ray against one quadric, which is the whole reason
    // this exists instead of a second render of the scene. The trick is to do
    // it in a space where the ellipsoid IS a sphere: scale the world down by
    // the craft's half-extents along its own axes, and the problem becomes the
    // sphere test that was here before. Long down the hull, narrow across it,
    // low in height -- so the image in the water is a boat-shaped smear lying
    // along the heading, and it swings round as she turns.
    vec3 toC = uCraftReflPos - vWorld;
    // The craft's frame: forward, athwartships, up.
    vec3 cf = normalize(vec3(uCraftReflFwd.x, 0.0, uCraftReflFwd.y));
    vec3 cr = vec3(-cf.z, 0.0, cf.x);
    vec3 half3 = max(uCraftReflHalf, vec3(0.05));
    // Both the offset and the ray, into that frame and divided by the extents.
    vec3 Rn = normalize(R);
    vec3 toE = vec3(dot(toC, cr), toC.y, dot(toC, cf)) / half3;
    vec3 Re  = vec3(dot(Rn, cr), Rn.y, dot(Rn, cf)) / half3;
    float dE = max(length(toE), 1e-3);
    float lenRe = max(length(Re), 1e-4);
    float cosA = dot(Re / lenRe, toE / dE);
    // In that space the proxy is the unit sphere, so its angular radius is
    // asin(1/distance) -- exact, where atan(r/d) was the small-angle stand-in.
    float angR = asin(clamp(1.0 / max(dE, 1.0001), 0.0, 1.0));
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

  // Aerated water. Twin: gpu/tsl/water-surface.js. wakeRaw is the flat,
  // saturated footprint of the whole disturbed area — the wrong shape for
  // foam coverage (that is what made the trail an even white sheet) but the
  // right one for the bubble plume, which really does cover the whole track.
  // FORKED: the prototype's subsurface plume replaces the flat milky tint.
  //
  // Upstream aerates the water by lerping the body colour toward one milky
  // constant, keyed off foam coverage. That is a tint, not a plume. The
  // prototype tracks the cloud itself: how DENSE it is and how much of it has
  // SURFACED, which is the difference between churn glowing turquoise at the
  // transom and staying dark blue-green where it is still metres down.
  vec2 bubs = uBubOn > 0.002 ? wakeBubblesAt(vFlat.xz) : vec2(0.0);
  if (bubs.x > 0.002) {
    // Beer-Lambert again: scattering saturates with how much cloud is in the
    // column, so a thick plume approaches its own colour instead of running
    // away to white.
    float scat = (1.0 - exp(-bubs.x * uBubBright * 1.5)) * uBubOn;
    float surfaced = bubs.y;
    vec3 deepCol = mix(uBubCol, uScatterColor * 1.8 + vec3(0.01, 0.10, 0.13), uBubDeepTint);
    vec3 bubCol = mix(deepCol, uBubCol, surfaced);
    bubCol = mix(bubCol, vec3(0.66, 0.80, 0.82), uBubMilk * scat * surfaced);
    // Lit by the same downwelling the body colour uses, so the plume sits in
    // the water rather than glowing on top of it.
    vec3 lit = bubCol * Edown * (uScatterAmount * WAKE_PLUME_GAIN / PI)
      * exp(-uAbsorption * pathLen * WAKE_PLUME_PATH) * ao;
    body = mix(body, lit, clamp(scat, 0.0, 1.0));
  }
  if (uWakePlume > 0.002 && wakeRaw > 0.002) {
    float plume = clamp(wakeRaw * uWakePlume, 0.0, 1.0);
    vec3 milky = uScatterColor * Edown * (uScatterAmount * WAKE_PLUME_GAIN / PI)
      * exp(-uAbsorption * pathLen * WAKE_PLUME_PATH) * ao;
    body = mix(body, milky, plume);
  }


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

  // Virtual seafloor. Twin: src/seafloor.js / gpu/tsl/water-surface.js.
  // Air → water. A straight -V is a dry photo of the bed.
  if (max(uFloorDepth, uFloorDepthMax) > 0.1) {
    // Lighting N + capillaries is LOD-0 grit. Long-wave slope only.
    vec2 sMip = cascadeSlopeAt(vFlat.xz, dist);
    vec3 Nfloor = normalize(vec3(-sMip.x, 1.0, -sMip.y));
    float eta = 1.0 / max(uWaterIOR, 1.01);
    vec3 I = -V;
    float dI = dot(Nfloor, I);
    float kI = 1.0 - eta * eta * (1.0 - dI * dI);
    vec3 RD = kI < 0.0 ? I : eta * I - (eta * dI + sqrt(max(kI, 0.0))) * Nfloor;
    if (RD.y > -0.02) RD = I;
    if (RD.y < -0.02) {
      float rawLo = uFloorDepthMin > 0.1 ? uFloorDepthMin : max(uFloorDepth, uFloorDepthMax);
      float rawHi = uFloorDepthMax > 0.1 ? uFloorDepthMax : max(uFloorDepth, uFloorDepthMin);
      float lo = min(rawLo, rawHi);
      float hi = max(rawLo, rawHi);
      float tHit = (lo + hi) * 0.5 / max(-RD.y, 0.02);
      float hx = vWorld.x;
      float hz = vWorld.z;
      float localD = hi;
      for (int i = 0; i < 3; i++) {
        hx = vWorld.x + RD.x * tHit;
        hz = vWorld.z + RD.z * tHit;
        localD = bedDepthAt(vec2(hx, hz), lo, hi);
        tHit = (vWorld.y - (uSeaLevel - localD)) / max(-RD.y, 0.02);
      }
      if (tHit > 0.05 && tHit < 260.0) {
        hx = vWorld.x + RD.x * tHit;
        hz = vWorld.z + RD.z * tHit;
        localD = bedDepthAt(vec2(hx, hz), lo, hi);
        // Same warp as the rocks: lighting slope × sdRefract.
        // Twin: floorLookSlide() in seafloor.js.
        // FORKED 0.045 -> 0.028. The gate is an anti-alias guard, and it was
        // set for open ocean where the bed is thirty metres down and any warp
        // is invisible anyway. Over a 3 m lagoon it crushed the control to
        // about 14 cm of lookup shift at forty metres -- a wobble well under
        // the scale of the bed's own features, which is why the slider read as
        // doing nothing. Loosened, not removed: the far field still needs it.
        float lookGate = clamp(localD * 0.7, 0.0, 1.0) / (1.0 + dist * 0.028);
        float lookW = uRefractDistort * lookGate * localD;
        hx += slope.x * lookW;
        hz += slope.y * lookW;
        localD = bedDepthAt(vec2(hx, hz), lo, hi);
        // FORKED: a lagoon FLOOR, not a two-tone gradient.
        //
        // The bed was two sine waves blended between sand and weed, and that is
        // most of why shallow water read as a swimming pool: a pool has one
        // featureless floor at one depth, and so did this. A real lagoon bottom
        // is PATCHY at several scales -- open sand, seagrass beds with crisp
        // edges, and isolated coral heads standing proud of both -- and it is
        // that patchiness, seen through changing depth, that makes the water
        // above it read as a lagoon.
        vec2 bp = vec2(hx, hz);
        // One range fade for everything fine-grained on the bed. It was inline
        // in the caustic line; hoisted so the work above it can be skipped
        // rather than merely scaled.
        float bedLod = smoothstep(340.0, 90.0, dist);
        // Seagrass. Beds have hard boundaries, not gradients: a narrow
        // smoothstep on aperiodic noise gives an edge you could walk to.
        float bedN = fbm2(bp * 0.011, 4) * 0.72 + fbm2(bp * 0.047 + 19.0, 3) * 0.28;
        float weedM = smoothstep(0.50, 0.60, bedN);
        // Coral heads: distance to the nearest cell point, so they come out as
        // discrete round mounds scattered over the floor rather than as another
        // layer of noise. A second noise decides WHICH cells grow one, so they
        // clump into gardens and leave clear sand between.
        // GATED. cellular3 walks a 3x3 cell neighbourhood with two hashes a
        // cell -- eighteen hashes -- and the heads are the highest-frequency
        // thing on the bed, so they are also the first to fall under a pixel
        // and turn into aliasing. Skip them when they are switched off, and
        // fade them out with the same range the caustics use rather than
        // paying for detail nobody can resolve.
        float headM = 0.0;
        if (uBedCoralAmt > 0.001 && bedLod > 0.002) {
          vec3 cw = cellular3(bp * 0.055);
          float headSeed = fbm2(bp * 0.03 + 71.0, 2);
          headM = (1.0 - smoothstep(0.10, 0.34, cw.x))
                * smoothstep(0.42, 0.58, headSeed) * uBedCoralAmt * bedLod;
        }
        // Sand is never one colour either: slow blotches of shell and rubble.
        float sandVar = 0.86 + 0.28 * fbm2(bp * 0.09 + 5.0, 3);
        float reef = weedM * uBedWeedAmt;
        vec3 bed = mix(uBedSand * sandVar, uBedWeed, reef);
        bed = mix(bed, uBedCoral, clamp(headM, 0.0, 1.0));
        // Focused sunlight on the sand. Twin: seafloor.js floorLace.
        //
        // GATED, and this is the single most expensive thing in the shader.
        // floorLace is three floorLaceLayer calls and each one runs a
        // cellular3 -- twenty-seven cells, fifty-four hashes, plus a dozen
        // trig calls -- for every water pixel. It was computed unconditionally
        // and only THEN multiplied by the range fade below, which is exactly
        // zero past 340 m from the eye. Zoom out over the lagoon and every one
        // of those hashes was evaluated and thrown away.
        //
        // Note the ablation trap here: turning lake.caustics down to zero used
        // to change nothing measurable, because the parameter only scales the
        // result and never skipped the work. Reading that as "the caustics are
        // cheap" is the wrong conclusion from the right number.
        float lace = 0.0;
        if (bedLod > 0.002 && uFloorCaustic > 0.001) {
          vec2 pSun = vec2(hx, hz) + uSunDir.xz / max(uSunDir.y, 0.18) * localD;
          float laceScale = max(uFloorCausticSize, 0.15);
          float web = floorLace(pSun.x / laceScale, pSun.y / laceScale, uTime);
          float sunK = floorSunGain(slope, uSunDir, localD);
        // FORKED, three ways. Caustics were being killed before they could be
        // seen, and each limiter alone was enough to do it:
        //
        // RANGE. The old fade ran 55 m to 16 m from the CAMERA -- full only
        // within 16 m, gone past 55. From any normal chase view the bed was
        // lit but plain. It still needs an LOD fade (a caustic web finer than
        // a pixel is pure aliasing), just six times further out.
        //
        // DEPTH. exp(-d*0.15) costs 70% of the effect at 8 m and 82% at 11 m
        // -- and the tropical beds were just deepened to exactly there, which
        // is why raising Bed depth made them worse rather than better. Clear
        // water carries a caustic web to the bottom of a lagoon; 0.045 keeps
        // 70% at 8 m.
        //
        // CONTRAST. 1 + lace*0.45 is a 45% brightening at most. Look at any
        // photograph of sand under a metre of water: the web is two to four
        // times the brightness of the sand between its lines. That ratio IS
        // the effect; without it the bed reads as textured, not as lit
        // through moving water.
          lace = web * sunK * (1.0 - reef * 0.45) * uFloorCaustic
               * exp(-localD * 0.045) * bedLod;
        }
        float mul = 1.0 + lace * 1.55;
        float peak = pow(lace, 2.2);
        // uBedGain, FORKED IN. Measured rather than guessed: splitting the
        // composite into its three parts showed the bed channel PINNED at
        // full scale across the whole frame -- the bottom was arriving so
        // overexposed that it clipped to white before tonemapping, and a
        // clipped surface has no contrast left to carry a caustic web. The
        // caustics were being computed correctly the whole time and then
        // flattened. Exposure here is set for the water; the bed needs its
        // own gain to land in range.
        vec3 floorLit = (bed * 0.46 * mul + bed * peak * 0.60 * vec3(1.06, 1.00, 0.88))
                      * Edown / PI * uBedGain;
        if (uHullPush > 0.0005) {
          float sy = max(uSunDir.y, 0.08);
          float shx = uHullPos.x + uSunDir.x / sy * localD;
          float shz = uHullPos.z + uSunDir.z / sy * localD;
          // THE SHADOW EDGE RIPPLES TOO, and this is where it comes from.
          //
          // The centre above is a straight geometric projection of the hull
          // along the sun -- no surface in it anywhere. So the bed rippled, the
          // caustics rippled, and the hull printed a clean airbrushed oval in
          // the middle of it, which is exactly the place the eye checks whether
          // it is looking at something underwater.
          //
          // The light that draws this edge crossed the same wavy surface the
          // view did, and refracted there, so it lands displaced by the local
          // slope over the depth it fell through. Same slope, same slider as
          // the bed warp -- one control for one physical cause -- but carried
          // over the full light path rather than the short view offset, which
          // is why it gets its own gain.
          //
          // Bounded to half the hull's own radius. In real chop the slope term
          // runs to two thirds of the blob and the shadow tears loose from the
          // boat above it, which is a worse artefact than a stiff edge: a
          // shadow that is not under its hull stops reading as a shadow.
          vec2 shWarp = slope * localD * uRefractDistort * 1.6;
          float shCap = max(uHullRadius, 0.8) * 0.5;
          float shLen = length(shWarp);
          if (shLen > shCap) shWarp *= shCap / shLen;
          shx += shWarp.x;
          shz += shWarp.y;
          float qh = length(vec2(hx - shx, hz - shz)) / max(uHullRadius, 0.8);
          // FORKED 0.55 -> 0.78. A hull is opaque: the patch of bed under it
          // gets sky only, no sun, and against a caustic-lit bottom a 45%
          // darkening is barely a smudge.
          floorLit *= 1.0 - exp(-qh * qh) * 0.78;
        }
        vec3 floorTrans = exp(-uAbsorption * tHit);
        // FORKED: dissolve the bed out before the hard tHit < 90 bound rather
        // than letting it stop dead there.
        //
        // tHit is the refracted ray's path to the bed, so it grows with
        // viewing angle: straight down it is the depth, out toward the edge of
        // frame it is tens of metres. The bound is a cost guard, but as a
        // binary it draws a CIRCLE -- lit sand inside, plain water outside --
        // centred on wherever the camera is looking down. On open ocean the
        // bed is too deep to see and nobody noticed; on a 4.5 m lagoon it is
        // a pale disc parked under the boat that slides away when you move.
        // FORKED 52/86 -> 150/250. Those numbers were set when the bed was a
        // deep-ocean afterthought. Looking ACROSS a lagoon the slant path runs
        // to tens of metres within a boat length or two, so the bottom used to
        // dissolve just past the bow -- and it is seeing the bottom recede into
        // blue, rather than stop, that reads as clear tropical water.
        // Absorption already fades it honestly; this is only the cost guard.
        float bedFade = 1.0 - smoothstep(150.0, 250.0, tHit);
        // UNDER the interface — do not replace the water.
        diffuse += floorLit * floorTrans * bedFade;
        float film = clamp(length(sMip) * 3.5, 0.0, 1.0)
                   * smoothstep(0.35, 0.95, NoV) * 0.16 * bedFade;
        Fenv += (1.0 - Fenv) * film;
      }
    }
  }

  // ---- what is UNDER this pixel of water -----------------------------------
  // Screen-space refraction of the pre-rendered scene. AFTER the seafloor on
  // purpose: the hull sits between the bed and the surface, so it must
  // occlude the bed's light -- composited before it, the bed painted straight
  // over the hull, which is exactly how the first version disappeared.
  //
  // The wobble is the surface normal's horizontal part -- the tilt that bends
  // a real ray -- damped with distance so far water does not shimmer. The
  // sampled depth decides everything: a scene fragment NEARER than the water
  // is topsides (drawn again after the water; skip), one BEHIND it is
  // submerged. Beer-Lambert on the linearised gap does the murk, so a keel a
  // metre down is a green shadow of itself and ten metres down is gone.
  if (uRefrOn > 0.5) {
    vec2 suv = gl_FragCoord.xy / uRefrRes;
    vec2 roff = N.xz * uRefrAmt / (1.0 + dist * 0.06);
    vec2 ruv = clamp(suv + roff, vec2(0.001), vec2(0.999));
    float dsceneW = texture(uRefrDepth, ruv).r;
    float dwater = gl_FragCoord.z;
    if (dsceneW > dwater && dsceneW < 1.0) {
      float zs = (2.0*uRefrNear*uRefrFar)/(uRefrFar+uRefrNear-(2.0*dsceneW-1.0)*(uRefrFar-uRefrNear));
      float zw = (2.0*uRefrNear*uRefrFar)/(uRefrFar+uRefrNear-(2.0*dwater-1.0)*(uRefrFar-uRefrNear));
      float thick = max(zs - zw, 0.0);
      // DISPLACEMENT GROWS WITH DEPTH, and this is what makes something under
      // the water look like it is under the water.
      //
      // The offset above is a single per-fragment translation, so it moves what
      // it samples without warping it -- fine for a hull, which is large enough
      // that the normal changes noticeably across it, and useless for a
      // two-centimetre bubble, which lands inside one nearly-constant patch of
      // normal and comes back a crisp circle in the wrong place. That is why
      // the bubbles read as stickers on the water rather than objects in it.
      //
      // A ray bent at the surface keeps travelling, so how far it lands from
      // where it started depends on how much water it crossed after bending.
      // Scaling the offset by the thickness now measured does that: two bubbles
      // side by side at different depths shift by different amounts, and a
      // cloud of them shears the way a real one does through a moving surface.
      vec2 ruvD = clamp(suv + roff * (1.0 + thick * 0.55), vec2(0.001), vec2(0.999));
      vec3 seen = texture(uRefrColor, ruvD).rgb;
      vec3 tinted = seen * exp(-uAbsorption * thick * uRefrMurk);
      // Visibility falls much slower than colour: you can SEE a pale keel
      // three metres down long after its reds are gone. 0.09 keeps the hull
      // legible to ~8 m of path; the tint above does the colour dying.
      float keep = exp(-thick * 0.09);
      diffuse = mix(diffuse, tinted, clamp(keep, 0.0, 1.0));
    }
  }

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
    // FORKED for softness. Foam clipped to near-white at every thickness is
    // what reads as a sticker rather than a raft of bubbles: with the base and
    // the ceiling pulled down, only genuinely thick lace gets to be white and
    // the filaments stay grey, which is the whole tonal range a real wake has.
    float albedo = clamp(mix(0.70, 0.50, uFoamSoft) + 0.26*bubbles
                       + 0.08*uFoamLift*fresh*bubbles,
                         mix(0.62, 0.40, uFoamSoft), mix(0.97, 0.76, uFoamSoft));
    float thickK = 0.0;
    float wrap = mix(0.48, 0.85, thickK);
    albedo = mix(albedo, 0.90, thickK);
    float fNoLw = max((dot(Nfoam, L) + wrap) / (1.0 + wrap), 0.0);
    // The unoriented term is light that entered the raft and came back out
    // with no direction left. At 0.28 it is what pushes the sunlit side past
    // 1.0 and clips, and a clipped highlight has no shape.
    vec3 Efoam = skyIrr * ao + sunRad * fNoLw
               + sunRad * mix(0.28, 0.11, uFoamSoft) * (0.55 + 0.45*bubbles);
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
    // Thin lace should not hide the water. Coverage now falls away with
    // optical thickness, so the veil tints instead of painting over.
    float cover = foamMask * mix(0.38, 0.88, fresh)
                * mix(1.0, 0.58 + 0.42*bubbles, uFoamSoft);
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

  // ---- wave-motion debug ---------------------------------------------------
  //
  // Waves are hard to READ on a lit sea: the shading that makes water look like
  // water -- Fresnel, sky reflection, foam, the bed showing through -- is also
  // what hides the thing you are trying to watch, which is a few centimetres of
  // height moving across the surface. So this throws all of it away and paints
  // the wake's own height as a diverging ramp: crests warm, troughs cold, still
  // water black. A travelling crest is then unmistakable, and so is one that
  // is NOT travelling.
  if (uWaveDebug > 0.5) {
    float h = wakeAt(vFlat.xz).y;
    float a = clamp(h / max(uWaveDebugScale, 0.005), -1.0, 1.0);
    vec3 c = a >= 0.0 ? mix(vec3(0.02, 0.02, 0.03), vec3(1.0, 0.42, 0.12), a)
                      : mix(vec3(0.02, 0.02, 0.03), vec3(0.12, 0.52, 1.0), -a);
    // A faint zero contour, so the crest LINES are legible and not just a wash
    // of colour -- it is the lines whose motion you are trying to follow.
    c += vec3(0.25) * (1.0 - smoothstep(0.0, 0.06, abs(a)));
    fragColor = ABYSSAL_OUT(c);
    return;
  }

  fragColor = ABYSSAL_OUT(col);
}
`;
