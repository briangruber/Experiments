// The vertical slice: one room, four puzzle steps, one conversation.
//
// The room is deliberately the smallest thing that still exercises every
// system a full game needs — an item you cannot reach, an item that transforms,
// an NPC gate, a conversation tree, and a world change that opens new floor.
// If this room is not fun, no quantity of generated backdrops will make the
// next twenty rooms fun, which is the actual question the prototype exists to
// answer.
//
// Content is data plus generator functions. Nothing here touches the renderer,
// the input handling or the sequencer, which is what makes the claim "a second
// room is a data file" testable rather than aspirational.

import { walk, face, say, wait, run } from '../engine/script.js';
import { LINES, EXCHANGES } from './lines.js';
import * as art from '../art/paint.js';
import { makeClouds, makeWater, makeLamps } from '../art/animate.js';
import { PROP_RECTS } from '../art/props.js';

export const ROOM_W = 1920, ROOM_H = 720;

// The dependency graph this room is an implementation of. main.js lints it at
// startup and refuses to run if it is incoherent.
export const PUZZLE = {
  start: ['hands'],
  goal: 'aboard',
  nodes: {
    'take-hook':  { needs: ['hands'], gives: 'boathook', where: 'the net pile' },
    'knock-cup':  { needs: ['boathook'], gives: 'cup', where: "the tavern's outside wall" },
    'fill-cup':   { needs: ['cup'], gives: 'cup-of-grog', where: 'the grog barrel' },
    'bribe':      { needs: ['cup-of-grog'], gives: 'pier-open', consumes: ['cup-of-grog'], where: 'Harbourmaster Grout' },
    'board':      { needs: ['pier-open'], gives: 'aboard', where: 'the gangplank' },
  },
};

export const CAST = {
  player: {
    id: 'player', name: 'Bonny Quill',
    x: 700, y: 690, talkColor: '#ffe9b0', talkOffset: -170,
    draw: art.makePerson({
      height: 165, skin: '#e8b48c', skin2: '#dda078', hair: '#7b3a1c',
      coat: '#7c2f2a', shirt: '#e9dcc2', sash: '#d9a441', legs: '#3d4d63', boots: '#241811',
      hat: art.BANDANA,
    }),
  },
  grout: {
    id: 'grout', name: 'Harbourmaster Grout',
    x: 1470, y: 700, facing: 'left', talkColor: '#bfe3ff', talkOffset: -175,
    draw: art.makePerson({
      height: 178, skin: '#c99a76', skin2: '#b8875f', hair: '#4a4642', beard: '#5d574f',
      coat: '#2f4a52', shirt: '#8f9aa0', sash: '#6b5334', legs: '#2b2a31', boots: '#1a1512',
      hat: art.TRICORN,
    }),
  },
};

// --- the room ---------------------------------------------------------------

export function makeRoomDef(state, plate, props = {}) {
  // A generated backdrop, when tools/plate.mjs has produced one, replaces the
  // static layers with a single blit. What it does NOT replace is anything the
  // player can touch: the cup below and the occluder props further down keep
  // being drawn by code, over the plate, because a repaint moves small objects
  // and a hotspot that has drifted off its own art is worse than placeholder
  // art that has not. The floor, scale and occluders are untouched either way —
  // the annotations are the durable asset, the painting is the replaceable one.
  // Every clickable object draws from its generated sprite when one exists and
  // from the procedural painter when it does not, at the same coordinates
  // either way. That is the whole of the swap: the box is the asset, the
  // painting inside it is replaceable.
  const prop = (name, fallback) => (ctx, room) => {
    const img = props[name];
    if (!img) { fallback(ctx, room); return; }
    const [x, y, w, h] = PROP_RECTS[name];
    ctx.drawImage(img, x, y, w, h);
  };

  const cupTaken = () => state.has('cup') || state.has('cup-of-grog');
  const cupLayer = {
    paint: (ctx, room) => {
      if (cupTaken()) return;
      prop('cup', (c, r) => art.paintCup(c, r, false))(ctx, room);
    },
  };
  const tavernLayer = { paint: prop('tavern', art.paintTavern) };

  // The moving layers work over either backdrop: the water resamples the plate
  // when there is one and falls back to glitter alone when there is not.
  const clouds = { paint: makeClouds() };
  const water = { paint: makeWater(plate) };
  const lamps = { paint: makeLamps() };

  const layers = plate
    ? [
        { paint: (ctx) => ctx.drawImage(plate, 0, 0, ROOM_W, ROOM_H) },
        water,
        clouds,        // drawn before the tavern, so a cloud passes behind it
        tavernLayer,
        lamps,
        cupLayer,
      ]
    : [
        { paint: art.paintSky, parallax: 0.55 },
        clouds,
        { paint: art.paintSea, parallax: 0.25 },
        water,
        { paint: art.paintPilings },
        { paint: art.paintDock },
        tavernLayer,
        lamps,
        cupLayer,
      ];

  return {
    id: 'dock',
    width: ROOM_W,
    height: ROOM_H,
    // Two anchor lines. Downstage the actor is full size; at the back of the
    // dock they are 62% — enough that walking upstage reads as walking away.
    scale: { y0: 604, s0: 0.62, y1: 716, s1: 1.0 },
    walk: [
      [40, 664, 1560, 604, 1560, 716, 40, 716],   // the dock itself
      [1560, 604, 1880, 596, 1880, 700, 1560, 716], // the pier, opened by the bribe
    ],
    layers,
    occluders: [
      { baseline: 660, paint: prop('barrel', art.paintBarrel) },
      { baseline: 700, paint: prop('crates', art.paintCrates) },
      { baseline: 690, paint: prop('nets', art.paintNets) },
    ],
    hotspots: HOTSPOTS(state),
  };
}

// The pier is closed until Grout is asleep. Rather than a separate walk area,
// the second polygon is simply removed from the union while he is awake —
// one line, and the pathfinder refuses to route past him for free.
export function applyPierState(room, state) {
  const open = !!state.get('pier-open');
  room.walk.polys = open ? room.def.walk : [room.def.walk[0]];
  room.walk.rebuild();
}

// --- hotspots ---------------------------------------------------------------

const H = (id, name, rect, at, verbs, extra = {}) => ({ id, name, rect, at, verbs, ...extra });

function HOTSPOTS(state) {
  return [
    H('sea', 'the sea', [440, 470, 1480, 126], null, {
      look: function* (g) {
        yield say(g.player, "Black as a magistrate's heart, and twice as deep.");
      },
      use: function* (g) { yield say(g.player, "I've had enough swimming this week."); },
    }),

    H('moon', 'the moon', [930, 60, 110, 120], null, {
      look: function* (g) {
        yield say(g.player, "A full moon. Somewhere, a plot is thickening.");
      },
    }),

    H('sign', 'the tavern sign', [232, 240, 136, 62], { x: 300, y: 646, facing: 'back' }, {
      look: function* (g) {
        yield say(g.player, '"THE BILGE." Truth in advertising is so rare these days.');
      },
    }),

    H('window', 'the tavern window', [202, 292, 146, 126], { x: 300, y: 650, facing: 'back' }, {
      look: function* (g) {
        yield say(g.player, "Warm light. Laughter. People who are not standing on a cold pier.", 3.2);
        yield say(g.player, "I'm told that's called 'having options'.");
      },
      use: function* (g) { yield say(g.player, "The shutters are latched from inside. Rude."); },
    }),

    H('door', 'the tavern door', [60, 380, 104, 240], { x: 200, y: 660, facing: 'left' }, {
      look: function* (g) { yield say(g.player, "Shut. And bolted. And, I suspect, personal."); },
      use: function* (g) {
        yield say(g.player, "Barred from the inside.");
        yield say(g.player, "The landlord and I disagree about the definition of 'a tab'.", 3.4);
      },
      talk: function* (g) { yield say(g.player, "I've talked to doors before. It never ends well."); },
    }),

    H('cup', 'a tin cup', [386, 434, 52, 56], { x: 470, y: 654, facing: 'left' }, {
      look: function* (g) {
        if (g.state.has('cup') || g.state.has('cup-of-grog')) return;
        yield say(g.player, "A tin cup, hung on a nail. Well out of reach of anyone honest.", 3.6);
      },
      use: function* (g) {
        yield say(g.player, "It's a good foot above my fingertips.");
        yield say(g.player, "I need something long. And hooked. And not attached to me.", 3.4);
      },
    }, {
      hidden: () => state.has('cup') || state.has('cup-of-grog'),
      useWith: {
        boathook: function* (g) {
          yield face(g.player, 'left');
          yield say(g.player, "Hold still, you.", 1.2);
          yield wait(0.35);
          yield say(g.player, "*clang*", 0.7);
          yield run(() => g.state.give('cup'));
          yield say(g.player, "Piracy! Already! And it isn't even midnight.", 3.0);
        },
      },
    }),

    H('barrel', 'a grog barrel', [512, 542, 100, 122], { x: 620, y: 672, facing: 'left' }, {
      look: function* (g) {
        yield say(g.player, "A barrel of grog with a working spigot, left unattended on a public pier.", 4.2);
        yield say(g.player, "Grout is either very trusting or very asleep.");
      },
      use: function* (g) {
        if (g.state.has('cup')) {
          yield say(g.player, "I should use the cup on it, not my face.");
        } else {
          yield say(g.player, "I turn the spigot. Grog goes onto the planks.");
          yield say(g.player, "The planks are now the drunkest thing here. I need a container.", 3.8);
        }
      },
    }, {
      useWith: {
        cup: function* (g) {
          yield face(g.player, 'left');
          yield say(g.player, "One measure of the harbour's finest...", 2.0);
          yield wait(0.4);
          yield run(() => { g.state.take('cup'); g.state.give('cup-of-grog'); });
          yield say(g.player, "...which is a phrase doing an enormous amount of work.", 3.4);
        },
        'cup-of-grog': function* (g) { yield say(g.player, "It's full. Greed is a separate puzzle."); },
      },
    }),

    H('crates', 'a stack of crates', [806, 556, 156, 150], { x: 880, y: 690, facing: 'back' }, {
      look: function* (g) {
        yield say(g.player, "Crates stencilled 'LIVE — DO NOT INVERT'.");
        yield say(g.player, "Something inside is breathing. I choose not to investigate.", 3.4);
      },
      use: function* (g) { yield say(g.player, "Nailed shut, and I like my fingers where they are."); },
    }),

    H('nets', 'a pile of nets', [1024, 610, 196, 88], { x: 1120, y: 700, facing: 'back' }, {
      look: function* (g) {
        if (g.state.has('boathook')) {
          yield say(g.player, "Just nets now. Wet ones.");
        } else {
          yield say(g.player, "A heap of fishing net with a boat hook sticking out of it like a flag.", 4.2);
        }
      },
      use: function* (g) {
        if (g.state.has('boathook')) { yield say(g.player, "I've had the good bit already."); return; }
        yield say(g.player, "Mine now.", 1.0);
        yield run(() => g.state.give('boathook'));
        yield say(g.player, "Salvage. It's practically a civic duty.", 2.6);
      },
    }),

    H('ship', 'the Errant Kipper', [1690, 440, 230, 270], { x: 1600, y: 660, facing: 'right' }, {
      look: function* (g) {
        yield say(g.player, "The Errant Kipper. Sailing at dawn, with or without a crew.", 4.0);
        yield say(g.player, "Preferably with. That's where I come in.");
      },
      use: function* (g) {
        if (!g.state.get('pier-open')) {
          yield say(g.player, "Grout is in the way, and Grout is a wide man.");
          return;
        }
        yield walk(g.player, g.room.walk, 1840, 646);
        yield run(() => g.win());
      },
    }),
  ];
}

// --- the conversation -------------------------------------------------------
//
// A dialogue tree is a state machine over the same flags the puzzles use, which
// is what keeps a conversation from drifting out of sync with the world. Grout
// knowing he is thirsty and Grout being bribable are the same fact.

export function groutTree(g) {
  const said = (k) => g.state.get('said-' + k);
  const mark = (k) => g.state.set('said-' + k, true);

  const opts = [];
  if (!said('intro')) {
    opts.push({ id: 'intro', text: "Evening. I'd like to board that ship." });
  } else {
    opts.push({ id: 'again', text: "About boarding that ship." });
  }
  if (said('intro') && !said('why')) opts.push({ id: 'why', text: "On whose authority?" });
  if (said('intro') && !said('thirst')) opts.push({ id: 'thirst', text: "You look parched, if I may say so." });
  if (g.state.has('cup-of-grog')) opts.push({ id: 'offer', text: "Perhaps this would help. [give the grog]" });
  opts.push({ id: 'bye', text: "Never mind." });
  return opts;
}

// One voiced line, by id. The measured clip length wins when a recording
// exists; otherwise say() estimates from the text. Nothing else changes, which
// is what makes recording an incremental step rather than a migration.
function speak(g, id) {
  const l = LINES[id];
  if (!l) throw new Error('no line ' + id);
  const actor = l.who === 'grout' ? g.grout : g.player;
  return say(actor, l.text, g.voice?.duration(id) ?? null, id);
}

export function* groutLine(g, opt) {
  const mark = (k) => g.state.set('said-' + k, true);

  if (opt.id === 'offer') {
    yield speak(g, 'offer-1');
    yield speak(g, 'offer-2');
    yield speak(g, 'offer-3');
    yield run(() => g.state.take('cup-of-grog'));
    yield say(g.grout, '*glug*', 1.0);
    yield wait(0.4);
    yield speak(g, 'offer-4');
    yield run(() => { g.grout.talkOffset = -100; });
    yield wait(0.8);
    yield say(g.grout, 'zzzzzz', 2.2);
    yield run(() => {
      g.state.set('pier-open', true);
      g.state.set('grout-asleep', true);
      g.grout.visible = false;          // he slumps out of the walkway
      g.onWorldChange();
    });
    yield speak(g, 'offer-5');
    yield speak(g, 'offer-6');
    return;
  }

  if (opt.id === 'intro' || opt.id === 'again') mark('intro');
  else if (EXCHANGES[opt.id]) mark(opt.id);

  for (const id of EXCHANGES[opt.id] || EXCHANGES.bye) yield speak(g, id);
}

export function* groutGreeting(g) {
  if (g.state.get('grout-asleep')) {
    yield say(g.player, "He's earned it.");
    return;
  }
  yield say(g.grout, "Pier's closed.", 1.4);
}
