// The web strand.
//
// Two concentric tubes rebuilt every frame from a quadratic curve: a bright,
// nearly opaque core, and a wider additive sheath that gives the silk a glow
// against the dark city. The line sags when there is slack in the rope and
// snaps straight the instant the constraint bites, which is the clearest read
// the player gets on whether the swing is actually pulling.
//
// A freshly fired strand also whips: a decaying transverse wobble that makes
// the attach read as thrown rather than drawn on.

import * as THREE from 'three';
import { clamp, smoothstep } from './util.js';

const SEGS = 22;
const SIDES = 6;
const SHOOT_TIME = 0.05;
const WOBBLE_TIME = 0.45;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _bin = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _ctrl = new THREE.Vector3();

function tube(color, opacity, blending) {
  const count = (SEGS + 1) * SIDES;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const idx = [];
  for (let s = 0; s < SEGS; s++) {
    for (let k = 0; k < SIDES; k++) {
      const a = s * SIDES + k;
      const b = s * SIDES + ((k + 1) % SIDES);
      idx.push(a, a + SIDES, b, b, a + SIDES, b + SIDES);
    }
  }
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, blending,
    side: THREE.DoubleSide,
  }));
  mesh.frustumCulled = false;
  return mesh;
}

export class WebLine {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'web';

    this.core = tube(0xdce8f7, 0.92, THREE.NormalBlending);
    this.core.renderOrder = 4;
    this.glow = tube(0x8ec8ff, 0.13, THREE.AdditiveBlending);
    this.glow.renderOrder = 3;

    // A bloom of silk where the strand meets the building.
    this.splat = new THREE.Mesh(
      new THREE.CircleGeometry(1, 18),
      new THREE.MeshBasicMaterial({
        color: 0xdbeeff, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.splat.frustumCulled = false;
    this.splat.renderOrder = 4;

    this.group.add(this.glow, this.core, this.splat);
    this.mesh = this.group;                 // what main.js adds to the scene
    this.group.visible = false;
    this.shoot = 0;
    this.wobble = 0;
  }

  update(dt, player, avatar) {
    const web = player.web;
    if (!web.active) {
      this.group.visible = false;
      this.shoot = 0;
      this.wobble = 0;
      return;
    }
    if (this.shoot === 0) this.wobble = 1;
    this.shoot = Math.min(1, this.shoot + dt / SHOOT_TIME);
    this.wobble = Math.max(0, this.wobble - dt / WOBBLE_TIME);
    this.group.visible = true;

    // Start at the hand when the avatar is up, at the body otherwise.
    _a.copy(avatar?.ready ? avatar.hands[web.side] : player.pos);
    _b.copy(web.anchor);
    if (this.shoot < 1) _b.lerpVectors(_a, _b, this.shoot);

    const dist = _a.distanceTo(_b);
    const slack = Math.max(0, web.length - dist);
    _ctrl.addVectors(_a, _b).multiplyScalar(0.5);
    _ctrl.y -= slack * 0.45 + 0.2;

    const radius = clamp(0.012 + dist * 0.0003, 0.011, 0.04);
    const whip = this.wobble * this.wobble * Math.min(1, dist / 20);
    const corePos = this.core.geometry.attributes.position.array;
    const glowPos = this.glow.geometry.attributes.position.array;
    _prev.copy(_a);

    for (let s = 0; s <= SEGS; s++) {
      const t = s / SEGS;
      const it = 1 - t;
      // Quadratic Bézier through the sag control point.
      _p.set(
        it * it * _a.x + 2 * it * t * _ctrl.x + t * t * _b.x,
        it * it * _a.y + 2 * it * t * _ctrl.y + t * t * _b.y,
        it * it * _a.z + 2 * it * t * _ctrl.z + t * t * _b.z,
      );
      _tan.subVectors(_p, _prev);
      if (_tan.lengthSq() < 1e-9) _tan.subVectors(_b, _a);
      _tan.normalize();
      _prev.copy(_p);

      _nrm.set(0, 1, 0);
      if (Math.abs(_tan.y) > 0.95) _nrm.set(1, 0, 0);
      _bin.crossVectors(_tan, _nrm).normalize();
      _nrm.crossVectors(_bin, _tan).normalize();

      // Transverse whip, pinned at both ends so the strand stays attached.
      if (whip > 0.001) {
        const swing = Math.sin(t * Math.PI * 2.4) * Math.sin(t * Math.PI) * whip * 0.5;
        _p.addScaledVector(_bin, swing);
      }

      // Taper toward the anchor so it reads as thrown, not drawn.
      const r = radius * (1 - 0.4 * t);
      const g = r * 2.6;
      for (let k = 0; k < SIDES; k++) {
        const ang = (k / SIDES) * Math.PI * 2;
        const cx = Math.cos(ang), cy = Math.sin(ang);
        const o = (s * SIDES + k) * 3;
        const bx = _bin.x * cx + _nrm.x * cy;
        const by = _bin.y * cx + _nrm.y * cy;
        const bz = _bin.z * cx + _nrm.z * cy;
        corePos[o] = _p.x + bx * r; corePos[o + 1] = _p.y + by * r; corePos[o + 2] = _p.z + bz * r;
        glowPos[o] = _p.x + bx * g; glowPos[o + 1] = _p.y + by * g; glowPos[o + 2] = _p.z + bz * g;
      }
    }
    this.core.geometry.attributes.position.needsUpdate = true;
    this.glow.geometry.attributes.position.needsUpdate = true;

    // Splat sits on the anchor, facing back down the strand.
    this.splat.position.copy(web.anchor);
    this.splat.lookAt(_a);
    const pop = smoothstep(0, 1, this.shoot);
    this.splat.scale.setScalar((0.22 + radius * 5) * pop);
    this.splat.material.opacity = 0.4 * pop;
  }
}
