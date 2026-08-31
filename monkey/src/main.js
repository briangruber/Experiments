// Wiring. Canvas, input, the verb dispatch, and the frame loop.
//
// The dispatch table at the centre of this file is the whole game feel. An
// adventure game lives or dies on what a click does when it is ambiguous —
// clicking a hotspot while holding an item, clicking during a line, clicking
// the floor behind an NPC — and every one of those cases is decided here
// rather than scattered through content. Content stays declarative because
// this file absorbs the ambiguity.

import { Room } from './engine/room.js';
import { Actor } from './engine/actor.js';
import { State, Sequencer, attachVoice, walk, face, say, run, wait } from './engine/script.js';
import { Voice } from './engine/audio.js';
import { lint } from './engine/puzzle.js';
import { VerbCoin, Inventory, DialogueMenu, drawSpeech } from './engine/ui.js';
import { Editor } from './engine/editor.js';
import * as art from './art/paint.js';
import { loadProps, registerPropIcons } from './art/props.js';
import { loadBackdrop, KIND, seamWeight } from './art/backdrop.js';
import { BLOCK as PIXEL_BLOCK } from './art/pixelate.js';
import { loadSpriteBody } from './art/sprite-actor.js';
import * as dock from './game/dock.js';
import * as galley from './game/galley.js';

const VIEW = { w: dock.ROOM_W, h: dock.ROOM_H };

const canvas = document.getElementById('stage');
canvas.width = VIEW.w;
canvas.height = VIEW.h;
const ctx = canvas.getContext('2d');

// --- world ------------------------------------------------------------------

const state = new State({});
const seq = new Sequencer();
const coin = new VerbCoin();
const inv = new Inventory(VIEW);
const menu = new DialogueMenu(VIEW);

// Every room the game has, and the one it is currently in. A room supplies its
// own cast, its own sprite atlases, its own puzzle graph and its own people;
// the wiring below knows none of their names.
const ROOMS = { dock, galley };
let here = 'dock';
let R = ROOMS[here];

// Actors are rebuilt per room, keyed by id. The player is rebuilt with them —
// everything about her that persists (inventory, flags) lives in `state`, and
// everything that does not is her position, which the room decides.
let actors = {};
const cast = () => Object.values(actors);
const npcIds = () => Object.keys(actors).filter((k) => k !== 'player');

// ?editor=1 opens the annotation overlay at load, which is how a walk area
// gets traced over a freshly generated backdrop.
const EDITOR_AT_LOAD = new URLSearchParams(location.search).get('editor') === '1';
let room, editor;
let props = {};
let backdrop = null;
const voice = new Voice();
// What a room's script is handed. Actors are reachable by id — `g.player`,
// `g.grout`, `g.pike`, `g.cat` — so a room's code reads the same as it did
// when there was only one room and they were module-level constants.
const g = {
  state, seq, VIEW, voice,
  get actors() { return actors; },
  get room() { return room; },
  get here() { return here; },
  onWorldChange: () => R.applyState?.(room, state, g),
  goTo: (id, from) => { pendingMove = { id, from }; },
  win: () => { state.set('sailed', true); },
};
for (const id of ['player', 'grout', 'pike', 'cat']) {
  Object.defineProperty(g, id, { get: () => actors[id] });
}

function buildRoom() {
  room = new Room(R.makeRoomDef(state, backdrop, props), VIEW);
  R.applyState?.(room, state, g);
  editor = new Editor(room, VIEW);
  if (EDITOR_AT_LOAD) editor.active = true;
}

// A door is taken between frames, not inside the handler that opened it: the
// sequencer is mid-step when it fires, and tearing the room out from under a
// running generator is how you get a walk that finishes in a room that no
// longer exists.
let pendingMove = null;
async function goTo(id, from) {
  if (!ROOMS[id]) throw new Error('no room ' + id);
  seq.cancel(); coin.hide(); menu.hide(); inv.selected = null;
  here = id; R = ROOMS[id];
  backdrop = await loadBackdrop(id);
  showBackdrop?.();
  await buildCast();
  const spawn = R.SPAWN?.[from] ?? R.SPAWN?.start ?? { x: 640, y: 690 };
  Object.assign(actors.player, { x: spawn.x, y: spawn.y, facing: spawn.facing || 'right' });
  actors.player.stop();
  buildRoom();
  room.follow(actors.player, 0, true);
}

// Build this room's actors and bind their atlases. Failure is silent and
// total, as it was: the actor keeps whatever `draw` its cast entry gave it.
async function buildCast() {
  actors = {};
  for (const [id, spec] of Object.entries(R.CAST)) actors[id] = new Actor(spec);
  for (const [id, cfg] of Object.entries(R.SPRITE_CAST || {})) {
    if (!actors[id]) continue;
    try {
      const A = window.__ASSETS?.cast?.[cfg.asset];
      const manifest = A?.manifest ?? await (await fetch(cfg.manifest)).json();
      const body = await loadSpriteBody({
        sheetUrl: A?.sheet ?? cfg.sheet, manifest, height: cfg.height, face: cfg.face,
      });
      if (body) actors[id].body = body;
    } catch { /* the puppet stands in */ }
  }
  if (voice?.manifest) attachVoice(cast(), voice);
}

// The linter runs before the game does. A room whose puzzle graph is
// incoherent should never reach a player, and finding out at load is the
// difference between a five-second fix and a playtest report.
// Every room's graph, not just the one that happens to load first. A second
// room whose puzzle is unwinnable is exactly as unshippable as the first.
const report = Object.entries(ROOMS).map(([id, r]) => [id, lint(r.PUZZLE)])
  .reduce((acc, [id, rep]) => ({
    problems: acc.problems.concat(rep.problems.map((p) => ({ ...p, msg: `[${id}] ${p.msg}` }))),
    longest: Math.max(acc.longest, rep.longest),
    nodes: acc.nodes + Object.keys(ROOMS[id].PUZZLE.nodes).length,
  }), { problems: [], longest: 0, nodes: 0 });
for (const p of report.problems) console[p.level === 'error' ? 'error' : 'warn']('[puzzle] ' + p.msg);
if (report.problems.some((p) => p.level === 'error')) {
  document.getElementById('fatal').textContent =
    'Puzzle graph is unwinnable:\n' + report.problems.map((p) => '  ' + p.msg).join('\n');
  document.getElementById('fatal').hidden = false;
}
console.log(`[puzzle] ${Object.keys(ROOMS).length} rooms, ${report.nodes} nodes, longest chain ${report.longest}, ${report.problems.length} problems`);

// --- input ------------------------------------------------------------------

let mouse = { x: 0, y: 0, rx: 0, ry: 0 };
let hoverSpot = null;
// Long enough that a deliberate second click lands, short enough that walking
// somewhere and then changing your mind is not read as a sprint.
const DOUBLE_CLICK_MS = 420;
let lastFloorClick = { t: -1e9, x: 0, y: 0 };

function toStage(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * VIEW.w,
    y: ((e.clientY - r.top) / r.height) * VIEW.h,
  };
}

canvas.addEventListener('pointermove', (e) => {
  const p = toStage(e);
  mouse = { x: p.x, y: p.y, rx: p.x + room.camX, ry: p.y };
  coin.move(p.x, p.y);
  menu.move(p.x, p.y);
  inv.hover = inv.hit(p.x, p.y, state.inventory);
  hoverSpot = (!coin.open && !menu.active && !inv.contains(p.x, p.y, state.inventory)) ? hotspotUnder() : null;
  editor?.move(mouse);
});

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const p = toStage(e);
  const rp = { x: p.x + room.camX, y: p.y };

  if (editor?.active && editor.pointerDown(rp, e)) return;

  if (menu.active) { menu.click(p.x, p.y); return; }

  // A click during a running interaction skips the current line. Never
  // queueing and never ignoring is what stops dialogue feeling like a cutscene
  // you are locked out of.
  if (seq.busy) {
    if (cast().some((a) => a.line)) voice.stop();
    for (const a of cast()) if (a.line) a.line.until = 0;
    return;
  }

  if (coin.open) {
    // Read the target before picking: pick() closes the coin, and closing it
    // clears the target.
    const target = coin.target;
    const verb = coin.pick(p.x, p.y);
    if (verb && target) doVerb(verb, target);
    return;
  }

  // Inventory strip: click to select, click again to put away. Only clicks
  // that land on the strip as drawn are consumed — see Inventory.contains.
  if (inv.contains(p.x, p.y, state.inventory)) {
    const item = inv.hit(p.x, p.y, state.inventory);
    if (item) inv.selected = inv.selected === item ? null : item;
    return;
  }

  const spot = hotspotUnder();

  if (inv.selected) {
    if (spot) useItemOn(inv.selected, spot);
    else inv.selected = null;
    return;
  }

  // An exit is a door, not a thing to have opinions about. Offering look, use
  // and talk on the way out of a room is the verb coin asking which of three
  // ways you would like to leave, and the answer is always the same one — so
  // a single click takes it.
  if (spot?.exit) { doVerb('use', spot); return; }

  if (spot) { coin.show(p.x, p.y, spot); return; }

  // Double-click to run. Detected here rather than through the `dblclick`
  // event because every other click in this game is decided on pointerdown,
  // and mixing the two would make the second click of a pair arrive after the
  // walk it is trying to upgrade has already started.
  const now = performance.now();
  const again = now - lastFloorClick.t < DOUBLE_CLICK_MS
    && Math.hypot(rp.x - lastFloorClick.x, rp.y - lastFloorClick.y) < 70;
  lastFloorClick = { t: now, x: rp.x, y: rp.y };
  actors.player.walkTo(room.walk, rp.x, rp.y, null, again);
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.key === '`' || e.key === '~') { editor.toggle(); return; }
  if (editor.active && editor.key(e)) return;
  if (e.key === 'Escape') { coin.hide(); inv.selected = null; }
  if (e.key === 'm') { voice.muted = !voice.muted; voice.stop(); toast(voice.muted ? 'voice off' : 'voice on'); }
  if (e.key === 's' && e.ctrlKey) { e.preventDefault(); save(); }
  if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); load(); }
});

// --- targets and verbs ------------------------------------------------------

// Grout is an actor, not a hotspot, so he needs his own hit test. Actors are
// hit against a box derived from their scale rather than a declared rect —
// otherwise the box is wrong the moment they walk upstage.
function actorBox(a) {
  const s = room.scaleAt(a.y);
  // The box comes from the frame being drawn, not from a constant. It was
  // 178 tall and 92 wide whatever the actor was doing, which was already a
  // guess and became a wrong one twice over: the figures are drawn taller now,
  // and Grout spends the back half of the game asleep on the ground, where a
  // standing-man box floats above him and the click lands on the dock.
  const b = a.body?.boxAt?.(a) ?? R.NPCS?.[a.id]?.box ?? { w: 92, h: a.height ?? 178 };
  const w = b.w * s, h = b.h * s;
  return { x: a.x - w / 2, y: a.y - h, w, h };
}

function hotspotUnder() {
  // People before scenery, and every person the room declared rather than one
  // named in the wiring. Last declared wins, as with hotspots, so a cat sitting
  // on a barrel is reachable over the barrel.
  for (const id of npcIds().reverse()) {
    const a = actors[id];
    if (!a?.visible) continue;
    const b = actorBox(a);
    if (mouse.rx >= b.x && mouse.rx <= b.x + b.w && mouse.ry >= b.y && mouse.ry <= b.y + b.h) {
      return { id, name: a.name, actor: a, npc: true, at: R.NPCS[id].approach(a) };
    }
  }
  return room.hotspotAt(mouse.rx, mouse.ry);
}

// Approach before acting. Adventure games that let you look at things from
// across the room feel like a database browser; walking there first is most of
// what makes the world feel inhabited.
function* approach(spot) {
  if (!spot.at) return;
  const P = actors.player;
  if (Math.hypot(P.x - spot.at.x, P.y - spot.at.y) > 24) {
    yield walk(P, room.walk, spot.at.x, spot.at.y);
  }
  // The hotspot's own centre is what "face it" means when the cast has no back
  // view: the rear-wall hotspots all ask for 'back', and a profile aimed at
  // the thing is the honest reading of that.
  const towardX = spot.rect ? spot.rect[0] + spot.rect[2] / 2 : null;
  if (spot.at.facing) yield face(P, spot.at.facing, towardX);
}

function doVerb(verb, spot) {
  if (spot.npc) return npcVerb(spot.id, verb);
  const handler = spot.verbs?.[verb];
  seq.start((function* () {
    yield* approach(spot);
    if (handler) { yield* handler(g); return; }
    yield say(actors.player, DEFAULTS[verb](spot.name));
  })());
}

// One path for every person in every room. A room's NPC entry says where to
// stand, what look and use do, and what talking to them is; anything it does
// not answer falls through to the conversation.
function npcVerb(id, verb) {
  const npc = R.NPCS[id];
  const a = actors[id];
  seq.start((function* () {
    yield* approach({ at: npc.approach(a) });
    const h = npc.verbs?.[verb];
    if (h) { yield* h(g); return; }
    if (npc.tree) { yield* startDialogue(id); return; }
    yield say(actors.player, DEFAULTS[verb](a.name));
  })());
}

const DEFAULTS = {
  look: (n) => `It's ${n}. It is exactly as interesting as it looks.`,
  use: (n) => `I can't think of anything clever to do with ${n}.`,
  talk: (n) => `${n[0].toUpperCase() + n.slice(1)} is not much of a conversationalist.`,
};

function useItemOn(item, spot) {
  inv.selected = null;
  // A room's people take items too — giving a fish to a cook and puffing
  // pepper at a cat are both "use this on that", and only hotspots could do it
  // while the only NPC in the game was one you talked to.
  const handler = spot.useWith?.[item] ?? (spot.npc ? R.NPCS[spot.id]?.useWith?.[item] : null);
  seq.start((function* () {
    yield* approach(spot);
    if (handler) { yield* handler(g); return; }
    yield say(actors.player, PICK_REFUSAL(item, spot.name));
  })());
}

const REFUSALS = [
  (i, n) => `Using the ${i} on ${n} would achieve nothing but noise.`,
  (i, n) => `The ${i} and ${n} have no future together.`,
  (i, n) => `I've tried that sort of thing before. There was a fine.`,
];
let refusalIdx = 0;
const PICK_REFUSAL = (i, n) => REFUSALS[refusalIdx++ % REFUSALS.length](i, n);

// --- dialogue ---------------------------------------------------------------

function* startDialogue(id) {
  const npc = R.NPCS[id];
  if (npc.greeting) yield* npc.greeting(g);
  // A tree that comes back empty is a person with nothing left to say, which
  // is how a conversation ends without the room having to special-case it.
  if (!npc.tree || !npc.tree(g).length) return;
  yield run(() => showMenu(id));
}

function showMenu(id) {
  const npc = R.NPCS[id];
  const opts = npc.tree(g);
  if (!opts.length) return;
  menu.show(opts, (opt) => {
    if (opt.id === 'bye') { seq.cancel(); return; }
    seq.start((function* () {
      yield* npc.line(g, opt);
      if (npc.tree(g).length) yield run(() => showMenu(id));
    })());
  });
}

// --- save -------------------------------------------------------------------

const SLOT = 'monkey.dock.save';
function save() {
  localStorage.setItem(SLOT, state.serialize({ room: here, player: { x: actors.player.x, y: actors.player.y } }));
  toast('saved');
}
function load() {
  const raw = localStorage.getItem(SLOT);
  if (!raw) { toast('no save'); return; }
  const d = state.restore(raw);
  if (!d) { toast('bad save'); return; }
  seq.cancel(); menu.hide(); coin.hide(); inv.selected = null;
  // The room is part of the save now — a game saved in the galley that came
  // back on the dock would be a worse bug than not saving at all. Everything
  // else the room implies (which people are in it, what pose the flags put
  // them in) is rebuilt by the door code rather than stored.
  (async () => {
    if (d.room && d.room !== here) await goTo(d.room, 'start');
    Object.assign(actors.player, { x: d.player.x, y: d.player.y });
    actors.player.stop();
    R.applyState?.(room, state, g);
    buildRoom();
    toast('loaded');
  })();
}

let toastText = null, toastT = 0;
function toast(t) { toastText = t; toastT = 1.6; }

// --- loop -------------------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  seq.update(dt);
  for (const a of cast()) a.update(dt, room);

  // Doors are taken here, between frames, rather than inside the script step
  // that opened one — the sequencer is mid-step when it fires, and tearing the
  // room out from under a running generator ends a walk in a room that no
  // longer exists.
  //
  // The loop stops for the duration and is restarted by the move, rather than
  // running on over a half-built room. Returning without doing that was a
  // freeze: the next frame is only ever scheduled at the bottom of this
  // function, so an early return is the end of the game.
  if (pendingMove) {
    const m = pendingMove;
    pendingMove = null;
    goTo(m.id, m.from).then(() => { last = performance.now(); requestAnimationFrame(frame); });
    return;
  }

  room.update(dt);
  room.follow(actors.player, dt);
  coin.update(dt);
  if (toastT > 0) toastT -= dt;

  ctx.clearRect(0, 0, VIEW.w, VIEW.h);
  room.render(ctx, cast());
  editor.render(ctx);
  for (const a of cast()) drawSpeech(ctx, a, room, VIEW);
  drawHud();
  inv.render(ctx, state.inventory, art.ICONS);
  coin.render(ctx, VIEW);
  menu.render(ctx);
  if (state.get('sailed')) drawWin();

  requestAnimationFrame(frame);
}

function drawHud() {
  // An exit gets a mark on the room as well as a word at the top: the label
  // says what it is, the chevron says it is a way out, and the second one is
  // the one you read without looking away from where you are pointing.
  if (hoverSpot?.exit && !seq.busy && !coin.open && !menu.active) {
    const [rx, ry, rw, rh] = hoverSpot.rect;
    const cx = rx + rw / 2 - room.camX, cy = ry + rh / 2;
    const dir = hoverSpot.exit.dir === 'left' ? -1 : hoverSpot.exit.dir === 'right' ? 1 : 0;
    const bob = Math.sin(performance.now() / 260) * 4;
    ctx.save();
    ctx.translate(cx + (dir ? dir * bob : 0), cy + (dir ? 0 : -bob));
    ctx.strokeStyle = '#f6d78a';
    ctx.lineWidth = 7; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 8;
    ctx.beginPath();
    if (dir) { ctx.moveTo(-12 * dir, -18); ctx.lineTo(12 * dir, 0); ctx.lineTo(-12 * dir, 18); }
    else { ctx.moveTo(-18, 12); ctx.lineTo(0, -12); ctx.lineTo(18, 12); }
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.font = '22px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let label = null;
  if (menu.active) label = null;
  else if (inv.selected && hoverSpot) label = `Use ${inv.selected.replace(/-/g, ' ')} on ${hoverSpot.name}`;
  else if (inv.selected) label = `Use ${inv.selected.replace(/-/g, ' ')} with...`;
  else if (inv.hover) label = inv.hover.replace(/-/g, ' ');
  else if (hoverSpot) label = hoverSpot.exit ? `Go to ${hoverSpot.name}` : hoverSpot.name;
  if (label && !seq.busy) {
    ctx.lineWidth = 4; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(6,4,3,0.9)';
    ctx.strokeText(label, VIEW.w / 2, 16);
    ctx.fillStyle = '#e6d3a8';
    ctx.fillText(label, VIEW.w / 2, 16);
  }
  if (toastT > 0) {
    ctx.globalAlpha = Math.min(1, toastT);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9d8a6a';
    ctx.fillText(toastText, VIEW.w - 18, 16);
  }
  ctx.restore();
}

function drawWin() {
  ctx.save();
  ctx.fillStyle = 'rgba(6,5,4,0.82)';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f6d78a';
  ctx.font = 'italic 58px Georgia, serif';
  ctx.fillText('Aboard the Errant Kipper', VIEW.w / 2, VIEW.h / 2 - 20);
  ctx.font = '24px Georgia, serif';
  ctx.fillStyle = '#c9a86a';
  ctx.fillText('two rooms, twelve puzzle steps, one very smug cat', VIEW.w / 2, VIEW.h / 2 + 40);
  ctx.restore();
}

// --- go ---------------------------------------------------------------------

// Boot. The backdrop, the props and the cast all come from whichever room the
// game starts in, and the same three lines run again on every door.
backdrop = await loadBackdrop(here);
props = await loadProps();
// Generated items are their own inventory icons. The thing on the table and
// the thing in the bag are one image, which is the point of generating it once
// instead of drawing it twice and hoping they resemble each other.
registerPropIcons(props, art.ICONS, art.imageIcon, { pepper: 'pepperpot', kipper: 'kipper' });
await buildCast();

const voiced = await voice.load();
if (voiced) attachVoice(cast(), voice);
console.log(voiced
  ? `[voice] ${Object.keys(voice.manifest.lines).length} recorded lines, measured timings`
  : '[voice] no recordings — line lengths estimated from text (run tools/voices.mjs)');
console.log(`[art] backdrop: ${backdrop.kind} (${backdrop.note})`);
// The art-pixel figure is the character's own, measured against the sheet it
// came from — PIXEL_BLOCK belongs to the procedural puppet and reporting it
// here described a code path the cast no longer takes. The backdrop's grid is
// 2px, so these two numbers should read 2.
console.log(`[cast] ${here}: ${cast().filter((a) => a.body).length} baked bodies, `
  + `${cast().filter((a) => !a.body).length} drawn puppets, `
  + cast().map((a) => a.body
      ? ` ${a.id} at ${((a.body.drawHeight ?? 0) / a.body.figureH).toFixed(2)}px art pixels`
      : '').join(','));
// Reported on the page as well as the console. A backdrop that quietly fell
// back to the still looks almost right, and "almost right" is the one failure
// nobody reports accurately.
const backdropBadge = document.getElementById('backdrop-state');
const showBackdrop = () => {
  if (!backdropBadge) return;
  backdropBadge.innerHTML = `<b>Backdrop</b> ${backdrop.kind === 'video' ? 'animated loop' : backdrop.note}`;
};
showBackdrop();
document.addEventListener('backdropchange', showBackdrop);
buildRoom();
if (backdrop.kind === KIND.NONE) console.log('[art] no backdrop — run tools/scene.mjs still && tools/scene.mjs loop');
// Exposed for tools/check.mjs, which plays the room through to the end by
// clicking real pixels. A prototype that cannot be driven by a script cannot
// be regression-tested, and an adventure game with no completion test breaks
// silently the first time a flag is renamed.
window.__monkey = { g, state, coin, inv, menu, seq, lint: report, room: () => room, get actors() { return actors; }, room_id: () => here, rooms: () => Object.keys(ROOMS), backdrop: () => backdrop.kind, voiced, props: () => Object.keys(props).length,
  bodies: () => cast().filter((a) => a.body).length,
  puppets: () => cast().filter((a) => !a.body).length,
  goTo: (id, from) => goTo(id, from),
  pixelBlock: () => PIXEL_BLOCK,
  // Does an actor actually put pixels on the canvas? Every previous check
  // asked whether a body was BOUND, which a sprite that draws nothing passes
  // just as well — and did, for a whole release. Sampling the box the actor
  // claims to occupy and comparing it against the same box with the actor
  // hidden is the only question that cannot be answered by a null renderer.
  // Strides per second at full speed. Depth cancels — both the distance
  // travelled and the stride length scale with it — so this is one number per
  // character, and a wrong one is the difference between walking and sprinting
  // on the spot.
  cadence: (who, gait = 'walk') => {
    const a = actors[who];
    if (!a) return 0;
    const speed = a.speed * (gait === 'run' ? a.runSpeed : 1);
    const stride = a.body?.strideFor?.(gait)
      || (a.cadence?.[gait] ? speed / a.cadence[gait] : a.stride);
    return +(speed / stride).toFixed(2);
  },
  // The drawn height of an actor at a given depth. Rounding the depth scale to
  // a whole-number zoom made this jump by a third at one point on the dock —
  // a pop the player sees and no count catches.
  spriteHeightAt: (who, y) => {
    const a = actors[who];
    if (!a) return 0;
    const c = document.querySelector('canvas');
    const g = c.getContext('2d');
    const ox = a.x, oy = a.y;
    a.x = 640; a.y = y;
    g.clearRect(0, 0, VIEW.w, VIEW.h);
    a.render(g, room);
    const d = g.getImageData(500, 200, 280, 520).data;
    let top = 1e9, bot = -1;
    for (let yy = 0; yy < 520; yy++) {
      for (let xx = 0; xx < 280; xx++) {
        if (d[(yy * 280 + xx) * 4 + 3] > 40) { if (yy < top) top = yy; if (yy > bot) bot = yy; break; }
      }
    }
    a.x = ox; a.y = oy;
    return bot < 0 ? 0 : bot - top + 1;
  },
  drawn: (who) => {
    const a = actors[who];
    if (!a) return 0;
    const c = document.querySelector('canvas');
    const g = c.getContext('2d');
    // The window follows the pose. It was a fixed 130x210 box around the feet,
    // which is a standing person — and Grout spends the second half of the
    // game asleep on the ground, half that tall and wider, where a standing
    // box samples mostly empty dock and could report a drawn character as
    // absent or an absent one as drawn.
    const b = a.body?.boxAt?.(a) ?? { w: 130, h: 210 };
    const sc = room.scaleAt(a.y);
    const w = Math.ceil(b.w * sc) + 16, h = Math.ceil(b.h * sc) + 16;
    const sx = Math.max(0, Math.round(a.x - w / 2));
    const sy = Math.max(0, Math.round(a.y - h + 8));
    const grab = () => g.getImageData(sx, sy, w, h).data;
    const paintRoom = () => {
      ctx.clearRect(0, 0, VIEW.w, VIEW.h);
      room.render(ctx, cast());
    };
    paintRoom();
    const before = grab();
    const was = a.visible;
    a.visible = false;
    paintRoom();
    const after = grab();
    a.visible = was;
    paintRoom();
    let diff = 0;
    for (let i = 0; i < before.length; i += 4 * 7) {
      if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1])
        + Math.abs(before[i + 2] - after[i + 2]) > 24) diff++;
    }
    return diff;
  },
  // How many screen pixels one of the character's own art pixels covers, at
  // the depth it is standing at. The backdrop is painted on a 2px grid
  // (measured — tools/pixel-grid.mjs on the plate), so this wants to be 2:
  // below it the character is being reduced and comes out grainy, above it the
  // blocks are bigger than the scene's and it reads as pasted on. It is a
  // number rather than a judgement precisely because judging it by eye is what
  // produced an 80px sheet.
  artPixel: (who) => {
    const a = actors[who];
    if (!a?.body) return 0;
    return +((a.body.figureH ? (R.SPRITE_CAST[who].height
      / a.body.figureH) * room.scaleAt(a.y) : 0)).toFixed(2);
  },
  // How far the feet wander sideways across a clip, in screen pixels.
  //
  // The atlas held every frame's HEAD at one column, on the reasoning that a
  // swinging arm moves the bounding box without moving the character. True of
  // a walk; false of an idle whose head sways, where holding the head still
  // slides the whole body — and what that looks like is a man standing on the
  // spot with shuffling feet, which is what shipped. The cutter now picks the
  // steadier end per clip, and this is the number that says whether it worked.
  //
  // It steps the clip by hand rather than waiting on the wall clock, so the
  // answer is the same every run.
  footDrift: (who, clip = 'idle') => window.__monkey.footTrack(who, clip).x,

  // Where the feet sit, horizontally AND vertically, across a clip — in screen
  // pixels, stepping the clip by hand so the answer is the same every run.
  //
  // The horizontal number caught the atlas pinning every frame's head to one
  // column, which slid the whole body for a character whose idle sways its
  // head and never moves its feet. The vertical number is the same question
  // asked of the other axis: the cutter puts every figure's LOWEST pixel on
  // one row, which is the right rule only if the lowest pixel is a boot. A
  // coat hem, a dropped hand or a shadow that dips below the boots in some
  // frames and not others pins the wrong thing, and the boots then bob.
  footTrack: (who, clip = 'idle') => {
    const a = actors[who];
    if (!a?.body?.hasClip?.(clip)) return { x: -1, y: -1 };
    const c = document.querySelector('canvas');
    const g = c.getContext('2d');
    const keep = { x: a.x, y: a.y, clip: a.clip, clipT: a.clipT, state: a.state };
    a.x = 640; a.y = 690; a.state = 'idle';
    const scale = room.scaleAt(a.y);
    const box = a.body.boxAt(a);
    const w = Math.ceil(box.w * scale) + 40;
    const h = Math.ceil(box.h * scale) + 40;
    const sx = Math.max(0, Math.round(640 - w / 2));
    const sy = Math.max(0, Math.round(690 - h + 20));
    const band = Math.max(4, Math.round(box.h * scale * 0.12));
    const cx = [], bot = [];
    for (let i = 0; i < 24; i++) {
      a.clip = clip; a.clipT = i / 12;
      g.clearRect(0, 0, VIEW.w, VIEW.h);
      a.render(g, room);
      const d = g.getImageData(sx, sy, w, h).data;
      // The GROUND row, measured the way the packer pins it: walk up from the
      // bottom until enough of the character has been passed to be a foot.
      // Reading the lowest opaque pixel instead reports on a speck of leftover
      // background removal, which moves whether or not the boots do.
      let low = -1, seen = 0;
      for (let y = h - 1; y >= 0; y--) {
        for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 40) seen++;
        if (seen >= 20) { low = y; break; }
      }
      if (low < 0) continue;
      bot.push(low);
      let lo = 1e9, hi = -1;
      for (let y = Math.max(0, low - band); y <= low; y++) for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 40) { if (x < lo) lo = x; if (x > hi) hi = x; }
      }
      if (hi >= lo) cx.push((lo + hi) / 2);
    }
    Object.assign(a, keep);
    const sp = (v) => (v.length ? +(Math.max(...v) - Math.min(...v)).toFixed(1) : -1);
    return { x: sp(cx), y: sp(bot) };
  },

  // Does a planted foot stay planted?
  //
  // This is the whole claim of measuring the stride: one cycle of animation
  // covers one stride of ground, so the foot that is on the dock does not
  // slide along it. Anything else is foot-skate, and it is the single thing
  // that makes generated walk art look wrong.
  //
  // Only pairs of frames where the CELL ACTUALLY CHANGED are compared. The
  // simulation runs faster than the clip, so most steps redraw the same
  // picture at a new position — the foot moves with the body by definition,
  // and pooling those measures the frame rate rather than the stride. That
  // flaw made an earlier version of this read 3.4 to 4.7 pixels across a 3.6x
  // sweep of stride: a flat curve, which was taken as evidence that the art
  // had no stance to lock to. It has one.
  // What the engine paces from, against what the sheet says.
  //
  // These have to be the same number: one cycle of animation must cover one
  // stride of ground, and the sheet's stride is measured off the art at cut
  // time (how fast a planted foot slides backward through the sprite, times
  // the cycle length). If they diverge, the legs describe one distance and the
  // character travels another — which is what "the run animation is very fast
  // but she does not move that far" was.
  //
  // This is asserted rather than a foot-lock measured on the canvas, and that
  // is a deliberate retreat: a foot-lock metric was built twice and neither
  // version could discriminate. The median over changed frames read a flat
  // 13px across a 4x sweep of stride because two thirds of a cycle is the rear
  // foot handing over to the other leg, which is a jump and not a slide; a low
  // percentile read a flat 1-3px because it picked up frames where rounding
  // happened to hold the foot still. A check that answers the same whatever it
  // measures is worse than no check, so what is asserted here is the thing
  // that can be established exactly.
  strideOf: (who, gait = 'walk') => {
    const a = actors[who];
    if (!a) return null;
    const speed = a.speed * (gait === 'run' ? a.runSpeed : 1);
    const sheet = a.body?.strideFor?.(gait) ?? null;
    const engine = sheet || (a.cadence?.[gait] ? speed / a.cadence[gait] : a.stride);
    return { sheet: sheet && +sheet.toFixed(1), engine: +engine.toFixed(1),
      speed: Math.round(speed), cadence: +(speed / engine).toFixed(2) };
  },

  seamWeight,
  // Paint one frame on demand, so a check can look at what a given state draws
  // without waiting for the loop to come round to it.
  render: () => {
    ctx.clearRect(0, 0, VIEW.w, VIEW.h);
    room.render(ctx, cast());
    for (const a of cast()) drawSpeech(ctx, a, room, VIEW);
  },
  // Does a generated prop actually put pixels on the canvas?
  //
  // Same question as drawn() asks of an actor, and for the same reason: every
  // prop is loaded from assets/props/<name>.png and some fall back to
  // procedural art if that image fails, so "the prop file is there" and "the
  // prop is on screen" are different claims. The room says where the sprite
  // sits and how to make it come and go; this diffs the box across that
  // toggle, which is the one form of the question a missing file cannot pass.
  // The state is saved and restored around it so a probe leaves no trace.
  //
  // The loaded sprite's own dimensions. propDrawn alone cannot tell a
  // generated cup from the procedural one standing in for a missing file —
  // both put pixels in the box — so the size of the image that actually loaded
  // is what separates them.
  propSize: (name) => {
    const img = props[name];
    return img ? { w: img.width, h: img.height } : null;
  },
  // Whether the inventory icon for an item is the generated sprite or a
  // hand-painted stand-in. The bug this caught was a pepper pot drawn one way
  // on the table and another way in the bag; one image for both is the fix,
  // and this is the assertion that the fix is still in force.
  // The backdrop object itself, so a test can lie to it. The galley copies a
  // piece of the painting over the pepper pot the painting drew, and whether
  // that copy is taken once or every frame is the difference between a patch
  // that lives in the firelight and a frozen rectangle sitting in it. No
  // automated run can tell them apart from the video, because headless
  // Chromium cannot decode h.264 — so the test drives the seam by hand.
  backdropObj: () => backdrop,
  iconSource: (item) => (art.ICONS[item]?.fromSprite ? 'sprite' : art.ICONS[item] ? 'painted' : null),
  propDrawn: (name) => {
    const probe = R.SPRITE_PROBES?.[name];
    if (!probe) return 0;
    const [x, y, w, h] = probe.rect;
    const c = document.querySelector('canvas');
    const gg = c.getContext('2d');
    const paintRoom = () => { ctx.clearRect(0, 0, VIEW.w, VIEW.h); room.render(ctx, cast()); };
    const saved = state.serialize();
    probe.hide(state);
    paintRoom();
    const before = gg.getImageData(x, y, w, h).data;
    probe.show(state);
    paintRoom();
    const after = gg.getImageData(x, y, w, h).data;
    state.restore(saved);
    paintRoom();
    let diff = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1])
        + Math.abs(before[i + 2] - after[i + 2]) > 24) diff++;
    }
    return diff;
  },

  // Where the last line of dialogue was printed, against where the character
  // it belonged to was drawn. Text over the body is the kind of fault that is
  // obvious on screen and invisible to every other assertion here.
  speechBox: (who) => actors[who]?.lastSpeechBox ?? null,
  // The shape the actor is drawn as right now, in room units. A pose change is
  // the one animation event that alters the silhouette rather than the frame,
  // so it is the only one a frame counter cannot see: a Grout who is "asleep"
  // but still standing passes every clip assertion and is plainly wrong.
  poseBox: (who) => {
    const a = actors[who];
    const b = a?.body?.boxAt?.(a);
    return b ? { w: Math.round(b.w), h: Math.round(b.h), clip: a.clip } : null;
  },
  // Diagnostics: what the pointer last resolved to, which is the only way to
  // tell a bad hit test from a bad coordinate mapping.
  mouse: () => ({ ...mouse }), hover: () => hoverSpot?.id ?? null };
requestAnimationFrame(frame);
