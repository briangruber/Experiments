// Bench spike: an Actor whose body is a Tripo-generated skinned model instead
// of the procedural chicken. Same directing surface — place / walkTo / face /
// look / gesture / emote / speak / setVisible / update(sdt, time, rdt) — so a
// scene written against the procedural cast plays unchanged. Under the hood:
//
//   - locomotion is the retargeted `preset:walk` clip crossfaded over
//     `preset:idle` through an AnimationMixer, with the clip's baked root
//     motion stripped so the Actor's own path slides the body (walk speed and
//     clip timescale are matched, so foot slip is modest but real);
//   - body / neck / head acting and every wing gesture come from the SAME
//     channel values the procedural rig uses (REST() + idle/emotion/look/
//     gesture/jaw passes, inherited from Actor) mapped onto the humanoid
//     skeleton as additive world-axis rotations on top of the mixer's output;
//   - the acting face — eyes with pupils, lids and brows, and the articulated
//     beak the lip sync drives — is procedural, built from the same shapes as
//     engine/chicken.js and parented to the Head bone over the painted face.
//
// NOT wired into the shipping page. The only consumer is tools/bench-shot.mjs,
// which imports this module into the live page and possesses the existing
// Esteban. Loading fetches GLBs, so this cannot run on the bundled/CSP page.

import * as THREE from '../vendor/three/three.module.min.js';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { Actor } from './acting.js';
import { REST } from './chicken.js';
import { TAU, clamp, clamp01, deg, approach } from './util.js';

const _qp = new THREE.Quaternion(), _qd = new THREE.Quaternion(), _qt = new THREE.Quaternion();
const _up = new THREE.Vector3(), _left = new THREE.Vector3(), _fwd = new THREE.Vector3();
const _v = new THREE.Vector3(), _box = new THREE.Box3();

// Rotate a bone about a WORLD axis without moving it, on top of whatever the
// mixer wrote this frame. local' = parentWorld⁻¹ · Δ · parentWorld · local.
// This is what makes the mapping independent of Tripo's (arbitrary) bone rest
// orientations: "lift the wing" is a rotation about the character's forward
// axis whichever way the Upperarm's own axes point.
function rotW(bone, axis, angle) {
  if (!angle) return;
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.getWorldQuaternion(_qp);
  _qd.setFromAxisAngle(axis, angle);
  _qt.copy(_qp).invert().multiply(_qd).multiply(_qp);
  bone.quaternion.premultiply(_qt);
}

// --- the acting face --------------------------------------------------------
// The same eye and beak construction as engine/chicken.js (kept in sync by
// hand — this is a bench spike, not a refactor), built at chicken scale `s`
// and hung off a world-aligned anchor on the Head bone.

function makeFace(spec, s, eyeSpread = 1) {
  const feather = new THREE.MeshStandardMaterial({ color: spec.plumage, roughness: 0.7, metalness: 0.05 });
  const beakMat = new THREE.MeshStandardMaterial({ color: spec.beak ?? 0xd8a445, roughness: 0.42 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: spec.iris ?? 0xc8862a, roughness: 0.18, metalness: 0.1 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x08060a, roughness: 0.1 });
  const ringMat = new THREE.MeshStandardMaterial({
    color: spec.eyeRing ?? new THREE.Color(spec.plumage).multiplyScalar(0.3).getHex(), roughness: 0.6,
  });
  const browMat = new THREE.MeshStandardMaterial({
    color: spec.brow ?? new THREE.Color(spec.plumage).multiplyScalar(0.42).getHex(), roughness: 0.85,
  });

  const face = new THREE.Group();

  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(sx * 0.055 * s * eyeSpread, 0.028 * s, 0.036 * s);
    eye.rotation.y = sx * deg(46);
    face.add(eye);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.03 * s, 16, 14), eyeMat);
    ball.scale.z = 0.88;
    eye.add(ball);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0165 * s, 14, 12), pupilMat);
    pupil.position.z = 0.0195 * s;
    pupil.scale.set(1, 1, 0.6);
    eye.add(pupil);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.0034 * s, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    glint.position.set(0.0095 * s, 0.011 * s, 0.0272 * s);
    eye.add(glint);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.031 * s, 0.006 * s, 6, 20), ringMat);
    ring.position.z = 0.011 * s;
    ring.scale.set(1, 1.04, 0.7);
    eye.add(ring);
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.0325 * s, 16, 8, 0, TAU, 0, Math.PI * 0.5), feather);
    lid.rotation.x = deg(-96);
    eye.add(lid);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.0105 * s, 0.016 * s), browMat);
    brow.position.set(0, 0.034 * s, 0.021 * s);
    brow.castShadow = true;
    eye.add(brow);
    eyes.push({ group: eye, ball, pupil, lid, brow, side: sx });
  }

  const beak = new THREE.Group();
  beak.position.set(0, -0.006 * s, 0.078 * s);
  face.add(beak);
  const beakUpper = new THREE.Mesh(new THREE.ConeGeometry(0.036 * s, 0.088 * s, 7), beakMat);
  beakUpper.rotation.x = Math.PI / 2;
  beakUpper.scale.set(1, 1, 0.58);
  beakUpper.position.set(0, 0.004 * s, 0.036 * s);
  beakUpper.castShadow = true;
  beak.add(beakUpper);
  const beakLowerPivot = new THREE.Group();
  const beakLower = new THREE.Mesh(new THREE.ConeGeometry(0.031 * s, 0.072 * s, 7), beakMat);
  beakLower.rotation.x = Math.PI / 2;
  beakLower.scale.set(1, 0.8, 0.46);
  beakLower.position.set(0, -0.011 * s, 0.03 * s);
  beakLowerPivot.add(beakLower);
  beak.add(beakLowerPivot);

  return { face, eyes, beak, beakLowerPivot };
}

// The neckerchief is Esteban's identity (his twin wears it in black). Same
// build as company/cast/wardrobe.js, on a world-aligned neck anchor.
function makeNeckerchief(size, color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.78 });
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.072 * size, 0.016 * size, 8, 20), mat);
  band.rotation.x = deg(90);
  band.position.y = 0.015 * size;
  band.castShadow = true;
  g.add(band);
  const knot = new THREE.Mesh(new THREE.ConeGeometry(0.03 * size, 0.07 * size, 6), mat);
  knot.position.set(0, -0.015 * size, 0.07 * size);
  knot.rotation.x = deg(150);
  g.add(knot);
  return g;
}

// --- the rig ----------------------------------------------------------------

async function loadGLB(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  GLTFLoader.USE_IMAGE_BITMAP = false;
  return new GLTFLoader().parseAsync(await res.arrayBuffer(), '');
}

// The acting layer owns the neck and the head outright — look-at, extension,
// pitch and roll are all channel-driven, exactly as on the procedural rig — so
// the clips' own neck/head motion is removed rather than fought. The bones sit
// at bind pose (restored every frame in applyBones, since the mixer no longer
// writes them) and the channels rotate them from there.
const ACTED_BONES = ['NeckTwist01', 'NeckTwist02', 'Head'];
function stripActedTracks(clip) {
  clip.tracks = clip.tracks.filter((t) => !ACTED_BONES.some((n) => t.name.startsWith(n + '.')));
}

// preset:walk bakes its root motion into the Hip translation track (about a
// metre of drift per loop). The Actor's own path moves the body, so remove the
// linear drift and keep the intra-stride bob and sway. Returns the baked
// forward speed in model units so the walk can be played at matched speed.
function stripWalkDrift(clip) {
  const track = clip.tracks.find((t) => /(^|\.)Hip\.position$/.test(t.name));
  if (!track) return 0;
  const v = track.values, times = track.times, n = times.length;
  const T = times[n - 1] - times[0] || 1;
  const drift = [v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 1] - v[1], v[(n - 1) * 3 + 2] - v[2]];
  for (let i = 0; i < n; i++) {
    const u = (times[i] - times[0]) / T;
    v[i * 3] -= drift[0] * u;
    v[i * 3 + 1] -= drift[1] * u;
    v[i * 3 + 2] -= drift[2] * u;
  }
  return Math.hypot(...drift) / T;
}

// Build the bone rig for Esteban: model + skeleton from the idle GLB, walk
// clip parsed out of the walk GLB (the mixer binds tracks by node name, so a
// clip from a sibling file drives the same skeleton).
//
// Tripo model space: character faces +X, wings along ±Z, feet near y=0. The
// wrapper turns it to face +Z (the whole cast's convention), scales it to
// `height` metres and puts the midpoint of the feet on the group origin.
export async function buildEstebanBoneRig(opts = {}) {
  const base = opts.base ?? '/company/cast/models';
  const spec = {
    name: 'Esteban', plumage: 0xb06a35, comb: 0xd2333c, beak: 0xdcb057,
    iris: 0xe0a437, eyeRing: 0xa06a44, ...opts.spec,
  };
  const size = opts.size ?? 1.14;             // procedural Esteban's spec.size
  const height = opts.height ?? 0.78;         // metres, floor to comb

  const [idleG, walkG] = await Promise.all([
    loadGLB(`${base}/esteban-idle.glb`),
    loadGLB(`${base}/esteban-walk.glb`),
  ]);
  const model = idleG.scene;
  const idleClip = idleG.animations[0];
  const walkClip = walkG.animations[0];
  const walkModelSpeed = stripWalkDrift(walkClip);
  stripActedTracks(idleClip);
  stripActedTracks(walkClip);

  model.updateMatrixWorld(true);
  const bones = {};
  for (const n of ['Root', 'Hip', 'Pelvis', 'Waist', 'Spine01', 'Spine02', 'NeckTwist01', 'NeckTwist02', 'Head',
    'L_Clavicle', 'L_Upperarm', 'L_Forearm', 'L_Hand', 'R_Clavicle', 'R_Upperarm', 'R_Forearm', 'R_Hand',
    'L_Foot', 'R_Foot']) {
    bones[n] = model.getObjectByName(n);
    if (!bones[n]) throw new Error(`bone ${n} missing`);
  }

  // Ground and centre on the feet, not the bounding box — the box is mostly
  // tail and would park the body off its mark.
  _box.setFromObject(model);
  const h0 = _box.max.y - _box.min.y;
  const k = height / h0;
  const fl = bones.L_Foot.getWorldPosition(new THREE.Vector3());
  const fr = bones.R_Foot.getWorldPosition(new THREE.Vector3());
  const feetMid = fl.add(fr).multiplyScalar(0.5);

  const root = new THREE.Group();
  root.name = spec.name;
  const attitude = new THREE.Group();       // bodyY / bodyZ, in character space
  root.add(attitude);
  const orient = new THREE.Group();         // model space -> character space
  orient.rotation.y = -Math.PI / 2;         // model +X -> character +Z
  orient.scale.setScalar(k);
  attitude.add(orient);
  model.position.set(-feetMid.x, -_box.min.y, -feetMid.z);
  orient.add(model);

  // The set dressing trims Tripo albedo to 0.82 because props read hot against
  // the night grade — but a LEAD is supposed to hold the key light, and at 0.82
  // his face goes to mud in the darker scenes. 0.95 sits him between the two.
  const albedo = opts.albedo ?? 0.95;
  model.traverse((n) => {
    if (!n.isMesh) return;
    n.castShadow = true;
    n.receiveShadow = true;
    n.frustumCulled = false;   // the skinned bounds lag the pose
    if (n.material && n.material.color) n.material.color.multiplyScalar(albedo);
  });

  // Bind-pose snapshot of the acted bones. Every frame their local positions
  // are restored and their WORLD orientation is re-set to the bind-pose world
  // orientation (rotated by the actor's yaw) before the channels are applied —
  // the real bird's head stabilisation: the skull holds its attitude while the
  // idle clip sways the spine under it, and only the acting moves it.
  const rest = {};
  for (const n of ACTED_BONES) {
    rest[n] = { pos: bones[n].position.clone(), quat: bones[n].quaternion.clone(), world: null };
  }

  const mixer = new THREE.AnimationMixer(model);
  const idleAction = mixer.clipAction(idleClip);
  const walkAction = mixer.clipAction(walkClip);
  idleAction.play();
  walkAction.play();
  walkAction.setEffectiveWeight(0);
  mixer.update(0);

  // World-aligned anchors, computed with the mixer parked on idle frame 0 and
  // the acted bones at bind (which is exactly where applyBones holds them).
  // The anchor's world axes equal the character's axes at yaw 0, and its
  // scale compensation puts children back in metres.
  root.updateMatrixWorld(true);
  for (const n of ACTED_BONES) {
    rest[n].world = bones[n].getWorldQuaternion(new THREE.Quaternion());
  }
  const anchorOn = (bone) => {
    const a = new THREE.Group();
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(a.quaternion).invert();
    const ws = bone.getWorldScale(_v);
    a.scale.setScalar(1 / ((Math.abs(ws.x) + Math.abs(ws.y) + Math.abs(ws.z)) / 3));
    bone.add(a);
    return a;
  };

  const headAnchor = anchorOn(bones.Head);
  const faceRoot = new THREE.Group();
  headAnchor.add(faceRoot);
  // Where the acting face sits relative to the Head bone, in character metres
  // (x left, y up, z forward). Tuned against renders of the painted head:
  // the painted eye line sits well above the Head bone origin, and the model's
  // skull is narrower than the procedural one, so the eyes pull in.
  faceRoot.position.set(0, (opts.faceUp ?? 0.068), (opts.faceFwd ?? 0.025));
  const faceScale = opts.faceScale ?? 1.15;
  const faceSize = size * faceScale;
  const { face, eyes, beakLowerPivot } = makeFace(spec, faceSize, opts.eyeSpread ?? 0.85);
  faceRoot.add(face);

  const neckAnchor = anchorOn(bones.NeckTwist01);
  neckAnchor.add(makeNeckerchief(size, opts.kerchief ?? 0xc4342f));

  return {
    spec, name: spec.name, size, root, attitude, model, bones,
    // What the Actor surface and the camera expect of a rig:
    head: faceRoot, neck: bones.NeckTwist01, body: bones.Spine01,
    eyes, beakLowerPivot, propAnchor: faceRoot, faceSize,
    mixer, idleAction, walkAction, walkWeight: 0, rest,
    walkSpeed: walkModelSpeed * k,   // metres/sec the clip walks at, timescale 1
    scale: k, headAnchor, faceRoot, neckAnchor,
  };
}

// --- the actor --------------------------------------------------------------

export class BoneActor extends Actor {
  // Take over an existing Actor in place. Every closure the Director built at
  // load time keeps pointing at the same object; only its class and its body
  // change. The procedural rig is hidden, not destroyed.
  static possess(actor, rig, scene) {
    actor.procRig = actor.rig;
    actor.procRig.root.visible = false;
    Object.setPrototypeOf(actor, BoneActor.prototype);
    actor.rig = rig;
    actor.root = rig.root;
    scene.add(rig.root);
    rig.root.visible = actor.visible;
    rig.root.position.copy(actor.pos);
    rig.root.rotation.y = actor.yaw;
    return actor;
  }

  // Same pipeline as Actor.update — locomotion, emotion, idle, look, gestures,
  // speech — with the commit stage swapped: instead of applyPose() on the
  // procedural rig, the channels drive the skeleton over the mixer's frame.
  update(dt, time, rdt) {
    if (!this.visible) return;
    const p = REST();

    this.updatePath(dt);
    for (const k in this.emotion) {
      this.emotion[k] = approach(this.emotion[k], this.emotionTarget[k], this.emotionRate, dt);
    }
    this.shockHold = Math.max(0, this.shockHold - dt * 0.55);
    this.idlePose(p, time, dt);
    this.emotionPose(p);
    this.lookPose(p, dt);

    for (let i = this.gestures.length - 1; i >= 0; i--) {
      const g = this.gestures[i];
      g.t += dt;
      if (g.t < 0) continue;
      const u = g.hold ? Math.min(1, g.t / g.dur) : g.t / g.dur;
      if (!g.hold && u >= 1) { this.gestures.splice(i, 1); continue; }
      if (g.releasing) {
        g.fade = Math.max(0, g.fade - dt / 0.6);
        if (g.fade <= 0) { this.gestures.splice(i, 1); if (g.name === 'faint') this.collapsedAmount = 0; continue; }
      } else {
        g.fade = Math.min(1, g.fade + dt / 0.12);
      }
      this._beat = null;
      g.def.apply(p, clamp01(u), g.weight * g.fade, this);
      if (this._beat && g.onBeat) { const fn = g.onBeat; g.onBeat = null; fn(this._beat, this); }
    }

    this.jawPose(p, rdt ?? dt);

    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.applyBones(p, dt);
    this.pose = p;
  }

  applyBones(p, dt) {
    const rig = this.rig, s = this.size, b = rig.bones;

    // Locomotion: crossfade idle -> walk with speed, and play the walk at the
    // rate the body actually covers ground so the feet roughly keep up.
    const movingW = clamp01(this.speed / (0.22 * s));
    rig.walkWeight = approach(rig.walkWeight, movingW, 7, dt);
    rig.idleAction.setEffectiveWeight(1 - rig.walkWeight);
    rig.walkAction.setEffectiveWeight(rig.walkWeight);
    if (rig.walkWeight > 0.01) {
      rig.walkAction.timeScale = clamp(this.speed / Math.max(0.05, rig.walkSpeed), 0.55, 2.4);
    }
    rig.mixer.update(dt);

    // Body offsets in character space (attitude sits under the yawed root).
    rig.attitude.position.set(0, p.bodyY * s - this.collapsedAmount * 0.1 * s, p.bodyZ * s);

    // Character axes in world space, given the root yaw.
    const yaw = this.yaw;
    _up.set(0, 1, 0);
    _left.set(Math.cos(yaw), 0, -Math.sin(yaw));
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));

    // Torso. Positive bodyPitch bows forward (chicken convention).
    rotW(b.Waist, _left, p.bodyPitch * 0.75);
    rotW(b.Waist, _up, p.bodyYaw * 0.8);
    rotW(b.Waist, _fwd, p.bodyRoll * 0.8);
    // The chest — strut and puff push it up and out.
    rotW(b.Spine02, _left, p.bodyPitch * 0.35 - p.puff * 0.14);

    // Acted bones: local position back to bind, world orientation re-set to
    // bind-at-this-yaw (their clip tracks are stripped; see stripActedTracks).
    // The spine sways under a held head, and only the channels move it.
    _qd.setFromAxisAngle(_up, yaw);
    for (const n in rig.rest) {
      const bone = b[n], r = rig.rest[n];
      bone.position.copy(r.pos);
      bone.parent.updateWorldMatrix(true, false);
      bone.parent.getWorldQuaternion(_qp);
      bone.quaternion.copy(_qp).invert().multiply(_qd).multiply(r.world);
    }

    // Neck: extension translates along the spine (bone-local +Y runs up the
    // chain), pitch/yaw split with the head like the procedural neck does.
    const ext = p.neckExtend;
    if (ext) {
      b.NeckTwist01.position.y += (ext * 0.045 * s) / rig.scale;
      b.NeckTwist02.position.y += (ext * 0.045 * s) / rig.scale;
    }
    rotW(b.NeckTwist01, _left, p.neckPitch + ext * -0.1);
    rotW(b.NeckTwist01, _up, p.neckYaw);

    rotW(b.Head, _left, p.headPitch);
    rotW(b.Head, _up, p.headYaw);
    rotW(b.Head, _fwd, p.headRoll);

    // Wings. Lift is a roll about the forward axis (up and away from the
    // flank), sweep swings the wing toward the front, spread carries on into
    // the forearm. Signs: the bird's left is +X at yaw 0.
    for (const sx of [-1, 1]) {
      const L = sx < 0;
      const lift = clamp(L ? p.wingLLift : p.wingRLift, -0.25, 1.35);
      const sweep = clamp(L ? p.wingLSweep : p.wingRSweep, -1.5, 1.5);
      const sgn = L ? 1 : -1;                 // L_* chains reach the +X side
      const cl = L ? b.L_Clavicle : b.R_Clavicle;
      const ua = L ? b.L_Upperarm : b.R_Upperarm;
      const fa = L ? b.L_Forearm : b.R_Forearm;
      rotW(cl, _fwd, sgn * lift * 0.35);
      rotW(ua, _fwd, sgn * (lift * 0.85 + p.wingSpread * 0.2));
      rotW(ua, _up, L ? sweep : -sweep);
      rotW(fa, _up, (L ? sweep : -sweep) * 0.35);
      rotW(fa, _fwd, sgn * p.wingSpread * 0.35);
    }

    // The acting face. Same channel formulas as engine/chicken.js applyPose,
    // at the scale the face was built at.
    const fs = rig.faceSize;
    rig.beakLowerPivot.rotation.x = p.beak * 0.42;
    for (const e of rig.eyes) {
      const lid = clamp(p.lid, -0.3, 1);
      e.lid.rotation.x = deg(-96) + lid * deg(186);
      e.lid.rotation.z = e.side * p.lidAngle * 0.5;
      e.brow.rotation.z = e.side * p.browAngle;
      e.brow.position.y = 0.038 * fs + p.browHeight * 0.02 * fs;
      e.pupil.position.x = p.eyeX * 0.008 * fs;
      e.pupil.position.y = p.eyeY * 0.008 * fs;
    }
  }
}

// --- bench entry point ------------------------------------------------------
// Called from tools/bench-shot.mjs inside the live page:
//   const m = await import('/engine/bone-actor.js');
//   await m.benchSwapEsteban(window.__telenovela, { faceUp: ..., ... });
export async function benchSwapEsteban(handle, opts = {}) {
  const rig = await buildEstebanBoneRig(opts);
  BoneActor.possess(handle.actors.esteban, rig, handle.scene);
  return { ok: true, scale: +rig.scale.toFixed(4), walkSpeed: +rig.walkSpeed.toFixed(3) };
}
