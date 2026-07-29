import { v3, mat4, mul, perspective, lookAt, invert, vNorm, vCross, clamp, DEG } from './math.js';

export class Camera {
  constructor(canvas) {
    this.canvas = canvas;
    this.pos = v3(0, 6, 0);
    this.yaw = -0.6;
    this.pitch = -0.045;
    this.fov = 38;
    this.near = 0.08;
    this.far = 90000;
    this.speed = 12;
    this.view = mat4();
    this.proj = mat4();
    this.viewProj = mat4();
    this.invViewProj = mat4();
    this.right = v3(1, 0, 0);
    this.up = v3(0, 1, 0);
    this.fwd = v3(0, 0, -1);
    this.moved = true;
    this.keys = new Set();
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    // Tracking every active pointer rather than a single drag is what lets one
    // finger look and two fingers pinch. Touch has no wheel, so without this
    // there is no way to zoom at all on a phone.
    const pointers = new Map();
    let pinchDist = 0;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const down = (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) pinchDist = spread();
      c.setPointerCapture?.(e.pointerId);
    };
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      c.releasePointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        const s = 0.0022 * (this.fov / 45);
        this.yaw -= (e.clientX - prev.x) * s;
        this.pitch = clamp(this.pitch - (e.clientY - prev.y) * s, -1.45, 1.45);
        this.moved = true;
      } else if (pointers.size === 2 && pinchDist > 0) {
        const d = spread();
        if (d > 1) {
          this.fov = clamp(this.fov * (pinchDist / d), 8, 95);
          pinchDist = d;
          this.moved = true;
        }
      }
    };
    c.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('pointermove', move);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.fov = clamp(this.fov * Math.exp(e.deltaY * 0.0012), 8, 95);
      this.moved = true;
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  update(dt, p) {
    const k = this.keys;
    const sp = this.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 6 : 1) *
               (k.has('AltLeft') ? 0.15 : 1);
    let mx = 0, my = 0, mz = 0;
    if (k.has('KeyW')) mz += 1;
    if (k.has('KeyS')) mz -= 1;
    if (k.has('KeyD')) mx += 1;
    if (k.has('KeyA')) mx -= 1;
    if (k.has('KeyE') || k.has('Space')) my += 1;
    if (k.has('KeyQ') || k.has('ControlLeft')) my -= 1;

    const cp = Math.cos(this.pitch), sp2 = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    this.fwd[0] = cp * sy; this.fwd[1] = sp2; this.fwd[2] = -cp * cy;
    vNorm(this.fwd, this.fwd);
    vCross(this.fwd, v3(0, 1, 0), this.right);
    vNorm(this.right, this.right);
    vCross(this.right, this.fwd, this.up);

    if (mx || my || mz) {
      this.pos[0] += (this.fwd[0] * mz + this.right[0] * mx) * sp * dt;
      this.pos[1] += (this.fwd[1] * mz + this.right[1] * mx + my) * sp * dt;
      this.pos[2] += (this.fwd[2] * mz + this.right[2] * mx) * sp * dt;
      this.moved = true;
    }

    // Handheld drift keeps still shots from looking like a locked-off render.
    if (p.handheld > 0.0001) {
      const t = performance.now() * 0.001;
      const a = p.handheld * 0.0025;
      this._driftY = Math.sin(t * 0.53) * a + Math.sin(t * 1.31) * a * 0.4;
      this._driftP = Math.cos(t * 0.41) * a + Math.sin(t * 0.97) * a * 0.35;
      if (Math.abs(this._driftY) > 1e-6) this.moved = true;
    } else {
      this._driftY = this._driftP = 0;
    }

    if (p.cameraBob > 0.0001) {
      const t = performance.now() * 0.001;
      this.pos[1] += Math.sin(t * 0.7) * p.cameraBob * dt * 2.0;
      this.moved = true;
    }

    this.pos[1] = Math.max(this.pos[1], p.minAltitude);
  }

  matrices(w, h, jitterX = 0, jitterY = 0) {
    const target = v3(
      this.pos[0] + Math.cos(this.pitch + this._driftP) * Math.sin(this.yaw + this._driftY),
      this.pos[1] + Math.sin(this.pitch + this._driftP),
      this.pos[2] - Math.cos(this.pitch + this._driftP) * Math.cos(this.yaw + this._driftY),
    );
    lookAt(this.pos, target, v3(0, 1, 0), this.view);
    perspective(this.fov * DEG, w / h, this.near, this.far, this.proj);
    this.proj[8] += jitterX * 2 / w;
    this.proj[9] += jitterY * 2 / h;
    mul(this.proj, this.view, this.viewProj);
    invert(this.viewProj, this.invViewProj);
    return this;
  }
}
