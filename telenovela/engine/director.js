// The direction: the cue runner, the tween runner, and the staging helpers
// every scene leans on. The scenes themselves live with their episode
// (episodes/e01-corazon/scenes/), assembled by its manifest (episode.js) and
// handed to the Director by main.js. Cue times are in scene-seconds, so slow
// motion stretches the beats along with the acting.

import * as THREE from '../vendor/three/three.module.min.js';
import { makeEgg } from '../company/cast/index.js';
import { clamp01, ease, lerp } from './util.js';

export const V = (x, y, z) => new THREE.Vector3(x, y, z);

export const MOON = V(22, 26, -42);

// --- tiny tween runner ------------------------------------------------------

class Tweens {
  constructor() { this.list = []; }
  add(dur, on, opts = {}) {
    this.list.push({ t: -(opts.delay || 0), dur, on, ease: opts.ease || 'inOut', done: opts.done });
    return this;
  }
  clear() { this.list.length = 0; }
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const w = this.list[i];
      w.t += dt;
      if (w.t < 0) continue;
      const u = clamp01(w.t / w.dur);
      w.on((ease[w.ease] || ease.inOut)(u), u);
      if (u >= 1) { w.done?.(); this.list.splice(i, 1); }
    }
  }
}

// --- the production ---------------------------------------------------------

export class Director {
  // The episode is passed in rather than imported: the engine stages any
  // episode, and the episode's manifest imports its staging helpers from here —
  // importing it back would close a cycle. Scenes are assembled from the
  // manifest's play order: each scene module builds its setup and cues against
  // the deps the episode provides, and the episode's dialogue wiring is
  // spliced in by scene id, so inserting a scene never renumbers anything.
  constructor(ctx, episode) {
    this.ctx = ctx;
    this.tweens = new Tweens();
    ctx.tw = this.tweens;
    this.episode = episode;
    this.scenes = episode.order.map((meta) => {
      const { setup, cues } = episode.scenes[meta.id].build(episode.deps(ctx));
      return {
        id: meta.id, name: meta.name, subtitle: meta.subtitle, dur: meta.dur, pace: meta.pace,
        setup,
        cues: [...cues, ...episode.subtitleCues(meta.id)].map(([t, fn]) => ({ t, fn, fired: false })),
      };
    });
    this.index = -1;
    this.t = 0;
    this.speed = 1;
    this.speedTarget = 1;
    // Tempo. The piece was authored at 1 and played a little statelier than it
    // reads; scenes can override it where a cue is tied to real-time audio.
    this.pace = 1.32;
    this.freezeT = 0;
    this.paused = false;
    this.onScene = null;
    this.props = ctx.props;
  }

  get scene() { return this.scenes[this.index]; }

  indexOf(id) { return this.scenes.findIndex((s) => s.id === id); }

  // Scenes are addressed by id or by position — the id is the stable name,
  // the index is what arrow keys and wrap-around arithmetic want.
  goTo(ref, { silent = false } = {}) {
    let i = ref;
    if (typeof ref === 'string') {
      i = this.indexOf(ref);
      if (i < 0) throw new Error(`unknown scene '${ref}'`);
    }
    i = ((i % this.scenes.length) + this.scenes.length) % this.scenes.length;
    this.index = i;
    this.t = 0;
    this.speed = this.speedTarget = 1;
    this.freezeT = 0;
    const s = this.scenes[i];
    for (const c of s.cues) c.fired = false;
    this.tweens.clear();
    this.ctx.titles.clear();
    s.setup(this.ctx);
    if (!silent) this.onScene?.(s, i);
    // Fire everything scheduled at t=0 immediately so a jump lands on a frame
    // that already looks like the scene.
    this.fire(0);
    this.ctx.cam.solve(0, true);
    return this;
  }

  next() { return this.goTo(this.index + 1); }
  prev() { return this.goTo(this.index - 1); }
  restart() { return this.goTo(0); }

  setSpeed(v, snap = false) { this.speedTarget = v; if (snap) this.speed = v; return this; }
  freeze(seconds) { this.freezeT = seconds; return this; }

  fire(t) {
    const s = this.scene;
    for (const c of s.cues) {
      if (!c.fired && c.t <= t) { c.fired = true; c.fn(this.ctx, this); }
    }
  }

  // dt here is real seconds; the scene clock is what gets scaled.
  update(dt) {
    if (this.index < 0) this.goTo(0);
    if (this.paused) return 0;

    if (this.freezeT > 0) {
      this.freezeT -= dt;
      this.ctx.post.setLook({ freeze: 1 });
      if (this.freezeT <= 0) this.ctx.post.setLook({ freeze: 0 });
      return 0;
    }

    this.speed = lerp(this.speed, this.speedTarget, 1 - Math.exp(-6 * dt));
    const sdt = dt * this.speed * (this.scene.pace ?? this.pace);
    this.t += sdt;
    this.fire(this.t);
    this.tweens.update(sdt);
    if (this.t >= this.scene.dur) this.next();
    return sdt;
  }
}

// --- staging helpers used all through any script ----------------------------

export function hideAll(ctx) {
  for (const k in ctx.actors) ctx.actors[k].setVisible(false).clearGestures().calm(99).lookAway();
  ctx.props.egg.visible = false;
  ctx.props.cloth.visible = false;
  // A scene that re-aims the key puts it back for whoever comes next.
  ctx.set.key.target.position.copy(ctx.set.keyDefault);
  ctx.set.key.intensity = 4.0;
  ctx.set.key.color.setHex(ctx.set.keyColorDefault);
}

export function baseLook(ctx, over = {}) {
  ctx.post.snapLook({
    exposure: 1.55, contrast: 1.06, saturation: 0.96, warmth: 0.06, lift: 0.006,
    bloom: 0.55, bloomThreshold: 0.72, diffusion: 0.3, halation: 0.35, dof: 1,
    grain: 0.028, vignette: 0.42, chroma: 0.32, letterbox: 0.115,
    flash: 0, fade: 0, freeze: 0, vhs: 0.18, tint: [1, 1, 1], whip: 1, whipDir: 0,
    ...over,
  });
}

// Hit whoever is on screen with the key. The courtyard is lit for a night
// scene, which is exactly wrong for a glamour shot of a dark bird.
export function keyOn(ctx, actor, intensity = 9) {
  ctx.set.key.target.position.set(actor.pos.x, 0.42, actor.pos.z);
  ctx.set.key.intensity = intensity;
  ctx.set.key.color.setHex(0xffe0bd);
}

// A hard cut with a one-frame flash of light — the punctuation of the genre.
export function stingCut(ctx, shot, kind = 'shock') {
  ctx.cam.cut(shot);
  ctx.score.sting(kind);
  ctx.post.snapLook({ flash: 0.16 });
  ctx.post.setLook({ flash: 0 });
  ctx.cam.shake(0.5);
}

export function buildProps(scene) {
  const egg = makeEgg(1);
  egg.position.set(-0.55, 0.072, -1.15);
  egg.visible = false;
  scene.add(egg);

  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.34, 6, 6),
    new THREE.MeshStandardMaterial({ color: 0x7d1220, roughness: 0.94, side: THREE.DoubleSide }),
  );
  // Sag the cloth so it drapes rather than floats.
  {
    const p = cloth.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      p.setZ(i, -Math.max(0, 0.09 - (x * x + y * y) * 1.6));
    }
    cloth.geometry.computeVertexNormals();
  }
  cloth.rotation.x = -Math.PI / 2;
  cloth.position.set(-0.55, 0.13, -1.15);
  cloth.castShadow = true;
  cloth.visible = false;
  scene.add(cloth);

  return { egg, cloth };
}

