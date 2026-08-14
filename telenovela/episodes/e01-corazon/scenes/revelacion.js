// The cloth comes off the egg; three reactions, each closer than the last;
// thunder, and the patriarch in the archway.

export const meta = {
  id: 'revelacion',
  name: 'LA REVELACIÓN',
  subtitle: 'el secreto bajo el paño',
  dur: 56,
  pace: 1.15,
  // Scene-seconds worth screenshotting: the accusation, the cloth mid-air,
  // the reactions, the patriarch, the dutch close-up.
  beats: [10, 16.5, 22, 28, 34],
};

export function build(deps) {
  const { actors, V, hideAll, baseLook, stingCut, marks, deg, lerp } = deps;
  const { rosalinda, esteban, valentina, donGallo } = actors;
  const { HIS_MARK, HIDE_PALM } = marks;
  return {
    setup(c) {
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
    cues: [
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
    ],
  };
}
