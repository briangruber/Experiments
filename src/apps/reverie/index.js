/*
 * The Reverie Network.
 *
 * The other kind of online service the era had: not a wall of text but a
 * painted world you walked around as a face you built yourself, with card
 * tables and board games in it. Halcyon carries it the way the text
 * services eventually carried these — as a place inside the service.
 *
 * Reverie is invented, like Halcyon. The backdrops and the flight over the
 * island are generated (tools/gen-assets.mjs); the faces are vectors.
 *
 * Nobody types at anybody here either: the same phrase book governs the
 * lands as governs the chat rooms.
 */

import { h, clear, $$ } from '../../core/dom.js';
import { openWindow } from '../../core/wm.js';
import * as A from '../../core/audio.js';
import { ART } from '../../assets/art.js';
import { faceSvg, faceFor, loadFace, saveFace, randomFace,
         PARTS, SKINS, HAIRS } from './faces.js';
import { createSayBox } from '../halcyon/say-box.js';
import { isPhrase } from '../halcyon/phrasebook.js';
import { screen, LIMITS } from '../../core/safety.js';
import { openCheckers } from './checkers-ui.js';
import { openSlots } from './slots.js';
import { openDawn } from './dawn.js';
import { openGolf } from './golf.js';

/* Every game in Reverie, and the thing that opens it. */
const GAMES = {
  checkers: { label: 'Checkers', open: openCheckers },
  golf:     { label: 'Crazy Golf', open: openGolf },
  slots:    { label: 'The Machine', open: openSlots },
  dawn:     { label: 'Dawn Patrol', open: openDawn },
};

export const LANDS = [
  { id: 'keep', name: "Jouster's Keep", art: 'rev_keep',
    blurb: 'Board games under the pennants',
    at: [42, 26], games: ['checkers'] },
  { id: 'boardwalk', name: 'The Boardwalk', art: 'rev_boardwalk',
    blurb: 'Crazy golf, lights on the water, and a machine that eats tokens',
    at: [66, 66], games: ['golf', 'slots'] },
  { id: 'cloud', name: 'Cloud Nine', art: 'rev_cloud',
    blurb: 'No games at all. Where everybody stands about and talks',
    at: [24, 62], games: [] },
  { id: 'airfield', name: 'Sky Squadron', art: 'rev_airfield',
    blurb: 'Two biplanes and a field at golden hour',
    at: [78, 34], games: ['dawn'] },
];

const roomOf = landId => 'rev-' + landId;

export function openReverie(session) {
  const win = openWindow({
    id: 'reverie', title: 'The Reverie Network', icon: 'globe',
    width: 660, height: 480, minWidth: 520, minHeight: 380,
    onClose: () => { leaveLand(); offs.forEach(fn => fn()); return true; },
  });

  const stage = h('div.rev');
  clear(win.body).append(stage);

  let face = loadFace();
  let land = null;             // the land we are standing in
  let bubbles = new Map();     // name -> timeout
  const offs = [];

  /* ── presence ──────────────────────────────────────────────────────── */

  function leaveLand() {
    if (!land) return;
    session.net.leave(roomOf(land.id));
    session.rooms.delete(roomOf(land.id));
    land = null;
  }

  function peopleIn(landId) {
    return session.net.roster(roomOf(landId));
  }

  /* The island should not read as deserted before you have been anywhere,
     so every land gets a population the first time you look at the map. */
  function primeIsland() {
    for (const l of LANDS) session.net.prime(roomOf(l.id));
  }

  /* ── the gate ──────────────────────────────────────────────────────── */

  function showGate() {
    leaveLand();
    clear(stage).append(h('div.rev-gate', {},
      h('div.rev-fly', { style: { backgroundImage: 'url(' + ART.rev_fly + ')' } }),
      h('div.rev-gate-panel', {},
        h('h1', {}, 'The Reverie Network'),
        h('p', {}, 'A painted island, four places to stand in it, and a face ' +
                   'you make yourself.'),
        face
          ? h('div.rev-gate-you', {},
              h('div.rev-face-big', {}, faceSvg(face, 84)),
              h('div', {},
                h('b', {}, session.name),
                h('span', {}, 'This is you.')))
          : h('p.rev-gate-nudge', {}, 'You will need a face before you can go in.'),
        h('div.rev-gate-btns', {},
          h('button.aol-btn', {
            type: 'button',
            onclick: () => { A.click(); face ? showMap() : showFaceMaker(); },
          }, face ? 'Enter Reverie' : 'Build a Face'),
          face ? h('button.aol-btn', {
            type: 'button', onclick: () => { A.click(); showFaceMaker(); },
          }, 'Change Face') : null))));
    A.announce('reverie');
  }

  /* ── the face maker ────────────────────────────────────────────────── */

  function showFaceMaker() {
    let draft = face ? { ...face } : randomFace();
    const preview = h('div.rev-face-big');

    const paint = () => { clear(preview).append(faceSvg(draft, 108)); };

    const row = (label, key, count, colours) => {
      const swatches = colours
        ? h('div.rev-swatches', {}, colours.map((c, i) =>
            h('button.rev-swatch', {
              type: 'button', style: { background: c },
              onclick: () => { draft[key] = i; paint(); markSwatches(); A.click(); },
              dataset: { i },
            })))
        : null;
      const stepper = !colours
        ? h('div.rev-stepper', {},
            h('button', { type: 'button', onclick: () => { draft[key] = (draft[key] + count - 1) % count; paint(); A.click(); } }, '◀'),
            h('span', {}, label),
            h('button', { type: 'button', onclick: () => { draft[key] = (draft[key] + 1) % count; paint(); A.click(); } }, '▶'))
        : h('div.rev-stepper-label', {}, label);
      return h('div.rev-part', {}, stepper, swatches);
    };

    function markSwatches() {
      $$('.rev-swatches', stage).forEach((g, gi) => {
        const key = gi === 0 ? 'skin' : 'hairColor';
        $$('.rev-swatch', g).forEach(b =>
          b.classList.toggle('on', Number(b.dataset.i) === draft[key]));
      });
    }

    clear(stage).append(h('div.rev-maker', {},
      h('div.rev-maker-left', {}, preview,
        h('div.rev-maker-name', {}, session.name)),
      h('div.rev-maker-right', {},
        h('h2', {}, 'Build a Face'),
        h('div.rev-parts', {},
          row('Skin', 'skin', SKINS.length, SKINS),
          row('Hair', 'hair', PARTS.hair.length),
          row('Hair colour', 'hairColor', HAIRS.length, HAIRS),
          row('Eyes', 'eyes', PARTS.eyes.length),
          row('Brows', 'brows', PARTS.brows.length),
          row('Nose', 'nose', PARTS.nose.length),
          row('Mouth', 'mouth', PARTS.mouth.length),
          row('Extras', 'extra', PARTS.extra.length)),
        h('div.rev-maker-btns', {},
          h('button.aol-btn.small', {
            type: 'button', onclick: () => { draft = randomFace(); paint(); markSwatches(); A.beep(); },
          }, 'Surprise Me'),
          h('button.aol-btn.small', {
            type: 'button',
            onclick: () => { face = draft; saveFace(face); A.startupChime(); showMap(); },
          }, 'This Is Me')))));
    paint();
    markSwatches();
  }

  /* ── the map ───────────────────────────────────────────────────────── */

  function showMap() {
    leaveLand();
    primeIsland();
    const marks = h('div.rev-marks');
    const tally = h('div.rev-tally');

    clear(stage).append(h('div.rev-map', {
      style: { backgroundImage: 'url(' + ART.rev_map + ')' },
    },
      marks,
      h('div.rev-map-bar', {},
        h('div.rev-map-you', {}, faceSvg(face, 30), h('b', {}, session.name)),
        tally,
        h('button.aol-btn.small', {
          type: 'button', onclick: () => { A.click(); showFaceMaker(); },
        }, 'Change Face'))));

    for (const l of LANDS) {
      const here = peopleIn(l.id).length;
      marks.append(h('button.rev-mark', {
        type: 'button', title: l.blurb,
        style: { left: l.at[0] + '%', top: l.at[1] + '%' },
        onclick: () => { A.doorOpen(); showLand(l); },
      },
        h('span.rev-mark-dot'),
        h('span.rev-mark-name', {}, l.name),
        h('span.rev-mark-count', {},
          (here ? here + ' here' : 'quiet') +
          ((l.games || []).length ? '  ·  ' + l.games.map(id => GAMES[id].label).join(', ') : ''))));
    }

    const total = LANDS.reduce((n, l) => n + peopleIn(l.id).length, 0);
    clear(tally).append(
      total
        ? h('span', {}, total + ' ' + (total === 1 ? 'person' : 'people') + ' on the island')
        : h('span', {}, 'Pick a place. Somebody will turn up.'));
  }

  /* ── a land ────────────────────────────────────────────────────────── */

  function showLand(l) {
    leaveLand();
    land = l;
    const room = roomOf(l.id);
    session.rooms.set(room, { ignored: new Set(), myColor: '#000080', roster: [] });

    const crowd = h('div.rev-crowd');
    const log = h('div.rev-log.scroll');
    const say = createSayBox({ onSend: text => speak(text), hint: 'Type what you mean' });

    const scene = h('div.rev-scene', {
      style: { backgroundImage: 'url(' + ART[l.art] + ')' },
    }, crowd);

    clear(stage).append(h('div.rev-land', {},
      h('div.rev-land-bar', {},
        h('button.rev-back', { type: 'button', onclick: () => { A.doorClose(); showMap(); } },
          '◀ The Island'),
        h('b', {}, l.name),
        (l.games || []).map(id => h('button.aol-btn.small', {
          type: 'button',
          onclick: () => {
            A.click();
            leaveLand();
            GAMES[id].open(stage, session, face, () => showLand(l));
          },
        }, GAMES[id].label))),
      scene,
      log,
      say.el));

    function drawCrowd() {
      const people = peopleIn(l.id);
      clear(crowd);
      for (const m of people) {
        const f = m.self ? face : faceFor(m.name);
        crowd.append(h('div.rev-person', { dataset: { name: m.name }, class: m.self ? 'me' : '' },
          h('div.rev-bubble', { hidden: true }),
          faceSvg(f, 46),
          h('div.rev-name', {},
            m.human && !m.self ? h('i.rev-real', { title: 'Another person, really here' }) : null,
            m.name)));
      }
      if (!people.length) crowd.append(h('div.rev-alone', {}, 'Nobody here yet.'));
    }

    function bubble(name, text) {
      const el = crowd.querySelector('.rev-person[data-name="' + CSS.escape(name) + '"] .rev-bubble');
      if (!el) return;
      el.textContent = text;
      el.hidden = false;
      clearTimeout(bubbles.get(name));
      bubbles.set(name, setTimeout(() => { el.hidden = true; }, 5200));
    }

    function line(from, text, self) {
      const row = h('div.rev-line', {},
        h('b', { class: self ? 'me' : '' }, from, ':'), ' ', h('span', {}, text));
      log.append(row);
      while (log.childElementCount > 80) log.firstChild.remove();
      log.scrollTop = log.scrollHeight;
    }

    function speak(text) {
      if (!isPhrase(text)) return;
      const res = screen(text, session.bucket, { max: LIMITS.maxChars });
      if (!res.ok) { A.ding(); return; }
      session.net.say(room, res.text);
      A.click();
    }

    const unhook = [
      session.net.on('chat', ev => {
        if (ev.room !== room) return;
        line(ev.from, ev.text, ev.self);
        bubble(ev.from, ev.text);
      }),
      session.net.on('roster', ev => { if (ev.room === room) drawCrowd(); }),
      session.net.on('join', ev => { if (ev.room === room) { A.doorOpen(); drawCrowd(); } }),
      session.net.on('part', ev => { if (ev.room === room) { A.doorClose(); drawCrowd(); } }),
    ];
    offs.push(...unhook);

    session.net.join(room);
    drawCrowd();
    line('Reverie', 'You are standing in ' + l.name + '. ' + l.blurb + '.', false);
    setTimeout(() => say.focus(), 80);
  }

  showGate();
  return win;
}
