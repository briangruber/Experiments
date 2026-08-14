// The sea dragon's behaviour: where it is, where it is going, and how hard its
// tail is beating.
//
// This is not a physics body and does not pretend to be one. It is a PURSUIT
// MODEL - a station to hold relative to whatever you are riding, a heading that
// turns toward it at a bounded rate, and a speed that closes the gap and then
// matches yours. That is the whole trick behind "swim fast next to our wave
// runner so we can ride up next to it": the animal is not wandering the ocean
// hoping you find it, it is holding a station off your shoulder and keeping it.
//
// Three things it must never do, each of which is a line below rather than a
// note here: surface (the renderer composites it INTO the sea, so a breaching
// fragment is water that is no longer over it - see src/gpu/tsl/creature.js),
// snap round when you turn hard (bounded yaw rate), or sit exactly on your line
// where you would ride through it.

import { clamp, lerp, v3 } from '../src/math.js';

const TAU = Math.PI * 2;

export class SeaDragon {

  constructor() {
    this.pos = v3(0, -6, 0);
    this.heading = 0;
    this.speed = 0;
    this.roll = 0;               // banks into its turns, like anything that swims
    this.pitch = 0;
    this.yawRate = 0;
    this.phase = 0;              // the body wave, radians
    this.depth = 6;              // below the mean surface, metres
    this.side = 1;               // which shoulder it is holding
    this.pacing = false;         // holding station, or circling
    this.gape = 0;               // 0 shut, 1 as wide as the mesh was modelled
    this.t = 0;
    this.wanderAngle = 0;
    this._primed = false;
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
    this.speed = 0; this.roll = 0; this.pitch = 0; this.yawRate = 0;
    this.t = 0; this.wanderAngle = h; this.pacing = false; this.gape = 0;
    this._primed = true;
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
      gx = veh.pos[0] + rx * this.side * off + fx * p.sdLead;
      gz = veh.pos[2] + rz * this.side * off + fz * p.sdLead;
      matchTo = vs;
    } else {
      // Circling: around you if you are aboard and idling, around the camera if
      // nobody is riding at all - so the ocean is never empty and the animal is
      // still there when you do press R.
      const cx = veh ? veh.pos[0] : (camera?.pos?.[0] ?? 0);
      const cz = veh ? veh.pos[2] : (camera?.pos?.[2] ?? 0);
      this.wanderAngle += d * p.sdOrbit;
      const r = off * (veh ? 1.5 : 2.4);
      gx = cx + Math.cos(this.wanderAngle) * r;
      gz = cz + Math.sin(this.wanderAngle) * r;
      matchTo = p.sdSpeed * 0.30;
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
    // Close the gap, then match. The +gap term is what lets it CATCH you when
    // you pull away, capped so it never teleports up alongside.
    want = clamp(matchTo + gap * 0.35, 0, p.sdSpeed);
    // Backing off when it is nearly there stops the station-keeping from
    // turning into a shunt every time you slow down.
    if (gap < half * 0.5) want = Math.min(want, matchTo * 1.02);
    this.speed = lerp(this.speed, want, 1 - Math.exp(-p.sdAccel * d));

    this.pos[0] += Math.sin(this.heading) * this.speed * d;
    this.pos[2] += -Math.cos(this.heading) * this.speed * d;

    // ---- depth ------------------------------------------------------------
    // It rises and sounds on a slow cycle, so it comes up into view and fades
    // back down instead of hanging at one depth like a decal. Never nearer the
    // surface than sdMinDepth: the renderer discards anything that breaches.
    const swing = Math.sin(this.t * 0.21) * 0.5 + Math.sin(this.t * 0.07 + 1.3) * 0.5;
    const wantDepth = Math.max(p.sdMinDepth, p.sdDepth + swing * p.sdDepthSwing);
    const prevY = this.pos[1];
    this.depth = lerp(this.depth, wantDepth, 1 - Math.exp(-0.7 * d));
    this.pos[1] = (p.sdSeaLevel ?? 0) - this.depth;
    // Nose up or down onto the depth it is taking, so a climb looks like one.
    const climb = (this.pos[1] - prevY) / Math.max(d, 1e-3);
    this.pitch = lerp(this.pitch, clamp(Math.atan2(climb, Math.max(this.speed, 2)), -0.5, 0.5), 1 - Math.exp(-3 * d));

    // ---- the body ---------------------------------------------------------
    // Tail beat rises with speed: a cruising animal is a slow sweep, a sprinting
    // one is a blur. sdBeat is beats per second at rest, sdBeatSpeed the extra
    // per metre per second.
    this.phase += (p.sdBeat + this.speed * p.sdBeatSpeed) * TAU * d;
    if (this.phase > TAU * 1024) this.phase -= TAU * 1024;
    // The mouth. Shut by default - the mesh was modelled with it open, and a
    // predator that swims permanently gaping looks like a model, which is
    // exactly how it was reported. It opens on a slow, irregular cycle and
    // opens WIDER when it is sprinting, so the gape reads as effort.
    const drive = Math.sin(this.t * 0.37) * 0.6 + Math.sin(this.t * 0.13 + 2.1) * 0.4;
    // wantGape, not `want`: there is already a `want` in this scope for the
    // speed, and redeclaring it is a SyntaxError that stops the whole app from
    // booting. It cost three checks that "timed out" before one was run alone
    // and said so.
    const wantGape = Math.max(0, drive - 0.55) / 0.45;      // open maybe a fifth of the time
    const eager = clamp(this.speed / Math.max(p.sdSpeed, 1), 0, 1);
    this.gape = lerp(this.gape, clamp(wantGape * (0.45 + 0.55 * eager), 0, 1), 1 - Math.exp(-3.5 * d));

    // Bank into the turn, the way anything with fins does.
    this.roll = lerp(this.roll, clamp(-this.yawRate * this.speed * 0.09, -0.6, 0.6), 1 - Math.exp(-3 * d));
  }

  /** How far it is from a point, on the water's plane. */
  distanceTo(x, z) {
    return Math.hypot(this.pos[0] - x, this.pos[2] - z);
  }

}
