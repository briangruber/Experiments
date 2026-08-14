// He returns, backlit in the archway; the almost-kiss; and behind them, in
// the dark, the villainess is watching.

export const meta = {
  id: 'encuentro',
  name: 'EL ENCUENTRO',
  subtitle: 'lo que el corazón no calla',
  dur: 52,
  // Scene-seconds worth screenshotting: the arrival, the low angle, the
  // two-shot, the almost-kiss, the crash zoom onto Valentina.
  beats: [3, 6, 14, 26, 39],
};

export function build(deps) {
  const { actors, V, hideAll, baseLook, keyOn, stingCut, marks, deg } = deps;
  const { rosalinda, esteban, valentina } = actors;
  const { HER_MARK, HIS_MARK, ARCH_IN, OFF_CENTRE } = marks;
  return {
    setup(c) {
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
    cues: [
      // The doorway practical flares so he actually enters backlit — a
      // silhouette against amber that resolves into a face on the strut pose.
      // The boost is restored below at 5.0, inside this same scene, so it
      // cannot leak into anyone else's lighting.
      [0.0, (c) => { c.score.setMood('romance', 3); c.score.setAmbience(1); c.set.doorway.intensity = 18; }],
      // Preludio ended on the gate creak; hearing it again stitches the cut.
      [0.2, (c) => c.score.play('sfx-gate-creak', { gain: 0.3 })],
      [0.8, (c) => {
        esteban.walkTo(ARCH_IN.x, ARCH_IN.z, { style: 'strut', speed: 0.52 });
        c.score.play('sfx-footsteps-mud', { gain: 0.4 });
      }],
      [2.0, (c) => c.score.sting('small')],
      [4.8, (c) => { esteban.gesture('strutPose'); esteban.look(rosalinda, 1); c.score.flap(); }],
      [5.0, (c) => {
        c.set.doorway.intensity = 10;
        c.cam.cut({
          subject: esteban, frame: 'ms', lens: 50, angle: 8, height: 'low',
          move: { type: 'push', amount: 0.35, dur: 7 }, dur: 7, handheld: 0.5, label: 'LOW ANGLE · 50mm',
        });
      }],
      [8.8, (c) => esteban.gesture('crow', { onBeat: () => c.score.crow() })],
      // Her reaction — shot/reverse-shot begins.
      // Angle -30 rather than -12: puts a lantern in the defocused background
      // so her close-up floats against warm bokeh rather than void. She melts
      // only halfway here — a year of silence buys him a reproach first.
      [9.0, (c) => {
        c.cam.cut({ subject: rosalinda, frame: 'cu', lens: 85, angle: -30, dur: 6, handheld: 0.55, aperture: 1.6 });
        rosalinda.emote({ love: 0.5, sorrow: 0.3 }, 2.2);
        rosalinda.look(esteban, 1);
      }],
      [10.4, () => rosalinda.gesture('gasp', { weight: 0.55 })],
      [12.0, (c) => { c.score.harpRun(true); }],
      // The reproach beat: she turns her back on him, so the melt at 14.6 is
      // earned and his walk to her at 15.5 has a reason.
      [12.2, () => { rosalinda.gesture('spurn', { weight: 0.7 }); rosalinda.lookAway(); }],
      [13.0, (c) => c.cam.cut({
        subject: esteban, frame: 'cu', lens: 85, angle: -8, dur: 6, handheld: 0.55, aperture: 1.6,
        label: 'REVERSE · 85mm',
      })],
      [13.2, () => esteban.emote({ love: 0.7, pride: 0.4 }, 2)],
      [14.6, () => { rosalinda.release('spurn'); rosalinda.look(esteban, 1); rosalinda.emote({ love: 1 }, 1.5); }],
      [15.5, () => esteban.walkTo(HIS_MARK.x, HIS_MARK.z, { style: 'strut', face: rosalinda.pos })],
      [16.0, (c) => c.cam.cut({
        subject: esteban, frame: 'mls', lens: 40, angle: 62, height: 0.42, dur: 9,
        move: { type: 'orbit', amount: 0.7, dur: 9 }, handheld: 0.45, label: 'TWO SHOT · 40mm',
      })],
      [19.5, () => { esteban.look(rosalinda, 1); rosalinda.face(esteban.pos); }],
      // To (0.3,-0.12), not (-0.15,-0.1): the old mark left the almost-kiss a
      // full body-length apart, and the orbit two-shot showed them nuzzling
      // air. This closes the beaks to about 0.2.
      [21.0, () => rosalinda.walkTo(0.3, -0.12, { style: 'shuffle', face: esteban.pos })],
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
      // The vow gets its reverse: his proposal played on the back of his head.
      [26.0, (c) => {
        c.cam.cut({
          subject: esteban, over: rosalinda, frame: 'mcu', lens: 100, angle: -26, dur: 4,
          handheld: 0.4, aperture: 1.8, label: 'REVERSE · 100mm',
        });
        esteban.gesture('nuzzle'); esteban.emote({ love: 1, pride: 0.2 }, 1.5);
      }],
      // Back to her for the answer — dlg-1c2, her button on the blessing.
      [29.4, (c) => c.cam.cut({
        subject: rosalinda, over: esteban, frame: 'mcu', lens: 100, angle: 26, dur: 3,
        handheld: 0.4, aperture: 1.8,
      })],
      [30.0, (c) => { c.score.setMood('romance', 2); c.score.harpRun(true); }],
      // And behind them, in the dark, someone is watching. The first distant
      // thunder seeds the storm here, at the suspense turn, so revelacion's
      // opening rain is an arrival rather than a continuity jump.
      [32.0, (c) => {
        valentina.emote({ anger: 0.8, love: 0.4 }, 2);
        valentina.look(esteban, 0.9);
        c.weather.setRain(0.08);
        c.score.setRain(0.08);
        c.score.thunder(0.3, 0.6);
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
      // Her reveal, finally lit: the cold key is the villana's motif (icy
      // against the lovers' warm), and the lightning does the introduction.
      // Without it this crash zoom landed on a near-black frame.
      [38.0, (c) => {
        // 20, not the helper's default: she hides a good 3m past where the
        // key's falloff is calibrated for, in near-black plumage.
        keyOn(c, valentina, 20);
        c.set.key.color.setHex(0xb9c6ff);
        c.weather.strike(0.6);
        stingCut(c, {
          subject: valentina, frame: 'bcu', lens: 135, angle: -18, look: 'eye', dur: 6,
          move: { type: 'snapZoom', amount: 1, dur: 1.6 }, handheld: 0.8, aperture: 2.4,
          label: 'CRASH ZOOM · 135mm',
        }, 'shock');
      }],
      [38.1, () => valentina.emote({ anger: 1 }, 4)],
      [41.0, (c) => c.cam.cut({
        subject: valentina, frame: 'ecu', lens: 135, angle: -22, look: 'eye', dur: 5,
        handheld: 0.9, aperture: 2.6, label: 'EXTREME CLOSE-UP · 135mm',
      })],
      [43.0, (c) => {
        valentina.gesture('cock', { side: -1, weight: 0.6 });
        valentina.look(c.props.cloth.position, 1);
        c.weather.setRain(0.15);
        c.score.setRain(0.15);
      }],
      // "…aquí" points at something now: her POV of the covered secret carries
      // the end of dlg-1f into the fade — dramatic irony, and the plant for
      // the reveal scene.
      // Same framing as preludio's insert of it — her POV rhymes with
      // Rosalinda's, which is the point.
      [46.6, (c) => c.cam.cut({
        subject: c.props.cloth, frame: 'ms', lens: 65, view: 0.55, height: 0.18, angle: 40,
        dur: 2.4, aperture: 2, handheld: 0.4, label: 'HER POV · 65mm',
      })],
      [48.5, (c) => c.post.setLook({ fade: 1 })],
    ],
  };
}
