// The web line itself: a four-sided tube rebuilt every frame from a quadratic
// curve between hand and anchor. It sags when there is slack in the rope and
// snaps straight the instant the constraint bites, which is the clearest read
// the player gets on whether the swing is actually pulling.

import * as THREE from 'three';
import { clamp } from './util.js';

const SEGS = 18;
const SIDES = 4;
const SHOOT_TIME = 0.055;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _bin = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _sag = new THREE.Vector3();
const _ctrl = new THREE.Vector3();

export class WebLine {
  constructor() {
    const count = (SEGS + 1) * SIDES;
    const pos = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    const idx = [];
    for (let s = 0; s < SEGS; s++) {
      for (let k = 0; k < SIDES; k++) {
        const a = s * SIDES + k;
        const b = s * SIDES + ((k + 1) % SIDES);
        const c = a + SIDES, d = b + SIDES;
        idx.push(a, c, b, b, c, d);
      }
    }
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.geo = geo;
    this.posAttr = geo.attributes.position;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xf2f7ff, transparent: true, opacity: 0.92, depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.shoot = 0;
  }

  update(dt, player, avatar) {
    const web = player.web;
    if (!web.active) {
      this.mesh.visible = false;
      this.shoot = 0;
      return;
    }
    this.shoot = Math.min(1, this.shoot + dt / SHOOT_TIME);
    this.mesh.visible = true;

    // Start at the hand when the avatar is up, at the body otherwise.
    _a.copy(avatar?.ready ? avatar.hands[web.side] : player.pos);
    _b.copy(web.anchor);
    if (this.shoot < 1) _b.lerpVectors(_a, _b, this.shoot);

    const dist = _a.distanceTo(_b);
    const slack = Math.max(0, web.length - dist);
    _ctrl.addVectors(_a, _b).multiplyScalar(0.5);
    _ctrl.y -= slack * 0.45 + 0.25;

    const radius = clamp(0.055 + dist * 0.0012, 0.05, 0.14);
    const arr = this.posAttr.array;
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

      // Taper the strand toward the anchor so it reads as thrown, not drawn.
      const r = radius * (1 - 0.45 * t);
      for (let k = 0; k < SIDES; k++) {
        const ang = (k / SIDES) * Math.PI * 2;
        const cx = Math.cos(ang) * r, cy = Math.sin(ang) * r;
        const o = (s * SIDES + k) * 3;
        arr[o] = _p.x + _bin.x * cx + _nrm.x * cy;
        arr[o + 1] = _p.y + _bin.y * cx + _nrm.y * cy;
        arr[o + 2] = _p.z + _bin.z * cx + _nrm.z * cy;
      }
    }
    this.posAttr.needsUpdate = true;
  }
}
