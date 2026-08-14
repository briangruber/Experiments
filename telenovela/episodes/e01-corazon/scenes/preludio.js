// The hacienda at midnight. Rosalinda alone at the fountain with her covered
// secret; something at the gate.

export const meta = {
  id: 'preludio',
  name: 'PRELUDIO',
  subtitle: 'la hacienda, medianoche',
  dur: 32,
  // Scene-seconds worth screenshotting: the establishing descent, the close-up,
  // and the turn toward the gate.
  beats: [3, 20, 27],
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
      c.cam.cut({
        subject: rosalinda, view: 3.4, lens: 20, angle: 196, height: 1.25,
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
    ],
  };
}
