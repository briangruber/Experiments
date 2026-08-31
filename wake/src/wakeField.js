// The wake field.
//
// Everything the boat leaves behind is baked, every frame, into one top-down
// float texture that follows the boat:
//
//   R = foam coverage       G = surface displacement (m)
//   B = surfaced bubbles    A = bubble density
//
// B is the SURFACED portion of A, so B/A recovers how much of the cloud has
// reached the top -- which is what sets its colour. Swell flattening used to
// live in B and is now derived in the ocean shader from foam and bubbles,
// since water is flattened because it is churned.
//
// The ocean shader then samples that texture — so the wake composites with the
// water with no seams, and none of the wake maths lives in the ocean shader.
//
// The wake itself is a ribbon mesh laid along the boat's recent path. Each
// vertex carries how far astern it is (arc), how far off the centreline (lat),
// and how old it is (age); the ribbon's fragment shader draws the whole wake
// procedurally from those three numbers. Because nothing accumulates between
// frames, changing any parameter re-draws the *entire* wake instantly — which
// is the whole point of the prototype.

import * as THREE from 'three';
import { get } from './params.js';
import { NOISE_GLSL } from './noise.js';

const MAX_SAMPLES = 640;   // path history points
const LAT_SEG = 48;        // lateral divisions of the ribbon
const STEP = 1.4;          // metres between path samples


const RIBBON_VERT = /* glsl */`
  attribute float aArc;
  attribute float aLat;
  attribute float aAge;
  attribute float aU;
  attribute vec2 aTan;
  attribute float aSpd;
  attribute float aTurn;
  attribute float aLoad;   // how hard the screw was working when this water was left
  varying float vArc; varying float vLat; varying float vAge; varying float vU;
  varying vec2 vWorld; varying vec2 vTan; varying float vSpd; varying float vTurn;
  varying float vLoad;
  void main(){
    vArc = aArc; vLat = aLat; vAge = aAge; vU = aU; vTan = aTan; vSpd = aSpd; vTurn = aTurn;
    vLoad = aLoad;
    vWorld = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIBBON_FRAG = /* glsl */`
  precision highp float;
  varying float vArc; varying float vLat; varying float vAge; varying float vU;
  varying vec2 vWorld; varying vec2 vTan; varying float vSpd; varying float vTurn;
  varying float vLoad;

  uniform float uMaxArc, uPlaning, uHumpFr, uWetShift;
  uniform float uKelvinFade;
  uniform float uIdleChurn, uBubGrain, uBubGrainScale;
  uniform float uFeatErode, uFeatErodeLen;
  uniform float uBeam, uHullLen, uEngines, uEngineGap;
  // The hull's length TWICE, and the difference matters whenever Model scale is
  // not 1. uHullLen is what the hull is DRAWN at, and everything that has to
  // line up with the boat on screen uses it -- where the wash starts, where the
  // bow wave sits, the hull's own footprint. uHullLenPhys is the length the
  // hydrodynamics were tuned in, and the Froude numbers and the bow/stern
  // interference keep using that, because scaling those with a look knob would
  // change the wake pattern rather than where it is drawn.
  uniform float uHullLenPhys;
  // How far aft of arc 0 the TRANSOM is, measured off the drawn model. arc 0 is
  // the stem, so for a hull whose origin sits at the stem this equals the drawn
  // length -- but it is measured rather than assumed, because the thing that
  // has to line up is the back of the boat on screen, not a number derived from
  // two sliders.
  uniform float uSternArc;
  // The hull WHERE IT ACTUALLY IS, in world metres: the bow's position and the
  // way it points. The ribbon's own (arc, lat) frame follows the COURSE, and
  // the hull is drawn along the HEADING -- so with any crab angle at all the
  // two disagree, and a footprint carved in ribbon space slides out from under
  // the boat as a bare rectangle beside it.
  uniform vec2 uHullXZ, uHullDir;
  uniform float uHullCut;
  uniform float uArmTan, uArmW0, uArmWGrow, uArmFoam, uArmHeight, uInnerBias, uFadeStart, uFadeLen;
  uniform float uAutoAngle;
  uniform float uRim, uRimW, uNearBoost, uNearLen, uCarve;
  uniform float uFeatSpace, uFeatGrow, uFeatLean, uFeatDepth, uFeatJitter, uFeatSharp;
  uniform float uWashW, uWashWGrow, uWashFoam, uWashLen, uWashTail, uWashDepth;
  uniform float uCav, uCavLen, uCavW, uCavGrain, uCavFoam;
  uniform float uFrPeak, uHumpFloor, uBeamGain, uInterf, uTurnBias;
  uniform float uBreakSteep, uWaveFoam, uFromWaves;
  uniform float uBreakPatch, uBreakPatchScale;
  uniform float uKelvinScale, uKelvinProp, uKelvinAmp, uKelvinDiv, uKelvinTrans, uKelvinCusp, uKelvinDecay, uKelvinLife, uKelvinMin;
  uniform float uFoamScale, uFoamContrast, uBreakup, uFoamLife, uDissolve;
  uniform float uMelt, uMeltScale;
  uniform float uSpeedDrive, uSpeedRef;
  uniform float uLace, uLaceAmt, uSoftness;
  uniform float uBubPlume, uBubW, uBubSpread, uBubLen, uBubArms, uBubLife, uBubMottle;
  uniform float uTime, uSwirl, uBubArmsLen, uBubDepth, uBubRise, uBubExt;

  ${NOISE_GLSL}

  // The hull's own waterline, matching the shape boat.js extrudes: a point at
  // the stem, full beam a little past midships, tucked very slightly at the
  // transom. Everything the hull makes has to start from THIS, not from a
  // constant half-beam -- otherwise the wake springs from a point at the bow
  // already at full width, and lays foam across and ahead of the stem.
  float hullHalf(float arc){
    float t = clamp(arc / max(uHullLen, 0.1), 0.0, 1.0);
    float w = pow(smoothstep(0.0, 0.55, t), 0.62);   // entry, fine forward
    return uBeam * 0.5 * mix(w, 0.92, t * t);        // slight tuck aft
  }

  void main(){
    float arc = max(vArc, 0.0);
    float d   = vLat;
    float ad  = abs(d);
    float age = vAge;

    // How hard was the water hit here? Every source below scales by the speed
    // the boat was ACTUALLY doing when it passed this spot, not by its speed
    // now -- so a wake built while accelerating gets narrower and fainter
    // towards its tail, instead of the whole thing appearing at full strength
    // the moment the throttle moves.
    //
    // Spray arms need planing speed to exist at all: below it a hull pushes
    // water aside rather than throwing it, and there are no sheets to break.
    float spd = max(vSpd, 0.0);

    // Where the hull was actually touching when it passed here. Once it is up
    // on plane the bow is clear of the water, so spray leaves from a contact
    // point well aft of the stem -- and this is per-sample, from the speed at
    // emission, so a wake laid while slow still starts at the stem.
    float frS = spd / sqrt(9.81 * max(uHullLenPhys, 0.5));
    float planedS = smoothstep(uHumpFr * 1.05, uHumpFr * 2.3, frS);
    float wet = uHullLen * uWetShift * planedS;
    float wa = max(arc - wet, 0.0);          // arc measured from the contact point

    // Wake magnitude by regime: least while displacing, largest through the
    // transition where the hull plows along with its bow up, and back down
    // again on plane where far less of it is in the water. Same Froude curve
    // the wave amplitude uses, so the churn and the waves agree about which
    // speed is the expensive one.
    float hw = frS / max(uFrPeak, 0.05);
    float regime = max(hw * hw * exp(1.0 - hw * hw),
                       uHumpFloor * smoothstep(0.12, 0.70, hw));
    float planing = smoothstep(uPlaning * 0.45, uPlaning, spd);
    float moving  = smoothstep(0.15, 1.6, spd);          // anything under way
    float churn   = smoothstep(0.4, uPlaning * 0.8, spd);  // prop working hard

    // Ribbon edge: never let the mesh boundary show as a hard line.
    float edge = 1.0 - smoothstep(0.80, 1.0, abs(vU));
    if (edge <= 0.0) discard;

    // ---------------------------------------------------------------- arms --
    // The V of spray sheets, springing from the bow and opening at a fixed
    // half-angle. The outer edge is a hard bright line; the inner edge is soft
    // and combed — that asymmetry is most of the read.
    float wander = (fbm(vec2(arc * 0.018, sign(d) * 3.7)) - 0.5) * (1.0 + arc * 0.045);
    // The arms leave the hull along its side, so they start at the waterline
    // and open from there. At the stem that is zero, which closes the V to a
    // point at the bow instead of a band across it.
    // The half-angle, from the water rather than from a slider.
    //
    // A displacement hull's wake is the Kelvin envelope: 19.47 degrees, and
    // famously independent of speed -- it falls out of deep-water gravity-wave
    // dispersion, not out of the boat. But that holds only while the hull is
    // slow compared with the waves it makes. Past a beam-Froude number of
    // about 0.5 the hull outruns the transverse system, only the divergent
    // waves survive, and the visible wake NARROWS as atan(1/(2*Fr_B))
    // (Rabaud & Moisy, PRL 2013) -- which is why a fast boat leaves a long
    // thin V and a tug leaves a wide one.
    //
    // Fr_B uses the BEAM, because the beam is the width of the disturbance the
    // hull is dragging. Per sample, from the speed at emission, so a wake laid
    // while accelerating opens out along its own length exactly as it should.
    float FrB = spd / sqrt(9.81 * max(uBeam, 0.2));
    float kelvin = 0.33984;                          // atan(1/(2*sqrt(2)))
    float physAng = min(kelvin, atan(1.0 / max(2.0 * FrB, 1e-3)));
    float armTan = mix(uArmTan, tan(physAng), uAutoAngle);
    float armC = hullHalf(max(arc, wet)) + wa * armTan + wander;
    // Thin where the hull is fine and the sheet has barely formed, thickening
    // as the water is thrown clear.
    float armW = max(uArmW0 + wa * uArmWGrow, 0.05)
               * mix(0.18, 1.0, smoothstep(0.0, uHullLen * 0.55, wa));
    float x = (ad - armC) / armW;
    float xb = (x < 0.0) ? x / (1.0 + uInnerBias * 2.6) : x;
    float armG = exp(-xb * xb * (x < 0.0 ? 1.7 : 3.4));
    float armFade = 1.0 - smoothstep(uFadeStart, uFadeStart + uFadeLen, arc);

    // The ribbon simply ends at the bow. Without a ramp, height and foam step
    // from nothing to full across that one leading edge, and the smoothed
    // texture lookup spreads the step into a dome standing ahead of the stem.
    // It also stops both arm crests piling into a single spike at arc = 0,
    // where the two of them meet on the centreline.
    float nose = smoothstep(0.0, uHullLen * 0.30, wa);

    // Feathering: periodic crests leaning back off the arm axis, stretching out
    // as the wake ages.
    float sp = max(uFeatSpace + arc * uFeatGrow, 0.1);
    // Jitter at TWO scales. One octave at 11 m wanders the whole train slowly
    // and leaves every crest inside it geometrically perfect; the finer one
    // makes each crest wander on its own, which is what stops the fan reading
    // as though it were drawn with a compass.
    float jit = ((fbm(vWorld * 0.09) - 0.5) * 0.72
               + (fbm(vWorld * 0.38 + 21.0) - 0.5) * 0.55) * uFeatJitter;
    float phase = (arc + (ad - armC) * uFeatLean) / sp + jit;
    float f = pow(0.5 + 0.5 * sin(6.28318 * phase), uFeatSharp);
    float inner = smoothstep(0.25, -1.30, x);          // 0 outboard, 1 inboard
    float comb = mix(1.0, f, uFeatDepth * inner);

    // AND IT BREAKS UP AS IT AGES.
    //
    // A feather is not a line, it is a row of breaking crests -- so it comes in
    // segments with gaps between them, and the further astern the more of it
    // has collapsed. A single clean sine, however well jittered, still draws an
    // unbroken curve from the bow to the end of the field, which is the fan of
    // drafting-pen lines this used to make. Two scales of noise thresholded
    // against each other give segments and gaps; erosion ramps with distance,
    // so the crests are whole where they are made and ragged where they are old.
    float bk = fbm(vWorld * 0.21 + 13.0) * 0.62 + fbm(vWorld * 0.83 - 7.0) * 0.38;
    float erode = uFeatErode * smoothstep(2.0, max(uFeatErodeLen, 3.0), arc);
    comb *= mix(1.0, smoothstep(0.30, 0.66, bk), erode);

    // The leading edge of the spray sheet is a hard bright line; without it the
    // arm reads as a soft smudge rather than as breaking water.
    float rimD = (ad - (armC + armW * 0.85)) / max(uRimW, 0.02);
    float rim = exp(-rimD * rimD) * uRim
              * mix(0.35, 1.0, comb)                       // broken by the comb
              * (0.45 + 0.85 * fbm(vWorld * 0.55))         // and by the water itself
              * smoothstep(4.0, 26.0, arc);                // only once the sheet thins

    // Close astern the whole wake is a dense unbroken mass; the lace-like
    // structure only emerges once it has spread and started to die.
    float near = 1.0 + uNearBoost * exp(-arc / max(uNearLen, 1.0));

    float armFoam = (armG * comb + rim) * uArmFoam * armFade * near * planing * nose;
    float armH    = (armG * mix(0.65, 1.0, comb) + rim * 0.5) * uArmHeight * armFade * planing * nose;

    // ------------------------------------------------------------ prop wash --
    // Turbulent water dragged off the transom: brightest foam in the wake and
    // the shortest-lived, trailing off into a thin centreline streak.
    // PINNED TO THE TRANSOM.
    //
    // This used to ramp from 0.55 to 1.05 hull-lengths, which on a 38 m boat is
    // a twenty-metre fade beginning amidships -- so the wash bled out of the
    // side of the hull and only reached full strength a boat-length astern.
    // The water a screw churns starts at the screw. A short ramp, a couple of
    // metres either side of the transom, so it begins where the boat ends
    // without printing a hard line across the wake.
    float astern = smoothstep(uSternArc - uHullLen * 0.10,
                              uSternArc + uHullLen * 0.06, arc);
    float ww = max(uWashW + arc * uWashWGrow, 0.05);

    // One plume per engine, spread about the centreline. They start as separate
    // channels and merge as each spreads -- which is exactly what a twin- or
    // triple-screw wake looks like from above.
    float wg = 0.0;
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uEngines) break;
      float off = (float(i) - (uEngines - 1.0) * 0.5) * uEngineGap;
      float dd = (d - off) / ww;
      wg += exp(-dd * dd);
    }
    wg = min(wg, 1.4);
    float washFoam = astern * wg * (uWashFoam * exp(-arc / uWashLen) + uWashTail) * near * churn * regime;
    float washH   = -astern * wg * uWashDepth * exp(-arc / (uWashLen * 1.6));

    // ------------------------------------------------------------ cavitation --
    //
    // Not a longer, brighter wash: a different thing entirely, and the prop
    // wash controls could never have produced it. Cavitation is the water
    // BOILING at the blade -- pressure on the suction face drops below vapour
    // pressure, the water flashes to steam, and the bubbles collapse again a
    // blade-width downstream. What you see is a dense white column right at the
    // screw, a metre or two long, not a streak running forty-five metres aft.
    //
    // It is driven by LOAD, not by speed, and that is the whole character of
    // it: a screw cavitates when it is asked for thrust it cannot get -- gun it
    // from rest, or throw it astern -- and stops once the boat is up and the
    // blades are working in clean water. So this rides vLoad, which the sim
    // fills from the gap between the throttle and the speed actually made, and
    // it is quenched as she comes up to that speed.
    // The sign of vLoad is which way she is going: negative astern. Going
    // astern the screws are AT the ribbon's anchor, because the anchor is the
    // transom -- so the boil starts at arc 0 rather than a hull-length back.
    float cavLoad = clamp(abs(vLoad), 0.0, 1.0);
    float propArc = vLoad < 0.0 ? 0.0 : uSternArc;
    // MEASURED FROM THE TRANSOM, which is where the screw is.
    //
    // arc is distance along the path from the STEM -- the ribbon is anchored at
    // the bow. So decaying straight off arc put the boil at the bow and killed
    // it before the transom: with a 1.2 m reach and a 9.9 m hull the term was
    // e^-16 by the time it reached the propeller, and what little survived was
    // under the hull, where the sea is cut away and nothing is drawn anyway.
    // Turning every slider to maximum could not rescue that, because the fault
    // was WHERE it was, not how strong.
    float cavArc = max(arc - propArc, 0.0);
    float cavReach = max(uCavLen, 0.3);
    float cavNear = exp(-cavArc / cavReach) * exp(-cavArc / cavReach);
    // Tight to the blade circle, tighter than the wash it sits inside.
    float cw = max(uCavW, 0.05);
    float cg = 0.0;
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uEngines) break;
      float off = (float(i) - (uEngines - 1.0) * 0.5) * uEngineGap;
      float dd = (d - off) / cw;
      cg += exp(-dd * dd);
    }
    cg = min(cg, 1.5);
    // Boiling, not flowing: a fast, fine, high-contrast field. The two octaves
    // run at different speeds so the pattern never reads as a scrolling
    // texture, and the threshold is what makes it discrete bubbles rather than
    // a smooth cloud.
    vec2 cp = vWorld * uCavGrain;
    float c1 = fbm(cp + vec2(uTime * 1.7, -uTime * 2.3));
    float c2 = fbm(cp * 2.7 + vec2(-uTime * 3.1, uTime * 1.3));
    float boil = smoothstep(0.38, 0.72, c1 * 0.6 + c2 * 0.4);
    // Gated aft of the hull for the same reason the wash is: the water under a
    // boat is cut out of the sea, so anything painted there is paint wasted.
    float cav = cavLoad * cg * cavNear * uCav * boil * astern;

    // ------------------------------------------------------- inside the V ----
    // -------------------------------------------------------- Kelvin waves --
    // Deep-water gravity waves from a moving source, by stationary phase.
    //
    // A wave train travelling at angle psi to the track has k = g/(V^2 cos^2
    // psi) and reaches the point (u astern, v abeam) with phase
    // k*(u cos psi + v sin psi). Stationary phase in psi reduces to
    //
    //     2 v T^2 + u T + v = 0,    T = tan(psi)
    //
    // whose two roots are the divergent and transverse systems. Real roots
    // need u^2 >= 8 v^2, i.e. |v/u| <= 1/(2*sqrt2) -- the 19.47 degree Kelvin
    // wedge, arriving out of the maths rather than being drawn on. That wedge
    // is WIDER than the spray arms, and being displacement rather than foam
    // these waves keep rolling long after the white has gone.
    float kelvinH = 0.0;
    float waveBreak = 0.0;
    // k0 = g / V^2 for the speed THIS water was disturbed at. Slow water makes
    // short, small waves; the pattern behind an accelerating boat is genuinely
    // not self-similar, and using one speed for the whole wake hides that.
    float kv = max(spd, 1.2);
    float k0 = 9.81 / (kv * kv) / uKelvinScale;

    // Anchor: how far astern the pattern thinks it is.
    //
    // arc is distance behind the boat RIGHT NOW, which ties the whole pattern
    // rigidly to the hull -- slow down and waves already on the water freeze
    // with it. But the steady solution is steady for a source that KEPT GOING
    // at the speed this water was disturbed at, so that is the anchor: emission
    // speed times age. The two are identical at constant speed, and they part
    // company exactly when they should, letting waves already made carry on
    // under their own momentum after the boat has slowed or stopped.
    float u = mix(arc, max(spd, 0.0) * age, uKelvinProp);
    float v = max(ad, 0.4);
    float disc = u * u - 8.0 * v * v;
    if (disc > 0.0 && u > 1.0) {
      float sq = sqrt(disc);
      float Td = (-u - sq) / (4.0 * v);         // divergent root
      float Tt = (-u + sq) / (4.0 * v);         // transverse root
      float sd = sqrt(1.0 + Td * Td);
      float st = sqrt(1.0 + Tt * Tt);
      float pd = k0 * sd * (u + v * Td);
      float pt = k0 * st * (u + v * Tt);

      // The divergent system runs to arbitrarily short waves as psi approaches
      // 90 degrees. Anything shorter than the field texture can carry becomes
      // moire rather than wave, so it is faded out at its own local wavelength.
      float ld = 6.28318 / max(k0 * sd, 1e-4);
      float lt = 6.28318 / max(k0 * st, 1e-4);
      float fd = smoothstep(uKelvinMin * 0.6, uKelvinMin * 1.8, ld);
      float ft = smoothstep(uKelvinMin * 0.6, uKelvinMin * 1.8, lt);

      // Amplitude thins as the energy spreads around a longer wavefront.
      float R = sqrt(u * u + v * v);
      float fall = 1.0 / sqrt(1.0 + R / max(uKelvinDecay, 1.0));

      // The two systems merge at the wedge edge and the amplitude piles up
      // there -- the cusp line, the brightest feature of a real wake.
      float cusp = 1.0 + uKelvinCusp * exp(-6.0 * disc / (u * u + 1.0));

      float kAge = pow(1.0 - clamp(age / max(uKelvinLife, 0.01), 0.0, 1.0), 1.1);

      // The wedge boundary is a hard on/off in the maths (disc crosses zero),
      // and baking that straight into the field leaves a jagged diagonal edge
      // one texel wide, which is exactly what a close-up shows. Ramped over a
      // small band of disc instead, so it resolves at any magnification.
      float wedge = smoothstep(0.0, u * u * 0.035 + 1.0, disc);

      // ---- how big a wave this hull makes, at this speed ------------------
      // Length Froude number. Wave-making is not linear in speed: it climbs,
      // peaks near hull speed where the hull is trapped between its own bow
      // and stern crests, and falls away again once it lifts and planes.
      float Fr = kv / sqrt(9.81 * max(uHullLenPhys, 0.5));
      float fr = Fr / max(uFrPeak, 0.05);
      // Peaks at 1.0 at Fr = uFrPeak, but floored rather than allowed to decay
      // to nothing: past the hump a hull lifts and its wave-making resistance
      // falls away, yet a planing boat plainly still leaves a wake. Without the
      // floor the waves switch off entirely at ordinary planing speeds.
      float hump = fr * fr * exp(1.0 - fr * fr);
      hump = max(hump, uHumpFloor * smoothstep(0.12, 0.70, fr));

      // Bow and stern each raise their own system, separated by the hull's
      // length. They add or cancel depending on how many wavelengths fit
      // between them -- the classic humps and hollows in a hull's resistance
      // curve, and the reason a given hull has speeds that feel cheap and
      // speeds that feel expensive.
      float interf = mix(1.0, abs(cos(k0 * uHullLenPhys * 0.5)) * 1.6, uInterf);

      // A beamier hull pushes more water aside.
      float beam = mix(1.0, uBeam / 2.6, uBeamGain);

      // In a turn the outside of the curve is where the hull is throwing its
      // water, so that side runs bigger.
      float side = clamp(vTurn * sign(d) * -6.0, -1.0, 1.0);
      float turnGain = 1.0 + side * uTurnBias * 0.5;

      float ampLoc = fall * cusp * kAge * uKelvinAmp * moving
                   * hump * interf * beam * turnGain;

      kelvinH = (cos(pd) * uKelvinDiv * fd + cos(pt) * uKelvinTrans * ft) * ampLoc * wedge;

      // ---- where the water actually breaks -------------------------------
      // Foam is not a shape to be drawn at a chosen angle. It is what happens
      // where a wave gets too steep to hold together, and steepness is
      // amplitude times wavenumber. Past a critical value the crest spills.
      //
      // Deriving it here means the foam inherits the wave field's own geometry:
      // it lands on the cusp line, where the divergent and transverse systems
      // merge and the amplitude piles up, and it follows speed, Froude number,
      // hull length and turn without being told to -- because all of those are
      // already in ampLoc and k0.
      float steepD = ampLoc * uKelvinDiv * fd * k0 * sd;
      float steepT = ampLoc * uKelvinTrans * ft * k0 * st;

      // ...and only on the crest faces, not in the troughs.
      float crestD = smoothstep(-0.15, 0.80, cos(pd));
      float crestT = smoothstep(-0.15, 0.80, cos(pt));

      waveBreak = (smoothstep(uBreakSteep, uBreakSteep * 2.4, steepD) * crestD
                 + smoothstep(uBreakSteep, uBreakSteep * 2.4, steepT) * crestT * 0.55) * wedge;

      // A CREST DOES NOT BREAK ALONG ITS WHOLE LENGTH, and painting it as if it
      // did is what made these read as ribbons rather than as water.
      //
      // The steepness above is an analytic function of position, so it is
      // smooth and continuous everywhere -- run a threshold across it and you
      // get an unbroken painted stripe with two clean edges, following the wave
      // exactly. Real breaking is intermittent: a crest goes over in patches a
      // few metres long with clear water between them, because the steepness
      // that trips it is never uniform along the line.
      //
      // Sampled in WORLD space so the patches belong to the water and stay put
      // as the boat runs on, and at two scales so the gaps themselves are not
      // evenly spaced. The threshold is what makes it patches rather than a
      // modulation: below it there is no foam at all, which is the clear water
      // between breaks.
      float bp = fbm(vWorld * uBreakPatchScale) * 0.62
               + fbm(vWorld * uBreakPatchScale * 2.7 + 41.0) * 0.38;
      waveBreak *= mix(1.0, smoothstep(0.34, 0.66, bp), uBreakPatch);
    }

    // ------------------------------------------------------------ foam look --
    // Two textures, both locked to the water rather than to the boat:
    //  · a reticulated bubble raft (open cells with bright walls), and
    //  · streaks stretched along the direction the water was thrown, which is
    //    the local path tangent frozen in at birth.
    //
    // ...and they MELT. A raft of foam is not a decal that dims: it is a
    // material sitting on water that is still moving under it. The turbulence
    // it was born in goes on stirring it, the bubbles drain and merge, and the
    // clean edges it had when it was laid wander, stretch and come apart. That
    // slow deformation is most of what makes old foam read as foam rather than
    // as a fading stain -- and none of it can happen while the pattern is a
    // fixed function of world position, which is what this was.
    //
    // So the macro field is read through a domain warp that GROWS WITH AGE:
    // fresh foam is sampled where it was laid and is crisp, and by the end of
    // its life the same water is being read from up to uMelt metres away, so
    // its clumps have drifted and its edges have gone soft and irregular. The
    // warp is world-locked and slow, so neighbouring foam melts in the same
    // direction as its neighbours rather than each texel wandering off alone.
    float meltT = clamp(age / max(uFoamLife, 0.01), 0.0, 1.0);
    vec2 wq = vWorld * uMeltScale;
    vec2 warp = vec2(fbm(wq + 11.7), fbm(wq + 71.3)) - 0.5;
    // Squared, so almost nothing happens while the foam is young and the
    // deformation runs away at the end -- which is the shape of the real thing.
    vec2 fW = vWorld + warp * (uMelt * meltT * meltT);

    vec2 nrm = vec2(-vTan.y, vTan.x);
    vec2 flow = vec2(dot(fW, vTan), dot(fW, nrm));
    float raft   = lattice(fW * uFoamScale, 0.13);
    float streak = fbm(flow * uFoamScale * vec2(0.40, 2.4));
    float blob   = fbm(fW * uFoamScale * 0.55);

    // One combined field, normalised to roughly [0,1] with a mean near 0.5.
    // This is MACRO variation only -- clumps and streaks a metre or two across.
    // The fine bubble lace is not baked here: this texture is 0.33 m per texel,
    // which is coarser than lace, so baking it produces visible squares up
    // close. The ocean shader adds it per-pixel instead, where it has no
    // resolution limit at all.
    float field = blob * 0.42 + raft * 0.42 + streak * 0.16;
    field = clamp((field - 0.5) * uFoamContrast + 0.5, 0.0, 1.0);
    field = clamp(field - (1.0 - comb) * uCarve * inner, 0.0, 1.0);

    // ---- what the speed at the time of emission buys ---------------------
    //
    // vSpd is the hull's speed WHEN THIS WATER WAS DISTURBED, not now. That
    // distinction is the whole point: foam laid down at twenty knots stays
    // dense and long-lived after the boat throttles back, and a wake that
    // thins along its whole length the moment you slow down is the tell that
    // it is being drawn rather than remembered.
    //
    // Density goes as v^2. A planing hull's drag goes as v^2, so the power it
    // pours into the water goes as v^3 -- but the foam is spread along a track
    // being laid at v metres per second, so the energy delivered PER METRE is
    // v^3/v. That is the air entrained per metre of wake, which is what
    // coverage is.
    //
    // Persistence goes as sqrt(v), deliberately weaker. A thicker raft takes
    // longer to clear because there is more of it, not because its bubbles
    // rise any slower -- so the life grows, but nothing like as fast as the
    // density does. Scaling both by v^2 gives a fast boat a trail that never
    // ends.
    float sN = max(spd, 0.0) / max(uSpeedRef, 0.5);
    // SATURATING v^2, not raw v^2.
    //
    // Coverage is the fraction of water that is aerated, so it cannot exceed
    // one -- but the raw law kept multiplying: at twice the reference speed it
    // asked for 4x, at three times 9x, and the lace's opacity build turned
    // anything past about 2 into a solid white sheet with no texture in it at
    // all. A fast boat had a paper wake.
    //
    // s^2(1+k)/(1+k s^2) is the same curve near zero, still exactly 1 at the
    // reference speed (any k), and asymptotes to (1+k)/k instead of running
    // away -- k = 1 caps a flat-out boat at twice reference density, which is
    // dense enough to read as violent and sparse enough to stay lace.
    float e2 = sN * sN;
    float energy = mix(1.0, e2 * 2.0 / (1.0 + e2), uSpeedDrive);
    float lifeK = mix(1.0, sqrt(max(sN, 0.04)), uSpeedDrive);

    float ageN = clamp(age / max(uFoamLife * lifeK, 0.01), 0.0, 1.0);
    float alive = pow(1.0 - ageN, uDissolve);

    // Coverage: how much of the water here is aerated. Smooth and continuous --
    // no threshold, so nothing here can produce a hard edge. Break-up with age
    // eats into coverage, which the ocean's threshold then turns into holes.
    // Foam coverage, from either the prescribed arms or from where the waves
    // are actually breaking -- uFromWaves crossfades between them so the two
    // can be compared directly.
    float coverArms  = armFoam + washFoam;
    float coverWaves = waveBreak * uWaveFoam * planing + washFoam;
    float cover = mix(coverArms, coverWaves, uFromWaves) * alive * energy;
    cover *= mix(1.0, 0.35 + 0.95 * field, mix(0.45, 1.0, ageN * uBreakup + 0.35));

    float foam = cover;

    // Right at the bow the spray is a smooth unbroken sheet; it only breaks
    // into bubbles once it has fallen back onto the water.
    float sheet = 1.0 - smoothstep(0.5, 7.0, arc);
    foam = mix(foam, max(foam, (armFoam + washFoam) * alive * 1.1), sheet * 0.34);

    // The hull's own footprint, optionally cut out of the foam.
    //
    // OFF by default now. The argument for cutting it was that a hull
    // displaces the water it sits in rather than floating on its own spray --
    // true, but the foam it is displacing is the foam it is MAKING, born at
    // the waterline it is cutting through right now. Removing it just leaves
    // a boat-shaped hole that reads as the wake failing to reach the boat,
    // which is worse than the thing the cut was avoiding. Kept as a knob
    // because the shape is right even when the strength should be zero.
    // WORLD space, against the real hull -- see uHullXZ above.
    vec2 relH = vWorld - uHullXZ;
    float sternward = -dot(relH, uHullDir);             // metres aft of the bow
    float latH = abs(dot(relH, vec2(uHullDir.y, -uHullDir.x)));
    float hb = max(hullHalf(sternward), 0.02);
    float hull = (1.0 - smoothstep(hb * 0.82, hb * 1.10, latH))
               * (1.0 - smoothstep(uHullLen * 0.96, uHullLen * 1.04, sternward))
               * smoothstep(-0.7, 0.2, sternward);      // nothing ahead of the stem
    foam *= 1.0 - hull * uHullCut;

    // ------------------------------------------------- subsurface bubbles --
    // The prop is underwater, so most of the air it drags in never reaches the
    // surface as foam. It stays as a plume in the water column: wider and much
    // longer-lived than the foam above it, still there long after the white has
    // gone. Seen through water it is cloudy rather than granular, so this is
    // deliberately low frequency -- and cheap to bake, unlike the lace.
    // Wide enough that adjacent screws overlap into ONE column. Two lanes
    // narrower than their own spacing never merge, and read as a pair of hard
    // pale strips under the hull rather than as churn.
    float bw = max(max(uBubW + arc * uBubSpread, 0.1), uEngineGap * 0.75);
    float bg = 0.0;
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uEngines) break;
      float off = (float(i) - (uEngines - 1.0) * 0.5) * uEngineGap;
      float dd = (d - off) / bw;
      bg += exp(-dd * dd);
    }
    bg = min(bg, 1.4);
    // A TURNING SHAFT MAKES BUBBLES, whatever the boat is doing.
    //
    // churn is smoothstep(0.4, planing*0.8, spd) -- right for how HARD the prop
    // is working, wrong for whether it is working at all. Gated on it alone the
    // plume did not exist until the hull was most of the way to planing, so
    // easing away from a mooring left the water behind the transom completely
    // undisturbed. A screw turning over entrains air from the moment it bites.
    //
    // So the idle term is separate: it comes in almost at once, and it is only
    // added to the PLUME, not to the wash foam. This is underwater churn seen
    // through the surface, not lace lying on top of it, and the two are
    // different things -- which is the distinction the foam channels already
    // draw between bubble density and the surfaced fraction of it.
    float propOn = smoothstep(0.06, 0.9, spd);
    // It does not stream far when she is barely moving: the column is left
    // behind at the speed she is making, so at idle it is a patch under the
    // counter rather than a trail.
    float bubReach = max(uBubLen, 1.0) * mix(0.22, 1.0, propOn * (0.35 + 0.65 * regime));
    float plume = astern * bg * uBubPlume * exp(-arc / bubReach) * churn * regime;
    // THE SHAFT'S OWN CHURN, kept separate because it does not obey the hull's
    // speed law. energy below is e2*2/(1+e2) -- how hard the HULL is working the
    // water -- and at a metre a second that is 0.077, which is what took this
    // from a visible boil down to three ten-thousandths and under the threshold
    // of being drawn at all. But the boil behind a transom is the propeller's
    // doing: a boat in gear at tickover churns plainly while making almost no
    // way. So it is added AFTER the speed law rather than passed through it.
    // CALIBRATED AGAINST WHAT IS SEEN, not against what is in the field.
    //
    // The water shader turns density into colour by Beer-Lambert:
    // scat = 1 - exp(-density * bright * 1.5). At 0.9 the idle plume reached a
    // density of 0.03, which is a 4% blend -- present in the buffer and
    // invisible on the water. Cruise sits at 0.21, a 27% blend, and that is
    // what "you can see it" looks like. I had called this verified by counting
    // texels above 0.002 in the field, which is nowhere near the threshold of
    // being visible; the bar was wrong, not the plumbing. 4.0 puts a metre a
    // second near 0.13, about a 17% blend: plainly there, still well under way
    // on.
    float plumeIdle = astern * bg * uBubPlume * exp(-arc / bubReach)
                    * uIdleChurn * propOn * 0.6;
    // 4.0 was calibrated when bubble life was being cut to a third at this
    // speed. Giving them their proper life multiplied the accumulation by about
    // the same factor, and the two compounded to a 73% blend -- milk. Two
    // corrections in one commit, each right on its own, is exactly how that
    // happens; the gain belongs downstream of the life, so it is re-measured
    // after it.

    // Spray plunging back in entrains its own air along each arm.
    //
    // Two corrections, both of which this term needed to stop drawing a pair
    // of hard bright wedges either side of the hull:
    //
    // Air comes down where the sheet FALLS BACK, not where it leaves. At the
    // bow the spray is still climbing; the bubbles it carries under appear a
    // hull-length or more astern, so the entrainment ramps in over that
    // distance instead of starting at the stem.
    //
    // And it is a veil, not a column. armG is a razor-thin gaussian near the
    // bow -- it has to be, it is drawing the sheet's bright edge -- and using
    // it neat gave the bubble cloud the arm's own hard profile. The square
    // root keeps the same centre and shoulders it out, the way a cloud of
    // rising bubbles spreads on its way up.
    float plunge = smoothstep(uHullLen * 0.5, uHullLen * 2.2, arc);
    float entrain = sqrt(max(armG, 0.0)) * uBubArms * armFade
                  * exp(-arc / max(uBubArmsLen, 1.0)) * planing * plunge;

    // Bubbles are injected at the prop, BELOW the surface, and take time to
    // rise. A cloud injected age seconds ago has climbed rise*age, so it
    // starts deep right at the transom and only breaks the top some way
    // astern. Light reaching it has to cross that depth twice, down and back,
    // so a deep cloud is dim -- which makes the churn bloom a little behind
    // the boat rather than peaking at the transom.
    float depth = max(uBubDepth - uBubRise * age, 0.0);
    float surfaced = 1.0 - depth / max(uBubDepth, 0.01);
    float vis = exp(-depth * uBubExt * 2.0);

    // Bubbles do not die sooner because the HULL is slow. lifeK is
    // sqrt(speed), and at a metre a second it was cutting bubble life to a
    // third -- which is why the same gain drew four times as much at cruise as
    // at idle, and why the floor had to be set so high that it swamped the
    // hull's own plume at speed. A gentler law here; the foam above keeps the
    // full one, since foam really is made by the hull moving.
    float bubLifeK = mix(1.0, sqrt(max(sN, 0.04)), uSpeedDrive * 0.35);
    float bubAge = clamp(age / max(uBubLife * bubLifeK, 0.01), 0.0, 1.0);
    // The same speed law the foam obeys, for the same reason -- and one more:
    // without it an IDLE boat kept injecting plume into the same spot, and
    // forty-four seconds of accumulated milk drew a pale disc a hundred
    // metres wide around every parked hull.
    // A FLOOR, not an addition. The shaft's churn saturates by about a metre a
    // second, so added on top it was still adding its full share at cruise --
    // which took the density there from 0.21 to 0.63, a 61% blend where 27%
    // was right, and milkied a wake nobody had complained about. Taking the
    // larger of the two says the true thing instead: the propeller sets a floor
    // the hull cannot fall below, and above that speed the hull's own work is
    // what you are seeing.
    float bub = (max(plume * energy, plumeIdle) + entrain * energy)
              * pow(1.0 - bubAge, 1.15) * vis;
    // The plume is the most turbulent part of the wake, so its clouds churn
    // rather than sitting still. Circling sample offsets again: the cloud
    // evolves in place instead of drifting off the water it belongs to.
    vec2 sw1 = vec2(cos(uTime * 0.31), sin(uTime * 0.31)) * uSwirl * 1.3;
    vec2 sw2 = vec2(cos(uTime * -0.19 + 2.1), sin(uTime * -0.19 + 2.1)) * uSwirl * 0.8;
    float cloud = fbm(vWorld * uFoamScale * 0.55 + sw1) * 0.65
                + fbm(vWorld * uFoamScale * 1.45 + sw2) * 0.45;
    bub *= mix(1.0, 0.18 + 1.55 * cloud, uBubMottle);

    // LITTLE BUBBLES, not a smooth cloud.
    //
    // The line above is deliberately low frequency -- the comment on it says
    // churn "is cloudy rather than granular" -- and that is true of a big wake
    // seen from a distance and wrong for what you actually watch behind a
    // tender ticking over, which is a crowd of separate blobs rising and
    // bursting. So the density is broken into clumps by thresholding a fine
    // noise, and the noise scrolls and evolves because bubbles rise.
    //
    // It fades with age: young churn is discrete, older churn has diffused into
    // the cloud the term above was written for. So the boil at the transom is
    // granular and the trail behind it is not, which is the right way round.
    vec2 gp = vWorld * uBubGrainScale;
    float g1 = fbm(gp + vec2(uTime * 0.13, -uTime * 0.34));
    float g2 = fbm(gp * 2.4 + vec2(-uTime * 0.22, uTime * 0.19));
    float clump = smoothstep(0.44, 0.68, g1 * 0.62 + g2 * 0.38);
    float young = 1.0 - smoothstep(0.10, 0.70, bubAge);
    // 1.9 so breaking it into clumps does not quietly halve the total.
    bub *= mix(1.0, clump * 1.9, clamp(uBubGrain * young, 0.0, 1.0));

    // The oldest end of the trail is a mesh boundary, not a physical edge.
    float tailFade = 1.0 - smoothstep(uMaxArc - min(70.0, uMaxArc * 0.3), uMaxArc, arc);
    foam *= tailFade;

    // Foam decay applies to the foam-borne crests only. The gravity waves carry
    // their own, much longer, life -- outliving the white is the whole point of
    // them.
    float height  = ((armH + washH) * mix(0.35, 1.0, alive)
                   + kelvinH * nose * uKelvinFade) * tailFade;
    // CAVITATION GOES IN AS BUBBLES, and mostly as SUBSURFACE ones.
    //
    // It is not surface foam -- the vapour collapses under water, which is why
    // the reference footage shows a white column inside a green sea rather than
    // a white patch on top of it. So it is added to the bubble channels with
    // only a fraction reaching the foam channel, and it bypasses the plume's
    // surfaced ramp (no backticks in here -- this GLSL lives inside a JS
    // template literal): cavitation is bright from the instant it is made,
    // whereas an entrained bubble has to rise before it shows.
    float bubOut = max(bub, 0.0) * tailFade;
    float cavOut = max(cav, 0.0) * tailFade;

    gl_FragColor = vec4((foam + cavOut * uCavFoam) * edge,
                        height * edge,
                        (bubOut * surfaced + cavOut) * edge,
                        (bubOut + cavOut * 1.35) * edge);
  }
`;


// ---------------------------------------------------------- interference --
//
// THE V, BUILT RATHER THAN DRAWN.
//
// Everything else in this file paints the Kelvin pattern: the wedge comes out
// of solving the stationary-phase condition analytically and the result is
// stamped into a ribbon that follows the boat. It is fast and it is right for a
// hull holding its speed, and it can never do anything else -- the pattern is a
// function of where you are in the ribbon, so it cannot pass the boat, cannot
// meet another wake, and cannot outlive the shape it was drawn on.
//
// This is the honest version. Each point the hull passed through is an impulse
// on the water, and an impulse radiates RINGS. Deep-water waves are dispersive,
// so at distance r and elapsed time tau you see the wavenumber whose GROUP
// velocity is r/tau:
//
//     cg = 0.5*sqrt(g/k) = r/tau        ->  k = g tau^2 / (4 r^2)
//     omega = sqrt(g k)                 ->  omega = g tau / (2 r)
//     phase = k r - omega tau           ->  phase = -g tau^2 / (4 r)
//
// which is Cauchy-Poisson. Sum that over the track and the 19.47 degree wedge
// APPEARS, as the interference of every ring the hull ever made -- nobody
// writes the angle down anywhere. Stop, and the rings carry on expanding
// through where the boat used to be. Turn, and the pattern turns with the
// history rather than with the hull. Both come free, because both are what
// rings actually do.
const INTERFERE_VERT = /* glsl */`
  varying vec2 vW;
  void main(){
    vW = (modelMatrix * vec4(position, 1.0)).xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const MAX_SRC = 96;

const INTERFERE_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vW;
  uniform vec4  uSrc[${MAX_SRC}];      // xz = where, z = when, w = how hard
  uniform vec2  uSrcDir[${MAX_SRC}];   // ...and which way she was pointing
  uniform int   uSrcCount;
  uniform float uTime, uAmp, uLife, uMinLam, uMaxLam;
  uniform float uSrcStep, uSrcDt;   // spacing of the impulses, in metres and seconds
  uniform float uAhead;             // how much wave is allowed ahead of a source

  void main(){
    float eta = 0.0;
    for (int i = 0; i < ${MAX_SRC}; i++) {
      if (i >= uSrcCount) break;
      vec4 s = uSrc[i];
      float tau = uTime - s.z;
      if (tau <= 0.02) continue;
      float r = length(vW - s.xy);
      // Inside a metre the stationary-phase picture stops meaning anything --
      // every wavelength arrives at once and the phase runs away to infinity.
      if (r < 0.8) continue;

      // Cauchy-Poisson: the wave at (r, tau) is the one whose group velocity
      // got it here, and this is its phase.
      float ph = 9.81 * tau * tau / (4.0 * r);
      // ...and its wavelength, which is what decides whether it can be drawn.
      float lam = 8.0 * 3.14159265 * r * r / (9.81 * tau * tau);

      // Short waves alias into moire in a field texture; long ones are the
      // leading edge of the disturbance and carry almost no amplitude. Fade
      // both rather than letting either print rubbish.
      float res = smoothstep(uMinLam * 0.7, uMinLam * 1.9, lam);
      // The long end matters more than it looks. A source at speed V makes its
      // transverse waves at lam = 2 pi V^2 / g -- 41 m at eight metres a second
      // -- and anything much longer than that travels faster than the boat,
      // outruns her and carries almost no energy. Cut at a fixed 140 m it was
      // nearly DC across a 270 m field, and the debug view showed exactly that:
      // the wedge sitting on huge smooth lobes that filled the frame. Tied to
      // the wake's own wavelength they go, and the V is what is left.
      float lo  = 1.0 - smoothstep(uMaxLam, uMaxLam * 1.9, lam);

      // NYQUIST ON THE SUM ITSELF.
      //
      // This sum stands in for an integral along the track, and it only means
      // anything where neighbouring impulses are within about pi of each other
      // in phase. Past that it aliases -- and an aliased sum does not merely
      // lose the wedge, it MANUFACTURES energy off-axis, because the
      // cancellation that carves the wedge is exactly what it fails to
      // reproduce. Measured: raising the budget from 48 impulses to 96 took the
      // lit fraction from 94.7% to 96.3%, so this is not under-sampling that a
      // bigger budget fixes. The short waves would want thousands.
      //
      // So gate on the phase step instead. d(phase) between neighbours, from
      // the time between them and the distance between them, and fade out
      // where it passes pi rather than letting it print noise.
      float dphi = abs(9.81 * tau / (2.0 * r)) * uSrcDt
                 + abs(9.81 * tau * tau / (4.0 * r * r)) * uSrcStep;
      float aa = 1.0 - smoothstep(1.5, 3.14159265, dphi);
      // Cylindrical spreading: one ring's energy over an ever longer crest.
      float amp = s.w / sqrt(max(r, 1.0));
      float ageF = pow(max(1.0 - tau / max(uLife, 0.1), 0.0), 1.1);

      // NOTHING AHEAD OF THE SOURCE.
      //
      // Each impulse radiates a ring, and rings go forward as well as aft. For
      // a source in STEADY motion that forward half cancels: the ring one
      // impulse throws ahead is met by the ring the next impulse throws, and
      // what survives is the wedge astern. That cancellation needs the track to
      // be long, and ours is a few seconds of history with a hard start -- so
      // the sum ahead of the bow does not cancel, it prints the start-up
      // transient of a source that sprang into existence, as concentric rings
      // marching out in front of the boat.
      //
      // That is a truncation artifact, not a wave. Water ahead of a steadily
      // moving hull is undisturbed until the hull gets there, which is exactly
      // what makes a bow wave read as a bow wave. So each impulse is faded out
      // over the forward quarter of its own ring, using the heading the hull
      // actually had when it laid that impulse. The wedge is untouched: it
      // lives from the beam aft, and this only reaches the bow sector.
      vec2 toP = vW - s.xy;
      float fwd = dot(toP / max(r, 1e-4), uSrcDir[i]);
      float aft = mix(1.0 - smoothstep(0.0, 0.35, fwd), 1.0, uAhead);

      eta += amp * cos(ph) * res * lo * ageF * aa * aft;
    }
    // Divided by sqrt(count): a sum of many phases grows that way, so without
    // it the budget doubles as a volume knob. With it, more impulses buy
    // CLEANER cancellation off-axis -- which is the thing that carves the wedge
    // out of what would otherwise be ripple everywhere -- at the same height.
    eta /= sqrt(max(float(uSrcCount), 1.0));

    // Height only. Foam, bubbles and spray are made where the hull churned the
    // water and stay there; this is the travelling part and nothing else.
    gl_FragColor = vec4(0.0, eta * uAmp, 0.0, 0.0);
  }
`;

export class WakeField {
  constructor(renderer, size = 1024) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.camera.up.set(0, 0, -1);

    this.center = new THREE.Vector2(0, 0);
    this.extent = get('field.extent');

    // --- path history -------------------------------------------------------
    // Ring of {x, z, hx, hz, t}: bow position, unit heading, birth time.
    this.path = [];
    this.arcOf = [];   // arc length from the bow back to each sample

    this._buildGeometry();
  }

  _buildGeometry() {
    const nv = MAX_SAMPLES * (LAT_SEG + 1);
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(nv * 3);
    this.arc = new Float32Array(nv);
    this.lat = new Float32Array(nv);
    this.age = new Float32Array(nv);
    this.uu = new Float32Array(nv);
    this.tan = new Float32Array(nv * 2);
    this.spd = new Float32Array(nv);
    this.trn = new Float32Array(nv);
    this.load = new Float32Array(nv);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aArc', new THREE.BufferAttribute(this.arc, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLat', new THREE.BufferAttribute(this.lat, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aU', new THREE.BufferAttribute(this.uu, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTan', new THREE.BufferAttribute(this.tan, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSpd', new THREE.BufferAttribute(this.spd, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTurn', new THREE.BufferAttribute(this.trn, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLoad', new THREE.BufferAttribute(this.load, 1).setUsage(THREE.DynamicDrawUsage));

    const idx = new Uint32Array((MAX_SAMPLES - 1) * LAT_SEG * 6);
    let o = 0;
    for (let s = 0; s < MAX_SAMPLES - 1; s++) {
      for (let l = 0; l < LAT_SEG; l++) {
        const a = s * (LAT_SEG + 1) + l, b = a + 1;
        const c = a + (LAT_SEG + 1), d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;

    this.uniforms = {
      uMaxArc: { value: 1 }, uKelvinFade: { value: 1 },
      uIdleChurn: { value: 0.55 },
      uBubGrain: { value: 0.8 }, uBubGrainScale: { value: 1.1 },
      uFeatErode: { value: 0.7 }, uFeatErodeLen: { value: 55 },
      uBeam: { value: 1 }, uHullLen: { value: 1 }, uHullLenPhys: { value: 1 }, uSternArc: { value: 1 }, uEngines: { value: 1 }, uEngineGap: { value: 1 },
      uArmTan: { value: 0 }, uArmW0: { value: 1 }, uArmWGrow: { value: 0 },
      uArmFoam: { value: 1 }, uArmHeight: { value: 0 }, uInnerBias: { value: 0 },
      uFadeStart: { value: 1 }, uFadeLen: { value: 1 },
      uRim: { value: 0 }, uRimW: { value: 1 }, uNearBoost: { value: 0 },
      uNearLen: { value: 1 }, uCarve: { value: 0 },
      uFeatSpace: { value: 1 }, uFeatGrow: { value: 0 }, uFeatLean: { value: 0 },
      uFeatDepth: { value: 0 }, uFeatJitter: { value: 0 }, uFeatSharp: { value: 1 },
      uWashW: { value: 1 }, uWashWGrow: { value: 0 }, uWashFoam: { value: 1 },
      uWashLen: { value: 1 }, uWashTail: { value: 0 }, uWashDepth: { value: 0 },
      uCav: { value: 0 }, uCavLen: { value: 1 }, uCavW: { value: 0.2 },
      uCavGrain: { value: 3 }, uCavFoam: { value: 0.2 },
      uBubDepth: { value: 1 }, uBubRise: { value: 0.2 }, uBubExt: { value: 0.4 },
      uKelvinScale: { value: 0.5 }, uKelvinProp: { value: 1 }, uPlaning: { value: 6.5 },
      uHumpFr: { value: 0.95 }, uWetShift: { value: 0.5 },
      uFrPeak: { value: 0.5 }, uHumpFloor: { value: 0.5 },
      uBreakSteep: { value: 0.08 }, uBreakPatch: { value: 0.8 }, uBreakPatchScale: { value: 0.12 }, uWaveFoam: { value: 1 }, uFromWaves: { value: 0 }, uBeamGain: { value: 1 }, uInterf: { value: 0.5 }, uTurnBias: { value: 0.5 }, uKelvinAmp: { value: 0 }, uKelvinDiv: { value: 1 },
      uKelvinTrans: { value: 0.5 }, uKelvinCusp: { value: 1 }, uKelvinDecay: { value: 100 },
      uKelvinLife: { value: 100 }, uKelvinMin: { value: 3 },
      uFoamScale: { value: 1 }, uFoamContrast: { value: 1 }, uBreakup: { value: 0 },
      uMelt: { value: 0 }, uMeltScale: { value: 0.12 },
      uFoamLife: { value: 1 }, uDissolve: { value: 1 },
      uSpeedDrive: { value: 1 }, uSpeedRef: { value: 13 },
      uAutoAngle: { value: 1 },
      uHullCut: { value: 0 },
      uHullXZ: { value: new THREE.Vector2() },
      uHullDir: { value: new THREE.Vector2(0, 1) },
      uLace: { value: 1 }, uLaceAmt: { value: 0 }, uSoftness: { value: 0.2 },
      uBubPlume: { value: 0 }, uBubW: { value: 1 }, uBubSpread: { value: 0 },
      uBubLen: { value: 1 }, uBubArms: { value: 0 }, uBubLife: { value: 1 }, uBubMottle: { value: 0 },
      uTime: { value: 0 }, uSwirl: { value: 0 }, uBubArmsLen: { value: 1 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    // The interference pass: one quad over the whole field, additive, height
    // only. It shares the bake and the blend the ribbon already uses.
    this.iUniforms = {
      uSrc: { value: Array.from({ length: MAX_SRC }, () => new THREE.Vector4()) },
      uSrcDir: { value: Array.from({ length: MAX_SRC }, () => new THREE.Vector2(0, 1)) },
      uSrcCount: { value: 0 },
      uAhead: { value: 0 },
      uTime: { value: 0 }, uAmp: { value: 0 }, uLife: { value: 26 },
      uMinLam: { value: 1.6 }, uMaxLam: { value: 140 },
      uSrcStep: { value: 6 }, uSrcDt: { value: 1 },
    };
    const iGeo = new THREE.PlaneGeometry(1, 1);
    iGeo.rotateX(-Math.PI / 2);
    this.iMesh = new THREE.Mesh(iGeo, new THREE.ShaderMaterial({
      uniforms: this.iUniforms,
      vertexShader: INTERFERE_VERT,
      fragmentShader: INTERFERE_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    }));
    this.iMesh.frustumCulled = false;
    this.iMesh.visible = false;
    this.scene.add(this.iMesh);
  }

  /**
   * Hand the interference pass the track as a list of impulses.
   *
   * Decimated to a fixed budget and spread by ARC rather than by index, so the
   * sources stay evenly spaced along the water however the samples happen to
   * have been laid down -- and so the cost is flat whatever the boat did.
   */
  _fillSources(now) {
    const P = this.path;
    const gain = get('kelvin.interfere');
    this.iMesh.visible = gain > 0.001 && P.length >= 2;
    if (!this.iMesh.visible) return;

    const life = get('kelvin.life');
    const want = Math.min(MAX_SRC, Math.max(4, Math.round(get('kelvin.sources'))));
    // Total arc first, so the picks can be spaced along it.
    let total = 0;
    for (let i = 1; i < P.length; i++) total += Math.hypot(P[i].x - P[i-1].x, P[i].z - P[i-1].z);
    if (total < 1) { this.iMesh.visible = false; return; }

    const step = total / want;
    const arr = this.iUniforms.uSrc.value;
    let acc = 0, next = 0, n = 0;
    // NORMALISED, so the source count is a quality control and not a volume
    // control. Weighting each impulse by sqrt(step) made the total grow as the
    // square root of N -- turning the budget up made the sea bigger rather than
    // the wake cleaner. The strength is now per-impulse and the shader divides
    // by sqrt(count), which is how a sum of many phases actually grows.
    for (let i = 1; i < P.length && n < want; i++) {
      const seg = Math.hypot(P[i].x - P[i-1].x, P[i].z - P[i-1].z);
      acc += seg;
      if (acc >= next) {
        next += step;
        const p = P[i];
        // Past its life a wave contributes nothing but cost, so the impulse is
        // simply not sent. This is the ONE control on how long a wave lasts;
        // nothing else decides when it stops.
        if (now - p.t > life) continue;
        const spd = Math.max(p.speed ?? 0, 0);
        // Wave-making goes as speed squared, saturating: the same law the rest
        // of the wake obeys, so the two agree about which speed is expensive.
        const e2 = (spd / 7) * (spd / 7);
        arr[n].set(p.x, p.z, p.t, e2 * 2 / (1 + e2));
        // The heading she had when this impulse was laid -- what the forward
        // fade in the shader needs. Taken from the sample rather than from the
        // current hull, so a turn does not swing every past ring with it.
        this.iUniforms.uSrcDir.value[n].set(p.hx ?? 0, p.hz ?? 1);
        n++;
      }
    }
    this.iUniforms.uSrcCount.value = n;
    // What the anti-alias gate needs: how far apart the impulses are on the
    // water, and how far apart in time. Even spacing by arc makes both close to
    // constant, so a scalar is honest enough for a Nyquist test.
    this.iUniforms.uSrcStep.value = step;
    this.iUniforms.uSrcDt.value = step / Math.max(P[0]?.speed ?? 1, 0.5);
    this.iUniforms.uTime.value = now;
    this.iUniforms.uAhead.value = get('kelvin.ahead');
    this.iUniforms.uAmp.value = gain * get('kelvin.amp');
    this.iUniforms.uLife.value = get('kelvin.life');
    // THE SHORT END IS A LOOK, not just a resolution limit.
    //
    // This was derived from the field texture's own resolution -- about 0.84 m
    // -- on the assumption that anything the texture could hold was worth
    // drawing. The mesh can carry those: at ten metres from the eye the grid
    // spacing is 0.29 m, so a 2.6 m wave gets nearly nine vertices and
    // genuinely displaces. The trouble is there are so MANY of them. Near the
    // boat the sum is dominated by half-metre to three-metre waves, and a dense
    // comb of tiny crests reads as a fan of drawn white lines rather than as
    // water moving, with the big rolling waves buried underneath.
    //
    // So the floor is a control. Raise it and the fine comb goes, leaving the
    // long waves that actually distort the surface; drop it for the full
    // spectrum with all its detail.
    this.iUniforms.uMinLam.value = Math.max(get('kelvin.minWave'),
      this.extent / this.rt.width * 3.2, 0.6);
    // The transverse wavelength of the fastest water in the trail: the longest
    // wave this hull can actually have made.
    let vMax = 0;
    for (let i = 1; i < P.length; i++) vMax = Math.max(vMax, P[i].speed ?? 0);
    this.iUniforms.uMaxLam.value = Math.max(6.2831853 * vMax * vMax / 9.81, 4);
    const c = this.center;
    this.iMesh.position.set(c.x, 0, c.y);
    this.iMesh.scale.set(this.extent, 1, this.extent);
  }

  /**
   * Where the hull really is: the bow in world XZ and the way it POINTS.
   *
   * Separate from pushSample because the two are genuinely different things --
   * the sample records the track the water was swept along, this records the
   * boat. They coincide only when the hull is not crabbing.
   */
  setHull( x, z, heading ) {
    this.uniforms.uHullXZ.value.set( x, z );
    this.uniforms.uHullDir.value.set( Math.sin( heading ), Math.cos( heading ) );
  }

  /** Record where the bow is now. Called every frame; samples are decimated. */
  pushSample(x, z, hx, hz, t, speed = 0, turn = 0, load = 0) {
    const last = this.path[0];
    if (last) {
      const dx = x - last.x, dz = z - last.z;
      if (dx * dx + dz * dz < STEP * STEP) { this.head = { x, z, hx, hz, t, speed, turn, load }; return; }
    }
    this.path.unshift({ x, z, hx, hz, t, speed, turn, load });
    this.head = null;
    const maxArc = get('field.trailLength');
    // Trim to the requested trail length.
    let arc = 0;
    for (let i = 1; i < this.path.length; i++) {
      const a = this.path[i - 1], b = this.path[i];
      arc += Math.hypot(b.x - a.x, b.z - a.z);
      if (arc > maxArc || i >= MAX_SAMPLES - 2) { this.path.length = i + 1; break; }
    }
  }

  /** Rebuild the ribbon from the path and re-bake the field texture. */
  update(now) {
    const P = this.path;
    if (P.length < 2) {
      // A boat that has not moved yet has no ribbon to draw -- but bailing
      // out here left the field texture at whatever the driver handed us,
      // and the sea reads that as coverage. On a fresh page that painted a
      // flat pale DISC the size of the whole field around a stationary
      // boat, which cleared the moment it moved far enough to lay a second
      // sample and the bake started running. Clear it once and stay clear.
      if (!this._cleared) { this._blank(); this._cleared = true; }
      return;
    }
    this._cleared = false;

    // Head sample keeps the ribbon's tip glued to the bow between decimated
    // samples, so the wake doesn't visibly stutter at the boat.
    const pts = this.head ? [this.head, ...P] : P;
    const n = Math.min(pts.length, MAX_SAMPLES);

    const armTan = Math.tan(get('arms.angle') * Math.PI / 180);
    const kProp = get('kelvin.propagate');
    // The DRAWN beam, for the same reason as the drawn length: the ribbon is
    // laid out either side of the track in metres, and at Model scale 3.85 an
    // unscaled beam builds a V a quarter as wide as the boat it comes off.
    const beam = get('boat.beam') * Math.max(get('boat.modelScale'), 0.05);
    const w0 = get('arms.width0'), wg = get('arms.widthGrow');

    let arc = 0;
    let o = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i > 0) arc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);

      // Lateral axis: perpendicular to the local path tangent.
      const q = pts[Math.min(i + 1, n - 1)], r = pts[Math.max(i - 1, 0)];
      let tx = r.x - q.x, tz = r.z - q.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;

      // Half-width: enough for the arms plus their falloff -- and for the
      // Kelvin wedge, which is wider than the arms at 19.47 degrees. Clipping
      // the ribbon narrower than the wedge would cut the divergent waves off
      // along a straight line.
      const KELVIN_TAN = 0.35355;   // tan(19.47 degrees) = 1 / (2 * sqrt 2)
      const age = now - p.t;
      // THE CANVAS HAS TO GROW WITH THE WEDGE IT CARRIES.
      //
      // The pattern's anchor is mix(arc, spd*age, propagate) -- emission speed
      // times age, so waves already on the water carry on after the boat slows.
      // The mesh width was still being taken from arc alone, which stops the
      // moment she does. At constant speed the two are the same number and
      // nothing changes; after a stop they part, and the wedge goes on widening
      // inside a ribbon that does not. Measured against an 8 m/s wake, four
      // seconds after stopping the pattern wants 28 m of half-width and the
      // ribbon offers 17 -- so two fifths of the wave was being cut off along a
      // straight line, which is the comment above describing its own bug.
      const uK = Math.max(arc, (p.speed ?? 0) * age * kProp);
      const halfW = Math.max(
        beam * 0.5 + arc * armTan + (w0 + arc * wg) * 3.2 + 1.5,
        beam * 0.5 + uK * KELVIN_TAN * 1.06 + 2.0,
      );

      for (let l = 0; l <= LAT_SEG; l++) {
        const u = (l / LAT_SEG) * 2 - 1;
        const d = u * halfW;
        const vi = o + l;
        this.pos[vi * 3] = p.x + nx * d;
        this.pos[vi * 3 + 1] = 0;
        this.pos[vi * 3 + 2] = p.z + nz * d;
        this.arc[vi] = arc;
        this.lat[vi] = d;
        this.age[vi] = age;
        this.uu[vi] = u;
        this.tan[vi * 2] = tx;
        this.tan[vi * 2 + 1] = tz;
        this.spd[vi] = p.speed || 0;
        this.trn[vi] = p.turn || 0;
        this.load[vi] = p.load || 0;
      }
      o += LAT_SEG + 1;
    }

    const g = this.geometry;
    // EVERY attribute, and a new one has to be added here as well as declared
    // and filled. aLoad was declared, allocated, written per vertex and bound to
    // the geometry -- and left out of this list, so it never uploaded and the
    // GPU read zeros for it forever. Cavitation multiplies by that load, so the
    // term evaluated to nothing at every slider setting, and the field measured
    // bit-identical with it on and off.
    for (const name of ['position', 'aArc', 'aLat', 'aAge', 'aU', 'aTan', 'aSpd', 'aTurn', 'aLoad']) {
      const n = name === 'position' ? o * 3 : name === 'aTan' ? o * 2 : o;
      g.getAttribute(name).addUpdateRange(0, n);
      g.getAttribute(name).needsUpdate = true;
    }
    this.maxArc = arc;
    g.setDrawRange(0, (n - 1) * LAT_SEG * 6);

    this._syncUniforms();
    this.uniforms.uTime.value = now;
    this._fillSources(now);
    this._bake();
  }

  _syncUniforms() {
    const u = this.uniforms;
    // Everything that decides how long the wake lasts -- in seconds and in
    // metres -- passes through one multiplier.
    const decay = Math.max(get('field.decay'), 0.05);
    u.uMaxArc.value = Math.max(this.maxArc || 1, 1);
    u.uIdleChurn.value = get('wash.idle');
    u.uFeatErode.value = get('feather.breakup');
    u.uFeatErodeLen.value = get('feather.breakupLen');
    u.uBubGrain.value = get('bubbles.grain');
    u.uBubGrainScale.value = 1 / Math.max(get('bubbles.grainSize'), 0.05);
    u.uBeam.value = get('boat.beam') * Math.max(get('boat.modelScale'), 0.05);
    u.uHullCut.value = get('boat.hullCut');
    // Drawn for the geometry, tuned for the physics -- and the transom taken
    // from whatever the caller measured off the model, falling back to the
    // drawn length for callers that do not measure.
    const drawnL = get('boat.length') * Math.max(get('boat.modelScale'), 0.05);
    u.uHullLen.value = drawnL;
    u.uHullLenPhys.value = get('boat.length');
    u.uSternArc.value = this.sternArc > 0 ? this.sternArc : drawnL;
    u.uEngines.value = Math.round(get('boat.engines'));
    u.uEngineGap.value = get('boat.engineSpacing');
    u.uArmTan.value = Math.tan(get('arms.angle') * Math.PI / 180);
    u.uAutoAngle.value = get('arms.autoAngle');
    u.uArmW0.value = get('arms.width0');
    u.uArmWGrow.value = get('arms.widthGrow');
    u.uArmFoam.value = get('arms.foam');
    u.uArmHeight.value = get('arms.height');
    u.uInnerBias.value = get('arms.innerBias');
    u.uFadeStart.value = get('arms.fadeStart') / decay;
    u.uFadeLen.value = get('arms.fadeLength') / decay;
    u.uRim.value = get('arms.rim');
    u.uRimW.value = get('arms.rimWidth');
    u.uNearBoost.value = get('arms.nearBoost');
    u.uNearLen.value = get('arms.nearLength');
    u.uCarve.value = get('feather.carve');
    u.uFeatSpace.value = get('feather.spacing');
    u.uFeatGrow.value = get('feather.spacingGrow');
    u.uFeatLean.value = get('feather.lean');
    u.uFeatDepth.value = get('feather.depth');
    u.uFeatJitter.value = get('feather.jitter');
    u.uFeatSharp.value = get('feather.sharpness');
    u.uWashW.value = get('wash.width');
    u.uWashWGrow.value = get('wash.widthGrow');
    u.uWashFoam.value = get('wash.foam');
    u.uWashLen.value = get('wash.length') / decay;
    u.uWashTail.value = get('wash.tailFoam');
    u.uCav.value = get('wash.cav');
    // Metres, and short. The falloff is squared in the shader, so this is the
    // e-folding of an already sharp curve -- at 1.2 m there is essentially
    // nothing left three metres astern, which is what the footage shows.
    u.uCavLen.value = get('wash.cavLen');
    u.uCavW.value = get('wash.cavWidth');
    u.uCavGrain.value = get('wash.cavGrain');
    u.uCavFoam.value = get('wash.cavFoam');
    u.uWashDepth.value = get('wash.depth');
    u.uBubDepth.value = get('bubbles.depth');
    u.uBubRise.value = get('bubbles.rise');
    u.uBubExt.value = get('bubbles.extinction');
    // k0 = g / V^2 is the actual deep-water wavenumber for this speed; the
    // scale slider stretches it because the hull size here is a stand-in.
    u.uKelvinScale.value = Math.max(get('kelvin.waveScale'), 0.05);
    u.uKelvinProp.value = get('kelvin.propagate');
    // CROSSFADE, not both at once. The analytic pattern and the interference
    // sum draw the same wedge by different means, so running them together
    // prints it twice and the two beat against each other. Turning the
    // interference up hands the wave-making over to it.
    u.uKelvinFade.value = 1 - Math.min(1, get('kelvin.interfere'));
    u.uFrPeak.value = get('kelvin.froudePeak');
    u.uHumpFloor.value = get('kelvin.humpFloor');
    u.uBreakSteep.value = get('kelvin.breakSteep');
    u.uBreakPatch.value = get('kelvin.breakPatch');
    u.uBreakPatchScale.value = 1 / Math.max(get('kelvin.breakPatchLen'), 0.5);
    u.uWaveFoam.value = get('arms.waveFoam');
    u.uFromWaves.value = get('arms.fromWaves');
    u.uBeamGain.value = get('kelvin.beamGain');
    u.uInterf.value = get('kelvin.interference');
    u.uTurnBias.value = get('kelvin.turnBias');
    u.uPlaning.value = get('boat.planing');
    u.uHumpFr.value = get('boat.humpFroude');
    u.uWetShift.value = get('boat.wetShift');
    u.uKelvinAmp.value = get('kelvin.amp');
    u.uKelvinDiv.value = get('kelvin.divergent');
    u.uKelvinTrans.value = get('kelvin.transverse');
    u.uKelvinCusp.value = get('kelvin.cusp');
    u.uKelvinDecay.value = get('kelvin.decay') / decay;
    u.uKelvinLife.value = get('kelvin.life') / decay;
    u.uKelvinMin.value = get('kelvin.minWave');
    u.uFoamScale.value = get('foamLook.scale') * 0.35;
    u.uFoamContrast.value = get('foamLook.contrast');
    u.uMelt.value = get('foamLook.melt');
    u.uMeltScale.value = get('foamLook.meltScale');
    u.uBreakup.value = get('foamLook.breakup');
    u.uFoamLife.value = get('foamLook.life') / decay;
    u.uSpeedDrive.value = get('field.speedDrive');
    u.uSpeedRef.value = get('field.speedRef');
    u.uDissolve.value = get('foamLook.dissolve');
    u.uLace.value = get('foamLook.lace');
    u.uLaceAmt.value = get('foamLook.laceAmount');
    u.uSoftness.value = get('foamLook.softness');
    u.uBubPlume.value = get('bubbles.plume');
    u.uBubW.value = get('bubbles.width');
    u.uBubSpread.value = get('bubbles.spread');
    u.uBubLen.value = get('bubbles.length') / decay;
    u.uBubArms.value = get('bubbles.fromArms');
    u.uBubLife.value = get('bubbles.life') / decay;
    u.uBubMottle.value = get('bubbles.mottle');
    u.uSwirl.value = get('foamMotion.plumeSwirl');
    u.uBubArmsLen.value = get('bubbles.armsLength') / decay;
  }

  /**
   * A point `d` metres back along the path the boat actually took.
   *
   * Not the same as "d metres astern along the current course": in a hard
   * turn the two are far apart, and it is the PATH that says where the wake
   * is. Returns null before there is any path to walk.
   */
  backAlongPath( d ) {
    const P = this.path;
    if ( ! P.length ) return null;
    let arc = 0;
    for ( let i = 1; i < P.length; i ++ ) {
      const a = P[ i - 1 ], b = P[ i ];
      const seg = Math.hypot( b.x - a.x, b.z - a.z );
      if ( arc + seg >= d ) {
        const t = seg > 1e-5 ? ( d - arc ) / seg : 0;
        return { x: a.x + ( b.x - a.x ) * t, z: a.z + ( b.z - a.z ) * t };
      }
      arc += seg;
    }
    const last = P[ P.length - 1 ];
    return { x: last.x, z: last.z };
  }

  /** Point the field at a world position (snapped, so the texture doesn't crawl). */
  focus(x, z, extent) {
    this.extent = extent || get('field.extent');
    const snap = this.extent / this.rt.width * 4;
    this.center.set(Math.round(x / snap) * snap, Math.round(z / snap) * snap);
    const h = this.extent * 0.5;
    const c = this.camera;
    c.left = -h; c.right = h; c.top = h; c.bottom = -h;
    c.position.set(this.center.x, 120, this.center.y);
    c.lookAt(this.center.x, 0, this.center.y);
    c.updateProjectionMatrix();
  }

  /** Wipe the field to nothing: no foam, no height, no bubbles anywhere. */
  _blank() {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setRenderTarget(prevTarget);
  }

  _bake() {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
  }
}
