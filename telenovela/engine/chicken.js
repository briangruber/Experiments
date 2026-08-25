// Procedural chicken. Everything below is built from primitives at load time —
// no meshes to download, and every character is the same rig with different
// dials, so the acting layer only ever has to talk to one set of channels.

import * as THREE from '../vendor/three/three.module.min.js';
import { TAU, clamp, clamp01, lerp, deg, mulberry32 } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

// A plump body of revolution. Profile runs tail (z-) to breast (z+); the lathe
// is built around Y then tipped onto Z so the bird faces +Z.
function bodyGeometry(rng, opts) {
  const { length, girth, breast, rump } = opts;
  const pts = [];
  const prof = [
    [0.00, 0.02], [0.06, 0.30], [0.14, 0.55], [0.25, 0.78], [0.38, 0.92],
    [0.52, 1.00], [0.66, 0.99], [0.78, 0.92], [0.88, 0.78], [0.95, 0.55], [1.0, 0.16],
  ];
  for (const [t, r] of prof) {
    // Rump end fattened, breast end fuller and rounder.
    const shape = lerp(rump, breast, t);
    pts.push(new THREE.Vector2(Math.max(0.001, r * girth * shape), (t - 0.5) * length));
  }
  const g = new THREE.LatheGeometry(pts, 28);
  g.rotateX(-Math.PI / 2); // lathe axis Y -> Z, bird now faces +Z
  // A little organic lumpiness so the silhouette isn't a perfect solid of
  // revolution. Small amplitude: feathers, not tumours.
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = (rng() - 0.5) * 0.5 + Math.sin(z * 19 + x * 11) * Math.cos(y * 15) * 0.5;
    const s = 1 + n * 0.035;
    pos.setXYZ(i, x * s, y * s, z);
  }
  g.computeVertexNormals();
  return g;
}

// One feather: a tapered, slightly curved blade. Used for tails, wing primaries
// and the ruff scales.
function featherGeometry(len, wid, curve = 0.25, segs = 7) {
  const g = new THREE.BufferGeometry();
  const pos = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Width swells early and tapers to a point.
    const w = wid * Math.sin(Math.pow(t, 0.55) * Math.PI) * (1 - t * 0.25) + wid * 0.05 * (1 - t);
    const y = t * len;
    const z = -curve * t * t * len;          // droop / sweep
    const thick = 0.32 * w + 0.004;
    pos.push(-w, y, z, 0, y, z + thick, w, y, z);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 3, b = a + 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// The comb: a serrated blade standing on the skull. Extruded from a Shape so
// the points read even in silhouette against a lightning flash.
function combGeometry(len, hgt, points, thick) {
  const s = new THREE.Shape();
  s.moveTo(-len / 2, 0);
  for (let i = 0; i < points; i++) {
    const t0 = i / points, t1 = (i + 0.5) / points, t2 = (i + 1) / points;
    const env = Math.sin(Math.pow(t1, 0.8) * Math.PI) * 0.55 + 0.45;
    s.lineTo(lerp(-len / 2, len / 2, t1), hgt * env);
    s.lineTo(lerp(-len / 2, len / 2, t2), hgt * env * 0.34);
    void t0;
  }
  s.lineTo(len / 2, 0);
  s.lineTo(-len / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: thick, bevelEnabled: true, bevelSize: thick * 0.45, bevelThickness: thick * 0.4, bevelSegments: 2, curveSegments: 2,
  });
  g.translate(0, 0, -thick / 2);
  g.rotateY(Math.PI / 2); // blade lies in the ZY plane, along the skull
  return g;
}

// Wing: a rounded paddle, extruded and bevelled so it catches the key light.
function wingGeometry(len, wid, thick) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(len * 0.35, wid * 0.62, len * 0.78, wid * 0.55, len, wid * 0.12);
  s.bezierCurveTo(len * 0.98, -wid * 0.12, len * 0.7, -wid * 0.42, len * 0.34, -wid * 0.44);
  s.bezierCurveTo(len * 0.16, -wid * 0.44, len * 0.03, -wid * 0.24, 0, 0);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: thick, bevelEnabled: true, bevelSize: thick * 0.9, bevelThickness: thick * 0.8, bevelSegments: 2, curveSegments: 8,
  });
  g.translate(0, 0, -thick / 2);
  return g;
}

function toeGeometry(len, r) {
  const g = new THREE.CylinderGeometry(r * 0.55, r, len, 5, 1);
  g.translate(0, len / 2, 0);
  g.rotateX(Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------
// the rig
// ---------------------------------------------------------------------------

export const REST = () => ({
  bodyY: 0, bodyPitch: 0, bodyRoll: 0, bodyYaw: 0, bodyZ: 0, squash: 0, puff: 0,
  neckExtend: 0, neckPitch: 0, neckYaw: 0,
  headPitch: 0, headYaw: 0, headRoll: 0, headZ: 0, headY: 0,
  beak: 0, browAngle: 0, browHeight: 0, lid: 0, lidAngle: 0, eyeX: 0, eyeY: 0,
  wingLLift: 0, wingRLift: 0, wingLSweep: 0, wingRSweep: 0, wingLTwist: 0, wingRTwist: 0, wingSpread: 0,
  tailPitch: 0, tailFan: 0, tailYaw: 0,
  legLift: 0, stance: 0,
});

const FEATHER_COUNT = 34;

export function makeChicken(spec) {
  const rng = mulberry32(spec.seed ?? 7);
  const s = spec.size ?? 1;

  const feather = new THREE.MeshStandardMaterial({
    color: spec.plumage, roughness: 0.78, metalness: 0.04,
  });
  if (spec.sheen) { feather.metalness = 0.16; feather.roughness = 0.52; }
  const accent = new THREE.MeshStandardMaterial({ color: spec.accent ?? spec.plumage, roughness: 0.7, metalness: 0.05 });
  const comb = new THREE.MeshStandardMaterial({ color: spec.comb, roughness: 0.45, metalness: 0.0 });
  const beakMat = new THREE.MeshStandardMaterial({ color: spec.beak ?? 0xd8a445, roughness: 0.42 });
  const legMat = new THREE.MeshStandardMaterial({ color: spec.legs ?? 0xd0913c, roughness: 0.62 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: spec.iris ?? 0xc8862a, roughness: 0.18, metalness: 0.1 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x08060a, roughness: 0.1 });
  // A bare ring of skin round the socket, so the eye reads against the face.
  const ringMat = new THREE.MeshStandardMaterial({
    color: spec.eyeRing ?? new THREE.Color(spec.plumage).multiplyScalar(0.3).getHex(),
    roughness: 0.6,
  });
  // Brows read as expression only if they are darker than the face.
  const browMat = new THREE.MeshStandardMaterial({
    color: spec.brow ?? new THREE.Color(spec.plumage).multiplyScalar(0.42).getHex(),
    roughness: 0.85,
  });
  const materials = [feather, accent, comb, beakMat, legMat, eyeMat, pupilMat, browMat, ringMat];

  const root = new THREE.Group();
  root.name = spec.name;

  const hipY = 0.30 * s;
  const body = new THREE.Group();
  body.position.y = hipY;
  root.add(body);

  const bodyLen = 0.44 * s, girth = 0.145 * s;
  const bodyMesh = new THREE.Mesh(bodyGeometry(rng, {
    length: bodyLen, girth, breast: spec.breast ?? 1.0, rump: spec.rump ?? 0.86,
  }), feather);
  bodyMesh.castShadow = bodyMesh.receiveShadow = true;
  body.add(bodyMesh);

  // Feather scales over the rump and flank — one instanced draw per bird.
  const scaleGeo = featherGeometry(0.11 * s, 0.036 * s, 0.5, 4);
  const ruff = new THREE.InstancedMesh(scaleGeo, accent, FEATHER_COUNT);
  ruff.castShadow = true;
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    for (let i = 0; i < FEATHER_COUNT; i++) {
      const u = rng(), v = rng();
      const zt = lerp(-0.46, 0.16, u * u);           // biased to the rump
      const ang = v * TAU;
      const rad = girth * (0.92 - Math.abs(zt / bodyLen) * 0.5);
      p.set(Math.cos(ang) * rad, Math.sin(ang) * rad * 0.96, zt * bodyLen * 2.1);
      e.set(deg(96) + (rng() - 0.5) * 0.5, 0, ang - Math.PI / 2 + (rng() - 0.5) * 0.4, 'ZYX');
      q.setFromEuler(e);
      const k = 0.75 + rng() * 0.6;
      sc.set(k, k * (0.9 + rng() * 0.5), k);
      ruff.setMatrixAt(i, m.compose(p, q, sc));
    }
    ruff.instanceMatrix.needsUpdate = true;
  }
  body.add(ruff);

  // --- tail -----------------------------------------------------------------
  const tail = new THREE.Group();
  tail.position.set(0, 0.03 * s, -bodyLen * 0.48);
  body.add(tail);
  const tailFeathers = [];
  const nTail = spec.rooster ? 9 : 7;
  for (let i = 0; i < nTail; i++) {
    const t = nTail === 1 ? 0 : i / (nTail - 1);
    const side = t * 2 - 1;
    const isSickle = spec.rooster && Math.abs(side) < 0.34;
    const len = (spec.rooster ? 0.30 : 0.21) * s * (isSickle ? 1.45 : 1 - Math.abs(side) * 0.22);
    const g = featherGeometry(len, (spec.rooster ? 0.052 : 0.062) * s, isSickle ? 0.62 : 0.2, 8);
    const mesh = new THREE.Mesh(g, isSickle && spec.sickle ? new THREE.MeshStandardMaterial({ color: spec.sickle, roughness: 0.35, metalness: 0.45 }) : feather);
    mesh.castShadow = true;
    const pivot = new THREE.Group();
    pivot.add(mesh);
    pivot.userData.side = side;
    pivot.userData.sickle = isSickle;
    tail.add(pivot);
    tailFeathers.push(pivot);
  }

  // --- neck & head ----------------------------------------------------------
  const neck = new THREE.Group();
  neck.position.set(0, 0.09 * s, bodyLen * 0.34);
  body.add(neck);
  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.052 * s, 0.085 * s, 0.16 * s, 14, 1, true), feather);
  neckMesh.position.y = 0.06 * s;
  neckMesh.castShadow = true;
  neck.add(neckMesh);
  // Hackle feathers around the neck — these fluff when a bird is furious.
  const hackle = new THREE.InstancedMesh(featherGeometry(0.1 * s, 0.03 * s, 0.42, 4), accent, 14);
  hackle.castShadow = true;
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      const r = 0.062 * s;
      e.set(deg(150), 0, a - Math.PI / 2, 'ZYX');
      q.setFromEuler(e);
      m.compose(V(Math.cos(a) * r, 0.035 * s, Math.sin(a) * r), q, V(1, 1, 1));
      hackle.setMatrixAt(i, m);
    }
    hackle.instanceMatrix.needsUpdate = true;
  }
  neck.add(hackle);

  const head = new THREE.Group();
  head.position.set(0, 0.135 * s, 0.012 * s);
  neck.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.085 * s, 20, 16), feather);
  skull.scale.set(0.97, 0.96, 1.1);
  skull.castShadow = true;
  head.add(skull);

  const combMesh = new THREE.Mesh(
    combGeometry((spec.rooster ? 0.15 : 0.085) * s, (spec.rooster ? 0.075 : 0.032) * s, spec.rooster ? 6 : 4, 0.014 * s),
    comb,
  );
  combMesh.position.set(0, 0.075 * s, -0.004 * s);
  combMesh.castShadow = true;
  head.add(combMesh);

  // Wattles — they swing, which is most of what sells a head-turn.
  const wattles = new THREE.Group();
  wattles.position.set(0, -0.055 * s, 0.062 * s);
  head.add(wattles);
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.SphereGeometry((spec.rooster ? 0.032 : 0.02) * s, 10, 10), comb);
    w.scale.set(0.55, 1.5, 0.75);
    w.position.set(sx * 0.018 * s, -0.014 * s, 0);
    w.castShadow = true;
    wattles.add(w);
  }

  const beak = new THREE.Group();
  beak.position.set(0, -0.006 * s, 0.078 * s);
  head.add(beak);
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

  // --- eyes -----------------------------------------------------------------
  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(sx * 0.055 * s, 0.028 * s, 0.036 * s);
    eye.rotation.y = sx * deg(46); // chickens are side-eyed, which is a gift
    head.add(eye);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.03 * s, 16, 14), eyeMat);
    ball.scale.z = 0.88;
    eye.add(ball);
    // The pupil has to clear the eyeball or it is simply not there.
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
    // Upper lid: a hemisphere that rolls down over the ball.
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.0325 * s, 16, 8, 0, TAU, 0, Math.PI * 0.5), feather);
    lid.rotation.x = deg(-96);
    eye.add(lid);
    // Brow tuft. Not anatomical. Entirely necessary.
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.0105 * s, 0.016 * s), browMat);
    brow.position.set(0, 0.034 * s, 0.021 * s);
    brow.castShadow = true;
    eye.add(brow);
    eyes.push({ group: eye, ball, pupil, lid, brow, side: sx });
  }

  // --- wings ----------------------------------------------------------------
  const wings = [];
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * girth * 0.82, 0.055 * s, 0.05 * s);
    body.add(shoulder);
    const wg = wingGeometry(0.26 * s, 0.2 * s, 0.016 * s);
    const w = new THREE.Mesh(wg, feather);
    w.castShadow = true;
    // Lie the paddle along the flank, tip pointing back.
    w.rotation.set(0, sx * Math.PI / 2, deg(-172));
    shoulder.add(w);
    const primaries = [];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Group();
      const fm = new THREE.Mesh(featherGeometry(0.15 * s, 0.038 * s, 0.22, 6), feather);
      fm.castShadow = true;
      p.add(fm);
      p.position.set(sx * 0.012 * s, -0.03 * s, -0.19 * s + i * 0.012 * s);
      p.userData.i = i;
      p.userData.side = sx;
      shoulder.add(p);
      primaries.push(p);
    }
    wings.push({ shoulder, mesh: w, primaries, side: sx });
  }

  // --- legs -----------------------------------------------------------------
  const legs = [];
  const thighLen = 0.15 * s, shinLen = 0.17 * s;
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 0.058 * s, -0.02 * s, -0.02 * s);
    body.add(hip);
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.021 * s, 0.017 * s, thighLen, 7), legMat);
    thigh.position.y = -thighLen / 2;
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -thighLen;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.014 * s, 0.016 * s, shinLen, 7), legMat);
    shin.position.y = -shinLen / 2;
    shin.castShadow = true;
    knee.add(shin);
    const ankle = new THREE.Group();
    ankle.position.y = -shinLen;
    knee.add(ankle);
    const foot = new THREE.Group();
    ankle.add(foot);
    for (const a of [-0.5, 0, 0.5]) {
      const toe = new THREE.Mesh(toeGeometry(0.075 * s, 0.011 * s), legMat);
      toe.rotation.y = a;
      toe.castShadow = true;
      foot.add(toe);
    }
    const spur = new THREE.Mesh(toeGeometry(0.045 * s, 0.01 * s), legMat);
    spur.rotation.y = Math.PI;
    foot.add(spur);
    legs.push({ hip, knee, ankle, foot, side: sx, thighLen, shinLen, phase: sx > 0 ? 0.5 : 0 });
  }

  // Props (hat, monocle, eyepatch…) hang off the head so they inherit its acting.
  const propAnchor = new THREE.Group();
  head.add(propAnchor);

  const rig = {
    spec, name: spec.name, size: s, root, body, bodyMesh, neck, head, skull, combMesh, wattles,
    beak, beakLowerPivot, eyes, wings, legs, tail, tailFeathers, ruff, hackle, propAnchor,
    materials, hipY, bodyLen, girth,
    // secondary-motion state
    _sec: { wattle: 0, wattleV: 0, comb: 0, combV: 0, tail: 0, tailV: 0, lastHeadY: 0, lastHeadP: 0 },
  };

  applyPose(rig, REST(), 0);
  return rig;
}

// ---------------------------------------------------------------------------
// posing
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();

// Two-bone IK for a chicken leg. The visible joint bends backwards, so the
// solution is mirrored relative to a human knee.
function solveLeg(leg, targetLocal) {
  const { thighLen: a, shinLen: b, hip, knee, ankle } = leg;
  _v.copy(targetLocal).sub(hip.position);
  const d = clamp(_v.length(), 1e-3, (a + b) * 0.999);
  // Angle at the hip between the leg line and the thigh.
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const cosK = clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1);
  const A = Math.acos(cosA), K = Math.acos(cosK);
  // Direction to target, in the hip's parent space.
  const pitch = Math.atan2(_v.z, -_v.y);
  const roll = Math.atan2(-_v.x, -_v.y);
  hip.rotation.set(pitch - A, 0, roll, 'ZXY');
  knee.rotation.set(Math.PI - K, 0, 0);
  ankle.rotation.set(-(pitch - A) - (Math.PI - K), 0, 0); // keep the foot flat
}

export function applyPose(rig, p, dt = 0.016) {
  const s = rig.size;
  const { body, neck, head, beakLowerPivot, wings, tail, tailFeathers, eyes } = rig;

  body.position.y = rig.hipY + p.bodyY * s - p.squash * 0.05 * s;
  body.position.z = p.bodyZ * s;
  body.rotation.set(p.bodyPitch, p.bodyYaw, p.bodyRoll, 'ZYX');
  const puff = 1 + p.puff * 0.16;
  body.scale.set(puff, puff * (1 - p.squash * 0.16), 1 + p.squash * 0.1);

  neck.position.y = 0.09 * s + p.neckExtend * 0.075 * s;
  neck.position.z = 0.115 * s + p.neckExtend * 0.03 * s;
  neck.rotation.set(p.neckPitch, p.neckYaw, 0, 'ZYX');
  neck.scale.y = 1 + p.neckExtend * 0.55;

  head.position.set(0, 0.135 * s + p.headY * s, 0.012 * s + p.headZ * s);
  head.rotation.set(p.headPitch, p.headYaw, p.headRoll, 'ZYX');

  beakLowerPivot.rotation.x = p.beak * 0.42;

  // Secondary motion: comb and wattles lag the skull, tail lags the body.
  const sec = rig._sec;
  const hy = head.rotation.y + neck.rotation.y, hp = head.rotation.x;
  const dy = (hy - sec.lastHeadY) / Math.max(dt, 1e-3), dp = (hp - sec.lastHeadP) / Math.max(dt, 1e-3);
  sec.lastHeadY = hy; sec.lastHeadP = hp;
  const spring = (val, vel, drive, k, damp) => {
    vel += (drive - val) * k * dt - vel * damp * dt;
    return [val + vel * dt, vel];
  };
  [sec.wattle, sec.wattleV] = spring(sec.wattle, sec.wattleV, clamp(-dy * 0.14 - dp * 0.05, -1.1, 1.1), 260, 13);
  [sec.comb, sec.combV] = spring(sec.comb, sec.combV, clamp(-dy * 0.09, -0.9, 0.9), 340, 15);
  [sec.tail, sec.tailV] = spring(sec.tail, sec.tailV, clamp(-p.bodyYaw * 0.5, -0.8, 0.8), 150, 11);
  rig.wattles.rotation.z = sec.wattle * 0.5;
  rig.wattles.rotation.x = clamp(sec.wattle, -0.6, 0.6) * 0.18;
  rig.combMesh.rotation.z = sec.comb * 0.26;

  tail.rotation.set(p.tailPitch, p.tailYaw + sec.tail * 0.5, 0, 'ZYX');
  for (const f of tailFeathers) {
    const side = f.userData.side;
    const fan = 0.34 + clamp(p.tailFan, 0, 1.2) * 0.55;
    f.rotation.set(deg(-38) + (f.userData.sickle ? deg(-14) : 0), side * fan * 0.55, side * fan * 0.62, 'ZYX');
  }

  for (const w of wings) {
    const sx = w.side;
    const lift = clamp(sx < 0 ? p.wingLLift : p.wingRLift, -0.25, 1.35);
    const sweep = clamp(sx < 0 ? p.wingLSweep : p.wingRSweep, -1.5, 1.5);
    const twist = clamp(sx < 0 ? p.wingLTwist : p.wingRTwist, -1, 1);
    w.shoulder.rotation.set(sweep, sx * lift * 0.8, sx * (lift * 0.95 + twist), 'ZYX');
    for (const pr of w.primaries) {
      const i = pr.userData.i;
      const spread = p.wingSpread * (0.4 + i * 0.3);
      pr.rotation.set(deg(-96) - lift * 0.2, sx * (0.25 + spread), sx * (0.5 + spread * 0.9), 'ZYX');
    }
  }

  for (const e of eyes) {
    // Negative lid over-opens the eye; that is where the shock lives.
    const lid = clamp(p.lid, -0.3, 1);
    e.lid.rotation.x = deg(-96) + lid * deg(186);
    e.lid.rotation.z = e.side * p.lidAngle * 0.5;
    e.brow.rotation.z = e.side * p.browAngle;
    e.brow.position.y = 0.038 * s + p.browHeight * 0.02 * s;
    e.pupil.position.x = p.eyeX * 0.008 * s;
    e.pupil.position.y = p.eyeY * 0.008 * s;
  }
}

// Foot placement is driven by the walker; kept separate so a standing bird can
// still shuffle its weight without the locomotion system running.
export function placeFeet(rig, footTargets) {
  for (let i = 0; i < 2; i++) solveLeg(rig.legs[i], footTargets[i]);
}

export { solveLeg, featherGeometry, V };
