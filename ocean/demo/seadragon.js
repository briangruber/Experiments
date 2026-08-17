// The sea dragon's behaviour: where it is, where it is going, and how hard its
// tail is beating.
//
// Two modes, one body. Left alone it is a PURSUIT MODEL - a station off your
// shoulder, a heading that turns toward it at a bounded rate, a speed that
// closes the gap and then matches yours. That is the whole trick behind
// "swim fast next to our wave runner so we can ride up next to it".
//
// When `this.active` it is a PILOT MODEL instead. Speed, heading and pitch
// hold until the player changes them. W/S and Arrow Up/Down change speed;
// Shift multiplies that step (not a dive — the ski's carve and the
// plane's pull stay theirs). A/D turn, E rises and Q dives. Space is a
// one-shot leap: it stores cruise speed and depth, surges FORWARD in
// the water first, then pitches up and climbs
// out (no velocity snap), arcs under gravity, keeps the entry speed so
// it sounds as deep as that fall goes, then floats back to the start
// depth and restores that speed. The AI's slow depth cycle is off
// entirely in this mode. The tail beat is Strouhal-matched to travel
// speed in both modes, so a sprint reads as a sprint and a loaf as a loaf.
// A leap is the exception: once airborne the stroke eases to a slowed
// swimming wave (cadence down, sweep mostly kept) and the body lags
// the ballistic rod a little, then both ramp back on re-entry.
//
// It may breach - the refraction pass gave it a depth buffer, so a fin above
// the waterline is an ordinary opaque fragment. It must not snap round when
// you turn hard (bounded yaw rate), and the AI must not sit exactly on your
// line where you would ride through it.

import { clamp, lerp, v3 } from '../src/math.js';

const TAU = Math.PI * 2;

// Sliders were tuned on the default 60 m animal. Frequency falls and
// metres-per-beat rise as length grows, so a leviathan covers ground
// with a slow sweep instead of an eel thrash.
export const SWIM_REF_LENGTH = 60;

// Airborne stroke: a slowed swim, not a freeze. Cadence drops more than
// sweep, so the travelling wave is still readable in the air.
const AIR_BEAT = 0.48;
const AIR_AMP = 0.82;

/** Fastest travel this body can produce at full effort, m/s. */
export function swimTopSpeed( p ) {

  const L = Math.max( p.sdLength ?? SWIM_REF_LENGTH, 1 );
  return Math.max( p.sdSpeed ?? 1, 1 ) * Math.sqrt( L / SWIM_REF_LENGTH );

}

/** How far below the sea a dive or a leap-fall may go.
 *  Follows the water column (`p.depth`) so a deeper ocean is a deeper
 *  dive, with a body-length standoff so a vertical animal does not sit
 *  under the bed. The old floor was 40 m regardless. */
export function maxDiveDepth( p ) {

  const water = Math.max( +( p?.depth ?? 200 ), 40 );
  const half = Math.max( p?.sdLength ?? SWIM_REF_LENGTH, 8 ) * 0.45;
  return Math.max( water - half, 40 );

}

/** Everyday swim, m/s. Capped by the sprint so the cruise slider cannot outrun top speed. */
export function loafSpeed( p ) {

  return Math.min( Math.max( p.sdCruise ?? 15, 0 ), swimTopSpeed( p ) );

}

// Biological cruising Strouhal, and the slider value that means "use that".
// Real swimmers sit at 0.25–0.35; 0.30 is the middle of the band.
export const STROUHAL_REF = 0.30;
export const BEAT_SPEED_REF = 0.032;
// The travelling body wave must outrun the swim or the mesh slides
// through its own bend. 1.15 is a light paddle surplus.
export const SWIM_PADDLE = 1.15;

/**
 * One stroke from length, effort, wave count and the Strouhal number.
 * St = f · (peak-to-peak amplitude) / speed, 0.25–0.35 for swimming animals.
 * Invert: speed = f · 2A / St, so distance per beat is 2A / St ∝ length.
 * Cadence is also floored so the wave speed c = f · L / n_waves stays
 * ahead of travel speed — that is the scale-and-speed term. The slider
 * is a trim around St = 0.30, not a guess at Hz per m/s.
 */
export function swimStroke( p, speed ) {

  const L = Math.max( p.sdLength ?? SWIM_REF_LENGTH, 1 );
  const U = Math.max( speed, 0 );
  const Umax = swimTopSpeed( p );
  const effort = clamp( U / Math.max( Umax, 1e-3 ), 0, 1 );
  const alpha0 = p.sdAmp ?? 0.055;
  const alpha = alpha0 * ( SWIM_REF_LENGTH / L ) ** 0.2;
  const ampM = Math.max( alpha * L * ( 0.52 + 0.48 * effort ), 0.25 );
  const St = clamp(
    STROUHAL_REF * ( ( p.sdBeatSpeed ?? BEAT_SPEED_REF ) / BEAT_SPEED_REF ),
    0.22, 0.45,
  );
  const fIdle = ( p.sdBeat ?? 0.35 ) * Math.sqrt( SWIM_REF_LENGTH / L );
  const fSt = U >= 0.08 ? St * U / ( 2 * ampM ) : 0;
  const waves = Math.max( p.sdWaves ?? 1, 0.25 );
  const fPaddle = U >= 0.08 ? U * waves / L * SWIM_PADDLE : 0;
  const fLoaf = fIdle * ( 0.50 + 0.50 * effort );
  const f = Math.max( fSt, fPaddle, fLoaf * ( U >= 0.08 ? 0.55 : 0.70 ) );
  return {
    f, ampM, ampFrac: ampM / L, St, fSt, fPaddle,
    distancePerBeat: f > 1e-4 ? U / f : 0,
  };

}

/**
 * How hard a breach or landing throws water. Kinetic energy in the vertical
 * (plus a little of the run), scaled by body length so a leviathan slapping
 * down moves more sea than a ski-sized slap at the same speed. 1 is a firm
 * hit; a high leap on the default 60 m animal lands around 2.5–4.
 */
export function splashEnergy( vy, speed, L, landing ) {

  const scale = Math.sqrt( Math.max( L, 8 ) / SWIM_REF_LENGTH );
  const ke = vy * vy + ( speed ?? 0 ) * ( speed ?? 0 ) * ( landing ? 0.18 : 0.08 );
  const e = ke / ( landing ? 68 : 115 ) * scale;
  return clamp( e, landing ? 0.6 : 0.28, landing ? 5.5 : 2.6 );

}

/**
 * Sign of the body-following swell: +1 is a bulge (swimming, or coming up
 * from underneath), -1 is a hollow (falling from the sky into the sea).
 *
 * Driven off the leap's own vertical speed and phase, not a slider. A
 * swimming dive (jumping false, climb < 0) stays a bulge — that body is
 * still shouldering water from below. Only an airborne fall or the
 * sounding that follows a landing flips the sign. Blends through 0 as
 * |vy| dies so the hole does not pop into a hill the frame buoyancy wins.
 */
export function swellContactSign( dragon ) {

  if ( ! dragon?.jumping ) return 1;
  const phase = dragon.jumpPhase;
  const vy = dragon.jumpVy ?? 0;
  const fromSky = phase === 'water' || ( phase === 'air' && vy < 0 );
  if ( ! fromSky ) return 1;
  return clamp( vy / 2, -1, 1 );

}

/**
 * World XZ of the first water contact. The origin is mid-body on a 60 m
 * animal and is often still in the air when a pitched nose (or tail) is
 * already in the sea — the same reason spray gates use dragonHighPoint()
 * rather than pos[1].
 *
 * Nose sits at local −Z; negative pitch drops it. A level belly stays at
 * the origin. When a breach profile is handed in, `bottomZ` (the station
 * with the lowest posed world Y) wins over the spine-tip fallback.
 */
export function waterContactXZ( dragon, p, breach ) {

  const L = Math.max( p?.sdLength ?? SWIM_REF_LENGTH, 1 );
  const half = L * 0.5;
  const pitch = dragon.pitch ?? 0;
  let localZ = 0;
  if ( breach && Number.isFinite( breach.bottomZ ) ) {

    localZ = breach.bottomZ;

  } else if ( pitch < - 1e-3 ) {

    localZ = - half;

  } else if ( pitch > 1e-3 ) {

    localZ = half;

  }
  const h = dragon.heading ?? 0;
  const sx = Math.sin( h ), cx = Math.cos( h );
  const ox = dragon.pos?.[ 0 ] ?? 0, oz = dragon.pos?.[ 2 ] ?? 0;
  return { x: ox - sx * localZ, z: oz + cx * localZ, along: localZ };

}

export class SeaDragon {

  constructor() {
    this.pos = v3(0, -6, 0);
    this.heading = 0;
    this.speed = 0;
    this.roll = 0;               // banks into its turns, like anything that swims
    this.pitch = 0;
    this.yawRate = 0;
    this.headYaw = 0;            // head & rostrum turn flex into turns, radians
    this.phase = 0;              // the body wave, radians
    this.depth = 6;              // below the mean surface, metres
    this.side = 1;               // which shoulder it is holding
    this.pacing = false;         // holding station, or circling
    this.gape = 0;               // 0 shut, 1 as wide as the mesh was modelled
    this.t = 0;
    this.wanderAngle = 0;
    this._primed = false;
    this.active = false;         // player is piloting it
    this.cruiseSpeed = 0;        // held until W/S changes it
    this._lastSdCruise = null;   // so a live slider edit can retarget a held loaf
    this.cruiseDepth = 6;        // held until rise/dive changes it
    this.swimAmp = 0.055;        // body-wave amplitude, grows with speed
    this.beatGain = 1;           // 1 = full wet cadence; eases to AIR_BEAT in air
    this.climb = 0;
    this.jumping = false;
    this.jumpAirborne = false;
    this.jumpPhase = null;       // 'accel' | 'rise' | 'air' | 'water'
    this.jumpVy = 0;
    this.jumpResumeSpeed = 0;
    this.jumpResumeDepth = 6;
    this.jumpLaunch = 0;
    this.jumpApex = 0;
    this.jumpAccelT = 0;
    this.jumpHoldY = 0;
    this.jumpSplashedOut = false;
    this.jumpEntered = false;
    this.splash = 0;             // punch for the shared spray burst (can exceed 1)
    this.splashPush = 0;         // lingering particle crown, not a water mound
    this.splashHit = 0;          // energy the ripple field holds until it dies
    this.splashAge = 10;         // seconds since the hit; large = field off
    this.splashKind = null;      // 'exit' | 'land' — particles; sea deform is the back mound only
    this.splashX = 0;
    this.splashZ = 0;
    this.splashHeading = 0;      // heading at the hit, so the cavity stays a sausage
    this._spaceWasDown = false;
  }

  /** Drop it in beside the camera, on station, facing the same way. */
  reset(camera, p) {
    const h = camera?.yaw ?? 0;
    const c = Math.cos(h), s = Math.sin(h);
    const off = p?.sdOffset ?? 14;
    this.heading = h;
    this.pos[0] = (camera?.pos?.[0] ?? 0) + c * off;
    this.pos[2] = (camera?.pos?.[2] ?? 0) + s * off;
    this.depth = p?.sdDepth ?? 6;
    this.pos[1] = - this.depth;
    this.speed = 0; this.roll = 0; this.pitch = 0; this.yawRate = 0; this.headYaw = 0;
    this.t = 0; this.wanderAngle = h; this.pacing = false; this.gape = 0;
    this.cruiseSpeed = this.speed;
    this.cruiseDepth = this.depth;
    this.swimAmp = p?.sdAmp ?? 0.055;
    this.beatGain = 1;
    this.jumping = false;
    this.jumpAirborne = false;
    this.jumpPhase = null;
    this.jumpVy = 0;
    this.splash = 0;
    this.splashPush = 0;
    this.splashHit = 0;
    this.splashAge = 10;
    this.splashKind = null;
    this._spaceWasDown = false;
    this._primed = true;
  }

  /**
   * Tail cadence and sweep from travel speed and body length. Frequency is
   * the Strouhal invert of speed / (2 · amplitude), so a longer animal
   * covers more water per beat and thrashes less.
   *
   * jumpAirborne is the wet/dry gate (origin vs sea, set by the leap
   * state machine). Cadence eases to AIR_BEAT; sweep holds AIR_AMP so
   * the body keeps a real wave. ~0.3 s down, ~0.5 s back — no pop.
   */
  advanceSwim(d, p) {
    const airborne = this.jumpAirborne;
    const want = airborne ? AIR_BEAT : 1;
    const k = airborne ? 8 : 4.5;
    this.beatGain = lerp(this.beatGain, want, 1 - Math.exp(-k * d));
    const airT = clamp((1 - this.beatGain) / (1 - AIR_BEAT), 0, 1);
    const ampGain = 1 + airT * (AIR_AMP - 1);
    const { f, ampFrac } = swimStroke(p, this.speed);
    this.phase += f * this.beatGain * TAU * d;
    if (this.phase > TAU * 1024) this.phase -= TAU * 1024;
    this.swimAmp = ampFrac * ampGain;
  }

  express(d, p) {
    const drive = Math.sin(this.t * 0.37) * 0.6 + Math.sin(this.t * 0.13 + 2.1) * 0.4;
    const wantGape = Math.max(0, drive - 0.55) / 0.45;
    const eager = clamp(this.speed / Math.max(swimTopSpeed(p), 1), 0, 1);
    this.gape = lerp(this.gape, clamp(wantGape * (0.45 + 0.55 * eager), 0, 1), 1 - Math.exp(-3.5 * d));
    // In the air the body rolls onto its flank (like breaching cetaceans in Monterey video),
    // presenting its side and back for a broadside landing slap, plus wave-driven flex.
    const wantRoll = this.jumpAirborne
      ? (this.jumpRollSign ?? 1) * 0.92 + Math.sin(this.phase + 0.7) * 0.16
      : clamp(-this.yawRate * this.speed * 0.09, -0.6, 0.6);
    this.roll = lerp(this.roll, wantRoll, 1 - Math.exp(-3.2 * d));

    // Head lead on turns: real sharks & cetaceans turn head and rostrum into the turn.
    // Positive yawRate (turning right) -> positive headYaw (head tilts right into turn).
    const wantHeadYaw = clamp(this.yawRate * 0.62, -0.45, 0.45);
    this.headYaw = lerp(this.headYaw ?? 0, wantHeadYaw, 1 - Math.exp(-4.8 * d));
  }

  /**
   * Player at the helm. Release a key and the last speed / heading / pitch
   * stay put - a cruise, not the ski's "off throttle means stop". L (level)
   * is what flattens a climb; Space is a leap, not a held climb.
   */
  pilot(d, p, keys) {
    const held = (...codes) => codes.some((c) => keys?.has(c));
    const space = held('Space');
    if (space && !this._spaceWasDown && !this.jumping) this.beginJump(p);
    this._spaceWasDown = space;
    if (this.jumping) {

      this.pilotJump(d, p, keys);
      return;

    }

    const throttle = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0);
    const steer = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0);
    const climbIn = (held('KeyE') ? 1 : 0) - (held('KeyQ') ? 1 : 0);
    const boost = held('ShiftLeft', 'ShiftRight') ? 2.6 : 1;

    const top = swimTopSpeed(p);
    this.cruiseSpeed = Math.min(this.cruiseSpeed, top);
    // sdAccel is the AI's 1/s close-rate; as m/s² it is too small, so it is
    // scaled into a long-body shove. A longer animal has a higher top speed,
    // so accel tracks sqrt(length) to keep the same time-to-sprint.
    const L = Math.max(p.sdLength ?? SWIM_REF_LENGTH, 1);
    const acc = Math.max(p.sdAccel, 0.15) * 8 * Math.sqrt(L / SWIM_REF_LENGTH) * boost;
    const loaf = loafSpeed(p);
    if (throttle > 0) this.cruiseSpeed = Math.min(top, this.cruiseSpeed + acc * d);
    else if (throttle < 0) this.cruiseSpeed = Math.max(0, this.cruiseSpeed - acc * 1.35 * d);
    else if (this._lastSdCruise != null && Math.abs((p.sdCruise ?? loaf) - this._lastSdCruise) > 0.05) {
      // Released W/S still HOLDS. Moving the cruise slider is the one
      // input that should retarget that hold — otherwise the knob is
      // dead the moment you press M.
      this.cruiseSpeed = loaf;
    }
    this._lastSdCruise = p.sdCruise ?? loaf;
    this.speed = lerp(this.speed, this.cruiseSpeed, 1 - Math.exp(-2.4 * d));

    const agility = p.sdTurnRate * (0.45 + 0.55 / (1 + this.speed / 12));
    const yawWant = steer * agility;
    this.yawRate = lerp(this.yawRate, yawWant, 1 - Math.exp(-4.5 * d));
    this.heading += this.yawRate * d;

    const pitchRate = p.sdClimb ?? 0.45;
    if (climbIn !== 0) {
      this.pitch = clamp(this.pitch + climbIn * pitchRate * d, -0.72, 0.72);
    }

    const cosp = Math.cos(this.pitch);
    const sinp = Math.sin(this.pitch);
    this.pos[0] += Math.sin(this.heading) * cosp * this.speed * d;
    this.pos[1] += sinp * this.speed * d;
    this.pos[2] += -Math.cos(this.heading) * cosp * this.speed * d;

    const sea = p.sdSeaLevel ?? 0;
    const minY = sea - maxDiveDepth(p);
    const maxY = sea + 8;
    if (this.pos[1] > maxY) {
      this.pos[1] = maxY;
      if (this.pitch > 0) this.pitch *= 0.82;
    } else if (this.pos[1] < minY) {
      this.pos[1] = minY;
      if (this.pitch < 0) this.pitch *= 0.82;
    }
    this.depth = sea - this.pos[1];
    this.cruiseDepth = this.depth;
    this.climb = sinp * this.speed;

    this.advanceSwim(d, p);
    this.express(d, p);
  }

  /** Store cruise speed and depth, then surge forward before the climb. */
  beginJump(p) {
    const L = Math.max(p.sdLength ?? SWIM_REF_LENGTH, 8);
    const top = swimTopSpeed(p);
    const sea = p.sdSeaLevel ?? 0;
    this.jumping = true;
    this.jumpPhase = 'accel';
    this.jumpAirborne = false;
    this.jumpSplashedOut = false;
    this.jumpEntered = false;
    this.jumpAccelT = 0;
    this.jumpHoldY = this.pos[1];
    this.jumpResumeSpeed = this.cruiseSpeed;
    this.jumpResumeDepth = Math.max(0.4, sea - this.pos[1]);
    this.jumpRollSign = Math.sign(this.yawRate) || (Math.sin(this.heading + this.t) >= 0 ? 1 : -1);
    // A hard forward punch so the run-up is a surge, not a nudge the
    // follow camera can miss. Capped by the body's own top speed.
    this.jumpLaunch = Math.min(top, Math.max(this.speed + 10, this.speed * 1.4, 0.46 * L));
    this.jumpApex = 0.18 * L + 5;
    this.jumpVy = 0;
    this.splash = 0;
    this.splashPush = 0;
  }

  /** Stamp a physics-scaled splash at the water contact (landing) or origin (exit). */
  throwSplash(p, landing) {
    const L = Math.max(p.sdLength ?? SWIM_REF_LENGTH, 8);
    // sdSplashExit / sdSplashLand are user gains on the physics hit.
    // 1 is the default. Particle count (sdSplashParticles) is applied
    // later, in three-main.
    // splashKind tells the driver which particle burst it is. The sea
    // over the back is a separate path (uSwellAmp); landing does not
    // write a crater until that look is right.
    const gain = landing ? (p.sdSplashLand ?? 2.04) : (p.sdSplashExit ?? 1.94);
    const hit = splashEnergy(this.jumpVy, this.speed, L, landing) * Math.max(gain, 0);
    this.splash = Math.max(this.splash, hit);
    this.splashPush = Math.max(this.splashPush, landing ? hit : hit * 0.7);
    this.splashHit = hit;
    this.splashAge = 0;
    this.splashKind = landing ? 'land' : 'exit';
    // Landing cavity at the hitting station (pitched nose / tail), not
    // mid-body. An exit still stamps at the origin — the body is leaving
    // along its length and the burst is already origin-sized.
    if ( landing ) {

      const hitAt = waterContactXZ( this, p );
      this.splashX = hitAt.x;
      this.splashZ = hitAt.z;

    } else {

      this.splashX = this.pos[ 0 ];
      this.splashZ = this.pos[ 2 ];

    }
    this.splashHeading = this.heading;
  }

  /**
   * Surge forward at the depth it started, then climb out on a ballistic
   * arc, keep the entry velocity so it sounds as deep as the fall
   * dictates, then buoyancy floats it back to the depth it jumped from.
   */
  pilotJump(d, p, keys) {
    const held = (...codes) => codes.some((c) => keys?.has(c));
    const steer = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0);
    const L = Math.max(p.sdLength ?? SWIM_REF_LENGTH, 8);
    const sea = p.sdSeaLevel ?? 0;
    const g = 11;
    const agility = (p.sdTurnRate ?? 0.55) * 0.55;
    this.yawRate = lerp(this.yawRate, steer * agility, 1 - Math.exp(-4.5 * d));
    this.heading += this.yawRate * d;

    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    this.pos[0] += fx * this.speed * d;
    this.pos[2] += fz * this.speed * d;

    if (this.jumpPhase === 'accel') {
      // Level and forward ONLY. A half-second hold vanished into the
      // follow camera; this has to last long enough that the sea rushing
      // past is the thing you notice, not a hop. No early-out on speed —
      // already-fast still runs the same stretch.
      this.jumpAccelT += d;
      this.speed = lerp(this.speed, this.jumpLaunch, 1 - Math.exp(-5.8 * d));
      this.pitch = lerp(this.pitch, 0, 1 - Math.exp(-6.0 * d));
      this.jumpVy = 0;
      this.pos[1] = this.jumpHoldY;
      this.climb = 0;
      if (this.jumpAccelT >= 1.25) this.jumpPhase = 'rise';
    } else if (this.jumpPhase === 'rise') {
      // The run-up already did the forward punch. Pitch up over a beat
      // so the first metres of climb are still mostly ahead, then the
      // same shove that clears the water and gives the fall its depth.
      this.speed = lerp(this.speed, this.jumpLaunch, 1 - Math.exp(-3.4 * d));
      this.pitch = lerp(this.pitch, 0.55, 1 - Math.exp(-1.7 * d));
      const mass = Math.sqrt(L / SWIM_REF_LENGTH);
      const surge = (14 + 0.28 * L) / mass;
      this.jumpVy += surge * d;
      this.jumpVy += Math.sin(this.pitch) * this.speed * 0.35 * d;
      this.jumpVy -= 0.055 * this.jumpVy * Math.abs(this.jumpVy) * d;
      this.pos[1] += this.jumpVy * d;
      this.climb = this.jumpVy;
      if (!this.jumpSplashedOut && this.pos[1] > sea - 0.12 * L) {
        this.throwSplash(p, false);
        this.jumpSplashedOut = true;
      }
      if (this.pos[1] >= sea) {
        this.jumpPhase = 'air';
        this.jumpAirborne = true;
      }
    } else if (this.jumpPhase === 'air') {
      this.speed = lerp(this.speed, this.jumpLaunch, 1 - Math.exp(-3 * d));
      this.jumpVy -= g * d;
      this.pos[1] += this.jumpVy * d;
      // Trajectory is jumpVy / pos. Pitch only follows the rod, with a
      // lag and a wave-driven flex so the spine still breathes in the air.
      const ballistic = clamp(Math.atan2(this.jumpVy, Math.max(this.speed, 2)), -0.9, 0.9);
      const flex = Math.sin(this.phase) * 0.10;
      this.pitch = lerp(this.pitch, ballistic + flex, 1 - Math.exp(-4.2 * d));
      this.climb = this.jumpVy;
      if (!this.jumpSplashedOut && this.pos[1] > sea - 0.12 * L) {
        this.throwSplash(p, false);
        this.jumpSplashedOut = true;
      }
      if (this.pos[1] >= sea) this.jumpAirborne = true;
      if (this.jumpAirborne && this.pos[1] <= sea && this.jumpVy < 0) {
        this.throwSplash(p, true);
        this.jumpAirborne = false;
        this.jumpEntered = true;
        this.jumpPhase = 'water';
        this.pos[1] = sea - 0.05;
      }
    } else {
      // Neutral in the water: weight and buoyancy cancel, so the leftover
      // fall speed is what sets how deep it goes. Drag bleeds that speed;
      // a spring toward the start depth only comes in once it has slowed,
      // so it sounds, then floats back, instead of bouncing off a floor.
      const targetY = sea - this.jumpResumeDepth;
      const err = this.pos[1] - targetY;
      const mass = Math.sqrt(L / SWIM_REF_LENGTH);
      const gate = clamp(1 - Math.abs(this.jumpVy) / 8, 0, 1);
      this.jumpVy += (-2.8 * err) * gate * d;
      this.jumpVy -= (0.04 / mass) * this.jumpVy * Math.abs(this.jumpVy) * d;
      this.jumpVy -= (0.45 / mass) * this.jumpVy * d;
      // Rising past the start depth is leftover punch, not buoyancy - bleed
      // it so it floats home instead of almost broaching again.
      if (err > -1.2 && this.jumpVy > 0) this.jumpVy -= 3.6 * this.jumpVy * d;
      this.pos[1] += this.jumpVy * d;
      if (this.pos[1] > sea) {
        this.pos[1] = sea - 0.05;
        if (this.jumpVy > 0) this.jumpVy *= 0.25;
      }
      this.speed = lerp(this.speed, this.jumpResumeSpeed, 1 - Math.exp(-1.1 * d));
      this.pitch = lerp(this.pitch, clamp(Math.atan2(this.jumpVy, Math.max(this.speed, 2)), -0.55, 0.45), 1 - Math.exp(-3 * d));
      this.climb = this.jumpVy;
      const settled = Math.abs(this.pos[1] - targetY) < 0.85
        && Math.abs(this.jumpVy) < 1.6
        && Math.abs(this.speed - this.jumpResumeSpeed) < 1.8;
      if (settled) {
        this.jumping = false;
        this.jumpPhase = null;
        this.jumpAirborne = false;
        this.jumpVy = 0;
        this.cruiseSpeed = this.jumpResumeSpeed;
        this.speed = this.jumpResumeSpeed;
        this.pos[1] = targetY;
        this.pitch = 0;
        this.climb = 0;
      }
    }

    const minY = sea - maxDiveDepth(p);
    if (this.pos[1] < minY) {
      this.pos[1] = minY;
      if (this.jumpVy < 0) this.jumpVy *= 0.35;
    }
    this.depth = sea - this.pos[1];
    this.cruiseDepth = this.depth;
    this.advanceSwim(d, p);
    this.express(d, p);
  }

  /** Flatten pitch so it holds the depth it is at - no climb, no dive. */
  level() {
    if (this.jumping) {
      this.jumping = false;
      this.jumpPhase = null;
      this.jumpAirborne = false;
      this.jumpVy = 0;
      this.cruiseSpeed = this.jumpResumeSpeed;
      this.speed = this.jumpResumeSpeed;
    }
    this.pitch = 0;
    this.climb = 0;
  }

  /**
   * @param {number} dt
   * @param {object} p       params
   * @param {object|null} veh  the active vehicle, or null when nobody is riding
   * @param {object} camera
   */
  update(dt, p, veh, camera) {
    const d = Math.min(dt, 1 / 20);
    this.t += d;
    if (!this._primed) this.reset(camera, p);
    // THE SPLASH CLOCK RUNS IN EITHER MODE. It used to live in pilot(), so
    // handing control back to the AI mid-landing froze splashAge - and a frozen
    // age under the 7 s window leaves the crater, the jet and the raft standing
    // in the sea for good (three-main.js's splashLive). Only pilot() can START
    // a leap; nothing says only pilot() can finish one.
    // sdSplashLife stretches how long splash / splashPush stay up (the
    // emitter hold in three-main). splashAge still ticks in seconds; the
    // field and the spout remap it there so the jet stays in sync.
    const splashLife = Math.max(p.sdSplashLife ?? 0.65, 0.15);
    this.splash = Math.max(0, this.splash - d * 1.8 / splashLife);
    this.splashPush = Math.max(0, this.splashPush - d * 0.7 / splashLife);
    this.splashAge += d;
    if (this.active) {

      this.pilot(d, p, camera?.keys);
      return;

    }

    // ---- the station it is trying to hold --------------------------------
    //
    // Off one shoulder and slightly ahead. AHEAD matters: a station level with
    // you is one you never catch up to the sight of, and a dragon you can only
    // see by looking sideways is a dragon most riders never notice. Half a body
    // length forward puts it in the frame of a chase camera.
    const half = Math.max(p.sdLength, 4) * 0.5;
    const off = Math.max(p.sdOffset, half * 0.6);
    const vs = veh ? Math.abs(veh.speed ?? 0) : 0;
    // NOTHING THIS SIZE HOVERS. Below a walking pace there is no station to
    // hold - matching a stopped ski means stopping, and a twenty-metre animal
    // parked in the water looks like a prop. So the station becomes an ORBIT:
    // stop, and it circles you instead, which is both what a curious sea animal
    // does and the thing that makes it worth stopping for.
    // Hysteresis on the threshold, not a bare compare: idling around 3 m/s
    // otherwise flips it between orbit and station several times a second, and
    // each flip re-picks the shoulder and throws a new heading at it.
    const pacing = veh !== null && vs > (this.pacing ? 2.0 : 3.0);
    let gx, gz, want, matchTo;
    if (pacing) {
      const h = veh.heading ?? 0;
      const fx = Math.sin(h), fz = -Math.cos(h);
      const rx = Math.cos(h), rz = Math.sin(h);
      // Take the near shoulder when it starts pacing, so it slides onto station
      // instead of crossing your bow to reach the far one.
      if (!this.pacing) {
        const dl = Math.hypot(veh.pos[0] - rx * off - this.pos[0], veh.pos[2] - rz * off - this.pos[2]);
        const dr = Math.hypot(veh.pos[0] + rx * off - this.pos[0], veh.pos[2] + rz * off - this.pos[2]);
        this.side = dr < dl ? 1 : -1;
      }
      // ...and closes in as you push it, down to sdOffsetClose.
      const rushIn = clamp((vs - 4) / Math.max(p.sdRushSpeed - 4, 1), 0, 1);
      const stand = lerp(off, Math.max(p.sdOffsetClose, half * 0.45), rushIn);
      gx = veh.pos[0] + rx * this.side * stand + fx * p.sdLead;
      gz = veh.pos[2] + rz * this.side * stand + fz * p.sdLead;
      matchTo = vs;
    } else {
      // Circling: around you if you are aboard and idling, around the camera if
      // nobody is riding at all - so the ocean is never empty and the animal is
      // still there when you do press R.
      const cx = veh ? veh.pos[0] : (camera?.pos?.[0] ?? 0);
      const cz = veh ? veh.pos[2] : (camera?.pos?.[2] ?? 0);
      // Path speed is Dragon cruise, not sdOrbit. The old fixed rad/s
      // made the station crawl the same circle no matter the slider —
      // raising cruise only made it weave around a point that never
      // went any farther.
      const r = off * (veh ? 1.5 : 2.4);
      matchTo = loafSpeed(p);
      this.wanderAngle += d * (r > 0.5 ? matchTo / r : (p.sdOrbit ?? 0.2));
      gx = cx + Math.cos(this.wanderAngle) * r;
      gz = cz + Math.sin(this.wanderAngle) * r;
    }
    this.pacing = pacing;

    // ---- steering ---------------------------------------------------------
    const dx = gx - this.pos[0], dz = gz - this.pos[2];
    const gap = Math.hypot(dx, dz);
    const bearing = Math.atan2(dx, -dz);
    let turn = bearing - this.heading;
    while (turn > Math.PI) turn -= TAU;
    while (turn < -Math.PI) turn += TAU;

    // Bounded yaw rate, and it tightens as it slows - a body this long cannot
    // pivot at speed, which is also what keeps it from snapping round when you
    // carve. Reported in the ski as the difference between a vehicle and a
    // cursor; the same applies to an animal.
    const agility = p.sdTurnRate * (0.45 + 0.55 / (1 + this.speed / 12));
    const yawWant = clamp(turn / Math.max(d, 1e-3), -agility, agility);
    this.yawRate = lerp(this.yawRate, yawWant, 1 - Math.exp(-4.5 * d));
    this.heading += this.yawRate * d;

    // ---- speed ------------------------------------------------------------
    // Escort: close the gap, then match the hull. Orbit: swim AT cruise.
    // The old +gap*0.35 on a circling animal shoved it to top speed
    // whenever it lagged the station, so the cruise slider did nothing.
    if (pacing) {
      want = clamp(matchTo + gap * 0.35, 0, swimTopSpeed(p));
      if (gap < half * 0.5) want = Math.min(want, matchTo * 1.02);
    } else {
      want = matchTo + Math.min(gap * 0.12, matchTo * 0.25);
    }
    this.speed = lerp(this.speed, want, 1 - Math.exp(-p.sdAccel * d));

    this.pos[0] += Math.sin(this.heading) * this.speed * d;
    this.pos[2] += -Math.cos(this.heading) * this.speed * d;

    // ---- depth ------------------------------------------------------------
    // It rises and sounds on a slow cycle, so it comes up into view and fades
    // back down instead of hanging at one depth like a decal. Never nearer the
    // surface than sdMinDepth: the renderer discards anything that breaches.
    const swing = Math.sin(this.t * 0.21) * 0.5 + Math.sin(this.t * 0.07 + 1.3) * 0.5;
    // IT COMES UP WHEN YOU GO FAST. Depth is what decides whether you can see it
    // at all - the sea eats it over sdFade metres - so an animal holding station
    // at cruising depth is one you never actually meet. Riding hard brings it up
    // to just under the surface and pulls it in off your shoulder, which is both
    // the thing worth chasing and the only way the shape reads at speed.
    const rush = veh ? clamp((vs - 4) / Math.max(p.sdRushSpeed - 4, 1), 0, 1) : 0;
    const base = lerp(p.sdDepth, p.sdMinDepth + 0.3, rush);
    const wantDepth = Math.max(p.sdMinDepth, base + swing * p.sdDepthSwing * (1 - rush * 0.7));
    const prevY = this.pos[1];
    this.depth = lerp(this.depth, wantDepth, 1 - Math.exp(-0.7 * d));
    this.pos[1] = (p.sdSeaLevel ?? 0) - this.depth;
    // Nose up or down onto the depth it is taking, so a climb looks like one.
    const climb = (this.pos[1] - prevY) / Math.max(d, 1e-3);
    this.pitch = lerp(this.pitch, clamp(Math.atan2(climb, Math.max(this.speed, 2)), -0.5, 0.5), 1 - Math.exp(-3 * d));
    // Persisted, not just local: three-main.js reads it to throw a one-shot
    // burst of spray at the MOMENT it actually breaks the surface, the same
    // "impact" concept demo/waverunner.js and demo/seaplane.js already use for
    // a hard landing or a wingtip touch, rather than the continuous sheet
    // dragonSpray drives on its own (which reads as foam, not spray).
    this.climb = climb;

    this.advanceSwim(d, p);
    this.express(d, p);
  }

  /** How far it is from a point, on the water's plane. */
  distanceTo(x, z) {
    return Math.hypot(this.pos[0] - x, this.pos[2] - z);
  }

}
