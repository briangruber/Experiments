// Things that go wrong on the shop floor.
//
// An incident is a timed problem attached to a rabbit or a patch of carpet. It
// announces itself, it costs you something while it runs, and it ends either
// because you dealt with it or because you did not. That is the difference
// between these and the idle antics: an antic is a joke, an incident is a
// second thing to watch while the queue is still moving.
//
// Each one is resolved the same way — tap the rabbit, or tap the alert — so the
// mechanic works whether you are aiming a mouse at a shop floor or a thumb at a
// phone where the culprit is off-frame.

import { pick } from './dialogue.js';

const browsing = (game) => game.shoppers.filter((s) => s.phase === 'browsing' && !s.incident);

export const INCIDENTS = [
  // ------------------------------------------------------------- shoplifter
  {
    id: 'shoplifter',
    minDay: 1,
    weight: 3,
    window: 9,
    alert: (s) => `${s.name} is edging towards the door`,
    call: 'Stop them',
    find: (game) => pick(browsing(game)),

    start(game, s) {
      s.stole = pick(game.stockIds);
      s.phase = 'sneaking';
      s.body.goTo(game.doorSpot.x, game.doorSpot.z);
      game.ui.bubble(s, pick([
        'I am simply leaving. With my arms like this.',
        'Nothing under here. Nothing under here at all.',
        'Do not look at my pockets. I do not have pockets. Do not look at them.',
      ]), { mood: 'cross', keep: true });
    },

    solve(game, s) {
      game.pay(game.rules.incidentReward);
      game.ui.bubble(s, pick([
        'It leapt into my paws. Genuinely. It jumped.',
        'I was going to pay. Eventually. Spiritually.',
        'Fine! Fine. Take your radish back. I have been humiliated.',
      ]), { mood: 'happy', keep: true });
      // Sheepishly returns to browsing, as though nothing had happened.
      s.phase = 'browsing';
      s.timer = 2.5;
      s.body.goTo(s.body.pos.x, s.body.pos.y);
    },

    expire(game, s) {
      game.pay(-game.rules.incidentTheft);
      game.ui.bubble(s, pick(['I was never here.', 'Lovely shop. No notes.']), { mood: 'cross', keep: true });
      s.phase = 'leaving';
      s.body.goTo(game.doorSpot.x, game.doorSpot.z - 1.5, { run: true });
    },
  },

  // ------------------------------------------------------------------ spill
  {
    id: 'spill',
    minDay: 1,
    weight: 3,
    window: 16,
    alert: () => 'Produce all over the floor',
    call: 'Clear it up',
    find: (game) => pick(browsing(game)),

    start(game, s) {
      const mess = game.scatter(s.body.pos.x, s.body.pos.y);
      game.ui.bubble(s, pick([
        'That was already like that.',
        'The shelf let go. I felt it let go.',
        'I have made a mistake and I am going to walk away from it.',
      ]), { mood: 'cross' });
      return { mess };
    },

    // A floor full of strawberries is a slow shop, and the rabbit at the
    // counter is the one who notices.
    patienceDrain: 1.6,

    solve(game) {
      game.pay(game.rules.incidentReward);
      game.ui.banner('Swept', pick([
        'Not one rabbit thanked you. They noticed, though.',
        'Spotless. Briefly.',
        'You have saved a strawberry from being stood on.',
      ]));
    },

    end(game, s, state) {
      game.clearScatter(state?.mess);
    },
  },

  // --------------------------------------------------------------- question
  {
    id: 'question',
    minDay: 2,
    weight: 2,
    window: 11,
    alert: (s) => `${s.name} has a question`,
    call: 'Answer it',
    find: (game) => pick(browsing(game)),

    start(game, s) {
      // Frozen mid-browse until answered, so they are not going anywhere.
      s.timer = 1e6;
      game.ui.bubble(s, pick([
        'Excuse me — is the corn local? Local to what, I have not decided.',
        'Sorry, quick one: which of these is the happiest?',
        'Hello! Do you sell anything that would impress a rabbit I know?',
        'Is the muffin a vegetable? Think carefully, this decides my evening.',
        'Would you say the cabbage is, and I want your honest opinion, big?',
      ]), { keep: true });
    },

    solve(game, s) {
      // A satisfied questioner buys more and tips like it was your idea.
      s.bonusTip = game.rules.incidentTipBonus;
      s.timer = 0;
      game.ui.bubble(s, pick([
        'That is exactly what I needed to hear. I will take several.',
        'You know, nobody has ever answered me before.',
        'Right! Yes. Decisive. I am buying the lot.',
      ]), { mood: 'happy', keep: true });
    },

    expire(game, s) {
      game.ui.bubble(s, pick([
        'No, it is fine. I will just guess. Forever.',
        'I will ask the shop across the meadow. They are rude, but they answer.',
      ]), { mood: 'cross', keep: true });
      s.phase = 'leaving';
      s.body.goTo(game.doorSpot.x, game.doorSpot.z - 1.5);
    },
  },
];
