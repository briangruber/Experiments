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

export function createChaseCamera({ ctx, camera, input }) {
  const pos = new THREE.Vector3(0, 6, 18);
  const look = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const target = new THREE.Vector3();
  const up = new THREE.Vector3();

  let spec = { ...SPECS.chase };
  let orbit = 0;          // extra yaw from the mouse
  let orbitPitch = 0;
  let zoom = 1;
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

      if (input?.pointer.down) {
        orbit -= input.pointer.dx * 0.0035;
        orbitPitch = THREE.MathUtils.clamp(orbitPitch - input.pointer.dy * 0.0025, -0.5, 0.9);
      }
      if (input?.pointer.wheel) zoom = THREE.MathUtils.clamp(zoom + input.pointer.wheel * 0.08, 0.55, 2.4);

      const yaw = b.heading + orbit;
      const fx = Math.sin(yaw), fz = -Math.cos(yaw);
      const dist = spec.distance * zoom;
      const height = spec.height * (0.55 + 0.45 * zoom) + orbitPitch * dist * 0.5;

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

      const k = first ? 1 : Math.min(1, ctx.dt * 3.4);
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
