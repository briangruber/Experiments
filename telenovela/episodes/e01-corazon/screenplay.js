// The screenplay for episode one. Every scene is a cue list in scene-seconds,
// so slow motion stretches the beats along with the acting; the staging
// grammar (shots, gestures, moods) comes from the engine, the subtitle script
// from dialogue.js next door.

import { V, MOON, hideAll, baseLook, keyOn, stingCut } from '../../engine/director.js';
import { subtitleCues } from './subtitles.js';
import { deg, lerp } from '../../engine/util.js';

export function buildScreenplay(ctx, tw) {
  const { actors } = ctx;
  const { rosalinda, esteban, valentina, donGallo, ricardo, pollito } = actors;
  // The subtitle script lives apart from the staging, and gets spliced in here
  // by position — scenes are constructed in order, so the counter is the scene
  // index the script refers to.
  let sceneIndex = -1;
  const scene = (name, subtitle, dur, setup, cues, opts = {}) => {
    sceneIndex++;
    return {
      name, subtitle, dur, setup, pace: opts.pace,
      cues: [...cues, ...subtitleCues(sceneIndex)].map(([t, fn]) => ({ t, fn, fired: false })),
    };
  };

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
    // The opening titles. Cut to the song rather than to the director's pace,
    // which is why this scene runs at 1: the chorus lands at about 21s and the
    // main card goes up on it.
    scene('ENTRADA', 'corazón de gallina', 31,
      (c) => {
        hideAll(c);
        baseLook(c, { fade: 1, exposure: 1.7, diffusion: 0.5, bloom: 0.7, halation: 0.5, vignette: 0.5, warmth: 0.1 });
        c.weather.setRain(0, true);
        c.score.setRain(0);
        c.set.wetness = 0;
        c.props.cloth.visible = true;
        c.props.cloth.position.set(-0.55, 0.13, -1.15);
        c.props.cloth.rotation.set(-Math.PI / 2, 0, 0);
        // Everyone waits in the dark room behind the arches and steps into
        // their own shot.
        rosalinda.setVisible(false).place(BY_FOUNTAIN.x, BY_FOUNTAIN.z, deg(-150));
        esteban.setVisible(false).place(0.85, -0.35, deg(-115));
        valentina.setVisible(false).place(-0.35, -1.35, deg(155));
        donGallo.setVisible(false).place(0.35, -2.15, deg(172));
        ricardo.setVisible(false).place(-1.55, -1.85, deg(120));
        c.cam.cut({
          subject: V(-0.2, 0.7, -1.2), view: 5.2, lens: 24, angle: 172, height: 2.1,
          move: { type: 'descend', amount: 0.5, dur: 8 }, dur: 8, handheld: 0.25, smooth: 2.2,
          label: 'TITLES · 24mm',
        });
      },
      [
        [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('opening', 2.5); c.score.setAmbience(1); }],

        // Each of them gets one shot and their name. A telenovela tells you
        // exactly who to distrust before a word is spoken.
        [4.0, (c) => {
          rosalinda.setVisible(true).setEmotion({ sorrow: 0.3, love: 0.4 });
          rosalinda.look(MOON, 0.8);
          keyOn(c, rosalinda);
          c.cam.cut({
            subject: rosalinda, frame: 'mcu', lens: 85, angle: 34, dur: 4.2,
            move: { type: 'push', amount: 0.22, dur: 4.2 }, handheld: 0.35, aperture: 1.8,
          });
          c.titles.show('ROSALINDA', { sub: 'la inocente', kind: 'cast', dur: 3.4, fadeIn: 0.7 });
          c.score.say('vo-name-rosalinda', 0.25);
        }],
        [5.2, () => rosalinda.gesture('sigh')],

        [7.6, (c) => {
          esteban.setVisible(true).setEmotion({ pride: 0.7, love: 0.3 });
          esteban.look(c.camera, 0.7);
          keyOn(c, esteban);
          c.cam.cut({
            subject: esteban, frame: 'mcu', lens: 85, angle: -30, height: 'low', dur: 4.2,
            move: { type: 'push', amount: 0.22, dur: 4.2 }, handheld: 0.35, aperture: 1.8,
          });
          c.titles.show('ESTEBAN', { sub: 'el galán', kind: 'cast', dur: 3.4, fadeIn: 0.7 });
          c.score.say('vo-name-esteban', 0.25);
        }],
        [8.6, () => esteban.gesture('strutPose')],

        [11.2, (c) => {
          valentina.setVisible(true).setEmotion({ anger: 0.7, pride: 0.6 });
          valentina.look(c.camera, 0.9);
          keyOn(c, valentina);
          c.cam.cut({
            subject: valentina, frame: 'mcu', lens: 100, angle: 28, dur: 4.2,
            move: { type: 'creep', amount: 0.6 }, handheld: 0.4, aperture: 2,
          });
          c.titles.show('VALENTINA', { sub: 'la villana', kind: 'cast', dur: 3.4, fadeIn: 0.7 });
          c.score.say('vo-name-valentina', 0.25);
        }],
        [12.3, () => valentina.gesture('scheme')],

        [14.8, (c) => {
          donGallo.setVisible(true).setEmotion({ pride: 1, anger: 0.4 });
          donGallo.look(c.camera, 0.7);
          keyOn(c, donGallo);
          c.cam.cut({
            subject: donGallo, frame: 'mcu', lens: 85, angle: -24, height: 'low', dur: 4.2,
            handheld: 0.35, aperture: 2, dutch: -3,
          });
          c.titles.show('DON GALLO', { sub: 'el patrón', kind: 'cast', dur: 3.4, fadeIn: 0.7 });
          c.score.say('vo-name-dongallo', 0.25);
        }],
        [15.9, () => donGallo.gesture('crow')],

        [18.4, (c) => {
          ricardo.setVisible(true).setEmotion({ pride: 0.9, anger: 0.5 });
          ricardo.look(c.camera, 0.9);
          keyOn(c, ricardo);
          c.cam.cut({
            subject: ricardo, frame: 'cu', lens: 100, angle: -26, dur: 4.2,
            move: { type: 'push', amount: 0.25, dur: 4.2 }, handheld: 0.45, aperture: 2, dutch: 5,
          });
          c.titles.show('RICARDO', { sub: 'el gemelo', kind: 'cast', dur: 3.4, fadeIn: 0.7 });
          c.score.say('vo-name-ricardo', 0.25);
        }],
        [19.5, () => ricardo.gesture('laugh')],

        // The chorus. Everyone in one frame, and the title over the top.
        [21.6, (c) => {
          c.cam.cut({
            subject: V(-0.2, 0.6, -1.1), view: 4.2, lens: 32, angle: 182, height: 1.9,
            move: { type: 'crane', amount: 0.45, dur: 9 }, dur: 9, handheld: 0.3, smooth: 2.4,
            label: 'THE COMPANY · 32mm',
          });
          for (const a of [rosalinda, esteban, valentina, donGallo, ricardo]) a.setVisible(true);
          c.set.key.target.position.set(-0.2, 0.45, -1.1);
          c.set.key.intensity = 7.5;
          c.post.setLook({ diffusion: 0.72, bloom: 0.9, halation: 0.62, exposure: 1.75 });
        }],
        [22.2, (c) => {
          c.titles.show('CORAZÓN DE GALLINA', {
            sub: 'una telenovela de corral', kind: 'main', dur: 6.6, rule: true, fadeIn: 1.6,
          });
          c.score.say('vo-title', 0.6);
        }],
        [23.0, () => { rosalinda.look(esteban, 1); esteban.look(rosalinda, 1); valentina.look(esteban, 1); }],
        [24.4, () => ricardo.gesture('scheme')],
        [28.6, (c) => c.post.setLook({ fade: 1 })],
      ],
      // Cut to the song, not to the director's tempo.
      { pace: 1.0 }),

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
        // The secret is on screen from the first shot, covered. The genre's
        // contract is that we see it before the villainess does.
        c.props.cloth.visible = true;
        c.props.cloth.position.set(-0.55, 0.13, -1.15);
        c.props.cloth.rotation.set(-Math.PI / 2, 0, 0);
        c.cam.cut({
          subject: rosalinda, view: 3.4, lens: 20, angle: 196, height: 1.25,
          move: { type: 'descend', amount: 0.45, dur: 17 }, dur: 18, handheld: 0.3, smooth: 1.6,
          label: 'ESTABLISHING · 20mm',
        });
      },
      [
        [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('theme', 4); c.score.setAmbience(1); }],
        [2.0, (c) => {
          c.titles.show('CAPÍTULO FINAL', { kind: 'act', dur: 4.5 });
          c.score.say('vo-capitulo', 0.3);
        }],
        [6.5, (c) => { rosalinda.gesture('sigh'); c.score.cluck(); }],
        [11.0, (c) => c.cam.move({
          subject: rosalinda, frame: 'mls', lens: 40, angle: 150, height: 'eye',
          move: { type: 'creep', amount: 1 }, dur: 8, smooth: 2.6, handheld: 0.5,
        })],
        [14.5, (c) => { rosalinda.gesture('sob', { weight: 0.45, scale: 0.9 }); rosalinda.look(c.props.cloth.position, 1); }],
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
          c.score.play('sfx-gate-creak', { gain: 0.65 });
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
        // Valentina is on screen the whole scene, unlit and behind them, so the
        // rack focus at 34.5 finds someone the audience had half-noticed rather
        // than conjuring a stranger out of the dark.
        valentina.setVisible(true).place(2.55, -0.05, deg(-91)).setEmotion({ anger: 0.35 });
        valentina.lookAway();
        c.props.cloth.visible = true;
        c.props.cloth.position.set(-0.55, 0.13, -1.15);
        c.props.cloth.rotation.set(-Math.PI / 2, 0, 0);
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
        [8.8, (c) => esteban.gesture('crow', { onBeat: () => c.score.crow() })],
        // Her reaction — shot/reverse-shot begins.
        [9.0, (c) => {
          c.cam.cut({ subject: rosalinda, frame: 'cu', lens: 85, angle: -12, dur: 6, handheld: 0.55, aperture: 1.6 });
          rosalinda.emote({ love: 0.85, sorrow: 0.1 }, 2.2);
          rosalinda.look(esteban, 1);
        }],
        [10.4, () => rosalinda.gesture('gasp', { weight: 0.55 })],
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
          valentina.emote({ anger: 0.8, love: 0.4 }, 2);
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
        [43.0, (c) => { valentina.gesture('cock', { side: -1, weight: 0.6 }); valentina.look(c.props.cloth.position, 1); }],
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
          c.score.play('sfx-cloth-whip', { gain: 0.95 });
          c.score.play('sfx-hen-gasp', { gain: 0.5 });
          c.cam.shake(0.7);
        }],
        [15.9, (c) => c.cam.cut({
          subject: c.props.egg, view: 0.2, lens: 100, angle: 24, height: 0.12, dur: 6,
          move: { type: 'snapZoom', amount: 1, dur: 1.4 }, handheld: 0.5, aperture: 2,
          label: 'CRASH ZOOM · 100mm',
        })],
        [17.5, (c) => { c.score.heartbeat(1); }],
        [18.5, (c) => { c.score.heartbeat(1); }],
        // Three reactions, each closer than the last.
        [19.5, (c) => {
          stingCut(c, {
            subject: rosalinda, frame: 'cu', lens: 85, angle: -20, dur: 3, handheld: 0.9,
            move: { type: 'snapZoom', amount: 0.8, dur: 1 }, aperture: 2,
          }, 'small');
          rosalinda.look(c.props.egg, 1);
          rosalinda.face(c.props.egg.position);
          rosalinda.gesture('gasp');
          rosalinda.emote({ fear: 0.8, sorrow: 0.5, love: 0 }, 4);
        }],
        [21.5, (c) => {
          stingCut(c, {
            subject: esteban, frame: 'bcu', lens: 100, angle: 16, dur: 3, handheld: 0.9,
            move: { type: 'snapZoom', amount: 0.9, dur: 1 }, aperture: 2.2,
          }, 'small');
          esteban.look(c.props.egg, 1);
          esteban.face(c.props.egg.position);
          esteban.gesture('doubleTake');
          esteban.emote({ shock: 1, anger: 0.5, fear: 0.2, love: 0 }, 4);
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
        [29.5, (c) => { donGallo.gesture('crow', { onBeat: () => c.score.crow() }); donGallo.emote({ anger: 0.9, pride: 1 }, 2); }],
        [31.8, (c) => c.weather.strike(0.9)],
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
      ], { pace: 1.15 }),

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
        [8.5, (c) => {
          c.cam.cut({
            subject: rosalinda, over: esteban, frame: 'mcu', lens: 85, angle: 24, dur: 5, handheld: 0.6,
            label: 'OVER SHOULDER · 85mm',
          });
          esteban.gesture('spurn', { weight: 0.5 });
          esteban.look(valentina, 0.8);
        }],
        [10.5, () => rosalinda.gesture('shudder')],
        // The slap. Time slows on the wind-up.
        [12.0, (c) => {
          c.cam.cut({
            subject: rosalinda, frame: 'ms', lens: 50, angle: 70, height: 0.42, dur: 7,
            handheld: 0.5, dutch: -4, label: 'THE SLAP · 50mm',
          });
        }],
        [12.1, (c, d) => d.setSpeed(0.22)],
        [12.6, (c, d) => {
          rosalinda.slapSide = 1;
          c.score.flap();
          rosalinda.gesture('slap', {
            side: 1,
            // Impact: freeze one frame, flash, shake, and cut on the sound.
            onBeat: () => {
              esteban.slapFrom = 1;
              esteban.gesture('slapped');
              c.score.slap();
              c.cam.shake(1.4, 2.6);
              c.post.snapLook({ flash: 0.5, whipDir: 0 });
              c.post.setLook({ flash: 0 });
              d.freeze(0.42);
              c.weather.strike(0.8);
              c.score.thunder(0.8, 0.05);
            },
          });
        }],
        [13.45, (c) => c.cam.cut({
          subject: esteban, frame: 'bcu', lens: 100, angle: -34, dur: 5, handheld: 1, dutch: 12,
          aperture: 2.2, label: 'IMPACT · 100mm',
        })],
        [15.6, (c, d) => d.setSpeed(1)],
        [16.5, (c) => { c.score.sting('shock'); }],
        // She is looking straight at him, so every front-on angle on her looks
        // through him — he sat 10cm in front of her on the camera's ray and
        // defocused into a dark blur across the whole frame. Framing it as an
        // over-shoulder puts him in the corner where he belongs instead.
        [17.0, (c) => c.cam.cut({
          subject: rosalinda, over: esteban, frame: 'cu', lens: 85, angle: 30, dur: 6,
          handheld: 0.8, aperture: 1.8, label: 'OVER SHOULDER · 85mm',
        })],
        [17.2, () => { rosalinda.emote({ sorrow: 1, anger: 0.2 }, 1.6); rosalinda.gesture('sob'); }],
        [20.0, () => { rosalinda.gesture('spurn'); rosalinda.face(deg(-20)); rosalinda.lookAway(); }],
        [21.0, (c) => c.cam.cut({
          subject: esteban, frame: 'mcu', lens: 85, angle: -8, dur: 6, handheld: 0.7, dutch: -5,
        })],
        [21.5, () => { esteban.look(valentina, 1); esteban.face(valentina.pos); esteban.emote({ sorrow: 1, anger: 0.4 }, 2); }],
        // The wing points past Rosalinda, at the villainess. This is the plant.
        [23.5, () => esteban.gesture('accuse', { side: -1, weight: 0.7 })],
        [18.0, () => { donGallo.look(rosalinda, 1); donGallo.gesture('strutPose'); }],
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
        [33.6, (c) => { c.weather.strike(1); c.score.thunder(1, 0.2); }],
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
            subject: V(-0.9, 0.5, -1.2), view: 4.6, lens: 28, angle: 8, height: 0.55, dur: 7,
            handheld: 0.7, dutch: -7, label: 'THE STRANGER · 28mm',
          });
          c.score.play('sfx-footsteps-mud', { gain: 0.5 });
          c.score.setMood('suspense', 2);
        }],
        [4.0, (c) => { c.weather.strike(1.3); c.score.thunder(1.2, 0.1); }],
        [6.0, (c) => { c.score.sting('rise'); c.cam.shake(0.4); }],
        // Every head turns, one after another.
        [7.0, (c) => {
          c.cam.cut({ subject: esteban, frame: 'cu', lens: 100, angle: -14, dur: 3, whip: true, handheld: 0.9, dutch: 8 });
          esteban.look(ricardo, 1); esteban.gesture('doubleTake'); esteban.emote({ shock: 1, anger: 0.4 }, 6);
        }],
        [9.0, (c) => {
          c.cam.cut({ subject: rosalinda, frame: 'cu', lens: 100, angle: 8, dur: 3, whip: true, handheld: 0.9, dutch: -8 });
          rosalinda.look(ricardo, 1); rosalinda.gesture('gasp'); rosalinda.emote({ shock: 1, fear: 0.6, sorrow: 0.4 }, 6);
        }],
        [11.0, (c) => {
          c.cam.cut({ subject: donGallo, frame: 'cu', lens: 100, angle: -6, dur: 3, whip: true, handheld: 0.9, dutch: 10 });
          donGallo.look(ricardo, 1); donGallo.gesture('doubleTake'); donGallo.emote({ shock: 1, anger: 0.8 }, 6);
        }],
        [13.0, (c) => {
          stingCut(c, {
            subject: ricardo, frame: 'cu', lens: 135, angle: -12, look: 'head', dur: 5,
            move: { type: 'snapZoom', amount: 1, dur: 1.3 }, handheld: 0.9, dutch: -12, aperture: 2.4,
            label: 'THE TWIN · 135mm',
          }, 'reveal');
          ricardo.gesture('scheme');
          c.score.play('sfx-hen-gasp', { gain: 0.5 });
        }],
        [16.0, (c) => { c.score.sting('reveal'); c.cam.shake(0.6); }],
        // The vertigo shot: she understands.
        [17.5, (c) => {
          c.cam.cut({
            subject: rosalinda, frame: 'mcu', lens: 40, angle: 12, dur: 9,
            move: { type: 'dollyZoom', amount: 1, dur: 6 }, handheld: 0.4, aperture: 1.4,
            label: 'DOLLY ZOOM · 40→100mm',
          });
          c.score.play('sfx-organ-hold', { gain: 0.55 });
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
          ricardo.walkTo(-0.15, -0.9, { style: 'storm', face: esteban.pos });
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
        [41.9, (c) => {
          c.score.sting('reveal');
          c.cam.shake(0.5);
          // The shared glance that makes them the egg's authors.
          valentina.look(c.props.egg, 1);
          ricardo.look(c.props.egg, 1);
        }],
        [42.0, (c) => {
          c.cam.cut({ subject: rosalinda, frame: 'cu', lens: 100, angle: 16, dur: 6, whip: true, handheld: 0.9 });
          rosalinda.look(valentina, 1);
          rosalinda.gesture('gasp');
          rosalinda.emote({ shock: 1, sorrow: 1 }, 3);
        }],
        [45.0, (c) => { c.weather.strike(1.4); c.score.thunder(1.3, 0.1); }],
        [46.0, (c) => c.post.setLook({ fade: 1 })],
      ], { pace: 1.15 }),

    // =======================================================================
    scene('CONTINUARÁ', 'el desmayo y el secreto', 40.6,
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
        [5.6, (c) => { c.score.sting('shock'); }],
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
        [4.9, () => { esteban.gesture('catcher'); esteban.look(rosalinda, 1); esteban.emote({ sorrow: 1, fear: 0.6 }, 2); }],
        [6.4, (c) => { c.cam.shake(0.35); c.score.sting('small'); }],
        [8.0, (c) => c.cam.cut({
          subject: rosalinda, frame: 'cu', lens: 100, angle: 40, height: 0.24, dur: 7,
          move: { type: 'creep', amount: 1 }, handheld: 0.6, aperture: 2, label: 'CLOSE · 100mm',
        })],
        [14.2, (c) => { c.weather.strike(1.2); c.score.thunder(1.1, 0.15); }],
        // The villains, silhouetted by the lightning.
        [12.0, (c) => {
          c.cam.cut({
            subject: valentina, frame: 'mls', lens: 35, angle: 20, height: 0.36, dur: 8,
            handheld: 0.7, dutch: 9, label: 'SILHOUETTE · 35mm',
          });
          valentina.gesture('laugh');
          ricardo.gesture('laugh', { delay: 0.4 });
        }],
        [14.8, (c) => { c.weather.strike(1.4); c.score.thunder(1.3, 0.05); c.score.sting('shock'); }],
        [18.6, (c) => {
          c.cam.cut({
            subject: donGallo, frame: 'cu', lens: 85, angle: -8, height: 'low', dur: 5,
            handheld: 0.8, dutch: -10,
          });
          donGallo.look(ricardo, 1);
          donGallo.gesture('strutPose');
        }],
        // Everyone forgets the egg. The camera does not.
        [20.0, (c) => {
          c.cam.cut({
            subject: c.props.egg, view: 0.55, lens: 50, angle: 30, height: 0.16, dur: 8,
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
          subject: c.props.egg, view: 0.2, lens: 100, angle: 22, height: 0.11, dur: 9,
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
        [36.5, () => pollito.gesture('cock', { side: -1, weight: 0.5 })],
        [38.5, (c) => {
          // Freeze frame, hold, and roll the card.
          c.post.setLook({ freeze: 1, grain: 0.11, contrast: 1.2, saturation: 0.8, vignette: 0.62 });
          c.cam.shake(0.2);
          c.score.sting('shock');
        }],
        [38.6, (c, d) => d.setSpeed(0.06)],
        [39.0, (c) => { c.titles.show('CONTINUARÁ…', { kind: 'end', dur: 12, fadeIn: 1.2, rule: true }); c.score.say('vo-continuara', 0.6); }],
        [39.0, (c) => { c.score.setMood('theme', 2); }],
        [39.5, (c) => { c.post.setLook({ fade: 1 }); }],
        [48.0, (c, d) => { d.setSpeed(1); c.post.setLook({ freeze: 0 }); }],
      ]),

    // =======================================================================
    // The curtain call. The cast line up downstage, take a bow each as their
    // name comes up, and then the crew gets its due.
    scene('CRÉDITOS', 'el reparto y los culpables', 60,
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
        // Spaced to the announcer's measured lengths, with the English under
        // him — the credits are in Spanish like everything else he says, and
        // the joke does not survive being untranslated.
        [23.4, (c) => {
          c.score.say('vo-credits-1');
          c.titles.show('CLAUDE OPUS 5', {
            kicker: 'dirección · guion · fotografía · vestuario · y todas las plumas',
            kind: 'credit', dur: 8.5, fadeIn: 1,
          });
          c.titles.subtitle('Directed, written, shot, costumed, and every last feather.', 8.3, { narration: true });
        }],
        [32.6, (c) => {
          c.score.say('vo-credits-2');
          c.titles.show('THREE.JS', {
            kicker: 'escenografía construida a mano, polígono por polígono',
            kind: 'credit', dur: 5.8, fadeIn: 0.9,
          });
          c.titles.subtitle('Sets built by hand, polygon by polygon.', 5.6, { narration: true });
        }],
        [39.1, (c) => {
          c.score.say('vo-credits-3');
          c.titles.show('ELEVENLABS', {
            kicker: 'música original · truenos · y todos los suspiros',
            kind: 'credit', dur: 5.4, fadeIn: 0.9,
          });
          c.titles.subtitle('Original music, thunder, and every sigh.', 5.2, { narration: true });
        }],
        [45.2, (c) => {
          c.score.say('vo-credits-4');
          c.titles.show('BRIAN GRUBER', {
            kicker: 'escribió unos cuantos prompts',
            kind: 'credit', dur: 3.3, fadeIn: 0.9,
          });
          c.titles.subtitle('Wrote a few prompts.', 3.1, { narration: true });
        }],
        [49.1, (c) => {
          c.score.say('vo-credits-5');
          c.titles.show('NINGUNA GALLINA RESULTÓ HERIDA', {
            sub: 'varias resultaron traicionadas',
            kind: 'act', dur: 6.0, fadeIn: 0.8,
          });
          c.titles.subtitle('No chicken was harmed in this production. Several were betrayed.', 5.8, { narration: true });
        }],
        // The last sound of the episode.
        [56.2, (c) => c.score.crow()],
        [57.6, (c) => c.post.setLook({ fade: 1 })],
      ],
      // The credits run to the announcer's clock, not the director's.
      { pace: 1.0 }),
  ];
}
