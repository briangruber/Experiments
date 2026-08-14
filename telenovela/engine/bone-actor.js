// A cast member whose body is a Tripo-generated skinned model instead of the
// procedural chicken. Same directing surface — place / walkTo / face / look /
// gesture / emote / speak / setVisible — so a scene written against the
// procedural cast plays unchanged. The acting pipeline is Actor.buildPose,
// inherited untouched; only the commit stage is different:
//
//   - locomotion is the retargeted walk/run clips crossfaded over idle through
//     an AnimationMixer, timescale ramped with the actor's real ground speed,
//     with the clips' baked root motion stripped;
//   - body / neck / head acting and every wing gesture come from the SAME
//     channel values the procedural rig produces, mapped onto the humanoid
//     skeleton as additive world-axis rotations on top of the mixer's frame;
//   - the acting face — skull shell, eyes with pupils, lids, brows, wattles
//     and the articulated beak the lip sync drives — is procedural, built from
//     the same shapes as engine/chicken.js and parented to the Head bone OVER
//     the painted face. The shell is what keeps the overlay honest off-profile:
//     brows and the far eye always sit on a skull, never in empty air, and the
//     enlarged beak fully occludes the sculpted snout so there is one beak.
//
// Only the twins ride this rig (the bench verdict was 'hybrid'); Ricardo is
// the same skinned scene with an offline-recolored base colour map swapped in.
// company/cast/index.js upgrades the two Actors in place once the GLBs decode,
// and the procedural cast stays on stage if a single byte fails to load.

import * as THREE from '../vendor/three/three.module.min.js';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { clone as cloneSkinned } from '../vendor/three/GLTFLoaderDeps.js';
import { Actor } from './acting.js';
import { featherGeometry } from './chicken.js';
import { CAST_MODELS } from '../company/cast/models-manifest.js';
import { TAU, clamp, clamp01, deg, approach } from './util.js';

const _qp = new THREE.Quaternion(), _qd = new THREE.Quaternion(), _qt = new THREE.Quaternion();
const _up = new THREE.Vector3(), _left = new THREE.Vector3(), _fwd = new THREE.Vector3();
const _v = new THREE.Vector3(), _box = new THREE.Box3();

// The calibration constants, baked. faceUp/faceFwd place the acting face
// relative to the Head bone in character metres; headScale is the one number
// the bench required (1.15–1.25): the sculpt's skull is small for a lead, so
// the Head bone is scaled up and the overlay recalibrated to match. All tuned
// against rendered bench frames, not a neutral viewer.
export const CAL = {
  headScale: 1.2,
  faceUp: 0.085, faceFwd: 0.035, faceScale: 1.3, eyeSpread: 0.92,
  beakScale: 1.3,
};

// The bundle inlines the models as data: URIs and the published page's policy
// refuses fetch() — including fetch of a data: URI. Decode in process.
function bytesFromDataUri(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function bytes(url) {
  if (url.startsWith('data:')) return bytesFromDataUri(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

async function loadCastGLB(file) {
  const url = CAST_MODELS[file];
  if (!url) throw new Error(`${file} not in cast models manifest`);
  GLTFLoader.USE_IMAGE_BITMAP = false;
  return new GLTFLoader().parseAsync(await bytes(url), '');
}

// Textures arrive through an <img>, never a fetch — the policy's one open door.
function loadCastImage(file) {
  const url = CAST_MODELS[file];
  if (!url) return Promise.reject(new Error(`${file} not in cast models manifest`));
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`${file}: image decode failed`));
    img.src = url;
  });
}

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
// The same eye, beak and wattle construction as engine/chicken.js, built at
// chicken scale `s` and hung off a world-aligned anchor on the Head bone. The
// skull shell is the piece the bench demanded: a feather-coloured skull the
// overlay parts sit ON, so a three-quarter or high angle can never show a brow
// floating against the night, and the painted eyes underneath are covered.

function makeFace(spec, s, eyeSpread = 1) {
  const feather = new THREE.MeshStandardMaterial({ color: spec.plumage, roughness: 0.8, metalness: 0.04 });
  const beakMat = new THREE.MeshStandardMaterial({ color: spec.beak ?? 0xd8a445, roughness: 0.42 });
  const combMat = new THREE.MeshStandardMaterial({ color: spec.comb, roughness: 0.45 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: spec.iris ?? 0xc8862a, roughness: 0.18, metalness: 0.1 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x08060a, roughness: 0.1 });
  const ringMat = new THREE.MeshStandardMaterial({
    color: spec.eyeRing ?? new THREE.Color(spec.plumage).multiplyScalar(0.3).getHex(), roughness: 0.6,
  });
  const browMat = new THREE.MeshStandardMaterial({
    color: spec.brow ?? new THREE.Color(spec.plumage).multiplyScalar(0.42).getHex(), roughness: 0.85,
  });

  const face = new THREE.Group();

  // The shell. Same proportions as the procedural skull; sized by `s`, which
  // is already the model's head scaled up per CAL — it encases the painted
  // head so every overlay part has a surface behind it from every angle.
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.085 * s, 20, 16), feather);
  skull.scale.set(0.97, 0.96, 1.1);
  skull.castShadow = true;
  face.add(skull);

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

  // A low crest ridge along the crown, in comb red: the sculpted comb roots
  // on the painted skull INSIDE the shell, and at a thrown-back head angle its
  // points would read as disconnected red hooks — the ridge bridges them to
  // the shell's silhouette.
  const crest = new THREE.Mesh(new THREE.BoxGeometry(0.02 * s, 0.03 * s, 0.11 * s), combMat);
  crest.position.set(0, 0.082 * s, -0.01 * s);
  crest.rotation.x = deg(-8);
  face.add(crest);

  // Wattles — sprung in applyBones, which is most of what sells a head-turn.
  // They hang over the sculpt's rigid painted ones and move.
  const wattles = new THREE.Group();
  wattles.position.set(0, -0.058 * s, 0.06 * s);
  face.add(wattles);
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.SphereGeometry(0.028 * s, 10, 10), combMat);
    w.scale.set(0.55, 1.5, 0.75);
    w.position.set(sx * 0.017 * s, -0.014 * s, 0);
    w.castShadow = true;
    wattles.add(w);
  }

  // The beak, scaled up so it fully occludes the sculpted snout — the bench's
  // "second beak" was the painted one showing beside a too-small overlay.
  const beak = new THREE.Group();
  beak.position.set(0, -0.006 * s, 0.078 * s);
  beak.scale.setScalar(CAL.beakScale);
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

  return { face, eyes, beak, beakLowerPivot, wattles, feather };
}

// The neckerchief is the twins' identity (Esteban red, Ricardo black). Same
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

// The silhouette channels the bone rig lost, restored as overlay geometry the
// same way the neckerchief attaches: a fan of tail feathers over the painted
// sickle for tailFan/tailPitch, and primaries on each Hand bone so a raised
// wing reads as a broad feathered fan rather than a thin painted stick.
function makeTailFan(spec, s) {
  const g = new THREE.Group();
  const feather = new THREE.MeshStandardMaterial({ color: spec.plumage, roughness: 0.78, metalness: 0.05 });
  const sickleMat = spec.sickle
    ? new THREE.MeshStandardMaterial({ color: spec.sickle, roughness: 0.35, metalness: 0.45 })
    : feather;
  const pivots = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const side = (i / (n - 1)) * 2 - 1;
    const isSickle = Math.abs(side) < 0.34;
    const len = 0.26 * s * (isSickle ? 1.35 : 1 - Math.abs(side) * 0.22);
    const mesh = new THREE.Mesh(featherGeometry(len, 0.05 * s, isSickle ? 0.6 : 0.22, 8), isSickle ? sickleMat : feather);
    mesh.castShadow = true;
    const pivot = new THREE.Group();
    pivot.add(mesh);
    pivot.userData.side = side;
    pivot.userData.sickle = isSickle;
    g.add(pivot);
    pivots.push(pivot);
  }
  return { group: g, pivots };
}

function makeHandFan(spec, s, sgn) {
  const g = new THREE.Group();
  const feather = new THREE.MeshStandardMaterial({ color: spec.plumage, roughness: 0.78, metalness: 0.05 });
  const pivots = [];
  for (let i = 0; i < 4; i++) {
    const mesh = new THREE.Mesh(featherGeometry(0.17 * s * (1 - i * 0.09), 0.042 * s, 0.24, 6), feather);
    mesh.castShadow = true;
    const pivot = new THREE.Group();
    pivot.add(mesh);
    // Feathers point down and back along the folded wing at rest.
    pivot.rotation.set(deg(-150), 0, sgn * deg(10 + i * 9));
    pivot.userData.i = i;
    g.add(pivot);
    pivots.push(pivot);
  }
  return { group: g, pivots };
}

// --- the rig ----------------------------------------------------------------

// The acting layer owns the neck and the head outright — look-at, extension,
// pitch and roll are all channel-driven, exactly as on the procedural rig — so
// the clips' own neck/head motion is removed rather than fought. The bones sit
// at bind pose (restored every frame in applyBones, since the mixer no longer
// writes them) and the channels rotate them from there.
const ACTED_BONES = ['NeckTwist01', 'NeckTwist02', 'Head'];
function stripActedTracks(clip) {
  clip.tracks = clip.tracks.filter((t) => !ACTED_BONES.some((n) => t.name.startsWith(n + '.')));
}

// The walk and run clips bake their root motion into the Hip translation track
// (about a metre of drift per loop). The Actor's own path moves the body, so
// remove the linear drift and keep the intra-stride bob and sway. Returns the
// baked forward speed in model units so the clip can be played at matched rate.
function stripRootDrift(clip) {
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

const BONE_NAMES = ['Root', 'Hip', 'Pelvis', 'Waist', 'Spine01', 'Spine02', 'NeckTwist01', 'NeckTwist02', 'Head',
  'L_Clavicle', 'L_Upperarm', 'L_Forearm', 'L_Hand', 'R_Clavicle', 'R_Upperarm', 'R_Forearm', 'R_Hand',
  'L_Foot', 'R_Foot'];

// Build one bone rig from an already-parsed skinned scene. Tripo model space:
// character faces +X, wings along ±Z, feet near y=0. The wrapper turns it to
// face +Z (the whole cast's convention), scales it to `height` metres and puts
// the midpoint of the feet on the group origin.
function buildRigFrom(model, clips, spec, opts = {}) {
  const size = opts.size ?? spec.size ?? 1.14;
  const height = opts.height ?? 0.78;          // metres, floor to comb

  const bones = {};
  model.updateMatrixWorld(true);
  for (const n of BONE_NAMES) {
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

  // The sculpt's skull is small against the procedural cast's; a close-up
  // framed for the show carries too little face. One number, baked in CAL.
  bones.Head.scale.multiplyScalar(CAL.headScale);

  // The bench material pass: kill the wet-plastic speculars (roughness up,
  // metalness and its map gone — feathers are not metal) and keep the albedo
  // as the offline-graded texture put it; `albedo` stays available as a trim.
  const albedo = opts.albedo ?? 1.0;
  model.traverse((n) => {
    if (!n.isMesh) return;
    n.castShadow = true;
    n.receiveShadow = true;
    n.frustumCulled = false;   // the skinned bounds lag the pose
    if (!n.material) return;
    if (opts.cloneMaterial) n.material = n.material.clone();
    const m = n.material;
    if (m.roughness !== undefined) m.roughness = Math.max(0.82, m.roughness);
    if (m.metalness !== undefined) m.metalness = 0;
    if (m.metalnessMap) m.metalnessMap = null;
    if (m.roughnessMap) m.roughnessMap = null;
    if (opts.map) {
      m.map = opts.map;
      m.needsUpdate = true;
    }
    if (m.color && albedo !== 1) m.color.multiplyScalar(albedo);
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
  const idleAction = mixer.clipAction(clips.idle);
  const walkAction = mixer.clipAction(clips.walk);
  const runAction = clips.run ? mixer.clipAction(clips.run) : null;
  idleAction.play();
  walkAction.play();
  walkAction.setEffectiveWeight(0);
  if (runAction) { runAction.play(); runAction.setEffectiveWeight(0); }
  mixer.update(0);

  // World-aligned anchors, computed with the mixer parked on idle frame 0 and
  // the acted bones at bind (which is exactly where applyBones holds them).
  // The anchor's world axes equal the character's axes at yaw 0, and its
  // scale compensation puts children back in metres.
  root.updateMatrixWorld(true);
  for (const n of ACTED_BONES) {
    rest[n].world = bones[n].getWorldQuaternion(new THREE.Quaternion());
  }
  // A child of the bone whose axes equal the character's at bind and whose
  // scale compensation puts children back in metres. It is rigid, so once the
  // bone moves, everything on the anchor swings with it.
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
  // (x left, y up, z forward). Tuned against renders of the painted head.
  faceRoot.position.set(0, opts.faceUp ?? CAL.faceUp, opts.faceFwd ?? CAL.faceFwd);
  const faceScale = opts.faceScale ?? CAL.faceScale;
  const faceSize = size * faceScale;
  const { face, eyes, beakLowerPivot, wattles } = makeFace(spec, faceSize, opts.eyeSpread ?? CAL.eyeSpread);
  faceRoot.add(face);

  const neckAnchor = anchorOn(bones.NeckTwist01);
  neckAnchor.add(makeNeckerchief(size, opts.kerchief ?? 0xc4342f));

  // Tail fan on a spine anchor, at the painted tail's root. Character space:
  // x left, y up, z forward — the tail root sits behind and above the hip.
  const waistAnchor = anchorOn(bones.Waist);
  const tailFan = makeTailFan(spec, size);
  const wp = bones.Waist.getWorldPosition(new THREE.Vector3());
  tailFan.group.position.set(0 - wp.x, 0.5 * height - wp.y, -0.2 * size - wp.z);
  waistAnchor.add(tailFan.group);

  // Primaries on the hands: anchored at the wing tip in character axes and
  // carried by the bone, so a lifted or thrust wing ends in a visible fan of
  // feathers rather than a thin painted point.
  const handFans = [];
  for (const sgn of [1, -1]) {
    const bone = sgn > 0 ? bones.L_Hand : bones.R_Hand;
    const fan = makeHandFan(spec, size, sgn);
    anchorOn(bone).add(fan.group);
    handFans.push({ pivots: fan.pivots, side: sgn });
  }

  return {
    spec, name: spec.name, size, root, attitude, model, bones,
    // What the Actor surface and the camera expect of a rig:
    head: faceRoot, neck: bones.NeckTwist01, body: bones.Spine01,
    eyes, beakLowerPivot, propAnchor: faceRoot, faceSize,
    wattles, tailFan, handFans,
    mixer, idleAction, walkAction, runAction, walkWeight: 0, runWeight: 0, rest,
    walkSpeed: clips.walkSpeed * k,   // metres/sec the clip walks at, timescale 1
    runSpeed: clips.runSpeed * k,
    scale: k, headAnchor, faceRoot, neckAnchor,
    _sec: { wattle: 0, wattleV: 0, tail: 0, tailV: 0, lastHeadY: 0, lastHeadP: 0 },
  };
}

// Load the twins. One parse of the skinned scene serves both bodies: Esteban
// keeps the graded copper texture baked into the GLB, Ricardo is a skinned
// clone (Object3D.clone would leave him bound to his brother's bones — that
// bug shipped once already) with the blue/charcoal recolor swapped in. The
// walk and run clips carry no textures, so they are shared as-is.
export async function buildTwinRigs(perChar) {
  const [idleG, walkG, runG] = await Promise.all([
    loadCastGLB('esteban-idle.glb'),
    loadCastGLB('esteban-walk.glb'),
    loadCastGLB('esteban-run.glb').catch(() => null),
  ]);
  const clips = {
    idle: idleG.animations[0],
    walk: walkG.animations[0],
    run: runG ? runG.animations[0] : null,
    walkSpeed: 0, runSpeed: 0,
  };
  clips.walkSpeed = stripRootDrift(clips.walk);
  clips.runSpeed = clips.run ? stripRootDrift(clips.run) : clips.walkSpeed * 2.2;
  stripActedTracks(clips.idle);
  stripActedTracks(clips.walk);
  if (clips.run) stripActedTracks(clips.run);

  const rigs = {};
  const errors = [];

  const ricardoScene = perChar.ricardo ? cloneSkinned(idleG.scene) : null;

  if (perChar.esteban) {
    try {
      rigs.esteban = buildRigFrom(idleG.scene, clips, perChar.esteban.spec, perChar.esteban);
    } catch (e) { errors.push(`esteban: ${e.message}`); }
  }
  if (perChar.ricardo) {
    try {
      const img = await loadCastImage('ricardo-body.jpg');
      const tex = new THREE.Texture(img);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      rigs.ricardo = buildRigFrom(ricardoScene, clips, perChar.ricardo.spec, {
        ...perChar.ricardo, cloneMaterial: true, map: tex,
      });
    } catch (e) { errors.push(`ricardo: ${e.message}`); }
  }
  return { rigs, errors };
}

// --- the close-up fill ------------------------------------------------------
// The painted face cannot hold the night grade's key the way the procedural
// feathers do, so close-ups get a warm, short-throw fill that rides between
// the camera and the nearest skinned face. Enabled only when the camera is
// inside ~1.2 m of a bone-rigged head; the 1.6 m falloff means it lights the
// head and neck and dies before the set.
const FILL = {
  light: null, camera: null, stamp: null, on: 0,
  min: Infinity, head: new THREE.Vector3(), lastHead: new THREE.Vector3(),
};

export function attachCastFill(scene, camera) {
  if (FILL.light) return FILL.light;
  const light = new THREE.PointLight(0xffc896, 0, 1.6, 1.8);
  light.castShadow = false;
  light.visible = false;
  scene.add(light);
  FILL.light = light;
  FILL.camera = camera;
  return light;
}

function fillReport(headWorld) {
  const d = FILL.camera.position.distanceTo(headWorld);
  if (d < FILL.min) { FILL.min = d; FILL.head.copy(headWorld); }
}

function fillApply(time, dt) {
  if (FILL.stamp === time) return;   // one bone actor already ran this frame
  FILL.stamp = time;
  // Apply LAST frame's nearest face, then start the new tally.
  const tight = clamp01((1.2 - FILL.min) / 0.45);
  FILL.on = approach(FILL.on, tight, 12, dt);
  const L = FILL.light;
  L.visible = FILL.on > 0.02;
  L.intensity = FILL.on * 1.5;
  if (Number.isFinite(FILL.min)) FILL.lastHead.copy(FILL.head);
  L.position.copy(FILL.camera.position).lerp(FILL.lastHead, 0.45);
  L.position.y += 0.06;
  FILL.min = Infinity;
}

// --- the actor --------------------------------------------------------------

export class BoneActor extends Actor {
  // Take over an existing Actor in place. Every closure the Director built at
  // load time keeps pointing at the same object; only its class and its body
  // change. The procedural rig is hidden, not destroyed — setVisible and any
  // failure path can put it back.
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

  // Same buildPose as every other Actor; only the commit differs — the
  // channels drive the skeleton over the mixer's frame instead of applyPose.
  commitPose(p, dt, time, rdt) {
    // Clamp the turn rate while stepping, so a walking turn pivots over the
    // stride instead of shearing the planted feet sideways.
    this.turnRate = this.speed > 0.06 ? 1.9 : 3.2;
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.applyBones(p, dt);
    if (FILL.light) {
      fillApply(time, dt);
      fillReport(this.rig.head.getWorldPosition(_v));
    }
  }

  applyBones(p, dt) {
    const rig = this.rig, s = this.size, b = rig.bones;

    // Locomotion: idle -> walk -> run by ground speed, timescale ramped so the
    // stride rate follows the body through starts and stops instead of the
    // feet skating under a fixed-rate clip.
    const sp = this.speed;
    const movingW = clamp01((sp - 0.02 * s) / (0.18 * s));
    const runBlend = rig.runAction ? clamp01((sp - 0.72 * s) / (0.3 * s)) : 0;
    rig.walkWeight = approach(rig.walkWeight, movingW * (1 - runBlend), 7, dt);
    rig.runWeight = approach(rig.runWeight, movingW * runBlend, 7, dt);
    rig.idleAction.setEffectiveWeight(1 - Math.max(rig.walkWeight, rig.runWeight));
    rig.walkAction.setEffectiveWeight(rig.walkWeight);
    if (rig.runAction) rig.runAction.setEffectiveWeight(rig.runWeight);
    if (rig.walkWeight > 0.01) {
      rig.walkAction.timeScale = clamp(sp / Math.max(0.05, rig.walkSpeed), 0.45, 1.9);
    }
    if (rig.runAction && rig.runWeight > 0.01) {
      rig.runAction.timeScale = clamp(sp / Math.max(0.05, rig.runSpeed), 0.6, 1.6);
    }
    rig.mixer.update(dt);

    // Body offsets in character space (attitude sits under the yawed root).
    rig.attitude.position.set(0, p.bodyY * s - this.collapsedAmount * 0.1 * s, p.bodyZ * s);

    // Character axes in world space, given the root yaw.
    const yaw = this.yaw;
    _up.set(0, 1, 0);
    _left.set(Math.cos(yaw), 0, -Math.sin(yaw));
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));

    // Torso. Positive bodyPitch bows forward (chicken convention). A strongly
    // one-sided wing (accuse, slap) counter-rotates the chest into the line of
    // the gesture, which is what makes the pointing arm read at shot distance.
    const asym = clamp(p.wingRSweep - p.wingLSweep, -3, 3);
    rotW(b.Waist, _left, p.bodyPitch * 0.75);
    rotW(b.Waist, _up, p.bodyYaw * 0.8 + asym * 0.07);
    rotW(b.Waist, _fwd, p.bodyRoll * 0.8 + asym * 0.03);
    // The chest — strut and puff push it up and out.
    rotW(b.Spine02, _left, p.bodyPitch * 0.35 - p.puff * 0.14);
    // Puff also swells the body: a small uniform scale pulse on the chest
    // bone, the closest the skinned body has to the procedural inflate.
    b.Spine02.scale.setScalar(1 + clamp(p.puff, -0.5, 1.5) * 0.05);

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
    // the forearm. Signs: the bird's left is +X at yaw 0. The excursions sit
    // well above the first spike's — the bench found the acting area too small
    // at shot distance — and the elbow takes a real share of the lift.
    for (const sx of [-1, 1]) {
      const L = sx < 0;
      const lift = clamp(L ? p.wingLLift : p.wingRLift, -0.25, 1.35);
      const sweep = clamp(L ? p.wingLSweep : p.wingRSweep, -1.5, 1.5);
      const twist = clamp(L ? p.wingLTwist : p.wingRTwist, -1, 1);
      const sgn = L ? 1 : -1;                 // L_* chains reach the +X side
      const cl = L ? b.L_Clavicle : b.R_Clavicle;
      const ua = L ? b.L_Upperarm : b.R_Upperarm;
      const fa = L ? b.L_Forearm : b.R_Forearm;
      const ha = L ? b.L_Hand : b.R_Hand;
      rotW(cl, _fwd, sgn * lift * 0.5);
      rotW(ua, _fwd, sgn * (lift * 1.0 + p.wingSpread * 0.25));
      rotW(ua, _up, (L ? sweep : -sweep) * 1.1);
      rotW(fa, _up, (L ? sweep : -sweep) * 0.5);
      rotW(fa, _fwd, sgn * (p.wingSpread * 0.4 + lift * 0.3));
      rotW(ha, _fwd, sgn * (twist * 0.5 + p.wingSpread * 0.2));
    }
    // Hand fans spread with the wing.
    for (const f of rig.handFans) {
      const L = f.side > 0;
      const lift = clamp(L ? p.wingLLift : p.wingRLift, -0.25, 1.35);
      for (const pv of f.pivots) {
        const i = pv.userData.i;
        pv.rotation.z = f.side * (deg(10 + i * 9) + (p.wingSpread * 0.5 + lift * 0.25) * (0.35 + i * 0.3));
      }
    }

    // Secondary motion, the same springs as the procedural head: wattles lag
    // the skull, the tail fan lags the body.
    const sec = rig._sec;
    const hy = p.headYaw + p.neckYaw, hp = p.headPitch;
    const dy = (hy - sec.lastHeadY) / Math.max(dt, 1e-3), dp = (hp - sec.lastHeadP) / Math.max(dt, 1e-3);
    sec.lastHeadY = hy; sec.lastHeadP = hp;
    const spring = (val, vel, drive, kk, damp) => {
      vel += (drive - val) * kk * dt - vel * damp * dt;
      return [val + vel * dt, vel];
    };
    [sec.wattle, sec.wattleV] = spring(sec.wattle, sec.wattleV, clamp(-dy * 0.14 - dp * 0.05, -1.1, 1.1), 260, 13);
    [sec.tail, sec.tailV] = spring(sec.tail, sec.tailV, clamp(-p.bodyYaw * 0.5, -0.8, 0.8), 150, 11);
    rig.wattles.rotation.z = sec.wattle * 0.5;
    rig.wattles.rotation.x = clamp(sec.wattle, -0.6, 0.6) * 0.18 + (p.wattleSwing ?? 0) * 0.3;

    // Tail: fan and pitch are live channels again (strut, pride, sorrow).
    rig.tailFan.group.rotation.set(p.tailPitch, p.tailYaw + sec.tail * 0.5, 0, 'ZYX');
    for (const f of rig.tailFan.pivots) {
      const side = f.userData.side;
      const fan = 0.34 + clamp(p.tailFan, 0, 1.2) * 0.55;
      f.rotation.set(deg(-58) + (f.userData.sickle ? deg(-14) : 0), side * fan * 0.55, side * fan * 0.62, 'ZYX');
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
      // Raised brows stay ON the shell — clamped harder than the procedural
      // formula, whose shock-brows crest the crown and read as floating bars
      // against the night from a low angle.
      e.brow.position.y = 0.032 * fs + clamp(p.browHeight, -1, 0.5) * 0.015 * fs;
      e.brow.position.z = 0.024 * fs;
      e.pupil.position.x = p.eyeX * 0.008 * fs;
      e.pupil.position.y = p.eyeY * 0.008 * fs;
    }
  }
}
