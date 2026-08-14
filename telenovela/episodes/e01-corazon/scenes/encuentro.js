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
  const { actors, V, hideAll, baseLook, stingCut, marks, deg } = deps;
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
    ],
  };
}
