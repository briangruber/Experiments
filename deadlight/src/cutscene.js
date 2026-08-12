// Scripted camera.
//
// A cutscene here is a list of shots, each with a duration, a camera move and
// optional titles and events. It runs on the same frame loop as everything
// else — no separate timeline, no video — so a shot can stage a real monster
// in the real level and hand the player back a world that has actually
// changed while they were watching.
//
// Two rules, both learned from cutscenes being annoying rather than
// frightening:
//
//   1. They are short. Nothing here runs past about six seconds. A horror
//      cutscene is a punctuation mark; the moment it becomes a scene the
//      player stops being afraid and starts waiting.
//   2. They are skippable, and the skip is advertised. A player who has died
//      four times has seen the intro four times, and forcing a fifth is how
//      you turn dread into irritation.
//
// While a cutscene runs the player is frozen *and* `cinematic` is set, which
// stops Player#update from touching the camera at all — see the guard in
// applyCamera. The cutscene owns the transform outright.

import * as THREE from 'three';

/** Ease that starts and ends still — the default move for a drifting camera. */
const smooth = (t) => t * t * (3 - 2 * t);
/** Ease with weight at the front, for a camera that is being *pushed*. */
const easeOut = (t) => 1 - (1 - t) ** 3;

export class Cutscene {
  constructor({ camera, player, hud, audio, post }) {
    this.camera = camera;
    this.player = player;
    this.hud = hud;
    this.audio = audio;
    this.post = post;

    this.active = false;
    this._shots = [];
    this._index = 0;
    this._time = 0;
    this._resolve = null;
    this._skippable = true;
  }

  /**
   * Run a list of shots. Resolves when the last one ends or the player skips.
   *
   * A shot is `{ hold, from, to, lookAt, lookTo, ease, title, subtitle,
   * onEnter, onExit, fov }`. Positions are world-space; `lookAt`/`lookTo`
   * interpolate the aim point, so a shot can track something that is moving.
   */
  play(shots, { skippable = true } = {}) {
    if (this.active) this.stop();
    this._shots = shots.filter(Boolean);
    if (!this._shots.length) return Promise.resolve();

    this._index = -1;
    this._time = 0;
    this._skippable = skippable;
    this.active = true;

    this.player.frozen = true;
    this.player.cinematic = true;
    this.hud?.setLetterbox(true, skippable);

    this.#advance();
    return new Promise((resolve) => { this._resolve = resolve; });
  }

  skip() {
    if (!this.active || !this._skippable) return;
    // Run every remaining onExit so a cutscene that changes the world still
    // changes it. A skipped intro must leave the same level behind.
    for (let i = Math.max(0, this._index); i < this._shots.length; i++) {
      this._shots[i].onExit?.();
    }
    this.stop();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.player.frozen = false;
    this.player.cinematic = false;
    this.hud?.setLetterbox(false);
    this.hud?.setTitle(null);
    const done = this._resolve;
    this._resolve = null;
    done?.();
  }

  #advance() {
    this._shots[this._index]?.onExit?.();
    this._index++;
    this._time = 0;

    const shot = this._shots[this._index];
    if (!shot) {
      this.stop();
      return;
    }

    shot.onEnter?.();
    this.hud?.setTitle(shot.title ?? null, shot.subtitle ?? null);
    if (shot.fov) {
      this.camera.fov = shot.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  update(dt) {
    if (!this.active) return;
    const shot = this._shots[this._index];
    if (!shot) {
      this.stop();
      return;
    }

    this._time += dt;
    const hold = shot.hold ?? 2;
    const raw = Math.min(1, this._time / hold);
    const k = (shot.ease ?? smooth)(raw);

    // Camera. `from`/`to` may be functions so a shot can follow something that
    // only exists once the previous shot's onEnter has run.
    const from = resolve(shot.from);
    const to = resolve(shot.to) ?? from;
    if (from) this.camera.position.lerpVectors(from, to, k);

    const lookAt = resolve(shot.lookAt);
    const lookTo = resolve(shot.lookTo) ?? lookAt;
    if (lookAt) {
      const aim = new THREE.Vector3().lerpVectors(lookAt, lookTo, k);
      this.camera.lookAt(aim);
    }

    shot.onFrame?.(k, dt);

    if (raw >= 1) this.#advance();
  }
}

function resolve(value) {
  const v = typeof value === 'function' ? value() : value;
  return v ? v.clone?.() ?? v : null;
}

export { smooth, easeOut };

// ---------------------------------------------------------------- the scripts

/**
 * Opening. A slow drift across the room the player wakes up in, then the
 * title, then control.
 *
 * The camera starts low and behind the player's own spawn point and arrives
 * exactly where the player will be standing when it ends — so the handover is
 * seamless rather than a cut, and the first thing the player does is continue
 * a movement rather than begin one.
 */
export function introScript({ level, player, world, audio, hud }) {
  const eye = player.position.clone().setY(1.68);
  const forward = player.forward();
  const start = eye.clone().addScaledVector(forward, -3.2).setY(2.4);
  const mid = eye.clone().addScaledVector(forward, -1.2).setY(1.95);
  const aim = eye.clone().addScaledVector(forward, 7);

  return [
    {
      hold: 3.4,
      from: start,
      to: mid,
      lookAt: aim.clone().setY(0.4),
      lookTo: aim.clone().setY(1.5),
      title: 'SUBLEVEL THREE',
      subtitle: 'ST. AGNES — DECOMMISSIONED 1994',
      onEnter: () => {
        audio?.pipeGroan();
        // Not a blackout — the opening shot is the only chance to show the
        // player what the room they are standing in actually looks like.
        // Killing the practicals here made the intro three seconds of black.
        player.torchOn = true;
      },
    },
    {
      hold: 2.6,
      from: mid,
      to: eye,
      lookAt: aim.clone().setY(1.5),
      lookTo: aim.clone().setY(1.68),
      subtitle: 'the night shift never clocked out',
      onEnter: () => audio?.distantClang(),
      onExit: () => {
        hud?.objective('Find the ward tags. Get the lift code.', 7);
      },
    },
  ];
}

/**
 * Power restored. The lights come up, and for one second the corridor is fully
 * lit — which is the only time in the game it ever is, and the only time the
 * player gets to see how much of it they have been walking past.
 */
export function powerScript({ player, world, audio, monsters }) {
  const eye = player.eyePosition;
  const forward = player.forward();
  const aim = eye.clone().addScaledVector(forward, 9);

  return [
    {
      hold: 1.9,
      from: eye,
      to: eye.clone().addScaledVector(forward, 0.35),
      lookAt: aim,
      lookTo: aim,
      subtitle: 'power restored — sublevel three',
      onEnter: () => {
        audio?.surge(true);
        for (const p of world.practicals) p.light.intensity = p.base * 4;
      },
    },
    {
      hold: 2.2,
      from: eye.clone().addScaledVector(forward, 0.35),
      to: eye.clone().addScaledVector(forward, 0.5),
      lookAt: aim,
      lookTo: aim,
      onEnter: () => {
        // Whatever is nearest now knows exactly where the player is standing.
        audio?.surge(false);
        world.blackout(3.4);
        const hunter = monsters?.find((m) => m.behaviour === 'hunter');
        if (hunter?.active) hunter.awareness = 1;
        audio?.stinger(0.75);
      },
    },
  ];
}

/**
 * Escape. The lift, and the thing that very nearly got there first.
 */
export function escapeScript({ player, audio, monsters, hud }) {
  const eye = player.eyePosition;
  const forward = player.forward();
  const behind = eye.clone().addScaledVector(forward, -4);

  return [
    {
      hold: 1.6,
      from: eye,
      to: eye.clone().addScaledVector(forward, 1.4),
      lookAt: eye.clone().addScaledVector(forward, 6),
      lookTo: eye.clone().addScaledVector(forward, 6),
      onEnter: () => audio?.chime(),
    },
    {
      hold: 2.4,
      // Turn and look back the way you came, at whatever is coming down it.
      from: eye.clone().addScaledVector(forward, 1.4),
      to: eye.clone().addScaledVector(forward, 1.6),
      lookAt: behind,
      lookTo: behind,
      subtitle: 'the doors close',
      onEnter: () => {
        const near = monsters?.filter((m) => m.active)
          .sort((a, b) => a.distanceToPlayer - b.distanceToPlayer)[0];
        if (near) {
          near.position.copy(behind);
          near.root.position.copy(behind);
          near.root.visible = true;
        }
        audio?.roar(3);
      },
      onExit: () => hud?.setTitle(null),
    },
  ];
}
