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
import { loadProps } from './art/props.js';
import { loadBackdrop, KIND } from './art/backdrop.js';
import * as dock from './game/dock.js';

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

const player = new Actor(dock.CAST.player);
const grout = new Actor(dock.CAST.grout);

// ?editor=1 opens the annotation overlay at load, which is how a walk area
// gets traced over a freshly generated backdrop.
const EDITOR_AT_LOAD = new URLSearchParams(location.search).get('editor') === '1';
let room, editor;
let props = {};
let backdrop = null;
const voice = new Voice();
const g = {
  player, grout, state, seq, VIEW, voice,
  get room() { return room; },
  onWorldChange: () => dock.applyPierState(room, state),
  win: () => { state.set('aboard', true); },
};

function buildRoom() {
  room = new Room(dock.makeRoomDef(state, backdrop, props), VIEW);
  dock.applyPierState(room, state);
  editor = new Editor(room, VIEW);
  if (EDITOR_AT_LOAD) editor.active = true;
}

// The linter runs before the game does. A room whose puzzle graph is
// incoherent should never reach a player, and finding out at load is the
// difference between a five-second fix and a playtest report.
const report = lint(dock.PUZZLE);
for (const p of report.problems) console[p.level === 'error' ? 'error' : 'warn']('[puzzle] ' + p.msg);
if (report.problems.some((p) => p.level === 'error')) {
  document.getElementById('fatal').textContent =
    'Puzzle graph is unwinnable:\n' + report.problems.map((p) => '  ' + p.msg).join('\n');
  document.getElementById('fatal').hidden = false;
}
console.log(`[puzzle] ${Object.keys(dock.PUZZLE.nodes).length} nodes, longest chain ${report.longest}, ${report.problems.length} problems`);

// --- input ------------------------------------------------------------------

let mouse = { x: 0, y: 0, rx: 0, ry: 0 };
let hoverSpot = null;

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
    if (player.line || grout.line) voice.stop();
    if (player.line) player.line.until = 0;
    if (grout.line) grout.line.until = 0;
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

  if (spot) { coin.show(p.x, p.y, spot); return; }

  player.walkTo(room.walk, rp.x, rp.y);
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
  const h = 178 * s;
  return { x: a.x - 46 * s, y: a.y - h, w: 92 * s, h };
}

function hotspotUnder() {
  if (grout.visible) {
    const b = actorBox(grout);
    if (mouse.rx >= b.x && mouse.rx <= b.x + b.w && mouse.ry >= b.y && mouse.ry <= b.y + b.h) {
      return { id: 'grout', name: grout.name, actor: grout, at: { x: grout.x + 130, y: grout.y, facing: 'left' } };
    }
  }
  return room.hotspotAt(mouse.rx, mouse.ry);
}

// Approach before acting. Adventure games that let you look at things from
// across the room feel like a database browser; walking there first is most of
// what makes the world feel inhabited.
function* approach(spot) {
  if (!spot.at) return;
  if (Math.hypot(player.x - spot.at.x, player.y - spot.at.y) > 24) {
    yield walk(player, room.walk, spot.at.x, spot.at.y);
  }
  if (spot.at.facing) yield face(player, spot.at.facing);
}

function doVerb(verb, spot) {
  if (spot.id === 'grout') return groutVerb(verb);
  const handler = spot.verbs?.[verb];
  seq.start((function* () {
    yield* approach(spot);
    if (handler) { yield* handler(g); return; }
    yield say(player, DEFAULTS[verb](spot.name));
  })());
}

function groutVerb(verb) {
  seq.start((function* () {
    yield* approach({ at: { x: grout.x + 140, y: 690, facing: 'left' } });
    if (verb === 'look') {
      if (state.get('grout-asleep')) { yield say(player, "Asleep, and smiling. A rare combination on this island."); return; }
      yield say(player, "Harbourmaster Grout. Built like a bollard and about as movable.", 4.2);
      yield say(player, "He has the look of a man eleven hours into a twelve-hour shift.", 4.0);
      return;
    }
    if (verb === 'use') { yield say(player, "I'm not laying hands on a man that size."); return; }
    yield* startDialogue();
  })());
}

const DEFAULTS = {
  look: (n) => `It's ${n}. It is exactly as interesting as it looks.`,
  use: (n) => `I can't think of anything clever to do with ${n}.`,
  talk: (n) => `${n[0].toUpperCase() + n.slice(1)} is not much of a conversationalist.`,
};

function useItemOn(item, spot) {
  inv.selected = null;
  const handler = spot.useWith?.[item];
  seq.start((function* () {
    yield* approach(spot);
    if (handler) { yield* handler(g); return; }
    yield say(player, PICK_REFUSAL(item, spot.name));
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

function* startDialogue() {
  yield* dock.groutGreeting(g);
  if (state.get('grout-asleep')) return;
  yield run(() => showMenu());
}

function showMenu() {
  const opts = dock.groutTree(g);
  menu.show(opts, (opt) => {
    if (opt.id === 'bye') { seq.cancel(); return; }
    seq.start((function* () {
      yield* dock.groutLine(g, opt);
      if (!state.get('grout-asleep')) yield run(() => showMenu());
    })());
  });
}

// --- save -------------------------------------------------------------------

const SLOT = 'monkey.dock.save';
function save() {
  localStorage.setItem(SLOT, state.serialize({ player: { x: player.x, y: player.y } }));
  toast('saved');
}
function load() {
  const raw = localStorage.getItem(SLOT);
  if (!raw) { toast('no save'); return; }
  const d = state.restore(raw);
  if (!d) { toast('bad save'); return; }
  player.x = d.player.x; player.y = d.player.y;
  player.stop();
  seq.cancel(); menu.hide(); coin.hide(); inv.selected = null;
  grout.visible = !state.get('grout-asleep');
  buildRoom();
  toast('loaded');
}

let toastText = null, toastT = 0;
function toast(t) { toastText = t; toastT = 1.6; }

// --- loop -------------------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  seq.update(dt);
  player.update(dt, room);
  grout.update(dt, room);
  room.update(dt);
  room.follow(player, dt);
  coin.update(dt);
  if (toastT > 0) toastT -= dt;

  ctx.clearRect(0, 0, VIEW.w, VIEW.h);
  room.render(ctx, [player, grout]);
  editor.render(ctx);
  drawSpeech(ctx, player, room, VIEW);
  drawSpeech(ctx, grout, room, VIEW);
  drawHud();
  inv.render(ctx, state.inventory, art.ICONS);
  coin.render(ctx);
  menu.render(ctx);
  if (state.get('aboard')) drawWin();

  requestAnimationFrame(frame);
}

function drawHud() {
  ctx.save();
  ctx.font = '22px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let label = null;
  if (menu.active) label = null;
  else if (inv.selected && hoverSpot) label = `Use ${inv.selected.replace(/-/g, ' ')} on ${hoverSpot.name}`;
  else if (inv.selected) label = `Use ${inv.selected.replace(/-/g, ' ')} with...`;
  else if (inv.hover) label = inv.hover.replace(/-/g, ' ');
  else if (hoverSpot) label = hoverSpot.name;
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
  ctx.fillText('end of the slice — four puzzle steps, one conversation, one room', VIEW.w / 2, VIEW.h / 2 + 40);
  ctx.restore();
}

// --- go ---------------------------------------------------------------------

backdrop = await loadBackdrop();
props = await loadProps();
const voiced = await voice.load();
if (voiced) attachVoice([player, grout], voice);
console.log(voiced
  ? `[voice] ${Object.keys(voice.manifest.lines).length} recorded lines, measured timings`
  : '[voice] no recordings — line lengths estimated from text (run tools/voices.mjs)');
console.log(`[art] backdrop: ${backdrop.kind}`);
buildRoom();
if (backdrop.kind === KIND.NONE) console.log('[art] no backdrop — run tools/scene.mjs still && tools/scene.mjs loop');
// Exposed for tools/check.mjs, which plays the room through to the end by
// clicking real pixels. A prototype that cannot be driven by a script cannot
// be regression-tested, and an adventure game with no completion test breaks
// silently the first time a flag is renamed.
window.__monkey = { g, state, coin, inv, menu, seq, lint: report, room: () => room, actors: { player, grout }, backdrop: () => backdrop.kind, voiced, props: () => Object.keys(props).length,
  // Diagnostics: what the pointer last resolved to, which is the only way to
  // tell a bad hit test from a bad coordinate mapping.
  mouse: () => ({ ...mouse }), hover: () => hoverSpot?.id ?? null };
requestAnimationFrame(frame);
