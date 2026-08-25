// The opening titles. Cut to the song rather than to the director's pace,
// which is why this scene runs at 1: the chorus lands at about 21s and the
// main card goes up on it.

export const meta = {
  id: 'entrada',
  name: 'ENTRADA',
  subtitle: 'corazón de gallina',
  dur: 31,
  // Cut to the song, not to the director's tempo.
  pace: 1.0,
  // Scene-seconds worth screenshotting: a cast portrait apiece, then the
  // company under the main card.
  beats: [5, 12, 19, 24],
};

export function build(deps) {
  const { actors, V, MOON, hideAll, baseLook, keyOn, marks, deg } = deps;
  const { rosalinda, esteban, valentina, donGallo, ricardo } = actors;
  const { BY_FOUNTAIN } = marks;
  return {
    setup(c) {
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
      // Forward of the old mark: at (-0.35,-1.35) a foreground jug blocked her
      // chest and a defocused blob ate the right third of her portrait.
      valentina.setVisible(false).place(-0.15, -0.95, deg(155));
      donGallo.setVisible(false).place(0.35, -2.15, deg(172));
      ricardo.setVisible(false).place(-1.55, -1.85, deg(120));
      c.cam.cut({
        subject: V(-0.2, 0.7, -1.2), view: 5.2, lens: 24, angle: 172, height: 2.1,
        move: { type: 'descend', amount: 0.5, dur: 8 }, dur: 8, handheld: 0.25, smooth: 2.2,
        label: 'TITLES · 24mm',
      });
    },
    cues: [
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
        // The villana's motif: her key is icy where the lovers' is warm, and
        // hot enough that a dark-navy bird finally reads against the night.
        keyOn(c, valentina, 11);
        c.set.key.color.setHex(0xb9c6ff);
        // Shot from the clear side — angle 28 put a jug and a branch in front
        // of her face.
        c.cam.cut({
          subject: valentina, frame: 'mcu', lens: 100, angle: -24, dur: 4.2,
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

      // The chorus. Everyone in one frame, and the title over the top. The old
      // tableau hid the company: tiny, dark, half-occluded behind the fountain
      // under a camera at 1.9m. Re-placed in an arc on the camera side of the
      // fountain, lower and closer, warm key up — cast AND title both read.
      [21.6, (c) => {
        // Facing downstage into the key (which lives on the +z side) — faced
        // the other way they took the title bow as five silhouettes.
        rosalinda.place(-0.5, -0.3, deg(10)); rosalinda.look(c.camera, 0.8);
        esteban.place(-0.05, -0.5, deg(4)); esteban.look(c.camera, 0.8);
        valentina.place(0.45, -0.55, deg(0)); valentina.look(c.camera, 0.9);
        donGallo.place(0.95, -0.45, deg(-4)); donGallo.look(c.camera, 0.8);
        ricardo.place(1.4, -0.25, deg(-10)); ricardo.look(c.camera, 0.9);
        for (const a of [rosalinda, esteban, valentina, donGallo, ricardo]) a.setVisible(true);
        c.cam.cut({
          subject: V(0.45, 0.5, -0.4), view: 3.4, lens: 32, angle: 4, height: 1.1,
          move: { type: 'crane', amount: 0.45, dur: 9 }, dur: 9, handheld: 0.3, smooth: 2.4,
          label: 'THE COMPANY · 32mm',
        });
        c.set.key.target.position.set(0.45, 0.45, -0.4);
        c.set.key.intensity = 10;
        c.set.key.color.setHex(0xffd9a8);
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
  };
}
