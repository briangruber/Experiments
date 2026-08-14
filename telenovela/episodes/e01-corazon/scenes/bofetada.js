// The misunderstanding, the slap in slow motion, and the plant for the twist:
// his wing points past Rosalinda, at the villainess.

export const meta = {
  id: 'bofetada',
  name: 'LA BOFETADA',
  subtitle: 'lo que se dice sin hablar',
  dur: 38,
  // Scene-seconds worth screenshotting: the confrontation, the slap itself
  // (slow motion is already on at 14.2), the sob, the laughing villainess.
  beats: [5, 14.2, 18, 27],
};

export function build(deps) {
  const { actors, hideAll, baseLook, deg } = deps;
  const { rosalinda, esteban, valentina, donGallo } = actors;
  return {
    setup(c) {
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
    cues: [
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
    ],
  };
}
