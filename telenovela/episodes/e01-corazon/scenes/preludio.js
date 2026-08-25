// The hacienda at midnight. Rosalinda alone at the fountain with her covered
// secret; something at the gate.

export const meta = {
  id: 'preludio',
  name: 'PRELUDIO',
  subtitle: 'la hacienda, medianoche',
  dur: 32,
  // Scene-seconds worth screenshotting: the establishing descent, the moon,
  // the close-up, and the turn toward the gate.
  beats: [3, 9, 20, 27],
};

export function build(deps) {
  const { actors, V, MOON, hideAll, baseLook, marks, deg } = deps;
  const { rosalinda } = actors;
  const { BY_FOUNTAIN } = marks;
  return {
    setup(c) {
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
      // Angle 215 rather than 196, aimed a touch left: the lit arches fill
      // frame-left instead of dead black floor, and the descent path crosses
      // the red cloth — the episode's pivot foreshadowed for free.
      c.cam.cut({
        subject: rosalinda, view: 3.4, lens: 20, angle: 215, height: 1.25,
        aimOffset: V(-0.3, 0.1, -0.35),
        move: { type: 'descend', amount: 0.45, dur: 17 }, dur: 18, handheld: 0.3, smooth: 1.6,
        label: 'ESTABLISHING · 20mm',
      });
    },
    cues: [
      [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('theme', 4); c.score.setAmbience(1); }],
      [2.0, (c) => {
        c.titles.show('CAPÍTULO FINAL', { kind: 'act', dur: 4.5 });
        c.score.say('vo-capitulo', 0.3);
      }],
      [6.5, (c) => { rosalinda.gesture('sigh'); c.score.cluck(); }],
      // Stage the waiting instead of standing it: she drifts toward the gate
      // under the narration that says she waits there every night.
      [7.5, (c) => rosalinda.walkTo(-0.3, -1.9, { style: 'shuffle', face: V(0, 0.4, -3.2) })],
      // The moon, at last, where every "gazing at the moon" eyeline points.
      // Wide enough that the 16-unit halo is a glow IN the sky rather than a
      // wall of it, and off-center so the clouds have somewhere to drift.
      [8.0, (c) => c.cam.cut({
        subject: MOON, view: 34, lens: 32, aimOffset: V(-5, -4, 0), dur: 3.5,
        handheld: 0.2, smooth: 1.4, label: 'LA LUNA · 32mm',
      })],
      [11.0, (c) => c.cam.move({
        subject: rosalinda, frame: 'mls', lens: 40, angle: 150, height: 'eye',
        move: { type: 'creep', amount: 1 }, dur: 8, smooth: 2.6, handheld: 0.5,
      })],
      // He never comes; she turns back to the one thing that is hers.
      [15.0, (c) => rosalinda.walkTo(-0.6, -0.55, { style: 'shuffle', face: V(-0.55, 0, -1.15) })],
      // Her POV of the covered secret, planted between the narrator's lines.
      [16.5, (c) => c.cam.cut({
        subject: c.props.cloth, frame: 'ms', lens: 65, view: 0.55, height: 0.18, angle: 40,
        dur: 2.5, handheld: 0.4, label: 'EL SECRETO · 65mm',
      })],
      [17.6, (c) => { rosalinda.gesture('sob', { weight: 0.45, scale: 0.9 }); rosalinda.look(c.props.cloth.position, 1); }],
      // Angle 45 rather than 28 so a lantern sits defocused behind her instead
      // of dead black wall.
      [19.0, (c) => {
        c.cam.cut({
          subject: rosalinda, frame: 'cu', lens: 85, angle: 45, look: 'head',
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
    ],
  };
}
