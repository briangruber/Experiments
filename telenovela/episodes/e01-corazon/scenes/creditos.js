// The curtain call. The cast line up downstage, take a bow each as their name
// comes up, and then the crew gets its due.

export const meta = {
  id: 'creditos',
  name: 'CRÉDITOS',
  subtitle: 'el reparto y los culpables',
  dur: 60,
  // The credits run to the announcer's clock, not the director's.
  pace: 1.0,
  // Scene-seconds worth screenshotting: the line-up, two of the bows, the
  // crew cards, the closing disclaimer.
  beats: [2, 11, 21, 30, 47],
};

export function build(deps) {
  const { actors, V, hideAll, baseLook } = deps;
  const { rosalinda, esteban, valentina, donGallo, ricardo, pollito } = actors;
  return {
    setup(c) {
      hideAll(c);
      baseLook(c, {
        fade: 1, exposure: 1.7, diffusion: 0.5, bloom: 0.7, halation: 0.45,
        warmth: 0.12, vignette: 0.44, grain: 0.034,
      });
      c.weather.setRain(0.06, true);
      c.score.setRain(0.06);
      c.set.wetness = 0.25;
      // The line, and where the camera will end up watching it from.
      const LINE = 0.5, EYE = V(0.55, 1.05, 2.95);
      const onLine = (actor, x, e) => {
        actor.setVisible(true).place(x, LINE, Math.atan2(EYE.x - x, EYE.z - LINE)).setEmotion(e);
        actor.look(c.camera, 0.85);
      };
      onLine(rosalinda, -0.9, { love: 0.35, pride: 0.3 });
      onLine(esteban, -0.3, { pride: 0.8 });
      onLine(valentina, 0.3, { pride: 0.9, anger: 0.2 });
      onLine(donGallo, 0.95, { pride: 1 });
      onLine(ricardo, 1.6, { pride: 0.9 });
      onLine(pollito, 2.1, { shock: 0.2 });
      pollito.rig.root.scale.setScalar(1);
      // Swing the key round onto the line — nobody takes a bow in the dark.
      // Warm footlights for the curtain call — the cool night key made the
      // whole company look embalmed.
      c.set.key.target.position.set(0.55, 0.45, LINE);
      c.set.key.color.setHex(0xffc98a);
      c.set.key.intensity = 6.0;
      c.cam.cut({
        subject: V(0.55, 0.45, LINE), view: 2.4, lens: 24, angle: 0, height: EYE.y,
        move: { type: 'crane', amount: 0.5, dur: 46 }, dur: 48, handheld: 0.35, smooth: 2.4,
        label: 'CURTAIN CALL · 24mm',
      });
    },
    cues: [
      [0.0, (c) => { c.post.setLook({ fade: 0 }); c.score.setMood('credits', 4); c.score.setAmbience(1); }],
      [0.8, (c) => c.titles.show('CORAZÓN DE GALLINA', { kicker: 'reparto', kind: 'main', dur: 5, rule: true, fadeIn: 1.4 })],

      // Each bird gets a bow and a noise of its own. The name card follows the
      // bow by a beat, so the face is coming back UP — visible — as the name
      // lands, instead of being buried in the dip for its whole card.
      [5.5, (c) => { rosalinda.gesture('bow'); c.score.cluck(); }],
      [6.4, (c) => c.titles.show('ROSALINDA', { sub: 'la inocente', kind: 'cast', dur: 2.9 })],
      [8.3, (c) => { esteban.gesture('bow'); c.score.crow(); }],
      [9.2, (c) => c.titles.show('ESTEBAN', { sub: 'el galán', kind: 'cast', dur: 2.9 })],
      // The footlight leans up for her bow — she stands on an unlit seam and
      // was taking her own curtain call as a black blob.
      [11.1, (c) => { valentina.gesture('bow'); c.score.squawk(); c.set.key.intensity = 7.5; }],
      [12.0, (c) => c.titles.show('VALENTINA', { sub: 'la villana', kind: 'cast', dur: 2.9 })],
      [13.9, (c) => { donGallo.gesture('bow'); c.score.crow(); c.set.key.intensity = 6.0; }],
      [14.8, (c) => c.titles.show('DON GALLO', { sub: 'el patrón', kind: 'cast', dur: 2.9 })],
      [16.7, (c) => { ricardo.gesture('bow'); c.score.squawk(); }],
      [17.6, (c) => c.titles.show('RICARDO', { sub: 'el gemelo malvado', kind: 'cast', dur: 2.9 })],
      [19.5, (c) => { pollito.gesture('bow'); c.score.peep(); }],
      [20.4, (c) => c.titles.show('POLLITO', { sub: 'el secreto', kind: 'cast', dur: 2.9 })],

      // And now the people who did this on purpose.
      [22.6, (c) => c.cam.move({
        subject: V(0.55, 0.45, 0.5), view: 3.0, lens: 28, angle: 13, height: 1.0,
        move: { type: 'orbit', amount: 0.5, dur: 26 }, dur: 26, handheld: 0.4, smooth: 3,
        label: 'THE GUILTY · 30mm',
      })],
      // Spaced to the announcer's measured lengths, with the English under
      // him — the credits are in Spanish like everything else he says, and
      // the joke does not survive being untranslated.
      [23.4, (c) => {
        c.score.say('vo-credits-1');
        c.titles.show('CLAUDE OPUS 5', {
          kicker: 'dirección · guion · fotografía · vestuario · y todas las plumas',
          kind: 'credit', dur: 8.5, fadeIn: 1,
        });
        c.titles.subtitle('Directed, written, shot, costumed, and every last feather.', 8.3, { narration: true });
      }],
      [32.6, (c) => {
        c.score.say('vo-credits-2');
        c.titles.show('THREE.JS', {
          kicker: 'escenografía construida a mano, polígono por polígono',
          kind: 'credit', dur: 5.8, fadeIn: 0.9,
        });
        c.titles.subtitle('Sets built by hand, polygon by polygon.', 5.6, { narration: true });
      }],
      [39.1, (c) => {
        c.score.say('vo-credits-3');
        c.titles.show('ELEVENLABS', {
          kicker: 'música original · truenos · y todos los suspiros',
          kind: 'credit', dur: 5.4, fadeIn: 0.9,
        });
        c.titles.subtitle('Original music, thunder, and every sigh.', 5.2, { narration: true });
      }],
      [45.2, (c) => {
        c.score.say('vo-credits-4');
        c.titles.show('BRIAN GRUBER', {
          kicker: 'escribió unos cuantos prompts',
          kind: 'credit', dur: 3.3, fadeIn: 0.9,
        });
        c.titles.subtitle('Wrote a few prompts.', 3.1, { narration: true });
      }],
      [49.1, (c) => {
        c.score.say('vo-credits-5');
        c.titles.show('NINGUNA GALLINA RESULTÓ HERIDA', {
          sub: 'varias resultaron traicionadas',
          kind: 'act', dur: 6.0, fadeIn: 0.8,
        });
        c.titles.subtitle('No chicken was harmed in this production. Several were betrayed.', 5.8, { narration: true });
      }],
      // The last sound of the episode.
      [56.2, (c) => c.score.crow()],
      [57.6, (c) => c.post.setLook({ fade: 1 })],
    ],
  };
}
