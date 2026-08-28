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
  varying float vArc; varying float vLat; varying float vAge; varying float vU;
  varying vec2 vWorld; varying vec2 vTan; varying float vSpd; varying float vTurn;
  void main(){
    vArc = aArc; vLat = aLat; vAge = aAge; vU = aU; vTan = aTan; vSpd = aSpd; vTurn = aTurn;
    vWorld = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIBBON_FRAG = /* glsl */`
  precision highp float;
  varying float vArc; varying float vLat; varying float vAge; varying float vU;
  varying vec2 vWorld; varying vec2 vTan; varying float vSpd; varying float vTurn;

  uniform float uMaxArc, uPlaning, uHumpFr, uWetShift;
  uniform float uOverAmp, uOverV, uOverLen, uOverWide;
  uniform float uIdleChurn;
  uniform float uBeam, uHullLen, uEngines, uEngineGap;
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
  uniform float uFrPeak, uHumpFloor, uBeamGain, uInterf, uTurnBias;
  uniform float uBreakSteep, uWaveFoam, uFromWaves;
  uniform float uKelvinScale, uKelvinProp, uKelvinAmp, uKelvinDiv, uKelvinTrans, uKelvinCusp, uKelvinDecay, uKelvinLife, uKelvinMin;
  uniform float uFoamScale, uFoamContrast, uBreakup, uFoamLife, uDissolve;
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
    float frS = spd / sqrt(9.81 * max(uHullLen, 0.5));
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
    float jit = (fbm(vWorld * 0.09) - 0.5) * uFeatJitter;
    float phase = (arc + (ad - armC) * uFeatLean) / sp + jit;
    float f = pow(0.5 + 0.5 * sin(6.28318 * phase), uFeatSharp);
    float inner = smoothstep(0.25, -1.30, x);          // 0 outboard, 1 inboard
    float comb = mix(1.0, f, uFeatDepth * inner);

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
    float astern = smoothstep(uHullLen * 0.55, uHullLen * 1.05, arc);
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
      float Fr = kv / sqrt(9.81 * max(uHullLen, 0.5));
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
      float interf = mix(1.0, abs(cos(k0 * uHullLen * 0.5)) * 1.6, uInterf);

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
    }

    // ------------------------------------------------------------ foam look --
    // Two textures, both locked to the water rather than to the boat:
    //  · a reticulated bubble raft (open cells with bright walls), and
    //  · streaks stretched along the direction the water was thrown, which is
    //    the local path tangent frozen in at birth.
    vec2 nrm = vec2(-vTan.y, vTan.x);
    vec2 flow = vec2(dot(vWorld, vTan), dot(vWorld, nrm));
    float raft   = lattice(vWorld * uFoamScale, 0.13);
    float streak = fbm(flow * uFoamScale * vec2(0.40, 2.4));
    float blob   = fbm(vWorld * uFoamScale * 0.55);

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
    float plumeIdle = astern * bg * uBubPlume * exp(-arc / bubReach)
                    * uIdleChurn * propOn * 0.9;

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

    float bubAge = clamp(age / max(uBubLife * lifeK, 0.01), 0.0, 1.0);
    // The same speed law the foam obeys, for the same reason -- and one more:
    // without it an IDLE boat kept injecting plume into the same spot, and
    // forty-four seconds of accumulated milk drew a pale disc a hundred
    // metres wide around every parked hull.
    float bub = ((plume + entrain) * energy + plumeIdle) * pow(1.0 - bubAge, 1.15) * vis;
    // The plume is the most turbulent part of the wake, so its clouds churn
    // rather than sitting still. Circling sample offsets again: the cloud
    // evolves in place instead of drifting off the water it belongs to.
    vec2 sw1 = vec2(cos(uTime * 0.31), sin(uTime * 0.31)) * uSwirl * 1.3;
    vec2 sw2 = vec2(cos(uTime * -0.19 + 2.1), sin(uTime * -0.19 + 2.1)) * uSwirl * 0.8;
    float cloud = fbm(vWorld * uFoamScale * 0.55 + sw1) * 0.65
                + fbm(vWorld * uFoamScale * 1.45 + sw2) * 0.45;
    bub *= mix(1.0, 0.18 + 1.55 * cloud, uBubMottle);

    // The oldest end of the trail is a mesh boundary, not a physical edge.
    float tailFade = 1.0 - smoothstep(uMaxArc - min(70.0, uMaxArc * 0.3), uMaxArc, arc);
    foam *= tailFade;

    // Foam decay applies to the foam-borne crests only. The gravity waves carry
    // their own, much longer, life -- outliving the white is the whole point of
    // them.
    // AHEAD OF THE BOW: the train that has overtaken a slowing hull.
    //
    // Only the gravity waves do this. Foam and spray are made of water that was
    // churned at a place and stays there; the waves are a travelling
    // disturbance and keep travelling. Crests run forward at the celerity that
    // built them, which for deep water is omega = g/c, so they visibly outpace
    // a stopping boat and stream away in front of it.
    float overH = 0.0;
    float ahead = max(-vArc, 0.0);
    if (ahead > 0.0 && uOverAmp > 0.0001) {
      float c = max(uOverV, 0.6);
      float lam = max(6.2831853 * c * c / 9.81, 1.5);
      float w = 9.81 / c;
      // Widest on the centreline, gone by the edge of the wedge it came from.
      float lat = 1.0 - smoothstep(0.0, max(uOverWide, 1.0), ad);
      overH = cos(6.2831853 * ahead / lam - w * uTime)
            * uOverAmp * exp(-ahead / max(uOverLen, 1.0)) * lat * lat;
    }

    float height  = ((armH + washH) * mix(0.35, 1.0, alive) + kelvinH * nose) * tailFade
                  + overH;
    float bubOut = max(bub, 0.0) * tailFade;

    gl_FragColor = vec4(foam * edge,
                        height * edge,
                        bubOut * surfaced * edge,
                        bubOut * edge);
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
  uniform int   uSrcCount;
  uniform float uTime, uAmp, uLife, uMinLam, uMaxLam;

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
      float lo  = 1.0 - smoothstep(uMaxLam * 0.7, uMaxLam * 1.8, lam);
      // Cylindrical spreading: one ring's energy over an ever longer crest.
      float amp = s.w / sqrt(max(r, 1.0));
      float ageF = pow(max(1.0 - tau / max(uLife, 0.1), 0.0), 1.1);

      eta += amp * cos(ph) * res * lo * ageF;
    }
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
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aArc', new THREE.BufferAttribute(this.arc, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLat', new THREE.BufferAttribute(this.lat, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aU', new THREE.BufferAttribute(this.uu, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTan', new THREE.BufferAttribute(this.tan, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSpd', new THREE.BufferAttribute(this.spd, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTurn', new THREE.BufferAttribute(this.trn, 1).setUsage(THREE.DynamicDrawUsage));

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
      uMaxArc: { value: 1 },
      uOverAmp: { value: 0 }, uOverV: { value: 4 },
      uOverLen: { value: 26 }, uOverWide: { value: 10 },
      uIdleChurn: { value: 0.55 },
      uBeam: { value: 1 }, uHullLen: { value: 1 }, uEngines: { value: 1 }, uEngineGap: { value: 1 },
      uArmTan: { value: 0 }, uArmW0: { value: 1 }, uArmWGrow: { value: 0 },
      uArmFoam: { value: 1 }, uArmHeight: { value: 0 }, uInnerBias: { value: 0 },
      uFadeStart: { value: 1 }, uFadeLen: { value: 1 },
      uRim: { value: 0 }, uRimW: { value: 1 }, uNearBoost: { value: 0 },
      uNearLen: { value: 1 }, uCarve: { value: 0 },
      uFeatSpace: { value: 1 }, uFeatGrow: { value: 0 }, uFeatLean: { value: 0 },
      uFeatDepth: { value: 0 }, uFeatJitter: { value: 0 }, uFeatSharp: { value: 1 },
      uWashW: { value: 1 }, uWashWGrow: { value: 0 }, uWashFoam: { value: 1 },
      uWashLen: { value: 1 }, uWashTail: { value: 0 }, uWashDepth: { value: 0 },
      uBubDepth: { value: 1 }, uBubRise: { value: 0.2 }, uBubExt: { value: 0.4 },
      uKelvinScale: { value: 0.5 }, uKelvinProp: { value: 1 }, uPlaning: { value: 6.5 },
      uHumpFr: { value: 0.95 }, uWetShift: { value: 0.5 },
      uFrPeak: { value: 0.5 }, uHumpFloor: { value: 0.5 },
      uBreakSteep: { value: 0.08 }, uWaveFoam: { value: 1 }, uFromWaves: { value: 0 }, uBeamGain: { value: 1 }, uInterf: { value: 0.5 }, uTurnBias: { value: 0.5 }, uKelvinAmp: { value: 0 }, uKelvinDiv: { value: 1 },
      uKelvinTrans: { value: 0.5 }, uKelvinCusp: { value: 1 }, uKelvinDecay: { value: 100 },
      uKelvinLife: { value: 100 }, uKelvinMin: { value: 3 },
      uFoamScale: { value: 1 }, uFoamContrast: { value: 1 }, uBreakup: { value: 0 },
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
      uSrcCount: { value: 0 },
      uTime: { value: 0 }, uAmp: { value: 0 }, uLife: { value: 26 },
      uMinLam: { value: 1.6 }, uMaxLam: { value: 140 },
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

    const want = Math.min(MAX_SRC, Math.max(4, Math.round(get('kelvin.sources'))));
    // Total arc first, so the picks can be spaced along it.
    let total = 0;
    for (let i = 1; i < P.length; i++) total += Math.hypot(P[i].x - P[i-1].x, P[i].z - P[i-1].z);
    if (total < 1) { this.iMesh.visible = false; return; }

    const step = total / want;
    const arr = this.iUniforms.uSrc.value;
    let acc = 0, next = 0, n = 0;
    // Each impulse stands for the stretch of track it was picked from, so a
    // sparser sampling does not quietly make a smaller wake.
    const share = Math.sqrt(step);
    for (let i = 1; i < P.length && n < want; i++) {
      const seg = Math.hypot(P[i].x - P[i-1].x, P[i].z - P[i-1].z);
      acc += seg;
      if (acc >= next) {
        next += step;
        const p = P[i];
        const spd = Math.max(p.speed ?? 0, 0);
        // Wave-making goes as speed squared, saturating: the same law the rest
        // of the wake obeys, so the two agree about which speed is expensive.
        const e2 = (spd / 7) * (spd / 7);
        arr[n].set(p.x, p.z, p.t, e2 * 2 / (1 + e2) * share);
        n++;
      }
    }
    this.iUniforms.uSrcCount.value = n;
    this.iUniforms.uTime.value = now;
    this.iUniforms.uAmp.value = gain * get('kelvin.amp');
    this.iUniforms.uLife.value = get('kelvin.life');
    this.iUniforms.uMinLam.value = Math.max(this.extent / this.rt.width * 3.2, 0.6);
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

  /**
   * How far the wave train has run out AHEAD of the bow.
   *
   * The transverse waves in a Kelvin wake travel at the speed that built them
   * -- that is exactly why they sit still relative to a boat holding its speed,
   * and why the pattern looks pinned to the hull. Take the way off her and they
   * do not stop with her: they carry on at their own celerity, overtake the
   * hull and run out in front of it before they disperse. Nothing in a ribbon
   * indexed by distance ASTERN can express that, which is why the waves used to
   * pile up at the bow and stop dead there.
   *
   * So: integrate how much faster the waves are than the boat. The speed that
   * made them rises with the throttle at once and falls slowly, because the
   * water already carries what it was given.
   */
  _advanceRunout(t, speed) {
    const dt = Math.max(0, Math.min(0.1, t - (this._lastT ?? t)));
    this._lastT = t;
    if (!dt) return;
    this._madeV = Math.max(speed, (this._madeV ?? 0) - dt * 1.1);
    const gain = Math.max(0, this._madeV - speed);
    // And they disperse: a train left behind spreads and dies rather than
    // running on for ever, so the runout bleeds away on its own clock.
    const life = 3.2;
    const r = (this._runout ?? 0) + gain * dt;
    this._runout = Math.max(0, Math.min(r - r * dt / life, 70));
  }

  /** Record where the bow is now. Called every frame; samples are decimated. */
  pushSample(x, z, hx, hz, t, speed = 0, turn = 0) {
    this._advanceRunout(t, speed);
    const last = this.path[0];
    if (last) {
      const dx = x - last.x, dz = z - last.z;
      if (dx * dx + dz * dz < STEP * STEP) { this.head = { x, z, hx, hz, t, speed, turn }; return; }
    }
    this.path.unshift({ x, z, hx, hz, t, speed, turn });
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
    // Mesh AHEAD of the bow for the overtaking train. Laid along the current
    // heading, and carrying negative arc so the bow stays at arc = 0 and every
    // astern term downstream is untouched.
    const bow = this.head ?? P[0];
    const over = get('kelvin.overtake') > 0.001 ? (this._runout ?? 0) : 0;
    const fwd = [];
    if (over > 0.5 && bow) {
      const nF = Math.min(20, Math.max(2, Math.ceil(over / 4)));
      for (let k = nF; k >= 1; k--) {
        const dd = over * (k / nF);
        fwd.push({ x: bow.x + bow.hx * dd, z: bow.z + bow.hz * dd,
          hx: bow.hx, hz: bow.hz, t: bow.t, speed: bow.speed, turn: 0 });
      }
    }
    const pts = fwd.concat(this.head ? [this.head, ...P] : P);
    const n = Math.min(pts.length, MAX_SAMPLES);

    const armTan = Math.tan(get('arms.angle') * Math.PI / 180);
    const kProp = get('kelvin.propagate');
    const beam = get('boat.beam');
    const w0 = get('arms.width0'), wg = get('arms.widthGrow');

    let arc = -over * (fwd.length ? 1 : 0);
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
      }
      o += LAT_SEG + 1;
    }

    const g = this.geometry;
    for (const name of ['position', 'aArc', 'aLat', 'aAge', 'aU', 'aTan', 'aSpd', 'aTurn']) {
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
    // The overtaking train. Amplitude ramps in with the runout rather than
    // appearing whole: the waves only separate from the boat as it slows, and
    // the runout IS how far they have got.
    const run = this._runout ?? 0;
    u.uOverV.value = Math.max(this._madeV ?? 0, 0.6);
    // Tied to the TRANSVERSE train, because that is literally what overtakes:
    // the divergent waves fan away astern and never catch the boat up. (An
    // earlier version read kelvin.height, which does not exist -- undefined
    // through this arithmetic is NaN, and a NaN in the height channel poisons
    // every pixel it touches rather than merely looking wrong.)
    const amp = get('kelvin.amp') * get('kelvin.transverse') * get('kelvin.overtake');
    u.uOverAmp.value = Number.isFinite(amp) ? amp * Math.min(1, run / 9) * 1.3 : 0;
    u.uOverLen.value = get('kelvin.overtakeLen');
    u.uIdleChurn.value = get('wash.idle');
    u.uOverWide.value = Math.max(get('boat.beam') * 2.4, 6);
    u.uBeam.value = get('boat.beam');
    u.uHullCut.value = get('boat.hullCut');
    u.uHullLen.value = get('boat.length');
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
    u.uWashDepth.value = get('wash.depth');
    u.uBubDepth.value = get('bubbles.depth');
    u.uBubRise.value = get('bubbles.rise');
    u.uBubExt.value = get('bubbles.extinction');
    // k0 = g / V^2 is the actual deep-water wavenumber for this speed; the
    // scale slider stretches it because the hull size here is a stand-in.
    u.uKelvinScale.value = Math.max(get('kelvin.waveScale'), 0.05);
    u.uKelvinProp.value = get('kelvin.propagate');
    u.uFrPeak.value = get('kelvin.froudePeak');
    u.uHumpFloor.value = get('kelvin.humpFloor');
    u.uBreakSteep.value = get('kelvin.breakSteep');
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
