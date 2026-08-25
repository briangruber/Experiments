import { v3, mat4, mul, perspective, lookAt, invert, vNorm, vCross, clamp, DEG } from '../src/math.js';

const WORLD_UP = [ 0, 1, 0 ];

/**
 * Fill fwd/right/up from yaw, pitch, roll. matrices() calls this so the
 * sea (cam3.lookAt(fwd)) and the sky (invViewProj from the same basis)
 * cannot disagree after a later write to yaw/pitch — a fast look used
 * to tear a black seam at the horizon.
 */
export function applyCameraBasis( yaw, pitch, roll, fwd, right, up ) {

	const cp = Math.cos( pitch ), sp = Math.sin( pitch );
	const cy = Math.cos( yaw ), sy = Math.sin( yaw );
	fwd[ 0 ] = cp * sy; fwd[ 1 ] = sp; fwd[ 2 ] = - cp * cy;
	vNorm( fwd, fwd );
	vCross( fwd, WORLD_UP, right );
	vNorm( right, right );
	vCross( right, fwd, up );
	if ( roll ) {

		const cr = Math.cos( roll ), sr = Math.sin( roll );
		const r0 = right[ 0 ], r1 = right[ 1 ], r2 = right[ 2 ];
		const u0 = up[ 0 ], u1 = up[ 1 ], u2 = up[ 2 ];
		right[ 0 ] = r0 * cr + u0 * sr;
		right[ 1 ] = r1 * cr + u1 * sr;
		right[ 2 ] = r2 * cr + u2 * sr;
		up[ 0 ] = u0 * cr - r0 * sr;
		up[ 1 ] = u1 * cr - r1 * sr;
		up[ 2 ] = u2 * cr - r2 * sr;

	}
	return fwd;

}

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
    this.roll = 0;
    this._driftY = 0; this._driftP = 0;
    this.locked = false;
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
        // Mouse-look convention: dragging right looks right. The two axes used
        // to disagree - vertical was first-person, horizontal was drag-the-world
        // - which is what made the controls feel backwards.
        const s = 0.0022 * (this.fov / 45) * (this.lookSens ?? 1);
        this.yaw += (e.clientX - prev.x) * s;
        this.pitch = clamp(this.pitch - (e.clientY - prev.y) * s * (this.invertY ? -1 : 1), -1.45, 1.45);
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
      // Arrows scroll the page; Space pages down. Both are vehicle keys.
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown'
        || e.code === 'ArrowLeft' || e.code === 'ArrowRight'
        || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  update(dt, p) {
    const k = this.keys;
    this.lookSens = p.lookSensitivity ?? 1;
    this.invertY = !!p.invertLookY;
    const sp = this.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 6 : 1) *
               (k.has('AltLeft') ? 0.15 : 1);
    let mx = 0, my = 0, mz = 0;
    if (k.has('KeyW')) mz += 1;
    if (k.has('KeyS')) mz -= 1;
    if (k.has('KeyD')) mx += 1;
    if (k.has('KeyA')) mx -= 1;
    if (k.has('KeyE') || k.has('Space')) my += 1;
    if (k.has('KeyQ') || k.has('ControlLeft')) my -= 1;

    this.rebuildBasis();

    // Something else is driving this camera; it still needs its basis, but the
    // flying controls must not fight it.
    if (this.locked) { this._driftY = 0; this._driftP = 0; return; }

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

    // minAltitude is the air floor (a ski eye). With the underwater look
    // on, Q can take you through the surface — the column pass owns that
    // side. Off, the old clamp still stops you punching through the sea.
    const floor = ( p.underwater ?? 1 ) >= 0.5
      ? ( p.seaLevel ?? 0 ) - 80
      : p.minAltitude;
    this.pos[1] = Math.max(this.pos[1], floor);
  }

  rebuildBasis(extraYaw = 0, extraPitch = 0) {
    applyCameraBasis(
      this.yaw + extraYaw,
      this.pitch + extraPitch,
      this.roll,
      this.fwd, this.right, this.up,
    );
    return this;
  }

  matrices(w, h, jitterX = 0, jitterY = 0) {
    // Rebuild AFTER any chase/follow write to yaw/pitch, and with the
    // same handheld drift the look target used to apply only here. The
    // sea aims with fwd; the sky unprojects with this view matrix.
    this.rebuildBasis(this._driftY, this._driftP);
    const target = v3(
      this.pos[0] + this.fwd[0],
      this.pos[1] + this.fwd[1],
      this.pos[2] + this.fwd[2],
    );
    lookAt(this.pos, target, this.up, this.view);
    perspective(this.fov * DEG, w / h, this.near, this.far, this.proj);
    this.proj[8] += jitterX * 2 / w;
    this.proj[9] += jitterY * 2 / h;
    mul(this.proj, this.view, this.viewProj);
    invert(this.viewProj, this.invViewProj);
    return this;
  }
}
