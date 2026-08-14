// Esteban has a twin. Every head turns, the dolly zoom lands while Rosalinda
// works it out, and the villainess crosses to his side — which explains
// everything.

export const meta = {
  id: 'gemelo',
  name: 'EL GEMELO MALVADO',
  subtitle: 'nadie es quien parece',
  dur: 50,
  pace: 1.15,
  // Scene-seconds worth screenshotting: heads turning, the twin revealed,
  // the dolly zoom, the confrontation, the alliance.
  beats: [8, 14, 20, 27, 40],
};

export function build(deps) {
  const { actors, V, hideAll, baseLook, stingCut, marks, deg } = deps;
  const { rosalinda, esteban, valentina, donGallo, ricardo } = actors;
  const { ARCH_L, OFF_LEFT } = marks;
  return {
    setup(c) {
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
    cues: [
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
    ],
  };
}
