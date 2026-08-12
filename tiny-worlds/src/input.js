// Keyboard, pointer and touch, folded into one small polled state object.
// Look is pointer-drag (no pointer lock — the worlds are small enough that you
// mostly want to orbit and read them, not aim).

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.move = { x: 0, y: 0 };     // -1..1, y is forward
    this.look = { x: 0, y: 0 };     // consumed each frame
    this.zoom = 0;                  // consumed each frame
    this.jumpQueued = false;
    this.interactQueued = false;
    this.pointerDown = false;
    this.lookedRecently = 0;
    this.stick = null;
    this.onKey = new Set();

    addEventListener('keydown', (e) => {
      if (e.repeat) { e.preventDefault?.(); return; }
      this.keys.add(e.code);
      if (e.code === 'Space') { this.jumpQueued = true; e.preventDefault(); }
      if (e.code === 'KeyE' || e.code === 'Enter') this.interactQueued = true;
      for (const fn of this.onKey) fn(e.code, e);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && e.clientX < innerWidth * 0.42) { this.startStick(e); return; }
      this.pointerDown = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.stick && this.stick.id === e.pointerId) { this.moveStick(e); return; }
      if (!this.pointerDown) return;
      this.look.x += e.clientX - this.lastX;
      this.look.y += e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.lookedRecently = 0.9;
    });
    const release = (e) => {
      if (this.stick && this.stick.id === e.pointerId) { this.stick = null; return; }
      this.pointerDown = false;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', (e) => { this.zoom += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
  }

  startStick(e) {
    this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 };
    this.canvas.setPointerCapture(e.pointerId);
  }

  moveStick(e) {
    const s = this.stick;
    const r = 62;
    s.x = Math.max(-1, Math.min(1, (e.clientX - s.ox) / r));
    s.y = Math.max(-1, Math.min(1, (e.clientY - s.oy) / r));
  }

  // Touch: tapping the right half jumps. Wired from main so it can respect
  // game state (a tap on the title screen should start, not jump).
  tapToJump() { this.jumpQueued = true; }

  poll(dt) {
    const k = this.keys;
    let x = 0, y = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (this.stick) { x += this.stick.x; y -= this.stick.y; }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    this.move.x = x; this.move.y = y;
    this.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    this.lookedRecently = Math.max(0, this.lookedRecently - dt);
    return this;
  }

  takeLook() {
    const l = { x: this.look.x, y: this.look.y };
    this.look.x = 0; this.look.y = 0;
    return l;
  }

  takeZoom() { const z = this.zoom; this.zoom = 0; return z; }
  takeJump() { const j = this.jumpQueued; this.jumpQueued = false; return j; }
  takeInteract() { const i = this.interactQueued; this.interactQueued = false; return i; }
}
