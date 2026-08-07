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

export function createBoatController({ ctx, input, water, terrain }) {
  const b = ctx.boat;
  b.position.set(-6, 0, 24);
  b.heading = 0.05;

  const n = new THREE.Vector3();
  let heelTarget = 0, trimTarget = 0;
  let wakeAccum = 0;

  function surfaceAt(x, z, t) {
    const w = water?.();
    return w?.sampleHeight ? w.sampleHeight(x, z, t) : waveHeight(x, z, t);
  }

  return {
    teleport(x, z, heading = b.heading) {
      b.position.x = x; b.position.z = z; b.heading = heading; b.speed = 0;
    },

    update(ctx) {
      const dt = ctx.dt;
      const throttleIn = input.axis('forward');
      const turnIn = input.axis('turn');
      const boost = input.isDown('ShiftLeft') || input.isDown('ShiftRight') ? 1.35 : 1;

      b.throttle += (throttleIn - b.throttle) * Math.min(1, dt * 3.2);
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
      b.turnRate += (-turnIn * authority * dir - b.turnRate) * Math.min(1, dt * 4.5);
      b.heading += b.turnRate * dt;

      b.forward.set(Math.sin(b.heading), 0, -Math.cos(b.heading));
      b.right.set(b.forward.z, 0, -b.forward.x);

      b.position.x += b.forward.x * b.speed * dt;
      b.position.z += b.forward.z * b.speed * dt;

      // Keep her off the beach.
      if (terrain?.seabedHeight) {
        const depth = -terrain.seabedHeight(b.position.x, b.position.z);
        if (depth < 1.1) {
          const eps = 1.5;
          const gx = terrain.seabedHeight(b.position.x + eps, b.position.z) - terrain.seabedHeight(b.position.x - eps, b.position.z);
          const gz = terrain.seabedHeight(b.position.x, b.position.z + eps) - terrain.seabedHeight(b.position.x, b.position.z - eps);
          const l = Math.hypot(gx, gz) || 1;
          const push = (1.1 - depth) * 2.2;
          b.position.x += (gx / l) * push * dt * 8;
          b.position.z += (gz / l) * push * dt * 8;
          b.speed *= 1 - Math.min(0.9, (1.1 - depth) * dt * 6);
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
        - Math.min(0.05, Math.abs(b.speed) * 0.006);
      heelTarget = -b.turnRate * Math.min(1, Math.abs(b.speed) / 5) * 0.42
        + n.x * b.right.x * 0.5 + n.z * b.right.z * 0.5;

      b.trim += (trimTarget - b.trim) * Math.min(1, dt * 5);
      b.heel += (heelTarget - b.heel) * Math.min(1, dt * 4);

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
