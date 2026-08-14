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
  const { actors, hideAll, baseLook, keyOn, deg } = deps;
  const { rosalinda, esteban, valentina, donGallo } = actors;
  return {
    setup(c) {
      hideAll(c);
      // Exposure 1.6, not 1.8: the wet floor plus the key was clipping the
      // close-up backgrounds to pure white.
      baseLook(c, { fade: 1, exposure: 1.6, vignette: 0.5, contrast: 1.12, saturation: 0.95 });
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
      // Over-the-shoulder from the start: she storms TO him, so a plain mcu
      // solve ended buried between the two bodies in a macro collision.
      [2.0, (c) => c.cam.move({
        subject: rosalinda, over: esteban, frame: 'mcu', lens: 65, angle: 26, dur: 6,
        handheld: 0.9, smooth: 0.3,
      })],
      [4.5, () => { rosalinda.gesture('accuse', { side: 1 }); rosalinda.emote({ anger: 1, sorrow: 0.8 }, 2); }],
      [6.5, (c) => {
        c.cam.cut({ subject: esteban, frame: 'mcu', lens: 65, angle: -18, dur: 4, whip: true, handheld: 0.8 });
        esteban.gesture('recoil');
        esteban.emote({ sorrow: 0.9, fear: 0.5 }, 2);
      }],
      // dlg-3c is HIS line and his glance toward Valentina is the plant for
      // the twist — the OTS favors him now instead of the back of his head.
      [8.5, (c) => {
        c.cam.cut({
          subject: esteban, over: rosalinda, frame: 'mcu', lens: 85, angle: -24, dur: 5, handheld: 0.6,
          label: 'OVER SHOULDER · 85mm',
        });
        esteban.gesture('spurn', { weight: 0.5 });
        esteban.look(valentina, 0.8);
      }],
      // A breath of Valentina feigning innocence — the cutaway his glance
      // asks for, and the setup for her lit close-up at 26.3. Her cold key
      // comes up for it and is put back before the slap shot.
      [10.4, (c) => {
        keyOn(c, valentina, 10);
        c.set.key.color.setHex(0xb9c6ff);
        c.cam.cut({ subject: valentina, frame: 'cu', lens: 100, angle: -14, dur: 1.6, handheld: 0.6, aperture: 2 });
        valentina.gesture('cock', { side: -1, weight: 0.4 });
        valentina.emote({ pride: 0.9, anger: 0.2 }, 1.5);
      }],
      [10.5, () => rosalinda.gesture('shudder')],
      // The slap. Time slows on the wind-up. Over Esteban's shoulder with the
      // camera on her slapping side — his body used to occupy center frame
      // and hide the entire wind-up.
      [12.0, (c) => {
        c.set.key.target.position.copy(c.set.keyDefault);
        c.set.key.intensity = 4.0;
        c.set.key.color.setHex(c.set.keyColorDefault);
        c.cam.cut({
          subject: rosalinda, over: esteban, frame: 'ms', lens: 50, angle: 35, height: 0.42, dur: 7,
          handheld: 0.5, dutch: -4, label: 'THE SLAP · 50mm',
        });
      }],
      // The slap lands on rain and thunder alone — the tragedy bed playing
      // straight through the episode's biggest hit was flattening it.
      [11.8, (c) => c.score.setMood('silence', 0.6)],
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
      [16.5, (c) => { c.score.sting('shock'); c.score.setMood('tragedy', 1.5); }],
      // The courtyard reacts to the scandal: off-screen witnesses.
      [16.8, (c) => c.score.play('sfx-hen-gasp', { gain: 0.35 })],
      [19.5, (c) => c.score.cluck()],
      // She is looking straight at him, so every front-on angle on her looks
      // through him — he sat 10cm in front of her on the camera's ray and
      // defocused into a dark blur across the whole frame. Framing it as an
      // over-shoulder puts him in the corner where he belongs instead.
      [17.0, (c) => c.cam.cut({
        subject: rosalinda, over: esteban, frame: 'cu', lens: 85, angle: 30, dur: 6,
        handheld: 0.8, aperture: 1.8, label: 'OVER SHOULDER · 85mm',
      })],
      // Her payoff line plays on a face, head up — the sob used to bury it
      // behind her own wing before the first word was out. She holds through
      // the line with a shudder, and only breaks once it lands.
      [17.2, () => rosalinda.emote({ sorrow: 1, anger: 0.4 }, 1.6)],
      [18.5, () => rosalinda.gesture('shudder', { weight: 0.5 })],
      [21.0, () => rosalinda.gesture('sob')],
      [22.4, () => { rosalinda.gesture('spurn'); rosalinda.face(deg(-20)); rosalinda.lookAway(); }],
      // The cut to him waits for the sob to read on her shot first.
      [21.4, (c) => c.cam.cut({
        subject: esteban, frame: 'mcu', lens: 85, angle: -8, dur: 6, handheld: 0.7, dutch: -5,
      })],
      [21.6, () => { esteban.look(valentina, 1); esteban.face(valentina.pos); esteban.emote({ sorrow: 1, anger: 0.4 }, 2); }],
      // The wing points past Rosalinda, at the villainess. This is the plant.
      [23.5, () => esteban.gesture('accuse', { side: -1, weight: 0.7 })],
      [18.0, () => { donGallo.look(rosalinda, 1); donGallo.gesture('strutPose'); }],
      // "Ask her about my brother" is the first mention of a brother, and
      // somebody on screen has to hear it: she whips around.
      [24.6, (c) => {
        c.cam.cut({ subject: rosalinda, frame: 'mcu', lens: 85, angle: 20, dur: 1.7, whip: true, handheld: 0.8 });
        rosalinda.face(esteban.pos);
        rosalinda.look(esteban, 1);
        rosalinda.gesture('doubleTake', { weight: 0.6 });
      }],
      // The villainess strolls out of her corner into the light for her
      // victory lap — her near-black plumage swallows any key thrown at the
      // old mark, so the fix is her feet, not more watts.
      [24.9, () => valentina.walkTo(1.15, -0.9, { style: 'strut', speed: 0.4, face: rosalinda.pos })],
      // Icy key on her destination, so her victory line lands on a readable
      // face. Scheme first, the line as a smug aside, and the laugh only
      // after the line ends, where the pull-back wide can see it: the laugh's
      // head-shake was fighting the speech envelope for the beak.
      [26.3, (c) => {
        c.set.key.target.position.set(1.15, 0.42, -0.9);
        c.set.key.intensity = 14;
        c.set.key.color.setHex(0xb9c6ff);
        // Her plumage eats light; the exposure leans up for her close-up and
        // comes back with the wide at 29.0.
        c.post.setLook({ exposure: 2.0 });
        // Angle 30 (the other shoulder): from -12 the solve parked Don Gallo
        // in the near foreground of her close-up.
        c.cam.cut({
          subject: valentina, frame: 'cu', lens: 100, angle: 30, dur: 5, handheld: 0.7, aperture: 2,
          label: 'THE VILLAINESS · 100mm',
        });
        valentina.gesture('scheme');
        c.score.sting('small');
      }],
      [29.0, (c) => {
        c.post.setLook({ exposure: 1.6 });
        c.cam.cut({
          subject: rosalinda, frame: 'ws', lens: 24, angle: 150, height: 1.4, dur: 9,
          move: { type: 'pull', amount: 0.5, dur: 8 }, handheld: 0.5, label: 'PULL BACK · 24mm',
        });
      }],
      [31.6, () => valentina.gesture('laugh')],
      [33.6, (c) => { c.weather.strike(1); c.score.thunder(1, 0.2); }],
      [34.0, (c) => c.post.setLook({ fade: 1 })],
    ],
  };
}
