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
// What it does NOT own: the ground. `world/town.js` answers `ground(x, z)`
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

const WALK_SPEED = 2.4;         // m/s, a strolling pace and not a sprint
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
    ctx, scene, input, camera, chaseCamera, town, terrain,
  } = opts;
  // The generated fisher: a skinned GLB with a walk clip, plus an
  // animation-only GLB carrying idle. Either missing -> the box walker.
  const heroGltf = opts.hero || null;
  const heroIdleGltf = opts.heroIdle || null;

  const TOUCH = typeof matchMedia === 'function'
    && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0);

  // --- the hero walker -------------------------------------------------------
  // The character is wrapped so its group origin is BETWEEN ITS FEET: scale to
  // game height, then lift the rig by its own min.y. Everything downstream
  // positions feet-on-deck and never needs to know which asset is inside.
  let heroMixer = null;
  let walkAction = null;
  let idleAction = null;
  let heroStride = 1.4;         // m/s the walk clip covers at timeScale 1
  function buildHeroWalker() {
    if (!heroGltf || !heroGltf.scene || !heroGltf.animations?.length) return null;
    const rig = heroGltf.scene;
    // The generated rig faces +X — its bind bbox is twice as deep (z) as it
    // is wide (x), and the walk clip's root motion runs along +X. The walker
    // convention is forward = local +Z (updateWalk moves along
    // (sin yaw, cos yaw) and poseWalker sets rotation.y = yaw), so turn the
    // model into convention first; unrotated it crab-walks with the camera
    // on its flank and every stick direction lands 90 degrees wrong.
    rig.rotation.y = -Math.PI / 2;
    rig.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rig);
    const size = box.getSize(new THREE.Vector3());
    const k = 1.68 / Math.max(size.y, 1e-3);
    rig.scale.setScalar(k);
    rig.updateMatrixWorld(true);
    box.setFromObject(rig);
    const c = box.getCenter(new THREE.Vector3());
    rig.position.x -= c.x;
    rig.position.z -= c.z;
    rig.position.y -= box.min.y;
    rig.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;      // a skinned bbox lies; culling pops limbs
      }
    });
    const g = new THREE.Group();
    g.name = 'walker';
    g.add(rig);

    // The preset walk is NOT in place: its Hip position track slides the
    // whole body a stride per loop (measured: 1.0 rig-units over the 1.9 s
    // clip) and snaps back on repeat — in game the character glided away
    // from its own group origin and teleported home twice a second. Remove
    // the secular drift by subtracting the first->last linear ramp from
    // every position track: a no-op for the 41 constant bone-offset tracks,
    // and for the Hip it turns the clip into a seamless in-place cycle.
    // The removed drift is exactly the ground one loop covers, so it also
    // calibrates playback: timeScale = speed / heroStride plants the feet.
    // Running twice is safe — after the first pass first == last, so the
    // ramp is zero.
    const walkClip = heroGltf.animations[0];
    let drift = 0;
    for (const tr of walkClip.tracks) {
      if (!tr.name.endsWith('.position') || tr.times.length < 2) continue;
      const t = tr.times;
      const v = tr.values;
      const n = t.length;
      const span = Math.max(t[n - 1] - t[0], 1e-6);
      const dx = v[(n - 1) * 3] - v[0];
      const dy = v[(n - 1) * 3 + 1] - v[1];
      const dz = v[(n - 1) * 3 + 2] - v[2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.02) continue;
      drift = Math.max(drift, len);
      for (let i = 0; i < n; i++) {
        const f = (t[i] - t[0]) / span;
        v[i * 3] -= dx * f;
        v[i * 3 + 1] -= dy * f;
        v[i * 3 + 2] -= dz * f;
      }
    }
    const stride = (drift * k) / Math.max(walkClip.duration, 1e-3);
    if (stride > 0.3) heroStride = stride;

    heroMixer = new THREE.AnimationMixer(rig);
    walkAction = heroMixer.clipAction(heroGltf.animations[0]);
    walkAction.play();
    walkAction.setEffectiveWeight(0);
    const idleClip = heroIdleGltf?.animations?.[0];
    if (idleClip) {
      idleAction = heroMixer.clipAction(idleClip);
      idleAction.play();
      idleAction.setEffectiveWeight(1);
    }
    return { group: g, pivots: [] };
  }

  const walker = buildHeroWalker() || buildWalker();
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
    yaw: town.yaw,
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
  town.berthWorld(berth);

  let moorFrom = { x: 0, z: 0, heading: 0 };

  // The walker lives in WORLD x/z, not the dock frame, because the town's
  // stone stair is a world-space polyline and half of "walk into town" is
  // climbing it. `ground` answers for the quay, the pier and the stair alike.
  function worldOf(x, z, out) {
    return out.set(x, town.ground(x, z) ?? town.deckY, z);
  }

  // --- the camera -----------------------------------------------------------
  //
  // Trails the walker's own facing rather than orbiting free: on a square this
  // size a free orbit spends most of its time looking at a wall, and the one
  // thing you want in frame is where you are about to walk.

  let camYaw = town.yaw;
  let footY = null;

  const landAt = (x, z) => {
    if (!terrain || !terrain.landHeight) return -1e4;
    const h = terrain.landHeight(x, z);
    return Number.isFinite(h) ? h : -1e4;
  };

  // The town stands in open water, so there is no hillside for the boom to
  // bury itself in and the camera can simply trail. It still clears the island
  // in case you walk somewhere with land behind you.
  function walkCamera(outPos, outLook) {
    worldOf(state.x, state.z, _tmp);
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    const cx = _tmp.x + fx * CAM_DIST, cz = _tmp.z + fz * CAM_DIST;
    const gh = landAt(cx, cz);
    outPos.set(cx, Math.max(_tmp.y + CAM_HEIGHT, gh + 1.6), cz);
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
    town.landingWorld(_tmp);
    state.x = _tmp.x;
    state.z = _tmp.z;
    // Face up the street into town. town.yaw IS that direction — the street's
    // +z axis aims at the harbour — and the +pi here had you arriving with
    // your back to the whole place, staring at open water.
    state.yaw = town.yaw;
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
    //
    // Derived, not guessed — guessing produced two wrong versions in a row,
    // the second of which was the first rewritten into an algebraically
    // IDENTICAL form, which changed nothing and looked like a fix.
    //
    // The camera sits behind the walker and looks along F = (sin cy, 0, cos cy).
    // Screen-right is cross(F, up) with up = +Y, which is (-cos cy, 0, sin cy).
    // Check it against three's default camera, F = (0, 0, -1), where
    // cross(F, up) = (1, 0, 0) = +X, as it must be. So the stick pushed right
    // has to produce (-cos, +sin), and pushed forward (sin, cos).
    const cs = Math.sin(camYaw), cc = Math.cos(camYaw);
    const wx = ay * cs - ax * cc;
    const wz = ay * cc + ax * cs;
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
      const here = town.ground(state.x, state.z) ?? town.deckY;
      const ok = (px, pz) => {
        const g = town.ground(px, pz);
        return g !== null && Math.abs(g - here) <= MAX_STEP;
      };
      if (!ok(nx, nz)) {
        if (ok(nx, state.z)) nz = state.z;
        else if (ok(state.x, nz)) nx = state.x;
        else { nx = state.x; nz = state.z; }
      }
      town.unblock(nx, nz, BODY_R, _uv);
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

  function poseWalker(dt = 0) {
    worldOf(state.x, state.z, _tmp);
    // No smoothing: the town is one flat deck, so the ground query is exact
    // and constant.
    walker.group.position.copy(_tmp);
    walker.group.rotation.y = state.yaw;

    if (heroMixer) {
      // Crossfade by speed, and clock the walk cycle to the ground actually
      // covered so the feet do not skate: heroStride is measured off the
      // clip's own root motion at build time, not guessed.
      const w = clamp(state.speed / 1.2, 0, 1);
      walkAction.setEffectiveWeight(w);
      if (idleAction) idleAction.setEffectiveWeight(1 - w);
      walkAction.setEffectiveTimeScale(clamp(state.speed / heroStride, 0.55, 3.0));
      heroMixer.update(dt);
      return;
    }

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
      state.canDock = slow && town.nearBerth(b.position.x, b.position.z);
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
      let d = town.yaw - moorFrom.heading;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      b.heading = moorFrom.heading + d * t;
      b.speed = 0;
      b.throttle = 0;

      poseWalker(dt);
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
      // While the town editor is open the stick belongs to it: the walker
      // stands still (speed zeroed so the mixer crossfades to idle) and the
      // walk camera stops writing — the editor does a full camera write after
      // this module every frame, but a rig that KEEPS writing would snap the
      // view for one frame on every editor exit.
      if (c.editorHold) {
        state.speed = 0;
        poseWalker(dt);
        return;
      }
      updateWalk(dt);
      poseWalker(dt);
      walkCamera(camPos, camLook);
      camera.position.lerp(camPos, Math.min(1, dt * 6.5));
      camera.lookAt(camLook);
      // Close enough to the boat to step back aboard?
      const du = town.localX(state.x, state.z) - town.BERTH.x;
      const dv = town.localZ(state.x, state.z) - town.BERTH.z;
      const near = du * du + dv * dv < 64;
      state.canDock = near;
      state.prompt = near ? 'Cast off' : '';
      return;
    }

    if (state.mode === 'boarding') {
      transition = Math.min(1, transition + dt / BOARD_TIME);
      const t = smooth(transition);
      poseWalker(dt);
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
