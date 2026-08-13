// Orbit camera. Left drag looks, right drag (or two fingers) pans, wheel or
// pinch zooms, and the whole thing eases towards its target so a preset change
// is a move rather than a cut.

import { Vector3 } from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Orbit {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.target = new Vector3(2.5, 0, 1.0);
    this.goalTarget = this.target.clone();
    this.dist = 21; this.goalDist = 21;
    this.yaw = 34 * Math.PI / 180; this.goalYaw = this.yaw;
    this.pitch = 33 * Math.PI / 180; this.goalPitch = this.pitch;
    this.minPitch = -4 * Math.PI / 180;
    this.maxPitch = 88 * Math.PI / 180;
    this.pointers = new Map();
    this.mode = null;
    this.pinch = 0;

    dom.addEventListener('pointerdown', (e) => this._down(e));
    dom.addEventListener('pointermove', (e) => this._move(e));
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) {
      dom.addEventListener(t, (e) => this._up(e));
    }
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.goalDist = clamp(this.goalDist * Math.exp(e.deltaY * 0.0012), 2.2, 220);
    }, { passive: false });
  }

  goto({ target, dist, yaw, pitch }, snap = false) {
    if (target) this.goalTarget.set(target[0], target[1], target[2]);
    if (dist !== undefined) this.goalDist = dist;
    if (yaw !== undefined) this.goalYaw = yaw * Math.PI / 180;
    if (pitch !== undefined) this.goalPitch = pitch * Math.PI / 180;
    if (snap) {
      this.target.copy(this.goalTarget);
      this.dist = this.goalDist; this.yaw = this.goalYaw; this.pitch = this.goalPitch;
    }
  }

  _down(e) {
    this.dom.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) this.mode = e.button === 2 ? 'pan' : 'orbit';
    if (this.pointers.size === 2) {
      this.mode = 'pinch';
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.mode = null;
    else if (this.pointers.size === 1) this.mode = 'orbit';
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (this.mode === 'orbit' && this.pointers.size === 1) {
      this.goalYaw -= dx * 0.0055;
      this.goalPitch = clamp(this.goalPitch + dy * 0.0045, this.minPitch, this.maxPitch);
    } else if (this.mode === 'pan') {
      const s = this.goalDist * 0.0016;
      const c = Math.cos(this.goalYaw), sn = Math.sin(this.goalYaw);
      this.goalTarget.x += (-dx * c - dy * sn) * s;
      this.goalTarget.z += (-dx * -sn - dy * c) * s;
    } else if (this.mode === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch > 0) this.goalDist = clamp(this.goalDist * (this.pinch / Math.max(d, 1)), 2.2, 220);
      this.pinch = d;
    }
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * 6.5);
    this.target.lerp(this.goalTarget, k);
    this.dist += (this.goalDist - this.dist) * k;
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x = this.target.x + Math.sin(this.yaw) * cp * this.dist;
    const z = this.target.z + Math.cos(this.yaw) * cp * this.dist;
    // Never let the eye drop through the surface: an orbit camera that goes
    // underwater by accident just looks like a bug.
    const y = Math.max(this.target.y + sp * this.dist, 0.35);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }
}
