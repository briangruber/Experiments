// GPU spray, spindrift and sea mist.
//
// Particles live entirely in two float textures. Emission samples the ocean's
// own folding term, so droplets only ever leave genuinely breaking water, and
// the whole system is gated on U10: a force-3 sea makes almost nothing, a
// hurricane fills the air.
//
// Only pos.w (life remaining, seconds) and vel.w (birth energy) are stored per
// particle. Class (droplet vs mist), total lifetime, size and the particle's
// place along its tear-off sheet are pure functions of the particle index, so
// the draw pass can recover them without spending a channel on each - see
// SPRAY_PARTICLE_GLSL, which both stages include.

import { NOISE_GLSL, ATMOSPHERE_GLSL, SKY_LUT_MAP_GLSL } from './sky.js';

const SAMPLE_OCEAN = /* glsl */`
uniform sampler2DArray uDisp, uFoam;
uniform float uPatch[4];
uniform int uCascadeCount;

// The FFT fields are indexed by the undisplaced (Lagrangian) coordinate, but a
// particle lives at a world point, and choppiness moves the surface several
// metres horizontally on a storm sea. Feeding a world coordinate straight into
// the lookup therefore reports the height of whatever water happens to share the
// crest's label - which in a big sea is often metres above the particle, so
// every droplet drowned on the frame it was born and force 10 produced no spray
// at all. Two fixed-point iterations invert the mapping to well inside a
// billboard's width.
vec2 dispXZ(vec2 q){
  vec2 d = vec2(0.0);
  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    d += textureLod(uDisp, vec3(q/uPatch[c], float(c)), 0.0).xz;
  }
  return d;
}

vec2 toLagrange(vec2 world){
  vec2 q = world - dispXZ(world);
  return world - dispXZ(q);
}

float heightAt(vec2 q){
  float h = 0.0;
  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    h += textureLod(uDisp, vec3(q/uPatch[c], float(c)), 0.0).y;
  }
  return h;
}

float oceanHeight(vec2 world){ return heightAt(toLagrange(world)); }

// x: height, y: fresh whitecap fraction (water tumbling this instant),
// z: total whitecap fraction (tumbling plus the raft it leaves behind).
//
// The foam pass already answers "is this crest breaking" properly - crest-line
// averaging, a ridge test across the crest, a forward-face gate and a threshold
// expressed in units of the sea's own RMS compression. Re-deriving that here
// from a raw single-texel Jacobian was the reason spray came off large stretches
// of merely steep water instead of off breakers, so the emission now reads the
// foam pass's own answer. Channel y is the dense crest foam that exists only
// while the water is actually tumbling; x includes the long-lived raft.
// q is a Lagrangian coordinate; dxz returns the horizontal displacement so the
// caller can place the particle at the world point that label lands on.
vec3 oceanAt(vec2 q, out vec2 dxz){
  float h = 0.0, fresh = 0.0, tot = 0.0;
  dxz = vec2(0.0);
  for (int c=0;c<4;c++){
    if (c >= uCascadeCount) break;
    vec3 uvc = vec3(q/uPatch[c], float(c));
    // Explicit LOD: spawn sites are random per fragment, so the implicit
    // derivatives would pick a near-top mip where every crest has averaged away.
    vec4 d = textureLod(uDisp, uvc, 0.0);
    h += d.y; dxz += d.xz;
    vec4 f = textureLod(uFoam, uvc, 0.0);
    fresh += f.y;
    tot   += f.x;
  }
  return vec3(h, fresh, tot);
}
`;

// Per-particle constants derived from the index alone. Shared verbatim by the
// simulation and the draw pass so both agree without a round trip through the
// state textures.
const SPRAY_PARTICLE_GLSL = /* glsl */`
uniform float uMistFrac, uLifetime, uMistLifetime;
uniform float uSizeMin, uSizeMax, uMistSize, uSheetSize, uMistRadius;

float sprayIsMist(float id){ return step(hash11(id*0.01571 + 0.317), uMistFrac); }

// Droplets are a near-field effect - past a hundred metres or so they are
// sub-pixel and carry nothing. The suspended veil is the opposite: it is what
// the middle distance is made of, so it works over a much larger disc.
float sprayReach(float id, float radius){ return radius * mix(1.0, max(uMistRadius,1.0), sprayIsMist(id)); }

// Where this particle sits along its tear-off sheet: 0 is the leading edge that
// the wind rips off first, 1 the trailing tail that shreds into fine droplets.
// A block of consecutive ids therefore spans one whole sheet, which is what
// turns a burst into something with a front and a wake instead of a fountain.
float sprayShred(float id){ return fract(id / max(uSheetSize, 1.0)); }

float sprayLifeTotal(float id){
  float r = hash11(id*0.02311 + 7.13);
  // The leading sheet is heavy water and falls back quickly; the shredded tail
  // is what stays airborne and streams downwind.
  float u = sprayShred(id);
  return mix(uLifetime * (0.30 + 1.10*r) * (0.55 + 0.85*u),
             uMistLifetime * (0.45 + 1.20*r), sprayIsMist(id));
}

// Spray is overwhelmingly small droplets with a thin tail of big ones, so the
// uniform sample is cubed rather than used straight. The leading edge of a
// sheet is still coherent water, so it carries the large parcels.
float sprayRadius(float id){
  float r = hash11(id*0.04173 + 3.77);
  float u = sprayShred(id);
  float drop = mix(uSizeMin, uSizeMax, r*r*r) * (0.55 + 0.75*(1.0-u)*(1.0-u));
  return mix(drop, uMistSize * (0.4 + 1.5*r), sprayIsMist(id));
}
`;

export const SPRAY_SIM_FS = /* glsl */`
${NOISE_GLSL}
${SAMPLE_OCEAN}
${SPRAY_PARTICLE_GLSL}
in vec2 vUv;
uniform sampler2D uPos, uVel;
uniform vec3  uCamPos, uWind;
// Hull emitter - see the birth block below. A wave runner has four separate
// sources, not one, and each has its own geometry.
uniform vec3  uCraftPos;
uniform vec2  uCraftFwd, uCraftRight;
uniform float uCraftSpeed, uCraftTurn, uCraftAmount, uCraftSpread, uCraftUp;
uniform float uCraftBeam, uCraftLen;
uniform float uCraftPlane, uCraftPlaneFull, uCraftLife, uCraftPulse;
uniform float uCraftLoad, uCraftLoadFull;
uniform float uCraftSteer, uCraftThrottle, uCraftSlip, uCraftAir, uCraftImpact;
uniform float uCraftJet, uCraftJetSpeed, uCraftJetAngle, uCraftJetRise;
uniform float uCraftSheet, uCraftSheetSpeed;
uniform float uCraftCurtain, uCraftCurtainSpeed;
uniform float uCraftBurst;
uniform float uDt, uTime, uFrame, uTexSize;
uniform float uSpawnRadius, uSpawnRate, uSpawnFocus;
uniform float uFoldThreshold, uFoldSoft, uFoamBias;
uniform float uWindMin, uWindFull, uMistWind;
uniform float uSheetRate, uSheetSpread, uShred;
uniform float uGravity, uDrag, uMistDrag, uMistFall, uMistRise;
uniform float uLaunchSpeed, uLaunchUp, uLaunchWind;
uniform float uTurbulence, uShear;
uniform float uHeightScale, uSeaLevel;
layout(location=0) out vec4 oPos;   // xyz world, w life remaining (s)
layout(location=1) out vec4 oVel;   // xyz velocity, w birth energy

void main(){
  vec4 P = texture(uPos, vUv);
  vec4 V = texture(uVel, vUv);
  float fid = floor(vUv.y*uTexSize)*uTexSize + floor(vUv.x*uTexSize);
  float mist = sprayIsMist(fid);
  float wind = length(uWind);
  vec3  wdir = wind > 0.01 ? uWind/wind : vec3(1.0, 0.0, 0.0);
  vec3  tang = vec3(-wdir.z, 0.0, wdir.x);
  float ep   = mod(uFrame, 2048.0);
  float reach = sprayReach(fid, uSpawnRadius);

  if (P.w <= 0.0){
    // ------------------------------------------------------------------ birth
    // The hull is a far denser source than the open sea whenever it is working,
    // so it gets first claim on a dead particle. Droplets, never mist: what the
    // hull throws is heavy water, not spindrift.
    //
    // A wave runner does not have "a spray". It has four sources, each with its
    // own place on the hull, its own launch direction and its own shape, and
    // which of them is loud depends entirely on what the rider is doing:
    //
    //   1  the pump jet, leaving the steering nozzle wherever the bars point
    //   2  the chine sheets, peeled off the planing surfaces and thrown out flat
    //   3  the slip curtain, shovelled up by a hull sliding sideways out of a turn
    //   4  the bow burst, thrown forward when the hull lands or punches a crest
    //
    // The previous emitter had one point, one direction, and a wide random cone
    // laid over the top to break up the parallel streaks that direction produced.
    // The cone worked, but it is isotropic: it threw away every bit of directional
    // information the launch had, which is exactly why a hard turn looked the same
    // as a straight run. Each source now gets a cone of its own, oriented along
    // something physical, and its own weight in the mix.
    //
    // A displacement hull throws almost nothing: below planing speed a ski just
    // pushes a bow wave and a little wash, so the terms below have thresholds
    // rather than slopes through the origin.
    float plane = smoothstep(uCraftPlane, uCraftPlaneFull, uCraftSpeed);
    float load  = smoothstep(2.0, uCraftLoadFull, uCraftLoad);
    float slipS = uCraftSlip;                 // signed, m/s, positive to starboard
    float slipA = abs(slipS);
    float wet   = 1.0 - uCraftAir;            // out of the water, out of water
    // Water does not shed at a constant rate: a chine bites, sheds a sheet and
    // reloads. Each source runs on its own clock, because one shared pulse made
    // the whole plume breathe as a single object rather than as several.
    float pJet   = 0.72 + 0.28*sin(uTime*19.7);
    float pSheet = 0.28 + 0.72*pow(0.5 + 0.5*sin(uTime*8.7 + hash11(floor(uTime*3.0))*13.0), 1.7);
    float pCurt  = 0.34 + 0.66*pow(0.5 + 0.5*sin(uTime*5.9 + 2.1), 1.4);

    // The pump runs off throttle, not off speed - which is why a ski standing
    // still on full lock still throws a tail, and why a carve that has scrubbed
    // all its speed does not go quiet.
    float wJet   = uCraftJet * uCraftThrottle * (0.30 + 0.70*plane) * pJet * wet;
    float wSheet = uCraftSheet * plane * pSheet * wet;
    // Sideslip and hull load are what a carve actually is, and both survive the
    // speed a carve destroys.
    float wCurt  = uCraftCurtain * clamp(slipA*0.40 + load*0.95, 0.0, 2.0) * pCurt * wet;
    float wBurst = uCraftBurst * uCraftImpact * 3.2;
    float wTot   = wJet + wSheet + wCurt + wBurst;

    float craftDrive = uCraftAmount * (1.0 - mist) * uCraftPulse * clamp(wTot, 0.0, 2.2);
    if (craftDrive > 0.001 && hash12(vec2(fid*0.0173 + 5.7, ep*0.531)) < craftDrive){
      vec2 hA = hash22(vec2(fid*0.311 + 1.3, ep*0.617));   // where on the hull
      vec2 hB = hash22(vec2(fid*0.719 + 9.1, ep*0.233));   // where in the cone
      vec2 hC = hash22(vec2(fid*1.093 + 3.7, ep*0.409));   // how fast, how long
      float pick = hash12(vec2(fid*1.31 + 4.4, ep*0.751)) * max(wTot, 1e-5);
      float u = sprayShred(fid);         // 0 leading edge, 1 shredded tail
      // A cheap hash does not have a mean of exactly 0.5, and a cone built as
      // (h*2 - 1) turns that small offset into a systematic sideways lean of the
      // entire plume: a dead straight run measurably sprayed more to starboard
      // than to port. Taking the *sign* from the particle index and only the
      // magnitude from the hash is symmetric whatever the hash's mean is, and it
      // costs nothing. Two independent bit planes, so the two cone axes do not
      // end up correlated into a diagonal.
      float sgnW = mod(fid, 2.0) * 2.0 - 1.0;
      float sgnN = mod(floor(fid*0.5), 2.0) * 2.0 - 1.0;
      float coin = mod(floor(fid*0.25), 2.0) * 2.0 - 1.0;   // exact 50/50 side

      vec3 F = vec3(uCraftFwd.x, 0.0, uCraftFwd.y);
      vec3 Rt = vec3(uCraftRight.x, 0.0, uCraftRight.y);
      const vec3 UP = vec3(0.0, 1.0, 0.0);
      vec3 hullVel = F * uCraftSpeed + Rt * slipS;
      float spreadK = max(uCraftSpread, 0.0);
      float liftK   = max(uCraftUp, 0.0);

      vec3  org  = vec3(0.0);   // launch point, hull-relative
      vec3  axis = -F;          // centre of the launch cone
      float relV = 1.0;         // launch speed relative to the hull
      float inherit = 0.4;      // how much of the hull's own motion it keeps
      float aWide = 0.3, aNar = 0.3;   // cone half-angles, in and across the sheet
      float energy = 0.5;
      float lifeK = 1.0;    // heavy parcels hang around longer than fine ones

      if (pick < wJet){
        // 1. Pump jet. The nozzle steers with the bars, and that single fact is
        // what makes a rooster tail sweep across a turn instead of always
        // trailing the hull's own heading. It is also aimed slightly up, which is
        // what stands the tail up behind the craft rather than firing it flat.
        float na = uCraftJetAngle * clamp(uCraftSteer, -1.0, 1.0);
        axis = normalize(-F*cos(na) + Rt*sin(na) + UP*uCraftJetRise*liftK);
        org  = -F*uCraftLen*0.95 + Rt*coin*hA.x*uCraftBeam*0.25
             + UP*(0.10 + 0.26*hA.y);
        // A jet is coherent where it leaves and torn apart further along, so the
        // tail of each burst opens out far wider than its head.
        aWide = (0.09 + 0.44*u) * spreadK;
        aNar  = (0.06 + 0.34*u) * spreadK;
        relV  = uCraftJetSpeed * (0.60 + 0.55*hC.x) * (0.35 + 0.65*uCraftThrottle);
        // The jet leaves at roughly the speed the hull is doing, in the opposite
        // direction, so in world terms the tail hangs almost still behind the
        // craft. Inheriting the hull's velocity here would fire it forwards.
        inherit = 0.16;
        energy  = 0.45 + 0.85*uCraftThrottle;
        lifeK   = 1.2;
      } else if (pick < wJet + wSheet){
        // 2. Chine sheets. A planing hull's deadrise deflects water sideways and
        // slightly forward, leaving as a thin flat sheet - so this cone is wide
        // in the horizontal and almost closed in the vertical. Anything else and
        // the wings either side of a planing hull come out as a cloud.
        float buried = uCraftTurn >= 0.0 ? 1.0 : -1.0;
        float turnAmt = clamp(abs(uCraftTurn)*1.6, 0.0, 0.85);
        // The buried rail does most of the work; the one the bank has lifted
        // clear does almost none. With no turn the exact coin splits the two
        // chines evenly, and the hash only ever biases *towards* the buried side.
        float sd = mix(coin, buried, step(hA.y, turnAmt));
        float isB = step(0.5, sd*buried*0.5 + 0.5);
        float sideGain = mix(1.0 - 0.80*turnAmt, 1.0 + turnAmt, isB);
        org  = F*(hA.x - 0.45)*uCraftLen*1.1 + Rt*sd*uCraftBeam*0.95 + UP*0.05;
        axis = normalize(Rt*sd*0.86 + F*0.42 + UP*0.16*liftK);
        aWide = (0.22 + 0.26*u) * spreadK;
        aNar  = (0.045 + 0.075*u) * spreadK;
        relV  = uCraftSpeed * uCraftSheetSpeed * (0.70 + 0.50*hC.x);
        inherit = 0.50;
        energy  = (0.30 + 0.85*plane) * sideGain;
        lifeK   = 0.85;
      } else if (pick < wJet + wSheet + wCurt){
        // 3. Slip curtain. In a carve the velocity lags the heading, so the hull
        // is travelling partly sideways and shovelling water with its flank. That
        // wall goes up and out on the side it is sliding towards - the outside of
        // the turn - which is the opposite side to the chine sheet above, and
        // getting the two on the correct sides is most of what makes a hard turn
        // read as a hard turn.
        float side = slipA > 0.05 ? sign(slipS) : coin;
        org  = -F*uCraftLen*(0.10 + 0.70*hA.x)
             + Rt*side*uCraftBeam*(0.80 + 0.40*hA.y) + UP*0.06;
        axis = normalize(Rt*side*0.72 + UP*0.62*liftK - F*0.14);
        aWide = (0.30 + 0.32*u) * spreadK;
        aNar  = (0.18 + 0.26*u) * spreadK;
        relV  = (slipA*uCraftCurtainSpeed + load*4.5 + uCraftSpeed*0.10)
              * (0.60 + 0.60*hC.x);
        inherit = 0.45;
        energy  = clamp(0.40 + slipA*0.22 + load*1.10, 0.0, 2.2);
        lifeK   = 1.3;
      } else {
        // 4. Bow burst. Landing off a crest or punching through one throws water
        // forward and up in a crown, and it is left behind almost at once.
        org  = F*uCraftLen*(0.60 + 0.50*hA.x)
             + Rt*coin*hA.y*uCraftBeam*0.8 + UP*0.04;
        axis = normalize(F*0.42 + UP*0.86*liftK);
        aWide = (0.70 + 0.30*u) * spreadK;
        aNar  = (0.50 + 0.30*u) * spreadK;
        relV  = (uCraftSpeed*0.35 + uCraftImpact*9.0) * (0.50 + 0.80*hC.x);
        inherit = 0.35;
        energy  = 0.55 + 1.35*uCraftImpact;
        lifeK   = 1.1;
      }

      // The cone, oriented on the source's own axis. One tangent is horizontal
      // and the other carries the vertical, so a sheet can be broad and flat
      // while a splash is broad both ways - which one isotropic cone cannot do.
      vec3 wide = cross(UP, axis);
      float wl = length(wide);
      wide = wl > 1e-3 ? wide/wl : vec3(1.0, 0.0, 0.0);
      vec3 nar = cross(axis, wide);
      vec3 dir = normalize(axis
               + wide * tan(min(aWide, 1.25)) * sgnW * hB.x
               + nar  * tan(min(aNar,  1.25)) * sgnN * hB.y);

      vec3 v = hullVel * inherit + dir * relV;
      // Whatever leaves the hull immediately meets the craft's own apparent wind.
      v += (uWind - hullVel) * 0.08;

      oPos = vec4(uCraftPos + org, uCraftLife * (0.35 + 0.80*hC.y) * lifeK);
      oVel = vec4(v, clamp(energy, 0.05, 1.35));
      return;
    }

    // Whitecaps start tearing at about F4 and the air is solid spindrift by
    // F10; mist needs a much stronger wind than ballistic droplets do.
    float gate = mix(smoothstep(uWindMin, uWindFull, wind),
                     smoothstep(uMistWind, uMistWind + 12.0, wind), mist);

    // Breaking water covers a few percent of the sea, so most candidate sites
    // are rejected. Retrying in proportion to the step keeps the population the
    // same whether the sim is running at 60 fps or at 3 - one attempt per frame
    // would make the whole system quietly frame-rate dependent.
    float sheet = floor(fid / max(uSheetSize, 1.0));
    float u     = sprayShred(fid);
    float lead  = 1.0 - u;
    int tries = int(clamp(uDt*60.0 + 0.5, 1.0, 16.0));
    for (int t = 0; t < 16; t++){
      if (t >= tries) break;

      // Water is torn off a crest in sheets, not droplet by droplet: a block of
      // consecutive particles shares one tear-off site, so a burst reads as a
      // sheet shredding rather than a fountain of independent dots. Each sheet
      // runs on its own phase so they do not all let go on the same tick.
      float epoch = floor(uTime*uSheetRate + hash11(sheet*0.913 + 4.1)*8.0) + float(t)*37.0;
      // The rate roll is per tear-off event, not per particle. Rolling it per
      // particle decorrelates the block and hands back the fountain of
      // independent dots the sheet exists to avoid - and, now that only a few
      // percent of candidate sites are on breaking water, it also throws away
      // most of the few attempts a low frame rate can afford.
      if (hash12(vec2(sheet*0.017 + 3.1, epoch*0.311)) > uSpawnRate * gate) continue;
      vec2  hs = hash22(vec2(sheet*0.7315 + 1.7, epoch));
      // Radial bias on the spawn disc. An exponent of 0.5 spreads the budget
      // uniformly over the area, which spends nearly all of it on parcels
      // smaller than a pixel; anything much above 1 piles a third of the
      // population into the first ten metres, where a handful of huge
      // billboards smear over the whole lower frame. Just past 1 is the
      // compromise: density falling as 1/r, which is roughly constant per unit
      // of screen area.
      float r = reach * (0.05 + 0.95*pow(hs.x, max(uSpawnFocus, 0.2)));
      float a = hs.y * 6.28318530718;
      vec2  base = uCamPos.xz + vec2(cos(a), sin(a)) * r;

      float j1 = hash12(vec2(fid*0.037, epoch)) - 0.5;
      float j2 = hash12(vec2(fid*0.053 + 5.0, epoch)) - 0.5;
      // The sheet lies along the crest line, i.e. across the wind, and its tail
      // is already trailing downwind at the moment it lets go.
      vec2 xz = base
              + tang.xz * (j1 * uSheetSpread * 2.0)
              + wdir.xz * (u*uShred + j2*uSheetSpread*0.3);

      vec2 dxz;
      vec3 o = oceanAt(xz, dxz);
      // Ballistic droplets are thrown by the break itself, so they need water
      // that is tumbling right now. Spindrift is scraped off the surface of any
      // whitewater by the wind, so the raft counts too - which is why a gale
      // grows a veil long after the individual breakers have passed.
      float T = max(uFoldThreshold, 0.01);
      float brk = smoothstep(T*clamp(uFoldSoft,0.0,0.95), T, o.y);
      float wet = smoothstep(T*0.25*clamp(uFoldSoft,0.0,0.95), T*0.25, o.z);
      float energy = clamp(mix(mix(wet, brk, clamp(uFoamBias,0.0,1.0)),
                               max(brk, 0.7*wet), mist), 0.0, 1.0);
      if (energy <= 0.015) continue;

      // Born just clear of the lip, the leading edge highest. The site was
      // chosen in Lagrangian coordinates because that is the frame the foam and
      // fold fields live in; the particle has to start where that piece of water
      // actually is.
      vec3 p = vec3(xz.x + dxz.x,
                    o.x*uHeightScale + uSeaLevel + 0.06 + (0.25 + 0.45*lead)*energy,
                    xz.y + dxz.y);

      float s1 = hash12(vec2(fid*0.071, epoch*0.23));
      float s2 = hash12(vec2(fid*0.091 + 3.0, epoch*0.29));
      float s3 = hash12(vec2(fid*0.113 + 9.0, epoch*0.31));
      // A spilling crest throws water forward along its own travel and the wind
      // immediately takes it: mostly downwind, only modestly up. The leading
      // edge leaves fastest, which is what stretches the sheet as it flies.
      // The per-particle spread has to stay small or the block turns into a
      // starburst of spokes instead of one sheet moving together.
      vec3 v = wdir * (uLaunchSpeed * (0.30 + 0.95*energy) * (0.30 + 1.05*lead) * (0.72 + 0.42*s1))
             + vec3(0.0,1.0,0.0) * (uLaunchSpeed * uLaunchUp * (0.25 + energy) * (0.25 + 0.95*lead) * (0.55 + 0.5*s2))
             + tang * ((s3 - 0.5) * uLaunchSpeed * 0.26 * (0.25 + 0.85*u));
      v += uWind * uLaunchWind;
      // Spindrift never has its own momentum - it leaves with the air.
      v = mix(v, uWind * (0.65 + 0.35*s1) + vec3(0.0, uMistRise*(0.4+s2), 0.0), mist);

      oPos = vec4(p, sprayLifeTotal(fid));
      oVel = vec4(v, energy);
      return;
    }
    oPos = vec4(P.xyz, 0.0); oVel = V; return;
  }

  // -------------------------------------------------------------------- step
  vec3  v  = V.xyz;
  float sz = sprayRadius(fid);
  // Drag time constant scales with droplet size: fine spray locks onto the air
  // within a metre, a heavy blob keeps flying ballistically.
  float k = mix(uDrag * clamp(0.16/max(sz, 0.02), 0.3, 5.0), uMistDrag, mist);

  // Log wind profile. The shear is what bends spindrift streaks over and makes
  // the top of a plume outrun its base.
  vec3 air = uWind * (1.0 + uShear * log(1.0 + max(P.y - uSeaLevel, 0.0) * 0.4));
  v += (air - v) * clamp(k*uDt, 0.0, 1.0);
  v.y -= uGravity * mix(1.0, uMistFall, mist) * uDt;

  // Eddies scale with the wind that made them.
  vec3 turb = vec3(vnoise(P.xyz*0.11 + uTime*0.5),
                   vnoise(P.xyz*0.11 + 31.0 + uTime*0.5),
                   vnoise(P.xyz*0.11 + 77.0 + uTime*0.5)) - 0.5;
  v += turb * uTurbulence * (0.4 + 0.05*wind) * mix(1.0, 2.2, mist) * uDt;

  vec3 p = P.xyz + v*uDt;
  float life = P.w - uDt;

  float surf = oceanHeight(p.xz)*uHeightScale + uSeaLevel;
  if (p.y < surf) life = 0.0;
  if (distance(p.xz, uCamPos.xz) > reach*1.7) life = 0.0;

  oPos = vec4(p, max(life, 0.0));
  oVel = vec4(v, V.w);
}
`;

export const SPRAY_VS = /* glsl */`
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}
${SAMPLE_OCEAN}
${SPRAY_PARTICLE_GLSL}
layout(location=0) in vec2 aCorner;
uniform sampler2D uPos, uVel, uSkyLUT;
uniform mat4 uViewProj;
uniform vec3 uCamRight, uCamUp, uCamPos, uWind, uSunDir, uSunColor;
uniform float uTexSize, uSizeScale, uStretch, uMistStretch;
uniform float uFadeNear, uFadeFar, uMistGrow, uViewportH, uMinPixels, uFarSoft;
uniform float uHeightScale, uSeaLevel;
out vec2 vCorner;
out float vFade, vMist, vEnergy, vSoft, vSeed, vSize, vShape, vTex, vSurfDelta;
out vec3 vWorld, vSun, vAmb;

void main(){
  int id = gl_InstanceID;
  int w = int(uTexSize);
  vec2 uv = (vec2(float(id % w), float(id / w)) + 0.5) / uTexSize;
  vec4 P = texture(uPos, uv);
  vec4 V = texture(uVel, uv);

  // Both of these are constant over the whole draw, and the transmittance is an
  // eight step march. A billboard field this dense would pay for it millions of
  // times per frame in the fragment stage, so it is resolved here instead.
  vSun = uSunColor * sunTransmittance(vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0), uSunDir)
       * uAtmoExposure * smoothstep(-0.09, 0.02, uSunDir.y);
  vAmb = textureLod(uSkyLUT, dirToSkyUv(vec3(0.0,1.0,0.0)), 4.0).rgb;

  if (P.w <= 0.0){
    gl_Position = vec4(2.0,2.0,2.0,1.0);
    vFade=0.0; vCorner=aCorner; vWorld=vec3(0.0); vMist=0.0; vEnergy=0.0;
    vSoft=1.0; vSeed=0.0; vSize=0.0; vShape=0.0; vTex=0.0; vSurfDelta=1.0;
    return;
  }

  float fid  = float(id);
  float mist = sprayIsMist(fid);
  float shred = sprayShred(fid);
  float age  = 1.0 - clamp(P.w / max(sprayLifeTotal(fid), 0.01), 0.0, 1.0);

  // Droplets hold their size and evaporate; mist keeps spreading as it disperses.
  float grow = mix(mix(0.75, 1.15, age), mix(0.5, uMistGrow, age), mist);
  float size = sprayRadius(fid) * uSizeScale * grow;

  float dist = distance(uCamPos, P.xyz);
  float far  = sprayReach(fid, uFadeFar);
  // Symmetric ramps at both ends of life and an absolute near clamp. The
  // relative one - so a puff the camera drifts into dissolves instead of filling
  // the frame - has to wait until the streak length is known.
  float fade = smoothstep(0.0, 0.10, age) * smoothstep(1.0, 0.62, age)
             * smoothstep(uFadeNear, uFadeNear*4.0, dist)
             * (1.0 - smoothstep(far*0.7, far, dist));

  // Most of the sea's spray is smaller than a pixel. Rasterised as-is it either
  // vanishes or twinkles, so anything under a pixel is grown to a floor and
  // dimmed by the same factor in area: the scattered energy is preserved and a
  // distant plume reads as the faint veil it actually is.
  vec4 c0 = uViewProj * vec4(P.xyz, 1.0);
  vec4 c1 = uViewProj * vec4(P.xyz + uCamUp*max(size, 1e-4), 1.0);
  float spx = uMinPixels;
  if (c0.w > 1e-3){
    float px = length(c1.xy/max(c1.w,1e-3) - c0.xy/c0.w) * 0.5 * uViewportH;
    float bump = clamp(uMinPixels / max(px, 1e-4), 1.0, 48.0);
    size *= bump;
    fade /= bump*bump;
    spx = max(px, uMinPixels);
  }
  // How much of this billboard's own structure the raster can actually resolve.
  // Everything below - outline raggedness, edge hardness, the droplet texture -
  // keys off this rather than off distance, because a two-pixel parcel is a
  // two-pixel parcel whether it is ten metres away or two hundred, and drawing
  // detail into it only buys speckle.
  float res = smoothstep(1.6, 8.0, spx);

  // Anisotropic billboard: the quad is stretched along the screen projection of
  // the velocity, which is what turns fast mist into streaks and leaves slow
  // droplets round. The projection length also handles foreshortening for free.
  vec3 rel = V.xyz - uWind*0.35;
  float rs = length(rel);
  vec3 vd  = rs > 0.01 ? rel/rs : vec3(0.0,1.0,0.0);
  vec2 s   = vec2(dot(vd, uCamRight), dot(vd, uCamUp));
  float sl = length(s);
  vec2 ax  = sl > 1e-4 ? s/sl : vec2(1.0, 0.0);
  vec2 ay  = vec2(-ax.y, ax.x);
  // The smear is an exposure, not a style knob: the parcel is drawn out by the
  // distance it covers while the shutter is open. Dividing by its own size is
  // what makes this read as spray - a fine droplet turns into a filament while a
  // heavy blob of the same speed barely elongates at all, so one launch produces
  // a whole range of shapes. Setting it as a raw multiplier instead gave every
  // particle the same aspect ratio and the frame filled with parallel tracer
  // streaks. The leading edge of a sheet is still connected water, so it draws
  // out further than the shredded tail behind it.
  float smear = rs * sl * mix(uStretch * (0.6 + 1.0*(1.0-shred)), uMistStretch, mist);
  float elong = clamp(1.0 + smear / max(2.0*size, 0.02), 1.0, 8.0);
  // Stretching at constant area keeps a streak from also getting brighter.
  vec2 q = ax*(aCorner.x*size*elong) + ay*(aCorner.y*size/sqrt(elong));
  // Now that the quad's real extent is known: nothing may subtend more than a
  // modest fraction of the frame, or one near particle smears over everything.
  fade *= smoothstep(1.2, 3.2, dist/max(size*elong, 0.02));

  vec3 world = P.xyz + uCamRight*q.x + uCamUp*q.y;
  // Height clearance above the water, evaluated per vertex rather than per
  // fragment: the surface is flat to well under a millimetre over a billboard,
  // so interpolating the clearance across the quad gives the same soft
  // waterline for a twelfth of the texture fetches. Inverting the Lagrangian
  // mapping is not cheap and the fragment stage runs it millions of times.
  vSurfDelta = world.y - (oceanHeight(P.xz)*uHeightScale + uSeaLevel);
  vWorld  = world;
  vCorner = aCorner;
  vFade   = fade;
  vMist   = mist;
  vEnergy = V.w;
  vSize   = size;
  vSeed   = fract(fid*0.618034);
  // Mist has no edge at all, and anything too small to resolve must be a smooth
  // veil rather than a hard dot, or the whole far field turns to speckle.
  vSoft   = mix(1.9, 2.8, mist) + uFarSoft * (1.0 - res);
  // A torn scrap of water has a ragged outline once it is big enough to show one.
  vShape  = res * (1.0 - 0.6*mist);
  vTex    = res;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const SPRAY_FS = /* glsl */`
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}
in vec2 vCorner;
in float vFade, vMist, vEnergy, vSoft, vSeed, vSize, vShape, vTex, vSurfDelta;
in vec3 vWorld, vSun, vAmb;
uniform sampler2D uSkyLUT;
uniform vec3 uSunDir, uCamPos;
uniform float uOpacity, uMistOpacity, uScatter, uAmbient, uMulti;
uniform float uForwardG, uBackG, uSurfFade, uAerial;
uniform float uGrain, uMistGrain, uGrainScale, uGrainAniso;
out vec4 fragColor;

void main(){
  // A torn scrap of water is not a disc: a per-particle angular ripple keeps
  // the billboards from reading as a field of identical soft circles.
  float th = atan(vCorner.y, vCorner.x);
  float d = length(vCorner)
          * (1.0 + vShape*(0.24*sin(th*3.0 + vSeed*6.28318) + 0.13*sin(th*7.0 + vSeed*11.3)));
  if (d > 1.0) discard;

  // Weakly-breaking crests emit too, but faintly: the emission ramp is soft so
  // that spray production is continuous in how hard the crest is breaking rather
  // than a switch, and the birth energy has to carry that gradation through to
  // the opacity.
  float a = pow(1.0 - d, vSoft) * vFade * mix(uOpacity, uMistOpacity, vMist)
          * mix(0.08 + 0.92*pow(max(vEnergy,0.0), 0.6), 0.25 + 0.75*vEnergy, vMist);

  // The one thing that separates spray from cotton wool. A parcel of spray is a
  // few thousand droplets with gaps between them, not a smooth gaussian, and a
  // smooth gaussian is exactly what a soft radial falloff draws. The mask lives
  // in billboard space so it stretches with the streak, and it is squashed along
  // the direction of travel because the wind draws every shred out into
  // filaments. It is faded out below a few pixels, where it could only alias.
  float g = mix(uGrain, uMistGrain, vMist) * vTex;
  if (g > 0.002){
    vec2 q = vec2(vCorner.x / max(uGrainAniso, 0.05), vCorner.y) * uGrainScale
           + vec2(vSeed*91.7, vSeed*57.3 + 13.0);
    float n = fbm2(q, 2);
    // Rescaled back to roughly unit mean, so adding structure does not quietly
    // darken the whole system and get compensated for with opacity.
    a *= mix(1.0, clamp((n - 0.34)*3.4, 0.0, 1.0) * 1.55, g);
  }

  // Fade out as the billboard enters the water instead of showing the hard
  // intersection edge a depth-tested quad would give. The band has to grow with
  // the billboard or a distant one held at the pixel floor cuts hard again.
  a *= smoothstep(0.0, max(uSurfFade, vSize*0.9), vSurfDelta);
  if (a < 0.002) discard;

  vec3 toCam = uCamPos - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);

  // vSun is the solar irradiance reaching this altitude and vAmb the average sky
  // radiance, both resolved in the vertex stage.
  vec3 sun = vSun, amb = vAmb;

  // Water droplets scatter almost everything forward. Two lobes: a very narrow
  // one for the halo right around the sun and a broad one for the general glow,
  // plus a weak backscatter shoulder. Front-lit spray gets almost nothing from
  // this, which is exactly why backlit spray is the shot.
  float mu = -dot(V, uSunDir);
  float phase = miePhase(mu, uForwardG) * 0.62
              + miePhase(mu, uForwardG*0.55) * 0.30
              + miePhase(mu, -abs(uBackG)) * 0.08;

  // Multiple scattering inside a dense sheet leaks light in every direction and
  // is what keeps front-lit spray white rather than grey.
  // sun is irradiance in LUT units, phase is per steradian, so the product is
  // already an outgoing radiance - no 4pi anywhere.
  vec3 col = sun * phase * uScatter
           + sun * uMulti * mix(1.0, 1.7, vMist)
           + amb * uAmbient;

  // Distant spray has to sit back into the air like everything else.
  vec3 far = texture(uSkyLUT, dirToSkyUv(-V)).rgb;
  float t = exp(-dist * uAerial);
  col = mix(far, col, t);

  fragColor = vec4(col * a, a);
}
`;

// ---------------------------------------------------------------- storm haze
//
// A wind-gated layer of suspended mist hugging the sea. The source function is
// constant along a given view ray, so all the march has to produce is the
// optical depth - which is where the physics lives. Two things matter: the sea
// curves away under a grazing ray, so the path through the layer is bounded
// instead of running thirty kilometres and painting a flat white band along the
// horizon, and the spume is torn off in drifting sheets rather than spread
// evenly, so the layer has to have structure.
export const SPRAY_HAZE_FS = /* glsl */`
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
${SKY_LUT_MAP_GLSL}
in vec2 vUv;
uniform sampler2D uSkyLUT;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos, uSunDir, uSunColor, uWind;
uniform float uHazeDensity, uHazeHeight, uHazeScatter, uHazeAmbient, uHazeG;
uniform float uHazeSheets, uHazeSheetScale, uTime, uSeaLevel;
uniform int uHazeSteps;
out vec4 fragColor;

void main(){
  vec4 c = uInvViewProj * vec4(vUv*2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(c.xyz/c.w - uCamPos);

  float H  = max(uHazeHeight, 0.5);
  float h0 = max(uCamPos.y - uSeaLevel, 0.0);
  float hTop = 7.0*H;

  // Distances along the ray, on the curved sea. b and cq come from intersecting
  // |camera + t*rd| with a sphere concentric with the planet.
  float Rc = R_PLANET + h0;
  float b  = Rc * rd.y;
  float tEnd;
  float discSea = b*b - (Rc*Rc - R_PLANET*R_PLANET);
  if (rd.y < 0.0 && discSea > 0.0){
    tEnd = -b - sqrt(discSea);                       // the ray meets the water
  } else {
    float Rt = R_PLANET + max(hTop, h0 + 1.0);
    tEnd = -b + sqrt(max(b*b + Rt*Rt - Rc*Rc, 0.0)); // it leaves out of the top
  }
  tEnd = clamp(tEnd, 0.0, 80000.0);
  if (tEnd < 0.5) discard;

  // Geometric step spacing: the near field is where the structure is visible
  // and the far field only contributes a slowly varying tail.
  const float KS = 3.2;
  float norm = 1.0/(exp(KS) - 1.0);
  int steps = clamp(uHazeSteps, 4, 24);
  vec2 drift = uWind.xz * uTime * 0.35;

  float od = 0.0;
  float tPrev = 0.0;
  for (int i = 1; i <= 24; i++){
    if (i > steps) break;
    float t1 = tEnd * (exp(KS*float(i)/float(steps)) - 1.0) * norm;
    float tm = 0.5*(tPrev + t1);
    // Height above the curved sea, to second order - exact enough at these
    // scales and far cheaper than a length().
    float hz = h0 + tm*rd.y + tm*tm*(1.0 - rd.y*rd.y)/(2.0*R_PLANET);
    float dens = exp(-max(hz, 0.0)/H);
    if (uHazeSheets > 0.001){
      vec2 q = (uCamPos.xz + rd.xz*tm - drift) * uHazeSheetScale;
      dens *= mix(1.0, 0.25 + 1.75*fbm2(q, 3), clamp(uHazeSheets, 0.0, 1.0));
    }
    od += dens * (t1 - tPrev);
    tPrev = t1;
  }

  float alpha = 1.0 - exp(-max(od, 0.0) * uHazeDensity);
  if (alpha < 0.002) discard;

  vec3 sunTr = sunTransmittance(vec3(0.0, R_PLANET + max(uCamPos.y, 1.0), 0.0), uSunDir);
  vec3 sun = uSunColor * sunTr * uAtmoExposure * smoothstep(-0.09, 0.02, uSunDir.y);
  // Half zenith average, half the sky actually behind the layer: a haze bank
  // that ignores where it is being looked at reads as flat grey paint.
  vec3 amb = mix(textureLod(uSkyLUT, dirToSkyUv(vec3(0.0,1.0,0.0)), 4.0).rgb,
                 textureLod(uSkyLUT, dirToSkyUv(rd), 3.0).rgb, 0.5);

  float mu = dot(rd, uSunDir);
  float phase = miePhase(mu, uHazeG)*0.75 + miePhase(mu, uHazeG*0.4)*0.25;
  vec3 col = sun * phase * uHazeScatter + amb * uHazeAmbient;

  fragColor = vec4(col * alpha, alpha);
}
`;
