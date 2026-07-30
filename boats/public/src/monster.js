import * as THREE from 'three';
import { MONSTER_BY_ID } from '/shared/config.js';
import { sampleWater } from '/shared/waves.js';

// Three body plans, each built once per monster and animated on the CPU.
// Segmented bodies go through an InstancedMesh so a serpent is one draw call
// instead of fourteen -- there can be forty of these on screen.

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _water = {};
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _near = new THREE.Vector3();

const mat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.06, flatShading: true, ...extra });

function eye(size, color) {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 7), mat(0xf7e9c8, { emissive: color, emissiveIntensity: 0.9 }));
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(size * 0.52, 7, 6), mat(0x0a0a0c));
  pupil.position.x = size * 0.62;
  pupil.scale.set(0.6, 1.3, 1);
  g.add(ball, pupil);
  return g;
}

function teethRing(radius, count, len, color) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(len * 0.28, len, 4), mat(color));
    tooth.position.set(0, Math.cos(a) * radius, Math.sin(a) * radius);
    tooth.rotation.z = -Math.PI / 2;
    g.add(tooth);
  }
  return g;
}

/* ----------------------------------------------------------------- serpent */

function buildSerpent(type, size) {
  const group = new THREE.Group();
  const SEG = 20;
  // Segments overlap heavily so the body reads as one animal rather than a
  // string of beads.
  const spacing = size * 0.62;
  const seg = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), mat(type.color), SEG);
  seg.frustumCulled = false;
  group.add(seg);

  // Dorsal fins ride the same spine as the body segments.
  const FIN = 9;
  const fins = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 3), mat(type.accent, { side: THREE.DoubleSide }), FIN);
  fins.frustumCulled = false;
  group.add(fins);

  const head = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(size * 0.92, 11, 9), mat(type.color));
  skull.scale.set(1.45, 0.92, 1.0);
  const snout = new THREE.Mesh(new THREE.ConeGeometry(size * 0.62, size * 1.7, 8), mat(type.color));
  snout.rotation.z = -Math.PI / 2;
  snout.position.set(size * 1.15, size * 0.12, 0);
  const jaw = new THREE.Group();
  const jawMesh = new THREE.Mesh(new THREE.ConeGeometry(size * 0.55, size * 1.6, 7), mat(type.color));
  jawMesh.rotation.z = -Math.PI / 2;
  jawMesh.position.x = size * 0.8;
  jawMesh.scale.y = 0.42;
  jaw.add(jawMesh, teethRing(size * 0.34, 8, size * 0.42, 0xf2e6cf));
  jaw.position.set(size * 0.25, -size * 0.24, 0);
  // Head frill: three swept spines, the bit you see first at range.
  for (let i = 0; i < 3; i++) {
    const spine = new THREE.Mesh(
      new THREE.ConeGeometry(size * 0.24, size * (1.5 - i * 0.28), 3),
      mat(type.accent, { side: THREE.DoubleSide })
    );
    spine.position.set(-size * (0.15 + i * 0.42), size * 0.66, 0);
    spine.rotation.z = 0.45 + i * 0.14;
    head.add(spine);
  }
  const eL = eye(size * 0.26, type.accent); eL.position.set(size * 0.62, size * 0.36, size * 0.52);
  const eR = eye(size * 0.26, type.accent); eR.position.set(size * 0.62, size * 0.36, -size * 0.52);
  head.add(skull, snout, jaw, eL, eR);
  group.add(head);

  const tailFin = new THREE.Mesh(
    new THREE.ConeGeometry(size * 0.85, size * 1.7, 3),
    mat(type.accent, { side: THREE.DoubleSide })
  );
  tailFin.scale.set(0.28, 1, 1);
  group.add(tailFin);

  const radii = [];
  for (let i = 0; i < SEG; i++) {
    const t = i / (SEG - 1);
    // Thick shoulders, long thin whip of a tail.
    radii.push(size * (0.78 * Math.pow(1 - t, 0.62) + 0.045));
  }

  return {
    group, head, jaw,
    spheres: new Array(SEG + 1).fill(null).map(() => ({ pos: new THREE.Vector3(), r: 1 })),
    update(ctx) {
      const { time, phase, swim, arch } = ctx;
      const pts = [];
      for (let i = 0; i < SEG; i++) {
        const x = -spacing * (i + 1.2);
        const lateral = Math.sin(phase - i * 0.34) * size * 0.5 * swim;
        // Big slow humps: the body loops in and out of the surface, which is
        // the whole silhouette of a sea serpent.
        const vert = Math.sin(phase * 0.8 - i * 0.46) * size * 1.15 * arch;
        pts.push(new THREE.Vector3(x, vert, lateral));
      }
      for (let i = 0; i < SEG; i++) {
        const p = pts[i];
        const nxt = pts[i + 1] || p;
        _q.setFromUnitVectors(_v.set(1, 0, 0), _s.copy(nxt).sub(p).normalize());
        _s.set(radii[i] * 1.5, radii[i], radii[i]);
        _m.compose(p, _q, _s);
        seg.setMatrixAt(i, _m);
        if (i < FIN) {
          const j = i * 2;
          const src = pts[j] || p;
          _q.setFromUnitVectors(_v.set(0, 1, 0), _s.set(0, 1, 0));
          _s.set(radii[j] * 0.7, radii[j] * 2.4, radii[j] * 0.16);
          _m.compose(_v.copy(src).setY(src.y + radii[j] * 1.5), _q, _s);
          fins.setMatrixAt(i, _m);
        }
      }
      seg.instanceMatrix.needsUpdate = true;
      fins.instanceMatrix.needsUpdate = true;

      const tail = pts[SEG - 1];
      tailFin.position.copy(tail);
      tailFin.rotation.z = Math.PI / 2 - 0.4;
      tailFin.rotation.y = Math.sin(phase - SEG * 0.34) * 0.6;

      head.position.set(0, Math.sin(phase * 0.8 + 0.46) * size * 0.95 * arch, Math.sin(phase + 0.34) * size * 0.35 * swim);
      head.rotation.z = Math.sin(phase * 0.8 + 1.1) * 0.22 * arch;
      head.rotation.y = -Math.sin(phase + 0.8) * 0.2 * swim;
      jaw.rotation.z = 0.14 + Math.max(0, Math.sin(time * 1.6)) * 0.36 * ctx.rage;

      // Hit spheres follow the animated spine exactly, so a long body really is
      // a long target.
      this.spheres[0].pos.copy(head.position); this.spheres[0].r = size * 1.25;
      for (let i = 0; i < SEG; i++) {
        this.spheres[i + 1].pos.copy(pts[i]);
        this.spheres[i + 1].r = Math.max(radii[i] * 1.5, size * 0.3);
      }
    },
  };
}

/* ------------------------------------------------------------------ kraken */

function buildKraken(type, size) {
  const group = new THREE.Group();

  const mantle = new THREE.Mesh(new THREE.ConeGeometry(size * 1.15, size * 3.0, 11), mat(type.color));
  mantle.rotation.z = Math.PI / 2;
  mantle.position.x = -size * 1.1;
  mantle.scale.set(1, 1, 0.86);
  group.add(mantle);

  const head = new THREE.Mesh(new THREE.SphereGeometry(size * 1.05, 12, 9), mat(type.color));
  head.scale.set(1.15, 0.95, 1);
  group.add(head);

  const fin = new THREE.Mesh(new THREE.ConeGeometry(size * 0.7, size * 1.3, 3), mat(type.accent, { side: THREE.DoubleSide }));
  fin.rotation.x = Math.PI / 2;
  fin.position.set(-size * 2.1, size * 0.2, 0);
  group.add(fin);

  const eL = eye(size * 0.52, type.accent); eL.position.set(size * 0.55, size * 0.42, size * 0.82);
  const eR = eye(size * 0.52, type.accent); eR.position.set(size * 0.55, size * 0.42, -size * 0.82);
  eL.rotation.y = 0.5; eR.rotation.y = -0.5;
  group.add(eL, eR);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(size * 0.34, size * 0.7, 5), mat(0x1a1418));
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(size * 0.95, -size * 0.15, 0);
  group.add(beak);

  const ARMS = 8, LINK = 16;
  const arms = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 6), mat(type.color), ARMS * LINK);
  arms.frustumCulled = false;
  group.add(arms);

  const suckers = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 5, 4), mat(type.accent), ARMS * LINK);
  suckers.frustumCulled = false;
  group.add(suckers);

  const spheres = new Array(1 + ARMS * 3).fill(null).map(() => ({ pos: new THREE.Vector3(), r: 1 }));

  return {
    group, head,
    spheres,
    update(ctx) {
      const { phase, swim, rage } = ctx;
      let k = 0, si = 1;
      for (let a = 0; a < ARMS; a++) {
        const ang = (a / ARMS) * Math.PI * 2;
        // Arms radiate from a ring around the beak and curl outward. Two of
        // them rear clear of the water -- that is the shot you see coming.
        const rearing = a === 1 || a === ARMS - 1;
        const phaseOff = a * 0.8;
        for (let i = 0; i < LINK; i++) {
          const t = i / (LINK - 1);
          const wave = Math.sin(phase * 1.5 - i * 0.42 + phaseOff) * (0.4 + swim * 0.6);
          const spread = size * (0.6 + t * 1.5);
          const curl = Math.sin(t * 2.4 + wave * 0.5);
          // Links are packed tight: an arm that gaps into floating beads is the
          // one thing that breaks a kraken.
          const x = size * (0.85 + t * 2.3) - Math.abs(curl) * size * t * 0.45;
          let y = Math.sin(ang) * spread * 0.72 + wave * size * t * 0.5;
          if (rearing) y += Math.pow(t, 1.7) * size * (1.7 + rage * 0.8);
          else y -= Math.pow(t, 2) * size * 0.7;
          const z = Math.cos(ang) * spread + wave * size * t * 0.4;
          const r = size * (0.42 * (1 - t * 0.72) + 0.055);
          _v.set(x, y, z);
          _q.identity();
          _s.set(r * 1.5, r * 1.15, r * 1.15);
          _m.compose(_v, _q, _s);
          arms.setMatrixAt(k, _m);
          _s.set(r * 0.42, r * 0.42, r * 0.42);
          _m.compose(_v.clone().setY(y + r * 0.8), _q, _s);
          suckers.setMatrixAt(k, _m);
          k++;
          if (i % 6 === 5 && si < spheres.length) {
            spheres[si].pos.set(x, y, z);
            spheres[si].r = r * 2.4;
            si++;
          }
        }
      }
      arms.instanceMatrix.needsUpdate = true;
      suckers.instanceMatrix.needsUpdate = true;

      head.position.y = Math.sin(phase * 0.7) * size * 0.25;
      mantle.position.y = head.position.y - size * 0.05;
      mantle.scale.y = 1 + Math.sin(phase * 0.7 + 1.2) * 0.09;
      spheres[0].pos.set(0, head.position.y, 0);
      spheres[0].r = size * 1.9;
      while (si < spheres.length) { spheres[si].pos.set(0, head.position.y, 0); spheres[si].r = 0.01; si++; }
    },
  };
}

/* --------------------------------------------------------------- leviathan */

function buildLeviathan(type, size) {
  const group = new THREE.Group();

  const bodyGeo = new THREE.SphereGeometry(size, 14, 11);
  const pos = bodyGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Clamped: x/size can land a hair outside [-1,1] and Math.pow would NaN.
    const t = Math.min(1, Math.max(0, (x / size + 1) * 0.5)); // 0 tail .. 1 snout
    const taper = 0.30 + 1.05 * Math.sin(Math.PI * Math.pow(t, 0.85));
    pos.setXYZ(i, x * 2.5, y * taper * (y < 0 ? 1.12 : 0.86), z * taper);
  }
  bodyGeo.computeVertexNormals();
  const body = new THREE.Mesh(bodyGeo, mat(type.color));
  group.add(body);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(size * 0.86, 12, 9), mat(type.accent));
  belly.scale.set(2.1, 0.5, 0.86);
  belly.position.y = -size * 0.52;
  group.add(belly);

  const jaw = new THREE.Group();
  const jawMesh = new THREE.Mesh(new THREE.SphereGeometry(size * 0.62, 10, 8), mat(type.color));
  jawMesh.scale.set(1.9, 0.42, 0.82);
  jaw.add(jawMesh, teethRing(size * 0.42, 9, size * 0.36, 0xf2e6cf));
  jaw.position.set(size * 1.5, -size * 0.30, 0);
  group.add(jaw);

  const tail = new THREE.Group();
  const stalk = new THREE.Mesh(new THREE.ConeGeometry(size * 0.42, size * 1.4, 7), mat(type.color));
  stalk.rotation.z = Math.PI / 2;
  stalk.position.x = -size * 0.5;
  const flukeGeo = new THREE.ConeGeometry(size * 1.05, size * 1.5, 3);
  const flukeL = new THREE.Mesh(flukeGeo, mat(type.color, { side: THREE.DoubleSide }));
  flukeL.rotation.x = Math.PI / 2; flukeL.rotation.z = Math.PI / 2;
  flukeL.position.set(-size * 1.35, 0, size * 0.7);
  flukeL.scale.set(0.55, 1, 0.3);
  const flukeR = flukeL.clone();
  flukeR.position.z = -size * 0.7;
  tail.add(stalk, flukeL, flukeR);
  tail.position.x = -size * 1.9;
  group.add(tail);

  const finL = new THREE.Mesh(new THREE.ConeGeometry(size * 0.5, size * 1.5, 3), mat(type.color, { side: THREE.DoubleSide }));
  finL.rotation.set(Math.PI / 2, 0, -0.5);
  finL.scale.set(0.6, 1, 0.25);
  finL.position.set(size * 0.5, -size * 0.35, size * 0.85);
  const finR = finL.clone();
  finR.position.z = -size * 0.85;
  finR.rotation.z = 0.5;
  group.add(finL, finR);

  for (let i = 0; i < 7; i++) {
    const f = 1 - Math.abs(i - 2) / 5;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(size * 0.26, size * (0.55 + f * 0.85), 4), mat(type.accent));
    spike.position.set(size * (1.15 - i * 0.55), size * (0.80 + f * 0.22), 0);
    spike.rotation.z = -0.18;
    group.add(spike);
  }

  const eL = eye(size * 0.22, type.accent); eL.position.set(size * 1.35, size * 0.1, size * 0.55);
  const eR = eye(size * 0.22, type.accent); eR.position.set(size * 1.35, size * 0.1, -size * 0.55);
  group.add(eL, eR);

  // Blowhole spout: cheap cone that only shows when it surfaces to breathe.
  const spout = new THREE.Mesh(
    new THREE.ConeGeometry(size * 0.3, size * 2.6, 7, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xdff0f6, transparent: true, opacity: 0.45, depthWrite: false })
  );
  spout.position.set(size * 0.7, size * 1.6, 0);
  group.add(spout);

  const spheres = [
    { pos: new THREE.Vector3(size * 1.3, 0, 0), r: size * 1.0 },
    { pos: new THREE.Vector3(size * 0.4, 0, 0), r: size * 1.25 },
    { pos: new THREE.Vector3(-size * 0.7, 0, 0), r: size * 1.05 },
    { pos: new THREE.Vector3(-size * 1.7, 0, 0), r: size * 0.7 },
    { pos: new THREE.Vector3(-size * 2.6, 0, 0), r: size * 0.6 },
  ];

  return {
    group, head: body, spheres,
    update(ctx) {
      const { time, phase, swim, rage } = ctx;
      tail.rotation.y = Math.sin(phase * 1.1) * 0.55 * (0.4 + swim);
      tail.rotation.z = Math.sin(phase * 1.1 + 0.7) * 0.18;
      group.rotation.z = Math.sin(phase * 0.55) * 0.09;
      jaw.rotation.z = -0.05 - Math.max(0, Math.sin(time * 1.4)) * 0.36 * rage;
      body.position.y = Math.sin(phase * 0.6) * size * 0.12;
      const breathing = (Math.sin(time * 0.35 + size) + 1) * 0.5;
      const blow = Math.max(0, breathing - 0.86) / 0.14;
      spout.visible = blow > 0.01;
      spout.scale.setScalar(0.4 + blow);
      spout.material.opacity = 0.5 * blow;
    },
  };
}

/* --------------------------------------------------------------- the view */

const BUILDERS = { serpent: buildSerpent, kraken: buildKraken, leviathan: buildLeviathan };

// How high each body plan floats: base sinkage in body-sizes, how much anger
// lifts it, and a slow surfacing bob.
const RIDE = {
  serpent: { base: 0.16, rage: 0.10, bob: 0.10 },
  kraken: { base: 0.24, rage: 0.12, bob: 0.09 },
  leviathan: { base: 0.30, rage: 0.12, bob: 0.16 },
};

export class MonsterView {
  constructor(kind, id) {
    this.id = id;
    this.type = MONSTER_BY_ID[kind] || MONSTER_BY_ID.silverfin;
    this.size = this.type.size;
    this.body = BUILDERS[this.type.model](this.type, this.size);
    this.root = new THREE.Group();
    this.root.add(this.body.group);

    this.x = 0; this.z = 0; this.h = 0; this.sp = 0;
    this.tx = 0; this.tz = 0; this.th = 0;
    this.hp = 100;
    this.state = 0;
    this.phase = Math.random() * 100;
    this.dying = 0;
    this.hitSpheresWorld = this.body.spheres.map(() => ({ pos: new THREE.Vector3(), r: 1 }));
    this.flash = 0;

    // Out in the dark water a monster is a shape under the surface long before
    // it is a monster. `rise` runs 0 (lurking) to 1 (fully up).
    this.rise = 0;
    this.breached = false;
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({ color: 0x03070c, transparent: true, opacity: 0, depthWrite: false })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = -5;      // under the water surface
    this.root.add(this.shadow);
  }

  /** Server snapshot: we lerp toward it rather than snapping. */
  target(m) {
    this.tx = m.x; this.tz = m.z; this.th = m.h;
    this.sp = m.sp;
    if (m.hp < this.hp) this.flash = 1;
    this.hp = m.hp;
    this.state = m.s;
    if (this.x === 0 && this.z === 0) { this.x = m.x; this.z = m.z; this.h = m.h; }
  }

  update(dt, time, playerPos = null) {
    const k = 1 - Math.pow(0.0015, dt);
    this.x += (this.tx - this.x) * k;
    this.z += (this.tz - this.z) * k;
    let dh = ((this.th - this.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.h += dh * k;

    sampleWater(this.x, this.z, time, _water);
    const rage = this.state === 2 ? 1 : this.state === 1 ? 0.55 : 0.15;
    const ride = RIDE[this.type.model];
    const breathe = Math.sin(time * 0.28 + this.id * 1.7) * this.size * ride.bob;

    // Lurk deeper the further from town you are: near the reef you can watch
    // them swim, in black water you get a shadow and a bad feeling.
    const fromTown = Math.hypot(this.x, this.z);
    const remoteness = Math.min(1, Math.max(0, (fromTown - 420) / 900));
    const lurkDepth = this.size * (1.1 + remoteness * 3.4);

    // It comes up when it takes an interest -- which is also when you are close
    // enough for it to have noticed you.
    let want = this.state > 0 ? 1 : 0;
    if (!want && playerPos) {
      const d = Math.hypot(this.x - playerPos.x, this.z - playerPos.z);
      if (d < this.type.aggro * 1.35) want = 1;
    }
    const wasUp = this.rise > 0.55;
    this.rise += (want - this.rise) * (1 - Math.pow(want ? 0.10 : 0.5, dt));
    if (!wasUp && this.rise > 0.55) this.breached = true;

    const surfaced = -this.size * (ride.base - rage * ride.rage) + breathe;
    const submerge = this.dying ? -this.size * (1.4 + this.dying * 2.2)
      : lurkDepth * -(1 - this.rise) + surfaced * this.rise;

    this.root.position.set(this.x, _water.y + submerge, this.z);
    this.root.rotation.y = -this.h;
    this.root.rotation.z = this.dying ? Math.min(this.dying * 2.6, Math.PI * 0.75) : 0;

    this.phase += dt * (1.4 + this.sp * 0.42 + rage * 1.2);
    this.body.update({
      time, phase: this.phase, rage,
      swim: 0.45 + Math.min(this.sp / this.type.speed, 1.3) * 0.75,
      arch: 0.7 + rage * 0.5,
    });

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 3.2);
      const f = this.flash;
      this.root.traverse((o) => {
        if (o.material && o.material.emissive) o.material.emissive.setRGB(f * 0.8, f * 0.1, f * 0.06);
      });
    }

    // The shadow on the surface: strongest when the body is deepest.
    const hidden = 1 - this.rise;
    const shadowMat = this.shadow.material;
    shadowMat.opacity = hidden * 0.46 * (0.6 + 0.4 * Math.sin(time * 0.9 + this.id));
    this.shadow.visible = shadowMat.opacity > 0.01;
    if (this.shadow.visible) {
      // Positioned in the root's local frame, level with the water above it.
      this.shadow.position.set(0, _water.y - this.root.position.y + 0.12, -this.size * 1.2);
      const spread = this.size * (2.6 + hidden * 1.8);
      this.shadow.scale.set(spread, this.size * (3.4 + hidden * 2.6), 1);
      this.shadow.rotation.z = 0;
    }

    // World-space hit spheres for the harpoon test.
    for (let i = 0; i < this.body.spheres.length; i++) {
      const s = this.body.spheres[i];
      const w = this.hitSpheresWorld[i];
      w.pos.copy(s.pos);
      this.body.group.localToWorld(w.pos);
      w.r = s.r;
    }
  }

  /** True once, on the frame it breaks the surface. */
  consumeBreach() {
    if (!this.breached) return false;
    this.breached = false;
    return true;
  }

  /** Point on the body nearest to a world position -- where the rope bites. */
  nearestSphere(point) {
    let best = this.hitSpheresWorld[0], bd = Infinity;
    for (const s of this.hitSpheresWorld) {
      const d = s.pos.distanceToSquared(point);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  hitTest(point, extra = 0) {
    for (let i = 0; i < this.hitSpheresWorld.length; i++) {
      const s = this.hitSpheresWorld[i];
      const r = s.r + extra;
      if (s.pos.distanceToSquared(point) <= r * r) return i;
    }
    return -1;
  }

  /**
   * Swept test against the whole body. A harpoon covers metres per frame, so a
   * point test misses far more often than it hits -- especially on a fast
   * throw at a thin serpent.
   */
  hitSegment(from, to, extra = 0) {
    _seg.copy(to).sub(from);
    const lenSq = _seg.lengthSq();
    let best = -1, bestT = Infinity;
    for (let i = 0; i < this.hitSpheresWorld.length; i++) {
      const s = this.hitSpheresWorld[i];
      const r = s.r + extra;
      _rel.copy(s.pos).sub(from);
      const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, _rel.dot(_seg) / lenSq)) : 0;
      _near.copy(_seg).multiplyScalar(t).add(from);
      if (_near.distanceToSquared(s.pos) <= r * r && t < bestT) { bestT = t; best = i; }
    }
    return best;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
  }
}

/** A dead monster, greyed and belly-up, for towing home behind the boat. */
export function createCarcass(kind) {
  const type = MONSTER_BY_ID[kind] || MONSTER_BY_ID.silverfin;
  const view = new MonsterView(kind, -1);
  // Pose it once: without a pass the instanced segments sit on zeroed matrices.
  view.body.update({ time: 0, phase: 1.2, swim: 0.35, arch: 0.4, rage: 0 });
  view.root.traverse((o) => {
    if (!o.material) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (m.color) m.color.lerp(new THREE.Color(0x6a7076), 0.62);
      if (m.emissive) m.emissive.setRGB(0, 0, 0);
      m.roughness = 0.95;
    }
  });
  view.root.scale.setScalar(0.62);
  view.root.rotation.x = Math.PI * 0.82;
  return { root: view.root, view, type };
}
