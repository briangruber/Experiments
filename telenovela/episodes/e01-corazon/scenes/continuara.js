// The faint, the catch, the laughing villains — and while nobody is watching
// the egg, it hatches, and looks straight down the lens.

export const meta = {
  id: 'continuara',
  name: 'CONTINUARÁ',
  subtitle: 'el desmayo y el secreto',
  dur: 40.6,
  // Scene-seconds worth screenshotting. Not 40: the scene fades to black at
  // 39.5 and runs to 40.6, so a frame there is deliberately empty. 39.0 is
  // the freeze and the card.
  beats: [6, 13, 29, 35, 39],
};

export function build(deps) {
  const { actors, V, hideAll, baseLook, deg } = deps;
  const { rosalinda, esteban, valentina, donGallo, ricardo, pollito } = actors;
  return {
    setup(c) {
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
    cues: [
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
      // Explicit view rather than 'ms': her framing height collapses with the
      // faint, and the frame used to dive into her body as she fell. Over his
      // shoulder so the narrator's "es Esteban quien la sostiene" plays on a
      // shot with both bodies — the pietà needs the catcher in it.
      [4.2, (c) => c.cam.cut({
        subject: rosalinda, over: esteban, view: 1.25, lens: 40, angle: 45, height: 0.3, dur: 8,
        handheld: 0.9, dutch: -6, label: 'THE FAINT · 40mm',
      })],
      [4.9, () => { esteban.gesture('catcher'); esteban.look(rosalinda, 1); esteban.emote({ sorrow: 1, fear: 0.6 }, 2); }],
      [6.4, (c) => { c.cam.shake(0.35); c.score.sting('small'); }],
      [8.0, (c) => c.cam.cut({
        subject: rosalinda, frame: 'cu', lens: 100, angle: 40, height: 0.24, dur: 7,
        move: { type: 'creep', amount: 1 }, handheld: 0.6, aperture: 2, label: 'CLOSE · 100mm',
      })],
      [14.2, (c) => { c.weather.strike(1.2); c.score.thunder(1.1, 0.15); }],
      // The villains, silhouetted by the lightning. 13.8, not 12.0: the
      // lullaby "Duerme, palomita…" runs to ~13.7, and cutting mid-line left
      // Esteban's tenderest caption stranded on the villains. The shot also
      // commits to being a silhouette now — key dead, doorway hot behind
      // them, exposure down — so the strikes pop them as black cutouts.
      [13.8, (c) => {
        c.set.key.intensity = 0;
        c.set.doorway.intensity = 14;
        c.post.setLook({ exposure: 1.5 });
        // (A true backlit cutout would need the camera on the downstage side,
        // but that solve lands inside the palms — so this settles for the
        // next best thing: key dead, doorway rim, exposure down, and the
        // strikes at 14.2/14.8 do the popping.)
        c.cam.cut({
          subject: valentina, frame: 'mls', lens: 35, angle: 20, height: 0.36, dur: 8,
          handheld: 0.7, dutch: 9, label: 'SILHOUETTE · 35mm',
        });
        valentina.gesture('laugh');
        ricardo.gesture('laugh', { delay: 0.4 });
      }],
      [14.8, (c) => { c.weather.strike(1.4); c.score.thunder(1.3, 0.05); c.score.sting('shock'); }],
      // Lighting back to the scene's base for the patriarch.
      [18.6, (c) => {
        c.set.key.intensity = 4.0;
        c.set.doorway.intensity = 10;
        c.post.setLook({ exposure: 1.85 });
        c.cam.cut({
          subject: donGallo, frame: 'cu', lens: 85, angle: -8, height: 'low', dur: 5,
          handheld: 0.8, dutch: -10,
        });
        donGallo.look(ricardo, 1);
        donGallo.gesture('strutPose');
      }],
      // Esteban hears the disinheriting — the catcher hold keeps his body;
      // the head turn is the beat.
      [20.3, () => { esteban.look(donGallo, 1); esteban.emote({ sorrow: 1, anger: 0.5 }, 2); }],
      // Everyone forgets the egg. The camera does not. 21.8, not 20.0: Don
      // Gallo's "Mi verdadero hijo ha vuelto" runs to ~24.2 and the egg cut
      // was swallowing it after 1.4 seconds; the push absorbs the wait.
      [21.8, (c) => {
        // The storm eases as the camera abandons the plot for the egg — and
        // fewer splash rings plate-sized next to it at this lens height.
        c.weather.setRain(0.5);
        c.score.setRain(0.5);
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
      // Wider and higher than the old egg-hugging frame, aimed a touch up, so
      // the chick's head is IN frame when it emerges instead of cropped off.
      [27.5, (c) => c.cam.cut({
        subject: c.props.egg, view: 0.3, lens: 100, angle: 22, height: 0.2, aimOffset: V(0, 0.09, 0),
        dur: 9, handheld: 0.5, aperture: 2, label: 'BIG CLOSE-UP · 100mm',
      })],
      // Hatch. The chick stays inside the shell for the first half of the
      // tween — legs popping to full length under a floating shell cap read
      // as broken, not born.
      [28.5, (c) => {
        const shell = c.props.egg.userData.shell;
        const cracks = c.props.egg.userData.cracks;
        pollito.setVisible(true);
        pollito.rig.root.scale.setScalar(0.001);
        c.tw.add(1.1, (u) => {
          shell.scale.set(1 - u * 0.15, Math.max(0.06, 1 - u * 0.92), 1 - u * 0.15);
          cracks.scale.setScalar(Math.max(0.001, 1 - u));
          pollito.rig.root.scale.setScalar(u < 0.45 ? 0.001 : Math.max(0.001, (u - 0.45) / 0.55));
        }, { ease: 'backOut' });
        c.score.eggCrack();
        c.score.peep();
        c.cam.shake(0.4);
      }],
      // The first full look at the newborn: a clean reveal after the tween.
      [29.6, (c) => c.cam.cut({
        subject: pollito, frame: 'ms', lens: 85, height: 0.14, dur: 3.4, handheld: 0.5, aperture: 2,
        label: 'THE NEWBORN · 85mm',
      })],
      [30.0, () => { pollito.emote({ shock: 0.3 }, 3); pollito.gesture('cock', { side: 1 }); }],
      [31.5, (c) => { pollito.gesture('peck'); c.score.peep(); }],
      // It looks straight down the lens. Strict angle 22 with a gentler push:
      // the solver's house-rule nudge was silently rewriting angle 0 and the
      // old push overshot until the head cropped to an orange sphere.
      [33.0, (c) => {
        c.cam.cut({
          subject: pollito, frame: 'bcu', lens: 135, angle: 22, strictAngle: true, look: 'eye', dur: 9,
          move: { type: 'push', amount: 0.25, dur: 7 }, handheld: 0.35, aperture: 2.6,
          label: 'TO CAMERA · 135mm',
        });
        pollito.look(c.camera, 1);
        c.score.setMood('silence', 1.5);
        c.weather.setRain(0.3);
        c.score.setRain(0.3);
      }],
      // The narrator asked whose child it is. The chick's unanswered answer.
      [35.8, (c) => c.score.peep()],
      [36.5, () => pollito.gesture('cock', { side: -1, weight: 0.5 })],
      [38.5, (c) => {
        // Freeze frame, hold, and roll the card. Exposure drops so the card
        // owns the frame rather than fighting the chick's bright cheek.
        c.post.setLook({ freeze: 1, grain: 0.11, contrast: 1.2, saturation: 0.8, vignette: 0.62, exposure: 1.5 });
        c.cam.shake(0.2);
        c.score.sting('shock');
      }],
      [38.6, (c, d) => d.setSpeed(0.06)],
      [39.0, (c) => { c.titles.show('CONTINUARÁ…', { kind: 'end', dur: 12, fadeIn: 1.2, rule: true }); c.score.say('vo-continuara', 0.6); }],
      [39.0, (c) => { c.score.setMood('theme', 2); }],
      [39.5, (c) => { c.post.setLook({ fade: 1 }); }],
      [48.0, (c, d) => { d.setSpeed(1); c.post.setLook({ freeze: 0 }); }],
    ],
  };
}
