// One input state for mouse+keyboard and touch alike. The game reads fields,
// never events, so adding a control surface never touches the simulation.
//
// A swinging game has two channels and no more: *where I want to go*, and *when
// to hold on*. `lean` is the first of those — a single signed intent axis that
// every direction control feeds, whether that is A/D, the mouse, a thumb drag or
// a slide on the swing pad. Pushing your view toward something IS leaning toward
// it; there is no separate notion of turning. Everything downstream reads this
// one number: which side the next web is thrown, which way the arc carves, and
// which way the body banks.

import { damp } from './util.js';

const KEYS = {
  KeyW: 'reel', ArrowUp: 'reel',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'dive', ShiftRight: 'dive',
  Space: 'swing',
  KeyQ: 'webLeft', KeyE: 'webRight',
  KeyB: 'boost',
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.held = new Set();

    this.lookX = 0; this.lookY = 0;   // radians accumulated since last frame
    this.steer = 0; this.throttle = 0;
    this.turn = 0;                     // heading authority, from keys only
    this.lean = 0;                     // -1..1 smoothed intent, the one direction channel
    this.webLeft = false; this.webRight = false;
    this.dive = false; this.reel = false;
    this.boost = false;                // edge triggered, cleared each frame
    /** One-button play: `web` replaces the two hand triggers entirely. */
    this.simple = false;
    this.web = false;
    this.enabled = false;
    this.locked = false;
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.sensitivity = this.touch ? 0.0055 : 0.0022;
    this.onPause = () => {};
    this.onKey = () => {};

    this.dragId = -1;
    this.mouseWeb = false;              // a mouse button is down
    this.dragX = 0; this.dragY = 0;
    this.padPointers = new Map();
  }

  attach() {
    const c = this.canvas;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Escape') { this.onPause(); return; }
      const k = KEYS[e.code];
      this.onKey(e.code);
      if (!k) return;
      e.preventDefault();
      this.held.add(k);
      if (k === 'boost') this.boost = true;
      // Space is the web in simple mode and the boost in full mode.
      if (k === 'swing' && !this.simple) this.boost = true;
    });
    addEventListener('keyup', (e) => {
      const k = KEYS[e.code];
      if (k) this.held.delete(k);
    });
    addEventListener('blur', () => { this.held.clear(); this.dragId = -1; this.mouseWeb = false; });

    // ---- desktop: buttons fire webs, pointer lock if we can get it ---------
    //
    // Pointer lock is the nicer way to aim, but an embedded frame can refuse it
    // and the request can reject outright. So it is always best-effort and
    // never gates input: without it, holding a button and dragging steers,
    // exactly like the touch path.
    c.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.touch) return;
      e.preventDefault();
      if (!this.locked) {
        try { c.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not allowed here */ }
      }
      if (this.simple) {
        this.web = true;
      } else {
        if (e.button === 0) this.webLeft = true;
        if (e.button === 2) this.webRight = true;
      }
      if (e.button === 1) this.boost = true;
      if (e.button === 0 || e.button === 2) this.mouseWeb = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.webLeft = false;
      if (e.button === 2) this.webRight = false;
      if (e.button === 0 || e.button === 2) this.mouseWeb = false;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
      if (!this.locked) { this.webLeft = this.webRight = false; this.mouseWeb = false; this.held.clear(); }
    });
    // Aiming never requires a button. Gating mouse-look behind a held button
    // put it in direct conflict with firing a web, which left one-button play
    // with no way to turn at all.
    addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        this.lookX -= e.movementX * this.sensitivity;
        this.lookY -= e.movementY * this.sensitivity;
      } else if (e.movementX !== undefined) {
        this.lookX -= e.movementX * this.sensitivity;
        this.lookY -= e.movementY * this.sensitivity;
      }
    });

    // ---- touch: drag anywhere to look ------------------------------------
    c.addEventListener('pointerdown', (e) => {
      if (!this.enabled || e.pointerType === 'mouse') return;
      if (this.dragId >= 0) return;
      this.dragId = e.pointerId;
      this.dragX = e.clientX; this.dragY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragId) return;
      this.lookX -= (e.clientX - this.dragX) * this.sensitivity;
      this.lookY -= (e.clientY - this.dragY) * this.sensitivity;
      this.dragX = e.clientX; this.dragY = e.clientY;
    });
    const endDrag = (e) => { if (e.pointerId === this.dragId) this.dragId = -1; };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
  }

  /**
   * Wire an on-screen pad to a field; `edge` fields latch for one frame.
   * A `steer` pad also turns while held, so sliding your thumb sideways off the
   * swing button aims — one thumb can then play the whole game.
   */
  bindPad(el, field, { edge = false, steer = false } = {}) {
    if (!el) return;
    let id = -1, sx = 0, sy = 0;
    const on = (e) => {
      e.preventDefault();
      el.classList.add('on');
      el.setPointerCapture?.(e.pointerId);
      id = e.pointerId; sx = e.clientX; sy = e.clientY;
      if (edge) this[field] = true; else this.padPointers.set(field, true);
    };
    const off = (e) => {
      e?.preventDefault();
      if (e && e.pointerId !== id && id !== -1) return;
      id = -1;
      el.classList.remove('on');
      if (!edge) this.padPointers.delete(field);
    };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    if (steer) {
      el.addEventListener('pointermove', (e) => {
        if (e.pointerId !== id) return;
        this.lookX -= (e.clientX - sx) * this.sensitivity;
        this.lookY -= (e.clientY - sy) * this.sensitivity;
        sx = e.clientX; sy = e.clientY;
      });
    } else {
      el.addEventListener('pointerleave', off);
    }
  }

  /** Fold held keys and pads into the analogue fields. Call once per frame. */
  sample(dt = 1 / 60) {
    const h = this.held;
    // One source of truth for the single trigger, so nothing can latch it on.
    if (this.simple) {
      this.web = h.has('swing') || this.padPointers.has('web') || this.mouseWeb;
    }
    // Explicit lean only. Aiming used to feed a second, rate-derived lean on top
    // of this, which both double-counted and evaporated the moment you stopped
    // moving the mouse. Where you are *looking* is now read by the player as an
    // angular error against where you are going, so pointing the camera and
    // holding it steers — and this axis is left as the deliberate nudge.
    const keyLean = (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0);
    this.steer = keyLean;
    this.turn = keyLean;
    this.lean = damp(this.lean, keyLean, 14, dt);
    this.throttle = (h.has('reel') ? 1 : 0) - (h.has('back') ? 1 : 0);
    this.reel = h.has('reel') || this.padPointers.has('reel');
    this.dive = h.has('dive') || this.padPointers.has('dive');
    if (h.has('webLeft')) this.webLeft = true;
    if (h.has('webRight')) this.webRight = true;
    if (this.padPointers.has('webLeft')) this.webLeft = true;
    if (this.padPointers.has('webRight')) this.webRight = true;
    if (this.touch) {
      if (!this.padPointers.has('webLeft') && !h.has('webLeft')) this.webLeft = false;
      if (!this.padPointers.has('webRight') && !h.has('webRight')) this.webRight = false;
    }
  }

  endFrame() {
    this.lookX = 0; this.lookY = 0;
    this.boost = false;
  }
}
