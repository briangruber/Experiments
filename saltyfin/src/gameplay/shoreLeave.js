// Tying up, and going ashore.
//
// Three states and two of them are transitions:
//
//   afloat    you are driving. If the boat is inside DOCK_RANGE of the berth
//             and nearly stopped, `state.canDock` goes true and the HUD offers
//             it. Nothing is forced — you can moor and leave again all day.
//   mooring   the boat eases into the berth on a solved curve while the camera
//             swings round to the quay, ~1.6 s. Nobody has control.
//   ashore    you are a person on the stone. WASD walks, the camera trails.
//   boarding  the reverse, and it hands the helm back.
//
// What this owns: the walker, its camera, and the boat's pose while moored.
// What it does NOT own: the ground. `world/harbour.js` answers `ground(x, z)`
// from the same rectangles it drew the quay from, so the walker can never be
// standing on something that is not there — which is the failure mode every
// raycast-against-the-mesh version of this has.
//
// Why a walker rather than a first-person camera: the boat is the character
// this game has been about for its whole life, and stepping off it into a
// bodiless floating eye throws that away. You can see yourself, you cast a
// shadow, and the town has someone in it.

import * as THREE from 'three';
import { LAYER, setLayers } from '../core/layers.js';
import { applyWaterClip } from '../water/clip.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const TAU = Math.PI * 2;

const WALK_SPEED = 3.5;         // m/s, a strolling pace and not a sprint
const TURN_RATE = 9.0;          // rad/s the body swings to face travel
const BODY_R = 0.42;            // how fat the walker is, for the push-out
// The tallest rise a step may take. Without it `ground()` is a teleporter:
// the stair corridor happily reports a height four metres above your feet
// where it passes over the bank, and the walker would simply appear up there.
// 0.70 clears the stair's steepest measured riser (0.59 m, at the turn above
// the quay) and stops everything else.
const MAX_STEP = 0.70;
const MOOR_TIME = 1.6;
const BOARD_TIME = 1.3;

// The camera trails behind and above, and it is deliberately close: a wide
// third-person shot of a 16 m square makes the square look like a car park.
const CAM_DIST = 5.4;
const CAM_HEIGHT = 2.75;
const CAM_LOOK = 1.15;          // metres above the walker's feet the eye aims

/** A small figure: the same fisher, standing up. */
function buildWalker() {
  const g = new THREE.Group();
  g.name = 'walker';

  const skin = new THREE.MeshStandardMaterial({ color: 0xC98F63, roughness: 0.78 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x2E5C8A, roughness: 0.85 });
  const trous = new THREE.MeshStandardMaterial({ color: 0x3B4048, roughness: 0.88 });
  const boot = new THREE.MeshStandardMaterial({ color: 0x2A2622, roughness: 0.9 });
  const hat = new THREE.MeshStandardMaterial({ color: 0x4E7A3C, roughness: 0.85 });

  const box = (mat, w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };

  // Torso, head, hat — all at a scale that matches the fisher in the boat.
  g.add(box(shirt, 0.46, 0.58, 0.30, 0, 1.14, 0));
  g.add(box(skin, 0.24, 0.24, 0.24, 0, 1.53, 0));
  g.add(box(hat, 0.34, 0.11, 0.34, 0, 1.66, 0));
  g.add(box(hat, 0.30, 0.10, 0.30, 0, 1.73, 0));

  // Limbs are kept as named children so the walk cycle can swing them.
  const legL = box(trous, 0.17, 0.52, 0.19, -0.12, 0.59, 0);
  const legR = box(trous, 0.17, 0.52, 0.19, 0.12, 0.59, 0);
  const armL = box(shirt, 0.14, 0.50, 0.16, -0.30, 1.14, 0);
  const armR = box(shirt, 0.14, 0.50, 0.16, 0.30, 1.14, 0);
  // Pivot at the hip and shoulder rather than the centre, so a rotation swings
  // the limb instead of spinning it about its middle.
  for (const [limb, pivotY] of [[legL, 0.85], [legR, 0.85], [armL, 1.39], [armR, 1.39]]) {
    const pivot = new THREE.Group();
    pivot.position.set(limb.position.x, pivotY, 0);
    limb.position.set(0, limb.position.y - pivotY, 0);
    pivot.add(limb);
    g.add(pivot);
  }
  const pivots = g.children.filter((c) => c.isGroup);

  g.add(box(boot, 0.19, 0.12, 0.26, -0.12, 0.06, 0.03));
  g.add(box(boot, 0.19, 0.12, 0.26, 0.12, 0.06, 0.03));

  return { group: g, pivots };
}

export function createShoreLeave(opts = {}) {
  const {
    ctx, scene, input, camera, chaseCamera, harbour, terrain,
  } = opts;

  const TOUCH = typeof matchMedia === 'function'
    && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0);

  const walker = buildWalker();
  const group = new THREE.Group();
  group.name = 'shore-leave';
  group.add(walker.group);
  group.visible = false;
  setLayers(group, LAYER.MAIN, LAYER.REFLECTED);
  applyWaterClip(group);
  scene.add(group);

  const state = {
    mode: 'afloat',       // afloat|mooring|ashore|boarding
    ashore: false,        // anything that is not 'afloat'
    ownsCamera: false,
    canDock: false,
    prompt: '',
    hint: '',
    x: 0,
    z: 0,
    yaw: harbour.yaw,
    speed: 0,
  };

  // Where the walker is, in the harbour's local frame. World is derived.
  let bob = 0;
  let transition = 0;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const fromPos = new THREE.Vector3();
  const fromLook = new THREE.Vector3();
  const _uv = { x: 0, z: 0 };
  const _tmp = new THREE.Vector3();

  // The boat's pose when moored, solved once so the hull sits parallel to the
  // quay rather than wherever it happened to be pointing when you pressed.
  const berth = new THREE.Vector3();
  harbour.berthWorld(berth);

  let moorFrom = { x: 0, z: 0, heading: 0 };

  // The walker lives in WORLD x/z, not the dock frame, because the town's
  // stone stair is a world-space polyline and half of "walk into town" is
  // climbing it. `ground` answers for the quay, the pier and the stair alike.
  function worldOf(x, z, out) {
    return out.set(x, harbour.ground(x, z) ?? harbour.deckY, z);
  }

  // --- the camera -----------------------------------------------------------
  //
  // Trails the walker's own facing rather than orbiting free: on a square this
  // size a free orbit spends most of its time looking at a wall, and the one
  // thing you want in frame is where you are about to walk.

  let camYaw = harbour.yaw;
  let footY = null;

  const landAt = (x, z) => {
    if (!terrain || !terrain.landHeight) return -1e4;
    const h = terrain.landHeight(x, z);
    return Number.isFinite(h) ? h : -1e4;
  };

  // The hillside comes down to the quay at about fifty degrees, so an
  // uncollided trail camera spends most of its life inside it — the first
  // capture of this feature was two thirds dark green. Walk the boom in from
  // the ideal distance until it is clear of the land, then hold it above
  // whatever it ended up over. Six samples, no raycast, no allocation.
  function walkCamera(outPos, outLook) {
    worldOf(state.x, state.z, _tmp);
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    let dist = CAM_DIST;
    for (let i = 0; i < 6; i++) {
      const cx = _tmp.x + fx * dist, cz = _tmp.z + fz * dist;
      const h = landAt(cx, cz);
      if (h < _tmp.y + CAM_HEIGHT - 0.7) break;
      dist -= CAM_DIST / 6;
      if (dist < 1.6) { dist = 1.6; break; }
    }
    const cx = _tmp.x + fx * dist, cz = _tmp.z + fz * dist;
    const gh = landAt(cx, cz);
    outPos.set(cx, Math.max(_tmp.y + CAM_HEIGHT, gh + 1.5), cz);
    outLook.set(_tmp.x, _tmp.y + CAM_LOOK, _tmp.z);
  }

  // --- transitions ----------------------------------------------------------

  function dock() {
    if (state.mode !== 'afloat' || !state.canDock) return;
    state.mode = 'mooring';
    state.ashore = true;
    transition = 0;
    moorFrom = { x: ctx.boat.position.x, z: ctx.boat.position.z, heading: ctx.boat.heading };
    ctx.boat.throttle = 0;
    ctx.boat.speed = 0;
    ctx.shoreHold = true;
    harbour.landingWorld(_tmp);
    state.x = _tmp.x;
    state.z = _tmp.z;
    // Face inland — at the town, which is the thing worth looking at.
    state.yaw = harbour.yaw + Math.PI;
    camYaw = state.yaw;
    footY = null;
    fromPos.copy(camera.position);
    camera.getWorldDirection(_tmp);
    fromLook.copy(camera.position).addScaledVector(_tmp, 12);
    state.ownsCamera = true;
    group.visible = true;
    state.prompt = '';
  }

  function board() {
    if (state.mode !== 'ashore') return;
    state.mode = 'boarding';
    transition = 0;
    fromPos.copy(camera.position);
    camera.getWorldDirection(_tmp);
    fromLook.copy(camera.position).addScaledVector(_tmp, 12);
  }

  function finishBoarding() {
    state.mode = 'afloat';
    state.ashore = false;
    state.ownsCamera = false;
    group.visible = false;
    ctx.shoreHold = false;
  }

  function toggle() {
    if (state.mode === 'afloat') dock();
    else if (state.mode === 'ashore') board();
  }

  // --- the walk -------------------------------------------------------------

  let padX = 0, padY = 0;       // touch stick, -1..1
  function setWalkAxes(x, y) {
    padX = clamp(Number(x) || 0, -1, 1);
    padY = clamp(Number(y) || 0, -1, 1);
  }

  function updateWalk(dt) {
    // `input.axis` already merges the keyboard with core/touch.js's thumbstick,
    // and the helm is held while you are ashore, so the same stick that drove
    // the boat walks the walker. Reading raw key codes here instead meant there
    // was NO way to move on a phone: the stick was live, the boat ignored it
    // because ctx.shoreHold was set, and nothing else was listening.
    let ax = input?.axis ? input.axis('turn') : 0;
    let ay = input?.axis ? input.axis('forward') : 0;
    if (!ax && !ay) { ax = padX; ay = padY; }
    const mag = Math.hypot(ax, ay);
    if (mag > 1) { ax /= mag; ay /= mag; }

    // Input is camera-relative, which is the only scheme that does not need
    // explaining: push the stick the way you want to go on screen.
    const cs = Math.sin(camYaw), cc = Math.cos(camYaw);
    const wx = ax * cc + ay * cs;      // world-ish x from camera basis
    const wz = -ax * cs + ay * cc;
    const speed = Math.min(1, Math.hypot(wx, wz)) * WALK_SPEED;
    state.speed = speed;

    if (speed > 1e-3) {
      const dl = Math.hypot(wx, wz) || 1;
      let nx = state.x + (wx / dl) * speed * dt;
      let nz = state.z + (wz / dl) * speed * dt;

      // Off the edge? Try each axis alone, so walking into a wall slides along
      // it instead of stopping dead — the single biggest difference between a
      // controller that feels good and one that feels broken. It is also what
      // makes the 2.3 m stair walkable at all: without it, every wobble off
      // the centreline is a full stop.
      const here = harbour.ground(state.x, state.z) ?? harbour.deckY;
      const ok = (px, pz) => {
        const g = harbour.ground(px, pz);
        return g !== null && Math.abs(g - here) <= MAX_STEP;
      };
      if (!ok(nx, nz)) {
        if (ok(nx, state.z)) nz = state.z;
        else if (ok(state.x, nz)) nx = state.x;
        else { nx = state.x; nz = state.z; }
      }
      harbour.unblock(nx, nz, BODY_R, _uv);
      if (ok(_uv.x, _uv.z)) { nx = _uv.x; nz = _uv.z; }
      state.x = nx; state.z = nz;

      const want = Math.atan2(wx, wz);
      let d = want - state.yaw;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      state.yaw += clamp(d, -TURN_RATE * dt, TURN_RATE * dt);
      bob += dt * speed * 2.1;
    } else {
      bob = lerp(bob, Math.round(bob / Math.PI) * Math.PI, Math.min(1, dt * 8));
    }

    // The camera follows the body's heading, a beat behind it.
    let cd = state.yaw - camYaw;
    while (cd > Math.PI) cd -= TAU;
    while (cd < -Math.PI) cd += TAU;
    camYaw += cd * Math.min(1, dt * 3.4);
  }

  function poseWalker() {
    worldOf(state.x, state.z, _tmp);
    // Ease the height rather than snapping it. The quay meets the town's stair
    // at a half-metre step and the stone steps above it are 0.35 m each;
    // taking those instantly makes the walker strobe up the hill. The ground
    // query stays exact — only the drawn height lags.
    footY = footY === null ? _tmp.y : lerp(footY, _tmp.y, Math.min(1, (ctx.dt || 0.016) * 12));
    _tmp.y = footY;
    walker.group.position.copy(_tmp);
    walker.group.rotation.y = state.yaw;
    const swing = Math.sin(bob) * Math.min(0.62, 0.16 + state.speed * 0.13);
    const p = walker.pivots;
    if (p.length >= 4) {
      p[0].rotation.x = swing;         // left leg
      p[1].rotation.x = -swing;        // right leg
      p[2].rotation.x = -swing * 0.72; // left arm
      p[3].rotation.x = swing * 0.72;  // right arm
    }
    // A touch of vertical bounce, so the feet feel like they carry weight.
    walker.group.position.y += Math.abs(Math.sin(bob)) * 0.035 * Math.min(1, state.speed);
  }

  // --- frame ----------------------------------------------------------------

  function update(c) {
    const dt = Math.min(0.05, c.dt || 0);

    if (state.mode === 'afloat') {
      const b = ctx.boat;
      // Generous, because the helm is a thumbstick on a phone and coasting to
      // an exact stop alongside is not the game.
      const slow = Math.abs(b.speed || 0) < 3.2;
      state.canDock = slow && harbour.nearBerth(b.position.x, b.position.z);
      state.prompt = state.canDock ? 'Tie up at the quay' : '';
      state.hint = '';
      return;
    }

    if (state.mode === 'mooring') {
      transition = Math.min(1, transition + dt / MOOR_TIME);
      const t = smooth(transition);
      const b = ctx.boat;
      b.position.x = lerp(moorFrom.x, berth.x, t);
      b.position.z = lerp(moorFrom.z, berth.z, t);
      let d = harbour.yaw - moorFrom.heading;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      b.heading = moorFrom.heading + d * t;
      b.speed = 0;
      b.throttle = 0;

      poseWalker();
      walkCamera(camPos, camLook);
      camera.position.lerpVectors(fromPos, camPos, t);
      _tmp.lerpVectors(fromLook, camLook, t);
      camera.lookAt(_tmp);
      camera.fov = lerp(chaseCamera?.spec?.fov || 55, 56, t);
      camera.updateProjectionMatrix();
      if (transition >= 1) {
        state.mode = 'ashore';
        state.hint = TOUCH
          ? 'Drag the left of the screen to walk'
          : 'WASD to walk · E to board the boat';
      }
      return;
    }

    if (state.mode === 'ashore') {
      updateWalk(dt);
      poseWalker();
      walkCamera(camPos, camLook);
      camera.position.lerp(camPos, Math.min(1, dt * 6.5));
      camera.lookAt(camLook);
      // Close enough to the boat to step back aboard?
      const du = harbour.localU(state.x, state.z) - harbour.BERTH.u;
      const dv = harbour.localV(state.x, state.z) - harbour.BERTH.v;
      const near = du * du + dv * dv < 42;
      state.canDock = near;
      state.prompt = near ? 'Cast off' : '';
      return;
    }

    if (state.mode === 'boarding') {
      transition = Math.min(1, transition + dt / BOARD_TIME);
      const t = smooth(transition);
      poseWalker();
      // Hand the frame back to the chase rig by aiming at where it wants to be.
      chaseCamera?.update?.(c);
      if (transition >= 1) finishBoarding();
      else {
        walkCamera(camPos, camLook);
        camera.position.lerpVectors(camPos, camera.position, 1 - t);
      }
    }
  }

  return {
    group,
    state,
    dock,
    board,
    toggle,
    setWalkAxes,
    update,
    get ownsCamera() { return state.ownsCamera && state.mode !== 'afloat'; },
    dispose() {
      group.traverse((o) => {
        if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
      });
    },
  };
}
