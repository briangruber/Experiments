// The screenplay. Six scenes, no dialogue, every trope we could fit on one
// courtyard. Cue times are in scene-seconds, so slow motion stretches the
// beats along with the acting.

import * as THREE from '../vendor/three/three.module.min.js';
import { makeEgg } from './cast.js';
import { deg, clamp01, ease, lerp } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

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
  constructor(ctx) {
    this.ctx = ctx;
    this.tweens = new Tweens();
    ctx.tw = this.tweens;
    this.scenes = buildScreenplay(ctx, this.tweens);
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

  goTo(i, { silent = false } = {}) {
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

// --- helpers used all through the script ------------------------------------

function hideAll(ctx) {
  for (const k in ctx.actors) ctx.actors[k].setVisible(false).clearGestures().calm(99).lookAway();
  ctx.props.egg.visible = false;
  ctx.props.cloth.visible = false;
  // A scene that re-aims the key puts it back for whoever comes next.
  ctx.set.key.target.position.copy(ctx.set.keyDefault);
  ctx.set.key.intensity = 4.0;
  ctx.set.key.color.setHex(ctx.set.keyColorDefault);
}

function baseLook(ctx, over = {}) {
  ctx.post.snapLook({
    exposure: 1.55, contrast: 1.06, saturation: 0.96, warmth: 0.06, lift: 0.006,
    bloom: 0.55, bloomThreshold: 0.72, diffusion: 0.3, halation: 0.35, dof: 1,
    grain: 0.028, vignette: 0.42, chroma: 0.32, letterbox: 0.115,
    flash: 0, fade: 0, freeze: 0, vhs: 0.18, tint: [1, 1, 1], whip: 1, whipDir: 0,
    ...over,
  });
}

// A hard cut with a one-frame flash of light — the punctuation of the genre.
function stingCut(ctx, shot, kind = 'shock') {
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

// ---------------------------------------------------------------------------
// THE SCREENPLAY
// ---------------------------------------------------------------------------

function buildScreenplay(ctx, tw) {
  const { actors } = ctx;
  const { rosalinda, esteban, valentina, donGallo, ricardo, pollito } = actors;
  const scene = (name, subtitle, dur, setup, cues, opts = {}) => ({
    name, subtitle, dur, setup, pace: opts.pace,
    cues: cues.map(([t, fn]) => ({ t, fn, fired: false })),
  });

  // Standing marks.
  const BY_FOUNTAIN = V(-0.75, 0, 0.35);
  const CENTRE = V(0.2, 0, -0.55);
  const HER_MARK = V(-0.55, 0, 0.15);
  const HIS_MARK = V(0.75, 0, -0.15);
  const HIDE_PALM = V(2.25, 0, 1.95);
  const ARCH_IN = V(0, 0, -2.6);
  const ARCH_L = V(-2.35, 0, -2.7);
  // Offstage: the dark room behind the arches. The back wall spans z -3.7..-3.2,
  // so anyone placed at -3.5 is standing inside it and appears to pop into
  // existence the moment the scene cuts.
  const OFF_CENTRE = V(0, 0, -4.45);
  const OFF_LEFT = V(-2.35, 0, -4.3);

  return [

    // =======================================================================
    scene('PRELUDIO', 'la hacienda, medianoche', 32,
      (c) => {
        hideAll(c);
        baseLook(c, { fade: 1, diffusion: 0.34 });
        c.weather.setRain(0, true);
        c.score.setRain(0);
        c.set.wetness = 0;
        rosalinda.setVisible(true).place(BY_FOUNTAIN.x, BY_FOUNTAIN.z, deg(-140)).setEmotion({ sorrow: 0.5 });
        rosalinda.look(MOON, 0.9);
        c.cam.cut({
          subject: rosalinda, view: 3.4, lens: 20, angle: 196, height: 1.25,
          move: { type: 'descend', amount: 0.45, dur: 17 }, dur: 18, handheld: 0.3, smooth: 1.6,
          label: 'ESTABLISHING · 20mm',
        });
      },
      [
        [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('theme', 4); c.score.setAmbience(1); }],
        [1.6, (c) => c.score.say('vo-title')],
        [1.4, (c) => c.titles.show('CORAZÓN DE GALLINA', { sub: 'una telenovela de corral', kind: 'main', dur: 8, rule: true, fadeIn: 2 })],
        [6.5, (c) => { rosalinda.gesture('sigh'); c.score.cluck(); }],
        [10.0, (c) => { c.titles.show('CAPÍTULO FINAL', { kind: 'act', dur: 4.5 }); c.score.say('vo-capitulo', 0.3); }],
        [11.0, (c) => c.cam.move({
          subject: rosalinda, frame: 'mls', lens: 40, angle: 150, height: 'eye',
          move: { type: 'creep', amount: 1 }, dur: 8, smooth: 2.6, handheld: 0.5,
        })],
        [14.5, () => rosalinda.gesture('sob', { weight: 0.45, scale: 0.9 })],
        [19.0, (c) => {
          c.cam.cut({
            subject: rosalinda, frame: 'cu', lens: 85, angle: 28, look: 'head',
            move: { type: 'push', amount: 0.45, dur: 9 }, dur: 9, handheld: 0.7, aperture: 1.5,
          });
          c.post.setLook({ diffusion: 0.62, bloom: 0.72, halation: 0.5 });
        }],
        [23.5, () => rosalinda.emote({ sorrow: 0.7, love: 0.35 }, 1.2)],
        // She hears something at the gate.
        [26.0, (c) => {
          rosalinda.gesture('cock', { side: 1 });
          rosalinda.look(V(0, 0.4, -3.2), 1);
          c.score.sting('small');
          c.score.cluck();
        }],
        [28.5, (c) => c.cam.cut({
          subject: V(0, 0.5, -3.1), frame: 'mls', lens: 35, angle: 17, height: 0.5,
          dur: 6, handheld: 0.6, smooth: 1.2, label: 'THE GATE · 35mm',
        })],
      ]),

    // =======================================================================
    scene('EL ENCUENTRO', 'lo que el corazón no calla', 52,
      (c) => {
        hideAll(c);
        baseLook(c, { diffusion: 0.45, bloom: 0.66, halation: 0.45 });
        c.weather.setRain(0, true);
        c.score.setRain(0);
        c.set.wetness = 0;
        rosalinda.setVisible(true).place(HER_MARK.x, HER_MARK.z, deg(178)).setEmotion({ love: 0.3, sorrow: 0.25 });
        rosalinda.look(V(0, 0.5, -3.1), 1);
        esteban.setVisible(true).place(OFF_CENTRE.x, OFF_CENTRE.z, 0).setEmotion({ pride: 0.6 });
        valentina.setVisible(false).place(HIDE_PALM.x, HIDE_PALM.z, deg(200));
        c.cam.cut({
          subject: V(0, 0.5, -3.1), frame: 'mls', lens: 35, angle: 17, height: 0.5,
          dur: 8, handheld: 0.6, label: 'THE GATE · 35mm',
        });
      },
      [
        [0.0, (c) => { c.score.setMood('romance', 3); c.score.setAmbience(1); }],
        // He arrives, backlit in the archway.
        [0.8, () => esteban.walkTo(ARCH_IN.x, ARCH_IN.z, { style: 'strut', speed: 0.52 })],
        [2.0, (c) => c.score.sting('small')],
        [4.8, (c) => { esteban.gesture('strutPose'); esteban.look(rosalinda, 1); c.score.flap(); }],
        [5.0, (c) => c.cam.cut({
          subject: esteban, frame: 'ms', lens: 50, angle: 8, height: 'low',
          move: { type: 'push', amount: 0.35, dur: 7 }, dur: 7, handheld: 0.5, label: 'LOW ANGLE · 50mm',
        })],
        [6.2, (c) => { esteban.gesture('crow'); c.score.crow(); }],
        // Her reaction — shot/reverse-shot begins.
        [9.0, (c) => {
          c.cam.cut({ subject: rosalinda, frame: 'cu', lens: 85, angle: -12, dur: 6, handheld: 0.55, aperture: 1.6 });
          rosalinda.emote({ love: 0.85, sorrow: 0.1 }, 2.2);
          rosalinda.look(esteban, 1);
        }],
        [10.4, (c) => { rosalinda.gesture('gasp', { weight: 0.55 }); c.score.squawk(); }],
        [12.0, (c) => { c.score.harpRun(true); }],
        [13.0, (c) => c.cam.cut({
          subject: esteban, frame: 'cu', lens: 85, angle: -8, dur: 6, handheld: 0.55, aperture: 1.6,
          label: 'REVERSE · 85mm',
        })],
        [13.2, () => esteban.emote({ love: 0.7, pride: 0.4 }, 2)],
        [15.5, () => esteban.walkTo(HIS_MARK.x, HIS_MARK.z, { style: 'strut', face: rosalinda.pos })],
        [16.0, (c) => c.cam.cut({
          subject: esteban, frame: 'mls', lens: 40, angle: 62, height: 0.42, dur: 9,
          move: { type: 'orbit', amount: 0.7, dur: 9 }, handheld: 0.45, label: 'TWO SHOT · 40mm',
        })],
        [19.5, () => { esteban.look(rosalinda, 1); rosalinda.face(esteban.pos); }],
        [21.0, () => rosalinda.walkTo(-0.15, -0.1, { style: 'shuffle', face: esteban.pos })],
        // The almost-kiss. Held far too long, as is correct.
        [24.0, (c) => {
          c.cam.cut({
            subject: rosalinda, over: esteban, frame: 'mcu', lens: 100, angle: 26, dur: 10,
            move: { type: 'push', amount: 0.3, dur: 10 }, handheld: 0.4, aperture: 1.8,
            label: 'OVER SHOULDER · 100mm',
          });
          c.post.setLook({ diffusion: 0.8, bloom: 0.85, halation: 0.6, warmth: 0.16, vignette: 0.5 });
        }],
        [25.0, () => { rosalinda.gesture('nuzzle'); rosalinda.emote({ love: 1 }, 1.5); }],
        [26.0, () => { esteban.gesture('nuzzle'); esteban.emote({ love: 1, pride: 0.2 }, 1.5); }],
        [30.0, (c) => { c.score.setMood('romance', 2); c.score.harpRun(true); }],
        // And behind them, in the dark, someone is watching.
        [32.0, (c) => {
          valentina.setVisible(true).setEmotion({ anger: 0.5 });
          valentina.look(esteban, 0.9);
          c.cam.cut({
            subject: rosalinda, frame: 'mcu', lens: 100, angle: 200, height: 0.5, dur: 12,
            handheld: 0.4, aperture: 2.2, focusOn: rosalinda, label: 'RACK FOCUS · 100mm',
          });
        }],
        [34.5, (c) => {
          // Pull focus off the lovers and onto the villainess behind the palm.
          c.cam.rackFocus(valentina, 0.9);
          c.score.setMood('suspense', 2.5);
        }],
        [36.5, () => valentina.gesture('scheme')],
        [38.0, (c) => stingCut(c, {
          subject: valentina, frame: 'bcu', lens: 135, angle: -18, look: 'eye', dur: 6,
          move: { type: 'snapZoom', amount: 1, dur: 1.6 }, handheld: 0.8, aperture: 2.4,
          label: 'CRASH ZOOM · 135mm',
        }, 'shock')],
        [38.1, () => valentina.emote({ anger: 1 }, 4)],
        [41.0, (c) => c.cam.cut({
          subject: valentina, frame: 'ecu', lens: 135, angle: -22, look: 'eye', dur: 5,
          handheld: 0.9, aperture: 2.6, label: 'EXTREME CLOSE-UP · 135mm',
        })],
        [43.0, () => valentina.gesture('cock', { side: -1, weight: 0.6 })],
        [48.5, (c) => c.post.setLook({ fade: 1 })],
      ]),

    // =======================================================================
    scene('LA REVELACIÓN', 'el secreto bajo el paño', 56,
      (c) => {
        hideAll(c);
        baseLook(c, { fade: 1, diffusion: 0.34, vignette: 0.46 });
        c.weather.setRain(0.12, true);
        c.score.setRain(0.12);
        rosalinda.setVisible(true).place(-0.15, -0.1, deg(80)).setEmotion({ love: 0.7 });
        esteban.setVisible(true).place(HIS_MARK.x, HIS_MARK.z, deg(-100)).setEmotion({ love: 0.7, pride: 0.3 });
        rosalinda.look(esteban, 1); esteban.look(rosalinda, 1);
        valentina.setVisible(true).place(HIDE_PALM.x, HIDE_PALM.z, deg(210)).setEmotion({ anger: 1 });
        donGallo.setVisible(false).place(0, -3.3, 0).setEmotion({ anger: 0.4, pride: 0.8 });
        c.props.egg.visible = true;
        c.props.cloth.visible = true;
        c.props.cloth.position.set(-0.55, 0.13, -1.15);
        c.props.cloth.rotation.set(-Math.PI / 2, 0, 0);
        c.props.egg.userData.cracks.scale.setScalar(0.001);
        c.props.egg.userData.shell.scale.setScalar(1);
        c.cam.cut({
          subject: valentina, frame: 'ms', lens: 50, angle: 15, height: 'low', dur: 8,
          handheld: 0.7, label: 'LOW ANGLE · 50mm',
        });
      },
      [
        [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('suspense', 2); }],
        // She breaks cover.
        [1.0, () => { valentina.gesture('strutPose', { weight: 0.5 }); valentina.look(esteban, 1); }],
        [2.2, () => valentina.walkTo(0.95, 0.55, { style: 'storm', face: rosalinda.pos })],
        [2.4, (c) => c.cam.move({
          subject: valentina, frame: 'mls', lens: 35, angle: 30, height: 0.32, dur: 6,
          move: { type: 'push', amount: 0.5, dur: 5 }, handheld: 0.9, smooth: 0.35,
          label: 'TRACKING · 35mm',
        })],
        [4.0, (c) => { c.score.sting('rise'); }],
        [5.5, (c) => {
          c.cam.cut({
            subject: rosalinda, frame: 'mcu', lens: 85, angle: -30, dur: 4, whip: true, handheld: 0.8,
            label: 'WHIP PAN · 85mm',
          });
          rosalinda.look(valentina, 1);
          rosalinda.gesture('gasp');
          rosalinda.emote({ love: 0.2, fear: 0.6 }, 3);
        }],
        [7.0, (c) => {
          c.cam.cut({ subject: esteban, frame: 'mcu', lens: 85, angle: 24, dur: 4, whip: true, handheld: 0.8 });
          esteban.look(valentina, 1);
          esteban.emote({ love: 0.1, fear: 0.35, anger: 0.3 }, 3);
          esteban.gesture('recoil');
        }],
        [9.0, (c) => c.cam.cut({
          subject: valentina, frame: 'ms', lens: 50, angle: 8, height: 0.34, dur: 7, handheld: 0.7,
        })],
        [9.5, () => { valentina.gesture('accuse', { side: 1 }); valentina.pointSide = 1; }],
        // The cloth comes off.
        [12.0, () => valentina.walkTo(-0.15, -1.55, { style: 'storm', face: V(-0.55, 0, -1.15) })],
        [14.2, (c) => {
          c.cam.cut({
            subject: c.props.cloth, frame: 'ms', lens: 40, angle: 20, height: 0.22, dur: 6,
            handheld: 0.6, label: 'INSERT · 40mm',
          });
          valentina.gesture('peck');
        }],
        [15.0, (c) => {
          const cloth = c.props.cloth;
          const from = cloth.position.clone();
          c.tw.add(0.75, (u) => {
            cloth.position.set(
              lerp(from.x, from.x + 0.9, u),
              lerp(from.y, from.y + 0.55 * Math.sin(u * Math.PI) + 0.02, u),
              lerp(from.z, from.z + 1.1, u),
            );
            cloth.rotation.z = u * 4.2;
            cloth.rotation.x = -Math.PI / 2 + u * 1.4;
          }, { ease: 'expoOut', done: () => { cloth.visible = false; } });
          c.score.sting('reveal');
          c.score.flap();
          c.cam.shake(0.7);
        }],
        [15.9, (c) => c.cam.cut({
          subject: c.props.egg, frame: 'bcu', lens: 100, angle: 24, height: 0.12, dur: 6,
          move: { type: 'snapZoom', amount: 1, dur: 1.4 }, handheld: 0.5, aperture: 2,
          label: 'CRASH ZOOM · 100mm', look: 'head',
        })],
        [17.5, (c) => { c.score.heartbeat(1); }],
        [18.5, (c) => { c.score.heartbeat(1); }],
        // Three reactions, each closer than the last.
        [19.5, (c) => {
          stingCut(c, {
            subject: rosalinda, frame: 'cu', lens: 85, angle: -20, dur: 3, handheld: 0.9,
            move: { type: 'snapZoom', amount: 0.8, dur: 1 }, aperture: 2,
          });
          rosalinda.look(c.props.egg, 1);
          rosalinda.face(c.props.egg.position);
          rosalinda.gesture('gasp');
          c.score.squawk();
          rosalinda.emote({ fear: 0.8, sorrow: 0.5, love: 0 }, 4);
        }],
        [21.5, (c) => {
          stingCut(c, {
            subject: esteban, frame: 'bcu', lens: 100, angle: 16, dur: 3, handheld: 0.9,
            move: { type: 'snapZoom', amount: 0.9, dur: 1 }, aperture: 2.2,
          });
          esteban.look(c.props.egg, 1);
          esteban.face(c.props.egg.position);
          esteban.gesture('gasp');
          c.score.squawk();
          esteban.emote({ fear: 0.9, anger: 0.2, love: 0 }, 4);
        }],
        [23.5, (c) => {
          stingCut(c, {
            subject: valentina, frame: 'ecu', lens: 135, angle: -14, look: 'eye', dur: 3.5,
            handheld: 0.9, aperture: 2.6,
          });
          valentina.gesture('laugh');
        }],
        // Thunder, and the patriarch in the archway.
        [26.5, (c) => {
          c.weather.strike(1.2);
          c.score.thunder(1.1, 0.25);
          c.weather.setRain(0.55);
          c.score.setRain(0.55);
          c.score.setMood('storm', 3);
          donGallo.setVisible(true);
          c.cam.cut({
            subject: donGallo, frame: 'mls', lens: 28, angle: 4, height: 0.28, dur: 8,
            move: { type: 'push', amount: 0.4, dur: 6 }, handheld: 0.8, dutch: -6,
            label: 'THE PATRIARCH · 28mm',
          });
        }],
        [27.2, () => donGallo.walkTo(0, -2.35, { style: 'storm', speed: 0.75 })],
        [29.5, (c) => { donGallo.gesture('crow'); c.score.crow(); donGallo.emote({ anger: 0.9, pride: 1 }, 2); }],
        [30.0, (c) => { c.weather.strike(0.9); c.score.thunder(0.9, 0.15); }],
        [32.5, (c) => c.cam.cut({
          subject: donGallo, frame: 'bcu', lens: 85, angle: -10, height: 'low', dur: 5,
          handheld: 0.8, dutch: 8, aperture: 2, label: 'DUTCH · 85mm',
        })],
        [33.0, () => donGallo.gesture('accuse', { side: -1 })],
        [33.2, () => donGallo.look(esteban, 1)],
        [36.0, (c) => {
          c.cam.cut({ subject: esteban, frame: 'cu', lens: 85, angle: 20, dur: 4, whip: true, handheld: 0.9, dutch: -8 });
          esteban.look(donGallo, 1);
          esteban.emote({ fear: 0.7, sorrow: 0.4 }, 3);
          esteban.gesture('recoil');
        }],
        [38.5, (c) => {
          c.cam.cut({ subject: rosalinda, frame: 'cu', lens: 85, angle: -26, dur: 5, whip: true, handheld: 0.9, dutch: 6 });
          rosalinda.look(esteban, 1);
          rosalinda.gesture('sob');
          rosalinda.emote({ sorrow: 1, anger: 0.4, love: 0.2 }, 2.5);
        }],
        [42.0, (c) => c.cam.cut({
          subject: rosalinda, frame: 'ws', lens: 28, angle: 40, height: 1.9, dur: 9,
          move: { type: 'crane', amount: 0.6, dur: 8 }, handheld: 0.5, label: 'CRANE UP · 28mm',
        })],
        [44.0, (c) => { c.weather.strike(0.7); c.score.thunder(0.7, 0.2); }],
        [48.0, () => rosalinda.walkTo(-0.9, 0.5, { style: 'hurry' })],
        [52.0, (c) => c.post.setLook({ fade: 1 })],
      ]),

    // =======================================================================
    scene('LA BOFETADA', 'lo que se dice sin hablar', 38,
      (c) => {
        hideAll(c);
        baseLook(c, { fade: 1, exposure: 1.8, vignette: 0.5, contrast: 1.12, saturation: 0.95 });
        c.weather.setRain(0.7, true);
        c.score.setRain(0.7);
        c.set.wetness = 0.7;
        rosalinda.setVisible(true).place(-0.75, 0.4, deg(120)).setEmotion({ sorrow: 0.9, anger: 0.6 });
        esteban.setVisible(true).place(0.55, -0.35, deg(-60)).setEmotion({ sorrow: 0.7, fear: 0.4 });
        valentina.setVisible(true).place(1.9, -1.5, deg(215)).setEmotion({ pride: 0.8, anger: 0.4 });
        donGallo.setVisible(true).place(-0.35, -2.3, deg(170)).setEmotion({ anger: 1, pride: 1 });
        c.props.egg.visible = true;
        rosalinda.look(esteban, 1); esteban.look(rosalinda, 1);
        valentina.look(rosalinda, 0.8); donGallo.look(esteban, 0.9);
        c.cam.cut({
          subject: rosalinda, frame: 'ms', lens: 50, angle: 26, height: 'eye', dur: 8,
          handheld: 0.7, dutch: 3, label: 'MEDIUM · 50mm',
        });
      },
      [
        [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('tragedy', 2.5); }],
        [1.5, () => rosalinda.walkTo(0.05, -0.05, { style: 'storm', face: esteban.pos })],
        [2.0, (c) => c.cam.move({
          subject: rosalinda, frame: 'mcu', lens: 65, angle: 22, dur: 6, handheld: 0.9, smooth: 0.3,
        })],
        [4.5, () => { rosalinda.gesture('accuse', { side: 1 }); rosalinda.emote({ anger: 1, sorrow: 0.8 }, 2); }],
        [6.5, (c) => {
          c.cam.cut({ subject: esteban, frame: 'mcu', lens: 65, angle: -18, dur: 4, whip: true, handheld: 0.8 });
          esteban.gesture('recoil');
          esteban.emote({ sorrow: 0.9, fear: 0.5 }, 2);
        }],
        [8.5, (c) => c.cam.cut({
          subject: rosalinda, over: esteban, frame: 'mcu', lens: 85, angle: 24, dur: 5, handheld: 0.6,
          label: 'OVER SHOULDER · 85mm',
        })],
        [10.5, () => rosalinda.gesture('shudder')],
        // The slap. Time slows on the wind-up.
        [12.0, (c) => {
          c.cam.cut({
            subject: rosalinda, frame: 'ms', lens: 50, angle: 70, height: 0.42, dur: 7,
            handheld: 0.5, dutch: -4, label: 'THE SLAP · 50mm',
          });
        }],
        [12.1, (c, d) => d.setSpeed(0.22)],
        [12.6, (c) => { rosalinda.slapSide = 1; rosalinda.gesture('slap', { side: 1 }); c.score.flap(); }],
        [13.9, (c, d) => {
          // Impact: freeze one frame, flash, shake, and cut on the sound.
          esteban.slapFrom = 1;
          esteban.gesture('slapped');
          c.score.slap();
          c.cam.shake(1.4, 2.6);
          c.post.snapLook({ flash: 0.5, whipDir: 0 });
          c.post.setLook({ flash: 0 });
          d.freeze(0.42);
          c.weather.strike(0.8);
          c.score.thunder(0.8, 0.05);
        }],
        [14.0, (c) => c.cam.cut({
          subject: esteban, frame: 'bcu', lens: 100, angle: -34, dur: 5, handheld: 1, dutch: 12,
          aperture: 2.2, label: 'IMPACT · 100mm',
        })],
        [15.6, (c, d) => d.setSpeed(1)],
        [16.5, (c) => { c.score.sting('shock'); }],
        [17.0, (c) => c.cam.cut({
          subject: rosalinda, frame: 'cu', lens: 85, angle: 14, dur: 6, handheld: 0.8, aperture: 1.8,
        })],
        [17.2, () => { rosalinda.emote({ sorrow: 1, anger: 0.2 }, 1.6); rosalinda.gesture('sob'); }],
        [20.0, () => { rosalinda.gesture('spurn'); rosalinda.face(deg(-20)); rosalinda.lookAway(); }],
        [21.0, (c) => c.cam.cut({
          subject: esteban, frame: 'mcu', lens: 85, angle: -8, dur: 6, handheld: 0.7, dutch: -5,
        })],
        [21.5, () => { esteban.look(rosalinda, 1); esteban.emote({ sorrow: 1, fear: 0.2 }, 2); }],
        [23.5, () => esteban.gesture('accuse', { side: -1, weight: 0.55 })],
        [26.0, (c) => {
          c.cam.cut({
            subject: valentina, frame: 'cu', lens: 100, angle: -12, dur: 5, handheld: 0.7, aperture: 2,
            label: 'THE VILLAINESS · 100mm',
          });
          valentina.gesture('laugh');
          c.score.sting('small');
        }],
        [29.0, (c) => c.cam.cut({
          subject: rosalinda, frame: 'ws', lens: 24, angle: 150, height: 1.4, dur: 9,
          move: { type: 'pull', amount: 0.5, dur: 8 }, handheld: 0.5, label: 'PULL BACK · 24mm',
        })],
        [30.0, (c) => { c.weather.strike(1); c.score.thunder(1, 0.2); }],
        [34.0, (c) => c.post.setLook({ fade: 1 })],
      ]),

    // =======================================================================
    scene('EL GEMELO MALVADO', 'nadie es quien parece', 50,
      (c) => {
        hideAll(c);
        baseLook(c, { fade: 1, exposure: 1.85, contrast: 1.14, saturation: 0.92, vignette: 0.52, chroma: 0.42 });
        c.weather.setRain(0.85, true);
        c.score.setRain(0.85);
        c.set.wetness = 0.85;
        rosalinda.setVisible(true).place(-0.7, 0.45, deg(-30)).setEmotion({ sorrow: 1 });
        esteban.setVisible(true).place(0.55, -0.35, deg(-70)).setEmotion({ sorrow: 0.9 });
        valentina.setVisible(true).place(1.9, -1.5, deg(215)).setEmotion({ pride: 0.9 });
        donGallo.setVisible(true).place(-0.35, -2.3, deg(170)).setEmotion({ anger: 1, pride: 1 });
        ricardo.setVisible(false).place(OFF_LEFT.x, OFF_LEFT.z, 0).setEmotion({ pride: 1, anger: 0.5 });
        c.props.egg.visible = true;
        c.cam.cut({
          subject: rosalinda, frame: 'mcu', lens: 85, angle: 20, dur: 7, handheld: 0.8, aperture: 1.8,
          label: 'CLOSE · 85mm',
        });
      },
      [
        [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('storm', 2); }],
        [1.0, () => rosalinda.gesture('sob')],
        // Footsteps in the left arch. Nobody sees him yet.
        [3.0, (c) => {
          ricardo.setVisible(true);
          ricardo.walkTo(ARCH_L.x, -2.5, { style: 'strut', speed: 0.6 });
          c.cam.cut({
            subject: ricardo, frame: 'mls', lens: 35, angle: 6, height: 0.3, dur: 7,
            handheld: 0.7, dutch: -7, label: 'THE STRANGER · 35mm',
          });
          c.score.setMood('suspense', 2);
        }],
        [4.0, (c) => { c.weather.strike(1.3); c.score.thunder(1.2, 0.1); }],
        [6.0, (c) => { c.score.sting('rise'); c.cam.shake(0.4); }],
        // Every head turns, one after another.
        [7.0, (c) => {
          c.cam.cut({ subject: esteban, frame: 'cu', lens: 100, angle: -14, dur: 3, whip: true, handheld: 0.9, dutch: 8 });
          esteban.look(ricardo, 1); esteban.gesture('doubleTake'); esteban.emote({ shock: 1, anger: 0.4 }, 6);
          c.score.squawk();
        }],
        [9.0, (c) => {
          c.cam.cut({ subject: rosalinda, frame: 'cu', lens: 100, angle: 8, dur: 3, whip: true, handheld: 0.9, dutch: -8 });
          rosalinda.look(ricardo, 1); rosalinda.gesture('gasp'); rosalinda.emote({ shock: 1, fear: 0.6, sorrow: 0.4 }, 6);
          c.score.squawk();
        }],
        [11.0, (c) => {
          c.cam.cut({ subject: donGallo, frame: 'cu', lens: 100, angle: -6, dur: 3, whip: true, handheld: 0.9, dutch: 10 });
          donGallo.look(ricardo, 1); donGallo.gesture('doubleTake'); donGallo.emote({ shock: 1, anger: 0.8 }, 6);
        }],
        [13.0, (c) => {
          stingCut(c, {
            subject: ricardo, frame: 'bcu', lens: 135, angle: -12, look: 'eye', dur: 5,
            move: { type: 'snapZoom', amount: 1, dur: 1.3 }, handheld: 0.9, dutch: -12, aperture: 2.4,
            label: 'THE TWIN · 135mm',
          }, 'reveal');
          ricardo.gesture('scheme');
        }],
        [16.0, (c) => { c.score.sting('reveal'); c.cam.shake(0.6); }],
        // The vertigo shot: she understands.
        [17.5, (c) => {
          c.cam.cut({
            subject: rosalinda, frame: 'mcu', lens: 40, angle: 12, dur: 9,
            move: { type: 'dollyZoom', amount: 1, dur: 6 }, handheld: 0.4, aperture: 1.4,
            label: 'DOLLY ZOOM · 40→100mm',
          });
          rosalinda.emote({ shock: 1, fear: 0.5, sorrow: 0.6 }, 3);
        }],
        [18.5, () => rosalinda.gesture('recoil')],
        [21.0, (c) => { c.score.heartbeat(1.1); }],
        [22.0, (c) => { c.score.heartbeat(1.1); }],
        [23.5, () => { rosalinda.look(esteban, 1); rosalinda.emote({ sorrow: 0.7, love: 0.5, shock: 0.4 }, 2); }],
        // Twin and hero, face to face. The two-shot that pays off the wardrobe.
        [25.5, (c) => {
          c.cam.cut({
            subject: esteban, frame: 'mls', lens: 50, angle: 96, height: 0.4, dur: 10,
            move: { type: 'orbit', amount: 0.8, dur: 10 }, handheld: 0.5, dutch: 4,
            label: 'CONFRONTATION · 50mm',
          });
          ricardo.walkTo(-0.75, -1.5, { style: 'storm', face: esteban.pos });
          esteban.look(ricardo, 1);
          esteban.emote({ anger: 1, pride: 0.5, sorrow: 0.2 }, 2);
        }],
        [28.5, () => { ricardo.look(esteban, 1); ricardo.gesture('strutPose'); }],
        [30.5, () => { esteban.gesture('accuse', { side: 1 }); }],
        [32.0, () => { ricardo.gesture('laugh'); }],
        [33.0, (c) => c.cam.cut({
          subject: ricardo, frame: 'cu', lens: 100, angle: -20, dur: 5, handheld: 0.8, dutch: -14,
          aperture: 2.2,
        })],
        // And the villainess crosses to his side, which explains everything.
        [36.0, (c) => {
          c.cam.cut({
            subject: ricardo, frame: 'mls', lens: 40, angle: 40, height: 0.5, dur: 8, handheld: 0.6,
            label: 'THE ALLIANCE · 40mm',
          });
          valentina.walkTo(-0.15, -1.85, { style: 'strut', face: ricardo.pos });
          valentina.look(ricardo, 1);
        }],
        [39.5, () => { valentina.gesture('nuzzle'); ricardo.gesture('nuzzle'); }],
        [41.0, (c) => { c.score.sting('reveal'); c.cam.shake(0.5); }],
        [42.0, (c) => {
          c.cam.cut({ subject: rosalinda, frame: 'cu', lens: 100, angle: 16, dur: 6, whip: true, handheld: 0.9 });
          rosalinda.look(valentina, 1);
          rosalinda.gesture('gasp');
          rosalinda.emote({ shock: 1, sorrow: 1 }, 3);
        }],
        [45.0, (c) => { c.weather.strike(1.4); c.score.thunder(1.3, 0.1); }],
        [46.0, (c) => c.post.setLook({ fade: 1 })],
      ]),

    // =======================================================================
    scene('CONTINUARÁ', 'el desmayo y el secreto', 54,
      (c) => {
        hideAll(c);
        baseLook(c, { fade: 1, exposure: 1.85, contrast: 1.12, saturation: 0.95, vignette: 0.5 });
        c.weather.setRain(0.95, true);
        c.score.setRain(0.95);
        c.set.wetness = 0.95;
        rosalinda.setVisible(true).place(-0.6, 0.5, deg(-40)).setEmotion({ sorrow: 1, shock: 0.8 });
        esteban.setVisible(true).place(0.4, -0.2, deg(-120)).setEmotion({ sorrow: 0.8, anger: 0.3 });
        ricardo.setVisible(true).place(-0.75, -1.5, deg(150)).setEmotion({ pride: 1 });
        valentina.setVisible(true).place(-0.15, -1.85, deg(190)).setEmotion({ pride: 1, anger: 0.3 });
        donGallo.setVisible(true).place(-0.35, -2.3, deg(160)).setEmotion({ anger: 1, pride: 1 });
        c.props.egg.visible = true;
        c.props.egg.userData.cracks.scale.setScalar(0.001);
        c.props.egg.userData.shell.scale.setScalar(1);
        pollito.setVisible(false).place(-0.55, -1.15, deg(40));
        rosalinda.look(esteban, 1);
        esteban.look(rosalinda, 1);
        c.cam.cut({
          subject: rosalinda, frame: 'mcu', lens: 85, angle: 18, dur: 8, handheld: 0.8, aperture: 1.8,
          label: 'CLOSE · 85mm',
        });
      },
      [
        [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('tragedy', 2.5); }],
        [1.0, () => { rosalinda.gesture('swoon', { side: -1 }); rosalinda.emote({ sorrow: 1, fear: 0.5 }, 2); }],
        [2.0, (c) => c.cam.move({
          subject: rosalinda, frame: 'ms', lens: 65, angle: 34, height: 0.55, dur: 8,
          move: { type: 'pull', amount: 0.3, dur: 6 }, handheld: 0.7, smooth: 1.1,
        })],
        [3.4, (c) => { c.score.sting('shock'); }],
        // The faint, and the catch.
        [4.0, (c) => {
          c.score.flap();
          rosalinda.gesture('faint', { side: -1 });
          esteban.walkTo(-0.28, 0.18, { style: 'hurry', face: rosalinda.pos });
        }],
        [4.2, (c) => c.cam.cut({
          subject: rosalinda, frame: 'ms', lens: 40, angle: 62, height: 0.3, dur: 8,
          handheld: 0.9, dutch: -6, label: 'THE FAINT · 40mm',
        })],
        [5.6, () => { esteban.gesture('catcher'); esteban.look(rosalinda, 1); esteban.emote({ sorrow: 1, fear: 0.6 }, 2); }],
        [6.4, (c) => { c.cam.shake(0.35); c.score.sting('small'); }],
        [8.0, (c) => c.cam.cut({
          subject: rosalinda, frame: 'cu', lens: 100, angle: 40, height: 0.24, dur: 7,
          move: { type: 'creep', amount: 1 }, handheld: 0.6, aperture: 2, label: 'CLOSE · 100mm',
        })],
        [10.5, (c) => { c.weather.strike(1.2); c.score.thunder(1.1, 0.15); }],
        // The villains, silhouetted by the lightning.
        [12.0, (c) => {
          c.cam.cut({
            subject: valentina, frame: 'mls', lens: 35, angle: 20, height: 0.36, dur: 8,
            handheld: 0.7, dutch: 9, label: 'SILHOUETTE · 35mm',
          });
          valentina.gesture('laugh');
          ricardo.gesture('laugh', { delay: 0.4 });
        }],
        [13.0, (c) => { c.weather.strike(1.4); c.score.thunder(1.3, 0.05); c.score.sting('shock'); }],
        [16.0, (c) => {
          c.cam.cut({
            subject: donGallo, frame: 'cu', lens: 85, angle: -8, height: 'low', dur: 5,
            handheld: 0.8, dutch: -10,
          });
          donGallo.look(ricardo, 1);
          donGallo.gesture('crow');
        }],
        // Everyone forgets the egg. The camera does not.
        [20.0, (c) => {
          c.cam.cut({
            subject: c.props.egg, frame: 'ms', lens: 50, angle: 30, height: 0.16, dur: 8,
            move: { type: 'push', amount: 0.5, dur: 7 }, handheld: 0.4, aperture: 1.6,
            label: 'THE EGG · 50mm',
          });
          c.score.setMood('suspense', 3);
        }],
        [22.5, (c) => {
          const cr = c.props.egg.userData.cracks;
          c.tw.add(2.4, (u) => cr.scale.setScalar(0.001 + u), { ease: 'backOut' });
          c.score.eggCrack();
          c.score.sting('small');
          c.cam.shake(0.25);
        }],
        [24.5, (c) => { c.score.heartbeat(1); c.cam.shake(0.2); }],
        [26.0, (c) => { c.score.heartbeat(1); c.cam.shake(0.3); }],
        [27.5, (c) => c.cam.cut({
          subject: c.props.egg, frame: 'bcu', lens: 100, angle: 22, height: 0.11, dur: 9,
          handheld: 0.5, aperture: 2, label: 'BIG CLOSE-UP · 100mm',
        })],
        // Hatch.
        [28.5, (c) => {
          const shell = c.props.egg.userData.shell;
          const cracks = c.props.egg.userData.cracks;
          pollito.setVisible(true);
          pollito.rig.root.scale.setScalar(0.001);
          c.tw.add(1.1, (u) => {
            shell.scale.set(1 - u * 0.15, Math.max(0.06, 1 - u * 0.92), 1 - u * 0.15);
            cracks.scale.setScalar(Math.max(0.001, 1 - u));
            pollito.rig.root.scale.setScalar(Math.max(0.001, u));
          }, { ease: 'backOut' });
          c.score.eggCrack();
          c.score.peep();
          c.cam.shake(0.4);
        }],
        [30.0, () => { pollito.emote({ shock: 0.3 }, 3); pollito.gesture('cock', { side: 1 }); }],
        [31.5, (c) => { pollito.gesture('peck'); c.score.peep(); }],
        // It looks straight down the lens.
        [33.0, (c) => {
          c.cam.cut({
            subject: pollito, frame: 'ecu', lens: 135, angle: 0, look: 'eye', dur: 9,
            move: { type: 'push', amount: 0.5, dur: 7 }, handheld: 0.35, aperture: 2.6,
            label: 'TO CAMERA · 135mm',
          });
          pollito.look(c.camera, 1);
          c.score.setMood('silence', 1.5);
        }],
        [34.0, (c) => { c.score.sting('reveal'); }],
        [36.5, () => pollito.gesture('cock', { side: -1, weight: 0.5 })],
        [38.5, (c) => {
          // Freeze frame, hold, and roll the card.
          c.post.setLook({ freeze: 1, grain: 0.11, contrast: 1.2, saturation: 0.8, vignette: 0.62 });
          c.cam.shake(0.2);
          c.score.sting('shock');
        }],
        [38.6, (c, d) => d.setSpeed(0.06)],
        [39.0, (c) => { c.titles.show('CONTINUARÁ…', { kind: 'end', dur: 12, fadeIn: 1.2, rule: true }); c.score.say('vo-continuara', 0.6); }],
        [42.0, (c) => { c.score.setMood('theme', 2); }],
        [46.0, (c) => { c.post.setLook({ fade: 1 }); }],
        [48.0, (c, d) => { d.setSpeed(1); c.post.setLook({ freeze: 0 }); }],
      ]),

    // =======================================================================
    // The curtain call. The cast line up downstage, take a bow each as their
    // name comes up, and then the crew gets its due.
    scene('CRÉDITOS', 'el reparto y los culpables', 51,
      (c) => {
        hideAll(c);
        baseLook(c, {
          fade: 1, exposure: 1.7, diffusion: 0.5, bloom: 0.7, halation: 0.45,
          warmth: 0.12, vignette: 0.44, grain: 0.034,
        });
        c.weather.setRain(0.06, true);
        c.score.setRain(0.06);
        c.set.wetness = 0.25;
        // The line, and where the camera will end up watching it from.
        const LINE = 0.5, EYE = V(0.55, 1.05, 2.95);
        const onLine = (actor, x, e) => {
          actor.setVisible(true).place(x, LINE, Math.atan2(EYE.x - x, EYE.z - LINE)).setEmotion(e);
          actor.look(c.camera, 0.85);
        };
        onLine(rosalinda, -0.9, { love: 0.35, pride: 0.3 });
        onLine(esteban, -0.3, { pride: 0.8 });
        onLine(valentina, 0.3, { pride: 0.9, anger: 0.2 });
        onLine(donGallo, 0.95, { pride: 1 });
        onLine(ricardo, 1.6, { pride: 0.9 });
        onLine(pollito, 2.1, { shock: 0.2 });
        pollito.rig.root.scale.setScalar(1);
        // Swing the key round onto the line — nobody takes a bow in the dark.
        // Warm footlights for the curtain call — the cool night key made the
        // whole company look embalmed.
        c.set.key.target.position.set(0.55, 0.45, LINE);
        c.set.key.color.setHex(0xffc98a);
        c.set.key.intensity = 6.0;
        c.cam.cut({
          subject: V(0.55, 0.45, LINE), view: 2.4, lens: 24, angle: 0, height: EYE.y,
          move: { type: 'crane', amount: 0.5, dur: 46 }, dur: 48, handheld: 0.35, smooth: 2.4,
          label: 'CURTAIN CALL · 24mm',
        });
      },
      [
        [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('credits', 4); c.score.setAmbience(1); }],
        [0.8, (c) => c.titles.show('CORAZÓN DE GALLINA', { kicker: 'reparto', kind: 'main', dur: 5, rule: true, fadeIn: 1.4 })],

        // Each bird gets a bow and a noise of its own.
        [5.5, (c) => { rosalinda.gesture('bow'); c.score.cluck(); c.titles.show('ROSALINDA', { sub: 'la inocente', kind: 'cast', dur: 2.9 }); }],
        [8.3, (c) => { esteban.gesture('bow'); c.score.crow(); c.titles.show('ESTEBAN', { sub: 'el galán', kind: 'cast', dur: 2.9 }); }],
        [11.1, (c) => { valentina.gesture('bow'); c.score.squawk(); c.titles.show('VALENTINA', { sub: 'la villana', kind: 'cast', dur: 2.9 }); }],
        [13.9, (c) => { donGallo.gesture('bow'); c.score.crow(); c.titles.show('DON GALLO', { sub: 'el patrón', kind: 'cast', dur: 2.9 }); }],
        [16.7, (c) => { ricardo.gesture('bow'); c.score.squawk(); c.titles.show('RICARDO', { sub: 'el gemelo malvado', kind: 'cast', dur: 2.9 }); }],
        [19.5, (c) => { pollito.gesture('bow'); c.score.peep(); c.titles.show('POLLITO', { sub: 'el secreto', kind: 'cast', dur: 2.9 }); }],

        // And now the people who did this on purpose.
        [22.6, (c) => c.cam.move({
          subject: V(0.55, 0.45, 0.5), view: 3.0, lens: 28, angle: 13, height: 1.0,
          move: { type: 'orbit', amount: 0.5, dur: 26 }, dur: 26, handheld: 0.4, smooth: 3,
          label: 'THE GUILTY · 30mm',
        })],
        [23.4, (c) => {
          c.score.say('vo-credits-1');
          c.titles.show('CLAUDE OPUS 5', {
            kicker: 'dirección · guion · fotografía · vestuario · y todas las plumas',
            kind: 'credit', dur: 6.5, fadeIn: 1,
          });
        }],
        [28.8, (c) => {
          c.score.say('vo-credits-2');
          c.titles.show('THREE.JS', {
            kicker: 'escenografía construida a mano, polígono por polígono',
            kind: 'credit', dur: 5.5, fadeIn: 0.9,
          });
        }],
        [34.0, (c) => {
          c.score.say('vo-credits-3');
          c.titles.show('ELEVENLABS', {
            kicker: 'música original · truenos · y todos los suspiros',
            kind: 'credit', dur: 5.5, fadeIn: 0.9,
          });
        }],
        [39.2, (c) => {
          c.score.say('vo-credits-4');
          c.titles.show('BRIAN GRUBER', {
            kicker: 'wrote a few prompts',
            kind: 'credit', dur: 5.5, fadeIn: 0.9,
          });
          c.score.crow();
        }],
        [44.4, (c) => {
          c.score.say('vo-credits-5');
          c.titles.show('NINGUNA GALLINA RESULTÓ HERIDA', {
            sub: 'varias resultaron traicionadas',
            kind: 'act', dur: 4.5, fadeIn: 0.8,
          });
        }],
        [48.0, (c) => c.post.setLook({ fade: 1 })],
      ],
      // The credits run to the announcer's clock, not the director's.
      { pace: 1.0 }),
  ];
}
