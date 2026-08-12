// The camera rig. The concept art frames the boat low-centre with the horizon
// a little above the middle, close enough to read the fisher's hat and far
// enough to see the wake and whatever is moving under the water — so the rig is
// a high, slightly long chase with a soft spring and no roll.
//
// `setSpec` exists for the capture harness: named framings, or an explicit
// position so a screenshot can be reproduced exactly.

import * as THREE from 'three';

const SPECS = {
  chase: { distance: 12.5, height: 5.0, lookAhead: 7.0, lookHeight: 1.1, fov: 46 },
  close: { distance: 8.5, height: 3.1, lookAhead: 5.0, lookHeight: 1.0, fov: 48 },
  wide: { distance: 20.0, height: 9.5, lookAhead: 10.0, lookHeight: 0.4, fov: 44 },
  // The harbour establishing shot from the first piece of concept art: high and
  // wide, but only about ten degrees of downward pitch — steeper than that and
  // the horizon leaves the frame and it stops being a seascape.
  harbor: { distance: 30.0, height: 11.0, lookAhead: 16.0, lookHeight: 2.2, fov: 58 },
  // The shot where the leviathan's shadow shows. High and steep, but not
  // vertical: ref/04 is about 50 degrees down, which also keeps the rig clear of
  // the straight-down case where lookAt has no up vector to work with.
  overhead: { distance: 26.0, height: 34.0, lookAhead: 12.0, lookHeight: -12.0, fov: 48 },
};

// Touch and mouse want different numbers, and the difference is not taste. A
// thumb's drag is coarser and there is no way to nudge a view back with the
// other hand, so on a phone the camera is gentler, its pitch is fenced in more
// tightly, and it returns behind the boat by itself.
const TOUCH = typeof matchMedia === 'function'
  && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0);

const ORBIT_GAIN = TOUCH ? 0.0021 : 0.0035;
const PITCH_GAIN = TOUCH ? 0.0016 : 0.0025;
// A phone screen is tall, so a camera that can dip toward the horizon puts the
// boat in the bottom eighth of it and the sea in the other seven. Keeping the
// low end higher is what makes the water the subject.
const PITCH_MIN = TOUCH ? -0.22 : -0.5;
const PITCH_MAX = TOUCH ? 0.75 : 0.9;
const PITCH_REST = TOUCH ? 0.06 : 0;
const ZOOM_MIN = TOUCH ? 0.70 : 0.55;
const ZOOM_MAX = TOUCH ? 1.9 : 2.4;
const RECENTRE_WAIT = TOUCH ? 1.1 : 2.6;
const RECENTRE_RATE = TOUCH ? 1.5 : 0.9;

export function createChaseCamera({ ctx, camera, input }) {
  const pos = new THREE.Vector3(0, 6, 18);
  const look = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const target = new THREE.Vector3();
  const up = new THREE.Vector3();

  let spec = { ...SPECS.chase };
  let cruise = 0;         // 1 when pottering, 0 at speed; smoothed
  let orbit = 0;          // extra yaw from the mouse
  let orbitPitch = 0;
  let zoom = 1;
  let idle = 0;          // seconds since the last drag, for the auto-recentre
  let first = true;
  let fixed = null;       // { position, target } for reproducible captures

  const params = new URLSearchParams(location.search);
  if (params.has('cam')) {
    const raw = params.get('cam');
    if (SPECS[raw]) spec = { ...SPECS[raw] };
    else {
      const p = raw.split(',').map(Number);
      if (p.length >= 6 && p.every((v) => Number.isFinite(v))) {
        fixed = {
          position: new THREE.Vector3(p[0], p[1], p[2]),
          target: new THREE.Vector3(p[3], p[4], p[5]),
        };
        if (p[6]) spec.fov = p[6];
      } else if (p.length >= 2) {
        // "orbit,<yawDeg>,<height>"
        orbit = THREE.MathUtils.degToRad(p[0] || 0);
        if (p[1]) spec.height = p[1];
      }
    }
  }

  camera.fov = spec.fov;
  camera.updateProjectionMatrix();

  return {
    setSpec(s) {
      if (typeof s === 'string' && SPECS[s]) spec = { ...SPECS[s] };
      else if (s && typeof s === 'object') Object.assign(spec, s);
      camera.fov = spec.fov;
      camera.updateProjectionMatrix();
      first = true;
    },
    get spec() { return spec; },

    update(ctx) {
      const b = ctx.boat;

      if (fixed) {
        camera.position.copy(fixed.position);
        camera.lookAt(fixed.target);
        return;
      }

      // Drag right, look right — the same sense as the helm, so the two never
      // disagree about which way is starboard.
      //
      // A thumb is not a mouse. On a phone the same gain that feels precise
      // under a cursor sends the camera spinning, because a thumb travels
      // further and lands with more slop; and there is no second hand free to
      // put the view back, so wherever a drag leaves it is where it stays. That
      // is the whole problem with the old rig on mobile — one careless swipe
      // and you are driving blind, sideways, permanently.
      const dragging = !!input?.pointer.down;
      if (dragging) {
        orbit += input.pointer.dx * ORBIT_GAIN;
        orbitPitch = THREE.MathUtils.clamp(
          orbitPitch - input.pointer.dy * PITCH_GAIN, PITCH_MIN, PITCH_MAX);
        idle = 0;
      } else {
        idle += ctx.dt;
      }
      if (input?.pointer.wheel) zoom = THREE.MathUtils.clamp(zoom + input.pointer.wheel * 0.08, ZOOM_MIN, ZOOM_MAX);

      // Ease back behind the boat once the thumb has been off the glass for a
      // moment. RECENTRE_WAIT is long enough to look at something deliberately
      // and short enough that you never have to think about undoing a swipe.
      // It also eases rather than snaps, and it eases FASTER the further out of
      // true it is, so a small deliberate offset survives noticeably longer
      // than a wild one.
      if (!dragging && idle > RECENTRE_WAIT) {
        const t = Math.min(1, ctx.dt * (RECENTRE_RATE + Math.abs(orbit) * 0.9));
        orbit -= orbit * t;
        orbitPitch -= (orbitPitch - PITCH_REST) * t;
      }

      // The gentle-cruise frame — now the other way round. Under about
      // 3.5 m/s the rig eases BACK and UP, so a boat sitting still is shot
      // wide: you can see the water she is drifting on, what is under it and
      // what is coming, which is what a player stopped in the middle of a
      // lagoon actually wants. Opening the throttle draws the camera back in
      // behind her, where a travelling shot belongs. `cruise` is smoothed so
      // crossing the threshold never bumps the frame, and a slow breathing
      // sway rides on top of it, too small to notice directly and just enough
      // that a stopped frame is never dead still.
      const cruiseWant = 1 - THREE.MathUtils.smoothstep(Math.abs(b.speed), 1.2, 3.8);
      cruise += (cruiseWant - cruise) * Math.min(1, ctx.dt * 0.8);

      const yaw = b.heading + orbit;
      const fx = Math.sin(yaw), fz = -Math.cos(yaw);
      const dist = spec.distance * zoom + cruise * 6.5;
      const height = spec.height * (0.55 + 0.45 * zoom) + orbitPitch * dist * 0.5
        + cruise * (3.0 + Math.sin(ctx.time * 0.31) * 0.14);

      // Lead the camera a little in the direction of travel so accelerating
      // feels like accelerating.
      const lead = THREE.MathUtils.clamp(b.speed / 9.2, -0.4, 1) * 2.2;

      desired.set(
        b.position.x - fx * (dist + lead),
        b.position.y + height,
        b.position.z - fz * (dist + lead),
      );

      const surface = ctx.water?.sampleHeight?.(desired.x, desired.z, ctx.time) ?? 0;
      desired.y = Math.max(desired.y, surface + 1.4);

      const k = first ? 1 : Math.min(1, ctx.dt * (TOUCH ? 2.6 : 3.4));
      pos.lerp(desired, k);

      target.set(
        b.position.x + fx * spec.lookAhead,
        b.position.y + spec.lookHeight,
        b.position.z + fz * spec.lookAhead,
      );
      look.lerp(target, first ? 1 : Math.min(1, ctx.dt * 5.0));

      camera.position.copy(pos);
      // Looking straight down, the view direction is parallel to +Y and lookAt
      // has no basis to build a rotation from — the framing snaps somewhere
      // arbitrary. Near vertical, roll the up vector onto the boat's heading so
      // the overhead shot stays pointed at the boat and keeps north up-frame.
      up.subVectors(look, pos);
      const steep = Math.abs(up.y) / Math.max(up.length(), 1e-5);
      if (steep > 0.975) camera.up.set(fx, 0, fz);
      else camera.up.set(0, 1, 0);
      camera.lookAt(look);
      first = false;
    },
  };
}
