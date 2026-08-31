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

import { walk, face, say, wait, run, play } from '../engine/script.js';
import { LINES, EXCHANGES } from './lines.js';
import * as art from '../art/paint.js';
import { makePixelPerson } from '../art/pixel-person.js';
import { makeClouds, makeWater, makeLamps } from '../art/animate.js';

// One screen, 16:9, no camera. The backdrop is a video and the video models
// generate 16:9 natively, so the room is the view and there is nothing to
// scroll — which also means the camera, the parallax and the scrolling seams
// all stop being things that can be wrong.
export const ROOM_W = 1280, ROOM_H = 720;

// The dependency graph this room is an implementation of. main.js lints it at
// startup and refuses to run if it is incoherent.
export const PUZZLE = {
  start: ['hands'],
  goal: 'aboard',
  nodes: {
    'take-hook':  { needs: ['hands'], gives: 'boathook', where: 'the rope coil' },
    'knock-cup':  { needs: ['boathook'], gives: 'cup', where: "the tavern's outside wall" },
    'fill-cup':   { needs: ['cup'], gives: 'cup-of-grog', where: 'the grog barrel' },
    'bribe':      { needs: ['cup-of-grog'], gives: 'pier-open', consumes: ['cup-of-grog'], where: 'Harbourmaster Grout' },
    'board':      { needs: ['pier-open'], gives: 'aboard', where: 'the jetty steps' },
  },
};

// A cast member with a `sprite` entry gets the baked 3D body; everything else
// stays the drawn puppet. Both are wanted on screen at once here, which is the
// most honest way to judge the trade: Bonny has the mesh, Grout does not.
// Empty on purpose. There was a baked 3D body here — a Tripo mesh, rigged,
// retargeted to a Mixamo clip and baked to a sprite atlas — and it lost to the
// puppet drawn in code beside it.
//
// The reason is worth keeping, because the pipeline was not at fault. A
// character in this room stands about forty art pixels tall, and at forty
// pixels nothing inside the silhouette reads: the outline carries the whole
// figure. A textured mesh under soft lighting bakes to gradients and mid-tones,
// which is exactly the wrong material at that size — it goes muddy, and the
// face has to be drawn back on top at a fidelity the body cannot match. The
// puppet is flat colour with a hard edge, which is what small sprites are made
// of, and it is also re-lightable, re-colourable and free.
//
// The loader below still honours this table, so a baked body remains one entry
// away for a room where the character is large in frame.
// The player's body is a generated sprite atlas at last, and the reason it
// works where seven general image models did not is that AutoSprite generates
// a character once and then animates THAT character, so the frames cannot
// drift into eight slightly different people.
//
// The numbers say it plainly. The general models returned sheets whose figure
// height varied 12-23% between frames, which reads as a pulse once it moves;
// this one varies by a single pixel across twenty-five frames, and
// tools/sheet-cut.mjs verifies the packed atlas has its feet on one row and
// its head on one column before it is allowed to ship.
export const SPRITE_CAST = {
  // These two numbers are the same number twice: each figure is drawn at
  // exactly TWICE its height on the sheet, because the backdrop is painted on
  // a 2px grid and a character has to stand on the same grid or it reads as a
  // different medium pasted over the art.
  //
  // Both halves of that were got wrong once. The grid was taken from
  // `BLOCK = 3` in pixelate.js — a constant belonging to the retired
  // procedural puppet, not to the painting — when `tools/pixel-grid.mjs
  // assets/scene.jpg` measures the plate itself and says 2px, a logical room
  // of 640x360. And the sheets were then re-extracted at 80px, which is 3.2
  // times below the character art's own grid: Grout's 1024px base image
  // quantises cleanly at 4px blocks and nowhere else, so 256 is native and
  // anything under it is thrown-away information, not style. It came back
  // grainy, which is what downsampling generated art has done every time this
  // project has tried it.
  //
  // So the frame size is derived rather than picked. Drawn height / 2 is the
  // figure height wanted on the sheet; divided by how much of its frame the
  // figure fills, that is the frameSize to ask AutoSprite for — 176 for Grout,
  // 224 for Bonny, both a mild reduction from native rather than a gutting.
  player: {
    asset: 'bonny',
    sheet: './assets/cast/bonny-sheet.png',
    manifest: './assets/cast/bonny-sheet.json',
    height: 270,          // 135 on the sheet, x2
  },
  grout: {
    asset: 'grout',
    sheet: './assets/cast/grout-sheet.png',
    manifest: './assets/cast/grout-sheet.json',
    // The 176px extraction, not the 152px one: at 152 the background remover
    // left a soft grey smear under his boots, and the cleaner pass puts his
    // figure at 168 rather than 148. Drawn at 310 that is 1.85 art pixels
    // rather than a clean 2, which is the price of taking the better art at a
    // size that does not divide evenly — and the smear was worse.
    height: 310,
  },
};

export const CAST = {
  player: {
    id: 'player', name: 'Bonny Quill',
    x: 620, y: 690, talkColor: '#ffe9b0', talkOffset: -170,
    height: 165,
    pixelDraw: makePixelPerson({
      skin: '#e8b48c', skinDark: '#c98f68', hair: '#7b3a1c',
      coat: '#7c2f2a', coatDark: '#5a1f1c', shirt: '#e9dcc2',
      sash: '#d9a441', legsCol: '#3d4d63', boots: '#241811',
      hat: '#b8383a', hatStyle: 'bandana',
    }),
    draw: art.makePerson({
      height: 165, skin: '#e8b48c', skin2: '#dda078', hair: '#7b3a1c',
      coat: '#7c2f2a', shirt: '#e9dcc2', sash: '#d9a441', legs: '#3d4d63', boots: '#241811',
      hat: art.BANDANA,
    }),
  },
  grout: {
    id: 'grout', name: 'Harbourmaster Grout',
    x: 186, y: 700, facing: 'right', talkColor: '#bfe3ff', talkOffset: -175,
    height: 178,
    pixelDraw: makePixelPerson({
      skin: '#c99a76', skinDark: '#a97a56', hair: '#4a4642',
      coat: '#2f4a52', coatDark: '#1f333a', shirt: '#8f9aa0',
      sash: '#6b5334', legsCol: '#2b2a31', boots: '#1a1512',
      // A tricorn and a beard: Grout has to read as a different person from
      // across the dock, and at this size that is outline work, not colour.
      hat: '#243a41', hatStyle: 'tricorn', beard: '#6d6660',
    }),
    draw: art.makePerson({
      height: 178, skin: '#c99a76', skin2: '#b8875f', hair: '#4a4642', beard: '#5d574f',
      coat: '#2f4a52', shirt: '#8f9aa0', sash: '#6b5334', legs: '#2b2a31', boots: '#1a1512',
      hat: art.TRICORN,
    }),
  },
};

// --- the room ---------------------------------------------------------------

export function makeRoomDef(state, backdrop, props = {}) {
  // The cup is the only prop still drawn by the engine, and the reason is the
  // reason: it is the only one that changes state. Everything else — the
  // barrel, the crates, the rope, the lantern, the sign — is painted into the
  // backdrop and is simply a rectangle you can click. The old rule ("nothing
  // clickable in the plate") existed because regenerating the plate moved
  // things underneath annotations that were already written. Annotating after
  // generating inverts that: the art comes first and the boxes are drawn onto
  // what is actually there.
  const cupTaken = () => state.has('cup') || state.has('cup-of-grog');
  const cupLayer = {
    paint: (ctx, room) => {
      if (cupTaken()) return;
      const img = props.cup;
      const [x, y, w, h] = CUP_RECT;
      // Drawn 1:1 and unsmoothed. The cup is generated art now, from the same
      // AutoSprite line as the cast rather than a repainted vector blockout,
      // and its box is sized to its cell so nothing is resampled — the mistake
      // this project keeps rediscovering, one prop smaller.
      if (img) {
        const was = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, x, y, w, h);
        ctx.imageSmoothingEnabled = was;
      }
      else { ctx.save(); ctx.translate(x + w / 2, y); ctx.scale(1.15, 1.15); art.paintCup(ctx, room, false); ctx.restore(); }
    },
  };

  // When the video plays it carries all the motion. When it does not — an
  // unplayable codec, a policy that refuses the URL scheme — the still would
  // otherwise sit there dead, so the procedural layers animate it instead.
  // Gated rather than removed: a backdrop that stops moving is a worse failure
  // than one that moves a bit less well.
  const clouds = makeClouds();
  const water = makeWater(null);
  const lamps = makeLamps();
  const whenStill = (fn) => (ctx, room) => { if (backdrop?.kind !== 'video') fn(ctx, room); };

  const layers = [
    { paint: (ctx) => backdrop?.draw?.(ctx, ROOM_W, ROOM_H) },
    { paint: whenStill(water) },
    { paint: whenStill(clouds) },
    { paint: whenStill(lamps) },
    cupLayer,
  ];

  return {
    id: 'dock',
    width: ROOM_W,
    height: ROOM_H,
    // The pixel-art plate stages the boardwalk much flatter than the painted
    // one did — it reads as a floor seen slightly from above rather than one
    // rushing away — so the character shrinks less across it. Halving would
    // now look like a mistake rather than like depth.
    scale: { y0: 514, s0: 0.62, y1: 716, s1: 1.0 },
    walk: [WALK_DOCK, WALK_JETTY],
    layers,
    // Nothing to depth-sort any more. The props are inside the backdrop, which
    // draws first and always sits behind the actors — so the walk area does
    // the occluding instead, by keeping the character in front of them.
    occluders: [],
    hotspots: HOTSPOTS(state),
  };
}

// The cup hangs on the tavern wall, above head height, between the door and
// the window. It is placed rather than found: a drawn sprite goes where the
// annotation says, which is the whole advantage of it being drawn.
// On the strip of wall between the left window and the door, above head
// height. Placed rather than found: a drawn sprite goes where the annotation
// says, which is the whole advantage of it being drawn.
// Sized to the generated sprite's own cell (64x64) and centred on where the
// hand-drawn cup used to hang, so the sprite draws 1:1 and the hotspot still
// covers the same nail.
export const CUP_RECT = [891, 391, 64, 64];

// Traced over the painting. The back edge runs in FRONT of the barrel, the
// crates and the rope coil, because those are painted into the backdrop and
// therefore always behind the actor — walking "behind" them would put the
// character on top of them. On the left the dock is clear, so the area opens
// upstage and the scale has somewhere to work.
// Traced over the plate, and measured rather than guessed: tools/measure-room.mjs
// reads the water-to-plank transition column by column, which is the line
// everything else is placed against.
//
// The back edge runs in FRONT of the barrel, the rope coil, the crates and the
// tavern's stone footing, because those are painted into the backdrop and so
// always sit behind the actor — walking "behind" them would put the character
// on top of them. Left of the barrel the boardwalk is clear right up to the
// railing, so the area opens upstage there and the scale has somewhere to work.
const WALK_DOCK = [
  120, 514, 618, 512, 646, 552, 1272, 556, 1272, 716, 120, 716,
];
// The last stretch of dock before it turns off toward the boats, blocked by
// Grout until he is asleep.
const WALK_JETTY = [0, 518, 120, 514, 120, 716, 0, 716];

// The way off the dock is closed until Grout is asleep. Rather than a second
// walk area with its own bookkeeping, the jetty polygon is simply dropped from
// the union while he is awake — one line, and the pathfinder then refuses to
// route past him for free.
export function applyPierState(room, state) {
  const open = !!state.get('pier-open');
  room.walk.polys = open ? room.def.walk : [room.def.walk[0]];
  room.walk.rebuild();
}

// --- hotspots ---------------------------------------------------------------

const H = (id, name, rect, at, verbs, extra = {}) => ({ id, name, rect, at, verbs, ...extra });

function HOTSPOTS(state) {
  return [
    H('sea', 'the harbour', [0, 386, 612, 122], null, {
      look: function* (g) {
        yield say(g.player, "Black as a magistrate's heart, and twice as deep.");
      },
      use: function* (g) { yield say(g.player, "I've had enough swimming this week."); },
    }),

    H('moon', 'the moon', [298, 70, 86, 86], null, {
      look: function* (g) {
        yield say(g.player, "A full moon. Somewhere, a plot is thickening.");
      },
    }),

    H('ship', 'the Errant Kipper', [394, 188, 224, 214], { x: 430, y: 606, facing: 'left' }, {
      look: function* (g) {
        yield say(g.player, "The Errant Kipper. Sailing at dawn, with or without a crew.", 4.0);
        yield say(g.player, "Preferably with. That's where I come in.");
      },
      use: function* (g) {
        yield say(g.player, "It's a hundred yards of cold water away.");
        yield say(g.player, "Her boat's tied up past the end of the dock. Past Grout, specifically.", 4.2);
      },
    }),

    H('sign', 'the tavern sign', [684, 306, 112, 80], { x: 742, y: 622, facing: 'back' }, {
      look: function* (g) {
        yield say(g.player, "The sign is blank. Weathered right back to the bare board.", 3.8);
        yield say(g.player, "Either the paint gave up or the landlord did.");
      },
    }),

    H('lantern', 'a hanging lantern', [1030, 344, 40, 66], { x: 1046, y: 636, facing: 'back' }, {
      look: function* (g) {
        yield say(g.player, "A lantern, lit. Someone in there still cares about being findable.", 4.2);
      },
      use: function* (g) { yield say(g.player, "It's hot, it's hung, and it isn't mine. Three good reasons."); },
    }),

    H('door', 'the tavern door', [944, 334, 94, 190], { x: 986, y: 626, facing: 'back' }, {
      look: function* (g) { yield say(g.player, "Shut. And bolted. And, I suspect, personal."); },
      use: function* (g) {
        yield say(g.player, "Barred from the inside.");
        yield say(g.player, "The landlord and I disagree about the definition of 'a tab'.", 3.4);
      },
      talk: function* (g) { yield say(g.player, "I've talked to doors before. It never ends well."); },
    }),

    H('window', 'a lit window', [1068, 338, 78, 82], { x: 1104, y: 646, facing: 'back' }, {
      look: function* (g) {
        yield say(g.player, "Warm light. Laughter. People who are not standing on a cold pier.", 3.4);
        yield say(g.player, "I'm told that's called 'having options'.");
      },
      use: function* (g) { yield say(g.player, "The shutters are latched from inside. Rude."); },
    }),

    H('cup', 'a tin cup', CUP_RECT, { x: 918, y: 616, facing: 'back' }, {
      look: function* (g) {
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
          yield face(g.player, 'back');
          yield say(g.player, "Hold still, you.", 1.2);
          yield wait(0.35);
          yield say(g.player, "*clang*", 0.7);
          yield run(() => g.state.give('cup'));
          yield say(g.player, "Piracy! Already! And it isn't even midnight.", 3.0);
        },
      },
    }),

    H('barrel', 'a grog barrel', [624, 418, 96, 130], { x: 668, y: 614, facing: 'back' }, {
      look: function* (g) {
        yield say(g.player, "A barrel of grog with a working spigot, left unattended on a public pier.", 4.2);
        yield say(g.player, "Grout is either very trusting or very thirsty.");
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
          yield face(g.player, 'back');
          yield say(g.player, "One measure of the harbour's finest...", 2.0);
          yield wait(0.4);
          yield run(() => { g.state.take('cup'); g.state.give('cup-of-grog'); });
          yield say(g.player, "...which is a phrase doing an enormous amount of work.", 3.4);
        },
        'cup-of-grog': function* (g) { yield say(g.player, "It's full. Greed is a separate puzzle."); },
      },
    }),

    H('crates', 'a stack of crates', [1146, 398, 126, 150], { x: 1178, y: 662, facing: 'back' }, {
      look: function* (g) {
        yield say(g.player, "Crates stencilled 'LIVE — DO NOT INVERT'.");
        yield say(g.player, "Something inside is breathing. I choose not to investigate.", 3.4);
      },
      use: function* (g) { yield say(g.player, "Nailed shut, and I like my fingers where they are."); },
    }),

    H('nets', 'a coil of rope', [1026, 482, 124, 70], { x: 1074, y: 640, facing: 'back' }, {
      look: function* (g) {
        if (g.state.has('boathook')) {
          yield say(g.player, "Just rope now. Wet rope.");
        } else {
          yield say(g.player, "A coil of tarred rope with a boat hook lying across it like a flag.", 4.2);
        }
      },
      use: function* (g) {
        if (g.state.has('boathook')) { yield say(g.player, "I've had the good bit already."); return; }
        yield say(g.player, "Mine now.", 1.0);
        yield run(() => g.state.give('boathook'));
        yield say(g.player, "Salvage. It's practically a civic duty.", 2.6);
      },
    }),

    H('jetty', 'the end of the dock', [0, 502, 118, 212], { x: 150, y: 664, facing: 'left' }, {
      look: function* (g) {
        yield say(g.player, "The dock runs on past the lamplight, and the Kipper's boat is tied up at the end of it.", 4.6);
      },
      use: function* (g) {
        if (!g.state.get('pier-open')) {
          yield say(g.player, "Grout is in the way, and Grout is a wide man.");
          return;
        }
        yield walk(g.player, g.room.walk, 30, 690);
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
    // Started rather than waited for, so the line lands over the drinking
    // instead of after it. It is a one-shot clip, so it holds on its last
    // frame — he ends up standing there holding the empty cup.
    yield run(() => g.grout.playClip('drink'));
    yield say(g.grout, '*glug*', 1.0);
    yield wait(0.4);
    yield speak(g, 'offer-4');
    // The bubble comes down with him: he is about a third as tall sitting.
    yield run(() => { g.grout.talkOffset = -100; });
    yield wait(0.8);
    yield say(g.grout, 'zzzzzz', 2.2);
    yield run(() => {
      g.state.set('pier-open', true);
      g.state.set('grout-asleep', true);
      g.onWorldChange();
    });
    // He used to vanish at this point — the placeholder for an animation that
    // did not exist. Now he sits down against nothing and snores, which is
    // both the better joke and the reason the sleeping clip was generated.
    yield play(g.grout, 'asleep');
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
