// Touch controls.
//
// A first-person horror game on a phone has one hard problem: the player has
// two thumbs and the desktop build wants six inputs at once. The layout here
// is the standard mobile-FPS split — left thumb moves, right thumb looks —
// with everything else demoted to buttons under the right thumb, ranked by how
// often you need it mid-panic:
//
//   torch    constantly, and usually in a hurry. Biggest button, lowest.
//   use      only when the prompt is up, so it hides when it is not — a dead
//            button in a panic is worse than no button.
//   run      hold-to-run rather than toggle: sprinting is loud and the player
//            must never be sprinting because they forgot to switch it off.
//   crouch   toggle, because crouching is a *posture* you hold for a corridor
//            at a time, and holding a button that long costs a thumb.
//
// The look pad is the whole right half of the screen rather than a widget:
// there is nothing to hit, and a thumb dragged anywhere in that area turns the
// view. Pointer Events handle mouse, pen and touch identically, so this is one
// code path rather than three.

/** Radius of the movement stick in CSS pixels, and its dead zone. */
const STICK_RADIUS = 58;
const DEAD_ZONE = 0.16;
/** Look sensitivity, in radians per CSS pixel dragged. */
const LOOK_SENSITIVITY = 0.0052;

export class TouchControls {
  constructor({ player, hud, onInteract }) {
    this.player = player;
    this.hud = hud;
    this.onInteract = onInteract;
    this.enabled = false;

    this.el = {
      layer: document.getElementById('touch'),
      stick: document.getElementById('touch-stick'),
      knob: document.getElementById('touch-knob'),
      use: document.getElementById('touch-use'),
    };

    /** pointerId → what that finger is doing. */
    this._pointers = new Map();
    this._axis = { x: 0, y: 0 };
  }

  enable() {
    if (this.enabled || !this.el.layer) return;
    this.enabled = true;
    this.el.layer.hidden = false;
    document.getElementById('touch-torch')?.classList
      .toggle('latched', this.player.torchOn);
    document.documentElement.classList.add('touch');

    this._onDown = (e) => this.#down(e);
    this._onMove = (e) => this.#move(e);
    this._onUp = (e) => this.#up(e);

    window.addEventListener('pointerdown', this._onDown, { passive: false });
    window.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.el.layer) this.el.layer.hidden = true;
    document.documentElement.classList.remove('touch');
    window.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.#reset();
  }

  /** Show or hide the USE button as the game offers something to use. */
  setUseVisible(visible) {
    if (this.el.use) this.el.use.classList.toggle('show', Boolean(visible));
  }

  #reset() {
    this._pointers.clear();
    this._axis.x = 0;
    this._axis.y = 0;
    this.player.setMoveAxis(0, 0);
    this.player.wantRun = false;
    this.#layoutKnob(0, 0);
    this.el.stick?.classList.remove('active');
  }

  // ----------------------------------------------------------------- input

  /**
   * Which control a press at this point belongs to.
   *
   * The stick claims the lower-left corner rather than the whole left half.
   * A left/right split is fine in landscape, where both thumbs sit at the
   * bottom anyway, but in portrait it hands half the *view* to the stick —
   * and the top of a portrait screen is exactly where you want to drag to
   * look. Anchoring the stick to the corner a thumb actually rests in works
   * in both orientations without asking which one we are in.
   */
  #classify(event) {
    const button = event.target?.closest?.('[data-touch]');
    if (button) return { kind: 'button', action: button.dataset.touch, el: button };

    const inCorner = event.clientX < window.innerWidth * 0.45
      && event.clientY > window.innerHeight * 0.38;
    return inCorner ? { kind: 'stick' } : { kind: 'look' };
  }

  #down(event) {
    if (!this.enabled) return;
    // Menus, the read panel and the diagnostic own their own taps. Swallowing
    // one here would leave the player looking at an escape hatch they cannot
    // press, which is worse than not offering it.
    if (event.target?.closest?.('.screen, #panel, #diagnostic')) return;

    const role = this.#classify(event);
    event.preventDefault();

    if (role.kind === 'button') {
      role.el.classList.add('down');
      this._pointers.set(event.pointerId, role);
      this.#press(role.action, true);
      return;
    }

    if (role.kind === 'stick') {
      // The stick materialises under the thumb. A fixed one is a thing to miss.
      this._pointers.set(event.pointerId, {
        kind: 'stick', originX: event.clientX, originY: event.clientY,
      });
      this.el.stick.style.left = `${event.clientX}px`;
      this.el.stick.style.top = `${event.clientY}px`;
      this.el.stick.classList.add('active');
      this.#layoutKnob(0, 0);
      return;
    }

    this._pointers.set(event.pointerId, {
      kind: 'look', lastX: event.clientX, lastY: event.clientY,
    });
  }

  #move(event) {
    const role = this._pointers.get(event.pointerId);
    if (!role) return;
    event.preventDefault();

    if (role.kind === 'stick') {
      const dx = event.clientX - role.originX;
      const dy = event.clientY - role.originY;
      const distance = Math.hypot(dx, dy);
      const clamped = Math.min(distance, STICK_RADIUS);
      const nx = distance > 0 ? (dx / distance) * (clamped / STICK_RADIUS) : 0;
      const ny = distance > 0 ? (dy / distance) * (clamped / STICK_RADIUS) : 0;

      this.#layoutKnob(nx * STICK_RADIUS, ny * STICK_RADIUS);
      const magnitude = Math.hypot(nx, ny);
      if (magnitude < DEAD_ZONE) {
        this._axis.x = 0;
        this._axis.y = 0;
      } else {
        // Rescale past the dead zone so the first millimetre of travel is not
        // a step change from standing still to half speed.
        const scale = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE) / magnitude;
        this._axis.x = nx * scale;
        this._axis.y = -ny * scale;
      }
      this.player.setMoveAxis(this._axis.x, this._axis.y);
      return;
    }

    if (role.kind === 'look') {
      this.player.applyLook(event.clientX - role.lastX, event.clientY - role.lastY,
        LOOK_SENSITIVITY);
      role.lastX = event.clientX;
      role.lastY = event.clientY;
    }
  }

  #up(event) {
    const role = this._pointers.get(event.pointerId);
    if (!role) return;
    this._pointers.delete(event.pointerId);

    if (role.kind === 'button') {
      role.el.classList.remove('down');
      this.#press(role.action, false);
      return;
    }
    if (role.kind === 'stick') {
      this._axis.x = 0;
      this._axis.y = 0;
      this.player.setMoveAxis(0, 0);
      this.el.stick.classList.remove('active');
      this.#layoutKnob(0, 0);
    }
  }

  #press(action, down) {
    switch (action) {
      case 'torch':
        if (down) {
          this.player.toggleTorch();
          // The torch being off is the single most common reason the screen
          // looks broken. Make its state visible on the button itself.
          document.getElementById('touch-torch')?.classList
            .toggle('latched', this.player.torchOn);
        }
        break;
      case 'use':
        if (down) this.onInteract?.();
        break;
      case 'run':
        // Held, not toggled — see the note at the top of this file.
        this.player.wantRun = down;
        break;
      case 'crouch':
        if (down) {
          this.player.wantCrouch = !this.player.wantCrouch;
          document.getElementById('touch-crouch')?.classList
            .toggle('latched', this.player.wantCrouch);
        }
        break;
      default:
        break;
    }
  }

  #layoutKnob(x, y) {
    if (this.el.knob) this.el.knob.style.transform = `translate(${x}px, ${y}px)`;
  }
}
