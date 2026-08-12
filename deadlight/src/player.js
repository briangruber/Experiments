// First-person controller.
//
// The movement model exists to make noise. Every parameter here has a second
// job feeding `noise`, the value the creature hears: sprinting is fast but
// loud, crouching is quiet but slow, and the torch is the loudest thing in the
// game despite making no sound at all. The player is always trading one of
// those against another, and the trade is the game.

import * as THREE from 'three';

export const EYE_HEIGHT = 1.68;
const CROUCH_HEIGHT = 1.02;

const SPEED = { walk: 2.5, run: 5.0, crouch: 1.25 };
const ACCEL = 13;
const FRICTION = 11;

/** Seconds of continuous sprint, and how long a full refill takes. */
const STAMINA_DRAIN = 1 / 5.5;
const STAMINA_REGEN = 1 / 8.5;

/** Torch runtime in seconds, and recharge rate while it is off. */
const BATTERY_DRAIN = 1 / 95;
const BATTERY_REGEN = 1 / 190;

export class Player {
  constructor(camera, level, audio) {
    this.camera = camera;
    this.level = level;
    this.audio = audio;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.stamina = 1;
    this.battery = 1;
    this.torchOn = true;
    this.crouching = false;
    this.alive = true;

    /** How loud the player currently is, 0..1. Read by the creature. */
    this.noise = 0;

    /** Set by the game while a scare has control of the camera. */
    this.frozen = false;
    /** Set while a cutscene owns the camera outright — see src/cutscene.js.
     *  `frozen` only stops input; this stops the camera being written at all,
     *  which is what lets a scripted shot fly somewhere the player is not. */
    this.cinematic = false;

    this.keys = new Set();
    /** Movement from a source that is not the keyboard, each −1..1.
     *  y is forward, x is strafe. Written by src/touch.js. */
    this._axis = { x: 0, y: 0 };
    /** Held/latched by touch buttons; the keyboard sets these per frame. */
    this.wantRun = false;
    this.wantCrouch = false;
    this._bobPhase = 0;
    this._bobAmount = 0;
    this._stepPhase = 0;
    this._sway = new THREE.Vector2();
    this._lookImpulse = new THREE.Vector2();
    this._shake = 0;
    this._eye = EYE_HEIGHT;

    this.onFootstep = null;
    this.onTorchToggle = null;
  }

  spawn(position, yaw = 0) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.stamina = 1;
    this.battery = 1;
    this.torchOn = true;
    this.crouching = false;
    this.alive = true;
    this.cinematic = false;
    this.wantRun = false;
    this.wantCrouch = false;
    this._axis.x = 0;
    this._axis.y = 0;
    this.peakAxis = 0;
    this._shake = 0;
  }

  // ----------------------------------------------------------------- input

  attach(dom) {
    this._dom = dom;

    this._onKeyDown = (e) => {
      // Never swallow the browser's own shortcuts.
      if (e.ctrlKey && e.key !== 'Control') return;
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.toggleTorch();
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);

    // Look works two ways. Pointer lock is the good one, but it is not always
    // available — an embedded page only gets it if whoever wrote the <iframe>
    // included `allow="pointer-lock"`, and there is no way to ask for it from
    // in here. So holding the mouse button turns the view too. It is a worse
    // way to play and the HUD says so, but it is the difference between a
    // playable page and a dead one.
    this._dragging = false;
    this._onMouseDown = (e) => {
      if (e.button === 0 && !document.pointerLockElement) this._dragging = true;
    };
    this._onMouseUp = () => { this._dragging = false; };

    this._onMouse = (e) => {
      const locked = document.pointerLockElement === dom;
      if (!locked && !this._dragging) return;
      this.applyLook(e.movementX, e.movementY);
    };

    // Losing focus mid-sprint would otherwise leave the key latched down.
    this._onBlur = () => {
      this.keys.clear();
      this._dragging = false;
      this.wantRun = false;
      this._axis.x = 0;
      this._axis.y = 0;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouse);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', this._onBlur);
  }

  detach() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouse);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('blur', this._onBlur);
  }

  toggleTorch() {
    if (!this.alive || this.frozen) return;
    if (!this.torchOn && this.battery <= 0.02) return;
    this.torchOn = !this.torchOn;
    this.audio?.click(this.torchOn);
    this.onTorchToggle?.(this.torchOn);
  }

  /** Kick the view — used by scares and by taking a hit. */
  shake(amount = 1) {
    this._shake = Math.min(2.5, this._shake + amount);
  }

  /**
   * Turn the view. One entry point for every device: the mouse, a dragged
   * finger and the drag-to-look fallback all arrive here, so sensitivity and
   * the pitch clamp exist in exactly one place.
   */
  applyLook(dx, dy, sensitivity = 0.0022) {
    if (this.frozen) return;
    this.yaw -= dx * sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sensitivity, -1.45, 1.45);
  }

  /** Movement from a virtual stick, each −1..1. */
  setMoveAxis(x, y) {
    this._axis.x = x;
    this._axis.y = y;
    // Peak magnitude ever requested. Only diagnostics reads this: it lets a
    // test distinguish a stick that was ignored from a stick that worked and
    // pushed the player into a wall.
    this.peakAxis = Math.max(this.peakAxis ?? 0, Math.hypot(x, y));
  }

  /** Wrench the view by a fixed offset, in radians. */
  nudgeLook(dyaw, dpitch) {
    this._lookImpulse.set(dyaw, dpitch);
  }

  /** Point the camera at a world position over the next few frames. */
  lookAt(target, snap = 0.18) {
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const dy = target.y - (this.position.y + this._eye);
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
    // Shortest way round, so a target behind the player does not spin 350°.
    let delta = wantYaw - this.yaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.yaw += delta * snap;
    this.pitch += (wantPitch - this.pitch) * snap;
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    const moving = this.#move(dt);
    this.#resources(dt, moving);
    this.#applyCamera(dt, moving);
  }

  #move(dt) {
    if (!this.alive || this.frozen) {
      // Clear `running` too: a scare that freezes the player mid-sprint would
      // otherwise leave the flag latched, and the director reads it as
      // exertion for as long as the freeze lasts.
      this.running = false;
      this.velocity.multiplyScalar(Math.max(0, 1 - FRICTION * dt));
      this.noise *= Math.max(0, 1 - 3 * dt);
      return 0;
    }

    const k = this.keys;
    // Keyboard and stick are summed, then clamped: a device with both should
    // not have one silently win, and holding W while nudging a gamepad-style
    // stick should not produce double speed.
    const forward = THREE.MathUtils.clamp(
      (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) + this._axis.y, -1, 1);
    const strafe = THREE.MathUtils.clamp(
      (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + this._axis.x, -1, 1);

    this.crouching = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC')
      || this.wantCrouch;
    const wantsRun = ((k.has('ShiftLeft') || k.has('ShiftRight')) || this.wantRun)
      && !this.crouching;
    const canRun = wantsRun && this.stamina > 0.02 && forward > 0;
    this.running = canRun;

    const speed = this.crouching ? SPEED.crouch : canRun ? SPEED.run : SPEED.walk;

    // Movement is relative to yaw only — looking at the ceiling should not
    // slow you down.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wish = new THREE.Vector3(
      -sin * forward + cos * strafe,
      0,
      -cos * forward - sin * strafe,
    );
    // `intensity` is how hard the player is asking to move — a stick pushed
    // halfway walks at half speed, where a key is always all the way.
    const intensity = Math.min(1, wish.length());
    if (intensity > 0) wish.normalize().multiplyScalar(speed * intensity);

    // Accelerate toward the wish velocity, decelerate to a stop otherwise.
    const rate = intensity > 0 ? ACCEL : FRICTION;
    this.velocity.x += (wish.x - this.velocity.x) * Math.min(1, rate * dt);
    this.velocity.z += (wish.z - this.velocity.z) * Math.min(1, rate * dt);

    this.position.addScaledVector(this.velocity, dt);
    this.level.collide(this.position, 0.36);

    const travelled = Math.hypot(this.velocity.x, this.velocity.z);

    // Noise: how fast you are going, plus a large constant for the torch.
    // The torch term is what makes the light a real decision rather than a
    // free upgrade.
    const gait = this.crouching ? 0.12 : canRun ? 1.0 : 0.45;
    const target = Math.min(1, (travelled / SPEED.run) * gait + (this.torchOn ? 0.34 : 0));
    this.noise += (target - this.noise) * Math.min(1, 4 * dt);

    return travelled;
  }

  #resources(dt, moving) {
    if (this.running && moving > 0.5) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
    } else if (!this.running) {
      const rate = this.crouching || moving < 0.5 ? STAMINA_REGEN * 1.7 : STAMINA_REGEN;
      this.stamina = Math.min(1, this.stamina + rate * dt);
    }

    if (this.torchOn) {
      this.battery = Math.max(0, this.battery - BATTERY_DRAIN * dt);
      if (this.battery <= 0) {
        this.torchOn = false;
        this.audio?.click(false);
        this.onTorchToggle?.(false);
      }
    } else {
      this.battery = Math.min(1, this.battery + BATTERY_REGEN * dt);
    }
  }

  #applyCamera(dt, moving) {
    // A cutscene is driving. Keep the bob and shake state ticking so the
    // handover back is not a jolt, but do not touch the transform.
    if (this.cinematic) {
      this._shake = Math.max(0, this._shake - dt * 1.7);
      this._bobAmount *= Math.max(0, 1 - 4 * dt);
      return;
    }

    // Head bob, and the footstep it implies. Driving steps off the bob phase
    // rather than a timer keeps the sound locked to the visible stride at any
    // speed, including while accelerating.
    const bobTarget = this.alive && !this.frozen ? Math.min(1, moving / SPEED.walk) : 0;
    this._bobAmount += (bobTarget - this._bobAmount) * Math.min(1, 6 * dt);

    const cadence = this.running ? 10.5 : this.crouching ? 4.4 : 7.2;
    const before = this._stepPhase;
    this._stepPhase += moving > 0.35 ? cadence * dt * (moving / SPEED.walk) : 0;
    if (Math.floor(before / Math.PI) !== Math.floor(this._stepPhase / Math.PI)) {
      this.audio?.step({ running: this.running, crouching: this.crouching });
      this.onFootstep?.(this.crouching ? 0.25 : this.running ? 1 : 0.55);
    }
    this._bobPhase = this._stepPhase;

    const eyeTarget = this.crouching ? CROUCH_HEIGHT : EYE_HEIGHT;
    this._eye += (eyeTarget - this._eye) * Math.min(1, 9 * dt);

    // Lateral sway lags the bob, which is what makes it read as a body rather
    // than as a camera on a spring.
    const bob = this._bobAmount;
    const bobY = Math.abs(Math.sin(this._bobPhase)) * 0.045 * bob;
    const bobX = Math.sin(this._bobPhase * 0.5) * 0.03 * bob;
    this._sway.x += (bobX - this._sway.x) * Math.min(1, 9 * dt);

    // Trauma-style shake: decays quadratically so a big hit falls off fast
    // and a small one is barely a tremor.
    this._shake = Math.max(0, this._shake - dt * 1.7);
    const trauma = this._shake * this._shake;
    const shakeYaw = (Math.random() * 2 - 1) * 0.045 * trauma;
    const shakePitch = (Math.random() * 2 - 1) * 0.045 * trauma;

    this.yaw += this._lookImpulse.x;
    this.pitch = THREE.MathUtils.clamp(this.pitch + this._lookImpulse.y, -1.5, 1.5);
    this._lookImpulse.set(0, 0);

    this.camera.position.set(
      this.position.x + this._sway.x,
      this.position.y + this._eye + bobY,
      this.position.z,
    );
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw + shakeYaw;
    this.camera.rotation.x = this.pitch + shakePitch;
    this.camera.rotation.z = Math.sin(this._bobPhase * 0.5) * 0.012 * bob + shakeYaw * 0.6;
  }

  /** Unit vector the player is facing, on the horizontal plane. */
  forward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  get eyePosition() {
    return new THREE.Vector3(this.position.x, this.position.y + this._eye, this.position.z);
  }

  /**
   * Is `point` inside the player's view cone and unobstructed?
   *
   * Used by the mannequins, so it deliberately asks a slightly *wider*
   * question than the camera frustum: something at the very edge of the screen
   * still counts as seen. Freezing only within the exact frustum produces a
   * horrible effect where a mannequin twitches whenever it clips the border.
   */
  canSee(point, halfAngle = 1.15) {
    const to = new THREE.Vector3().subVectors(point, this.eyePosition);
    const dist = to.length();
    if (dist < 0.001) return true;
    to.divideScalar(dist);
    const facing = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    if (facing.dot(to) < Math.cos(halfAngle)) return false;
    return this.level.lineOfSight(this.eyePosition, point);
  }
}
