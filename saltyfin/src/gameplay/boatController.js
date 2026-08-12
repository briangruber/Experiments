// Boat physics. Not a rigid-body sim — a hull that rides the wave field, leans
// into its turns, squats under throttle and keeps a little way on when you let
// go, which is all the fidelity a cosy fishing boat needs.

import * as THREE from 'three';
import { waveHeight, waveNormal } from '../water/waves.js';

const MAX_SPEED = 9.2;        // m/s flat out
const REVERSE_SPEED = 3.0;
const ACCEL = 4.6;
const DRAG = 0.72;
const TURN_RATE = 1.15;       // rad/s at speed
const TURN_AT_REST = 0.30;

// How much water she needs under her, and the fastest she will ever be refloated.
// The cap is the important one: it is what keeps a grounding a nudge rather than a
// teleport, and a teleport resamples the seabed gradient somewhere unrelated, which
// is what made a grounded boat shake itself apart.
const DRAFT = 1.1;
const REFLOAT_MAX = 4.0;      // m/s

export function createBoatController({ ctx, input, water, terrain }) {
  const b = ctx.boat;
  b.position.set(-6, 0, 24);
  b.heading = 0.05;

  const n = new THREE.Vector3();
  let heelTarget = 0, trimTarget = 0;
  let wakeAccum = 0;
  // Sideways way through the water, from the harpoon line. The hull normally
  // only moves along its heading; a rope pulling on the bow is the one thing
  // in the game that shoves her bodily, so it gets its own velocity that the
  // keel then kills. Exposed on ctx.boat as towDrift for anything that needs
  // the hull's true velocity (the rope's damping does).
  const drift = new THREE.Vector2();
  b.towDrift = drift;

  function surfaceAt(x, z, t) {
    const w = water?.();
    return w?.sampleHeight ? w.sampleHeight(x, z, t) : waveHeight(x, z, t);
  }

  // The latched throttle setpoint, 0..1. Forward only: reverse is a
  // manoeuvring gear and stays held-only.
  let cruise = 0;

  return {
    teleport(x, z, heading = b.heading) {
      b.position.x = x; b.position.z = z; b.heading = heading; b.speed = 0;
      drift.set(0, 0);
    },

    update(ctx) {
      const dt = ctx.dt;
      // The helm stands down while fishing, and while you are ashore. These
      // are flags read here rather than those modules writing throttle from
      // outside, because there has to be ONE owner of the hull — and W/S mean
      // "work the lure" down there and "walk" up on the quay, so without this
      // a jig would also drive the boat off the fish and a stroll across the
      // square would take the boat with it.
      const hold = !!ctx.fishingHold || !!ctx.shoreHold || !!ctx.editorHold || !!ctx.harpoonHold;

      // CRUISE. The throttle latches where you leave it, so the boat can be
      // set to a lazy putter and steered with one thumb while the other holds
      // a drink. The old helm was momentary — release W or the stick and the
      // boat sighed to a stop — which turns "gently boating around" into a
      // dead-man's switch you hold for the whole voyage.
      //
      //   push forward   the setpoint chases the stick (or walks up under W,
      //                  which always reads 1), so a half-deflection cruises
      //                  at half and a tap of W nudges the speed up a notch
      //   release        the setpoint stays — that is the whole feature
      //   pull back      brakes NOW (the negative goes straight to the prop)
      //                  while the setpoint unwinds; let go early and you
      //                  keep the lower cruise, hold on through zero and you
      //                  are in reverse — which is momentary, never latched,
      //                  because nobody means to cruise backwards
      //
      // The fishing and shore holds also clear the setpoint: coming back from
      // a catch or a walk ashore to a boat that quietly takes off on its own
      // remembered throttle is a horror film, not a convenience.
      const raw = hold ? 0 : input.axis('forward');
      // A physical lever is already a latch: where the thumb leaves it is the
      // order, neutral means neutral, and running the cruise logic on top of
      // it would mean pulling back to neutral kept the boat cruising — which
      // is not what a throttle does on any boat ever built.
      if (input.hasLever) {
        cruise = hold ? 0 : Math.max(0, raw);
      } else if (hold) cruise = 0;
      else if (raw > 0.02) cruise += (raw - cruise) * Math.min(1, dt * 1.1);
      // The unwind is deliberately slower than the brake. The brake itself is
      // immediate — the negative goes straight to the prop above — so this
      // rate only decides how much CRUISE a moment of braking costs. At 0.9/s
      // a one-second pull-back erased a 0.66 setpoint entirely (measured);
      // 0.45/s leaves about a third of it, which is what "ease off a little"
      // should mean. Stopping outright is just holding the brake on.
      else if (raw < -0.02) cruise = Math.max(0, cruise - dt * 0.45);
      const throttleIn = raw < -0.02 ? raw : cruise;
      const turnIn = hold ? 0 : input.axis('turn');
      // Shift is the throttle wide open. It was 1.35x, which on a hull that
      // already accelerates over about three seconds is a change you have to
      // look at the speed readout to notice — and a "go faster" key you cannot
      // feel is a key that does not exist. 1.9x is 17.5 m/s, fast enough that
      // the boat plainly picks up its skirts, and it drives the wake and the
      // prop wash harder along with it because both key off speed.
      // No boost on the line: 17.5 m/s against a rope that parts at a
      // sustained overload turns "full throttle away", the taught winning
      // technique, into a guaranteed snap in 2.5 seconds. The engine simply
      // has a rope's worth of grip while one is made fast.
      const boost = !hold && !ctx.lineOut
        && (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) ? 1.9 : 1;

      b.throttle += (throttleIn - b.throttle) * Math.min(1, dt * (boost > 1 ? 4.6 : 3.2));
      const target = b.throttle >= 0
        ? b.throttle * MAX_SPEED * boost
        : b.throttle * REVERSE_SPEED;

      const accel = Math.abs(target) > Math.abs(b.speed) ? ACCEL : ACCEL * 1.6;
      const before = b.speed;
      b.speed += (target - b.speed) * Math.min(1, dt * accel * 0.42);
      b.speed -= b.speed * DRAG * dt * 0.25;

      // Steering authority scales with way through the water; a stopped boat
      // can still swing on the outboard, just slowly.
      const authority = TURN_AT_REST + (TURN_RATE - TURN_AT_REST) * Math.min(1, Math.abs(b.speed) / 4.5);
      const dir = b.speed < -0.05 ? -1 : 1;
      // Heading grows clockwise and forward is (sin h, 0, -cos h), so a positive
      // heading rate IS a turn to starboard. Negating the input here put the
      // helm the wrong way round: pressing right turned left.
      b.turnRate += (turnIn * authority * dir - b.turnRate) * Math.min(1, dt * 4.5);
      b.heading += b.turnRate * dt;

      b.forward.set(Math.sin(b.heading), 0, -Math.cos(b.heading));
      b.right.set(b.forward.z, 0, -b.forward.x);

      b.position.x += b.forward.x * b.speed * dt;
      b.position.z += b.forward.z * b.speed * dt;

      // THE LINE. ctx.tow is written by the harpoon module each frame it is
      // taut and null otherwise: a horizontal force (m/s^2 on this hull), a
      // yaw rate (the rope leads over the bow, so tension off-axis swings her
      // nose toward the pull), and heel/trim/sink terms that ride on top of
      // the wave-driven targets below. The drift is what makes being DRAGGED
      // read: way the keel did not choose, decayed by the keel at ~1.4/s, so
      // a hard yank slides her metres before she answers her own helm again.
      const tow = ctx.tow;
      if (tow) {
        drift.x += (tow.fx || 0) * dt;
        drift.y += (tow.fz || 0) * dt;
        b.heading += (tow.yaw || 0) * dt;
        b.speed -= b.speed * Math.min(0.9, (tow.brake || 0) * dt);
      }
      const keel = Math.exp(-dt * 1.4);
      drift.x *= keel;
      drift.y *= keel;
      if (drift.lengthSq() > 1e-8) {
        b.position.x += drift.x * dt;
        b.position.z += drift.y * dt;
      }

      // Keep her off the beach.
      //
      // seabedHeight is NEGATIVE below water and positive on dry land, so its
      // gradient points UPHILL — toward the sand. The first version of this
      // pushed along +gradient, which drove her further aground the instant she
      // touched, and the shove was unbounded, so once the seabed rose above
      // water it grew with every metre she climbed. Measured by driving her
      // north into the village island: she touched sand at z=33 and was 26 m
      // inland twelve frames later, after which she jittered twenty metres a
      // frame across the hilltop with her speed pinned near zero and reverse
      // doing nothing. That is the "stuck on a shallow area, shakes violently,
      // cannot move" a player reported.
      //
      // So: downhill, bounded, and the damping only bites when she is actually
      // driving into the shallows — otherwise backing off is impossible, which
      // is the half of the bug that turns a grounding into a dead end.
      if (terrain?.seabedHeight) {
        const depth = -terrain.seabedHeight(b.position.x, b.position.z);
        if (depth < DRAFT) {
          // The tow drift is way the keel did not choose, and aground it is
          // way the SAND now owns: scrub it hard, or a leviathan dragging
          // the hull across a shoal reintroduces the grounded-shake this
          // whole block exists to prevent.
          drift.multiplyScalar(Math.max(0, 1 - dt * 6));
          // Widen the baseline the further aground she is. A 1.5 m sample reads
          // the bump she is sitting on, and a hillside has plenty of local
          // basins for that to settle into — dropped in the middle of the
          // village island she walked four metres downhill and then stopped
          // dead on a shelf. At 24 m the gradient is the shape of the island
          // rather than the shape of the ground under her, and that always
          // leads to water.
          const eps = depth < 0 ? Math.min(24, 1.5 + (-depth) * 0.8) : 1.5;
          const gx = terrain.seabedHeight(b.position.x + eps, b.position.z) - terrain.seabedHeight(b.position.x - eps, b.position.z);
          const gz = terrain.seabedHeight(b.position.x, b.position.z + eps) - terrain.seabedHeight(b.position.x, b.position.z - eps);
          const l = Math.hypot(gx, gz);
          // A flat shoal has no downhill to offer. Backing her out the way she
          // came is always available and always right, so it is the fallback.
          const nx = l > 1e-4 ? -gx / l : -b.forward.x;
          const nz = l > 1e-4 ? -gz / l : -b.forward.z;
          // Metres per second, capped. Uncapped, a boat somehow placed inland
          // teleports rather than refloats, and a teleport resamples the
          // gradient somewhere unrelated — which is the shaking.
          const shove = Math.min((DRAFT - depth) * 3.0, REFLOAT_MAX);
          b.position.x += nx * shove * dt;
          b.position.z += nz * shove * dt;
          // Only scrub way off if she is still headed uphill. Sign here is what
          // lets the player reverse out under their own power.
          const uphill = l > 1e-4 ? (b.forward.x * gx + b.forward.z * gz) / l : 0;
          if (uphill * b.speed > 0) {
            b.speed *= 1 - Math.min(0.7, (DRAFT - depth) * Math.abs(uphill) * 2.5 * dt);
          }
        }
      }

      // Ride the surface: sample three points along the hull so she pitches
      // over a swell instead of floating through it.
      const t = ctx.time;
      const bow = surfaceAt(b.position.x + b.forward.x * 2.0, b.position.z + b.forward.z * 2.0, t);
      const stern = surfaceAt(b.position.x - b.forward.x * 2.0, b.position.z - b.forward.z * 2.0, t);
      const mid = surfaceAt(b.position.x, b.position.z, t);
      b.position.y += ((mid - 0.03) - b.position.y) * Math.min(1, dt * 9);

      waveNormal(b.position.x, b.position.z, t, n);
      const waveTrim = Math.atan2(bow - stern, 4.0);
      const accelTrim = (b.speed - before) / Math.max(dt, 1e-3);
      trimTarget = -waveTrim - THREE.MathUtils.clamp(accelTrim * 0.012, -0.06, 0.06)
        - Math.min(0.05, Math.abs(b.speed) * 0.006)
        + (tow ? tow.trim || 0 : 0);
      heelTarget = -b.turnRate * Math.min(1, Math.abs(b.speed) / 5) * 0.42
        + n.x * b.right.x * 0.5 + n.z * b.right.z * 0.5
        + (tow ? tow.heel || 0 : 0);

      b.trim += (trimTarget - b.trim) * Math.min(1, dt * 5);
      b.heel += (heelTarget - b.heel) * Math.min(1, dt * (tow && tow.heel ? 6 : 4));
      // A line pulling DOWN shortens her freeboard. The ride-height lerp above
      // pulls y toward the surface at dt*9; subtracting sink at the SAME rate
      // makes the equilibrium exactly `surface - sink`, so sink is in honest
      // metres — 0.4 is a wetted bow, 1.5 is green water over the foredeck.
      if (tow && tow.sink) {
        b.position.y -= Math.min(2.2, tow.sink) * Math.min(1, dt * 9);
      }

      b.wakeStrength = THREE.MathUtils.clamp(Math.abs(b.speed) / MAX_SPEED, 0, 1);

      // Stamp the ripple sim behind the transom at a fixed spacing so the wake
      // does not thin out when the frame rate does.
      const w = water?.();
      if (w?.disturb) {
        wakeAccum += Math.abs(b.speed) * dt;
        while (wakeAccum > 0.45) {
          wakeAccum -= 0.45;
          w.disturb(
            b.position.x - b.forward.x * 2.3,
            b.position.z - b.forward.z * 2.3,
            0.55 + 0.45 * b.wakeStrength,
            1.5 + 2.0 * b.wakeStrength,
          );
        }
      }
    },
  };
}
