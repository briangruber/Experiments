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
         PARTS, SKINS, HAIRS, SHIRTS, BACKDROPS } from './faces.js';
import { frame, portrait, btn } from './ui.js';
import { townAmbience, landAmbience } from './ambience.js';
import { createSayBox } from '../halcyon/say-box.js';
import { isPhrase } from '../halcyon/phrasebook.js';
import { screen, LIMITS } from '../../core/safety.js';
import { openCheckers } from './checkers-ui.js';
import { openSlots } from './slots.js';
import { openDawn } from './dawn.js';
import { openGolf } from './golf.js';
import { openShutTheBox } from './box.js';
import { openWish, openPostcard } from './noticeboard.js';

/* Every game in Reverie, and the thing that opens it. */
const GAMES = {
  checkers: { label: 'Checkers', open: openCheckers },
  golf:     { label: 'Crazy Golf', open: openGolf },
  slots:    { label: 'The Machine', open: openSlots },
  dawn:     { label: 'Dawn Patrol', open: openDawn },
  box:      { label: 'Shut the Box', open: openShutTheBox },
  wish:     { label: 'Make a Wish', open: openWish },
  postcard: { label: 'Pin a Postcard', open: openPostcard },
};

/* The seven places, in the order you would walk them: the square first,
   then out along the lanes. The `at` pairs are percentages measured off
   the generated town picture. */
export const LANDS = [
  { id: 'fountain', name: 'The Fountain', art: 'rev_fountain',
    blurb: 'The middle of everything, and somewhere to make a wish',
    at: [43, 70], games: ['wish'] },
  { id: 'post', name: 'The Post Office', art: 'rev_post',
    blurb: 'Pigeonholes, parcel string, and a board of postcards',
    at: [60, 36], games: ['postcard'] },
  { id: 'inn', name: 'The Bridge Inn', art: 'rev_inn',
    blurb: 'A fire, long tables, and a box that wants shutting',
    at: [79, 62], games: ['box'] },
  { id: 'keep', name: "Jouster's Keep", art: 'rev_keep',
    blurb: 'Board games under the pennants',
    at: [27, 12], games: ['checkers'] },
  { id: 'boardwalk', name: 'The Boardwalk', art: 'rev_boardwalk',
    blurb: 'Crazy golf, lights on the water, and a machine that eats tokens',
    at: [11, 24], games: ['golf', 'slots'] },
  { id: 'airfield', name: 'Sky Squadron', art: 'rev_airfield',
    blurb: 'Two biplanes and a field at golden hour',
    at: [10, 82], games: ['dawn'] },
  { id: 'cloud', name: 'Cloud Nine', art: 'rev_cloud',
    blurb: 'No games at all. Where everybody stands about and talks',
    at: [6, 9], games: [] },
];

const roomOf = landId => 'rev-' + landId;

export function openReverie(session) {
  const win = openWindow({
    id: 'reverie', title: 'The Reverie Network', icon: 'globe',
    width: 700, height: 540, minWidth: 560, minHeight: 420,
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
    clear(stage).append(h('div.rev-ground.pur', {},
      h('div.rev-gate', {},
        h('div.rev-gate-word', {}, 'The Reverie Network'),
        frame(ART.rev_fly, 'rev-fly'),
        h('div.rev-gate-sub', {},
          'A painted island, four places to stand in it, and a face you make yourself.'),
        face
          ? h('div.rev-gate-you', {},
              portrait(face, session.name, { size: 72 }),
              h('div.rev-gate-sub', {}, 'This is you. Everybody on the island ' +
                                        'will see this face and this name.'))
          : h('div.rev-gate-sub', {}, 'You will need a face before you can go in.')),
      h('div.rev-bar', {},
        btn(face ? 'Enter Reverie' : 'Build a Face', () => {
          A.click(); face ? showMap() : showFaceMaker();
        }, { cls: 'big go' }),
        face ? btn('Change Face', () => { A.click(); showFaceMaker(); }, { cls: 'big' }) : null,
        h('span.spacer'),
        h('span.rev-note', {}, 'Nobody types at anybody here.'))));
    A.announce('reverie');
  }

  /* ── the face maker ────────────────────────────────────────────────── */

  /* Two flanking columns of arrow buttons with the sitter between them,
     which is how every one of these looked. */
  function showFaceMaker() {
    let draft = face ? { ...face } : randomFace();
    const preview = h('div.rev-port.big.me', {});
    const plate = h('span.rev-plate', {}, session.name);

    const paint = () => {
      clear(preview).append(h('div.rev-frame', {}, faceSvg(draft, 150)), plate);
    };

    /* One row: ◀ [name and which one you are on] ▶ */
    const step = (label, key, count) => {
      const name = h('span.rev-part-name', {}, label,
        h('i', {}, (draft[key] % count) + 1 + '/' + count));
      const move = d => {
        draft[key] = (draft[key] + count + d) % count;
        clear(name).append(label, h('i', {}, draft[key] + 1 + '/' + count));
        paint(); A.click();
      };
      return h('div.rev-part', {},
        h('button.rev-arrow', { type: 'button', onclick: () => move(-1) }, '◀'),
        name,
        h('button.rev-arrow', { type: 'button', onclick: () => move(1) }, '▶'));
    };

    /* Colour rows are the same row with the range in place of the counter,
       so both columns line up whatever is in them. */
    const swatch = (label, key, colours) => {
      const strip = h('span.rev-strip', { dataset: { key } }, colours.map((c, i) =>
        h('button.rev-swatch', {
          type: 'button', style: { background: c }, dataset: { i },
          onclick: ev => {
            ev.stopPropagation();
            draft[key] = i; paint(); markSwatches(); A.click();
          },
        })));
      const move = d => {
        draft[key] = (draft[key] + colours.length + d) % colours.length;
        paint(); markSwatches(); A.click();
      };
      return h('div.rev-part', {},
        h('button.rev-arrow', { type: 'button', onclick: () => move(-1) }, '\u25c0'),
        h('span.rev-part-name', {}, label, strip),
        h('button.rev-arrow', { type: 'button', onclick: () => move(1) }, '\u25b6'));
    };

    function markSwatches() {
      $$('.rev-strip', stage).forEach(g => {
        const key = g.dataset.key;
        $$('.rev-swatch', g).forEach(b =>
          b.classList.toggle('on', Number(b.dataset.i) === draft[key]));
      });
    }

    /* A fresh draft means fresh labels on every row, so the whole screen
       is rebuilt rather than patched. */
    const shuffle = () => { draft = randomFace(); render(); };

    function render() {
      clear(stage).append(h('div.rev-ground.red', {},
        h('div.rev-top', {}, h('b', {}, 'Make a Face')),
        h('div.rev-maker', {},
          h('div.rev-maker-col', {},
            swatch('Skin', 'skin', SKINS),
            step('Hair Style', 'hair', PARTS.hair.length),
            swatch('Hair Colour', 'hairColor', HAIRS),
            step('Eyes', 'eyes', PARTS.eyes.length),
            step('Eyebrows', 'brows', PARTS.brows.length)),
          h('div.rev-maker-mid', {}, preview),
          h('div.rev-maker-col', {},
            step('Nose', 'nose', PARTS.nose.length),
            step('Mouth', 'mouth', PARTS.mouth.length),
            step('Hats & Glasses', 'extra', PARTS.extra.length),
            swatch('Clothes', 'shirt', SHIRTS),
            swatch('Backdrop', 'backdrop', BACKDROPS))),
        h('div.rev-bar', {},
          btn('Surprise Me', () => { A.beep(); shuffle(); }),
          btn('This Is Me', () => {
            face = draft; saveFace(face); A.startupChime(); showMap();
          }, { cls: 'go' }),
          face ? btn('Cancel', () => { A.click(); showMap(); }) : null,
          h('span.spacer'),
          h('span.rev-note', {}, 'Your face is kept on this computer only.'))));
      paint();
      markSwatches();
    }

    render();
  }

  /* ── the island map ────────────────────────────────────────────────── */

  /* Painted town in a mount, numbered badges on it, and the numbers again
     in a cream legend down the right-hand side. */
  function showMap() {
    leaveLand();
    primeIsland();

    const pic = h('div.rev-pic.rev-map-pic', {
      style: { backgroundImage: 'url(' + ART.rev_town + ')' },
    }, townAmbience());
    const list = h('ol');

    LANDS.forEach((l, i) => {
      const here = peopleIn(l.id).length;
      const go = () => { A.doorOpen(); showLand(l); };

      const spot = h('button.rev-spot', {
        type: 'button', title: l.name + ' — ' + l.blurb,
        style: { left: l.at[0] + '%', top: l.at[1] + '%',
                 animationDelay: (i * 70) + 'ms' },
        onclick: go,
      }, String(i + 1),
        here ? h('span.rev-spot-here', {}, here + ' here') : null);
      pic.append(spot);

      list.append(h('li', { onclick: go, style: { animationDelay: (i * 55) + 'ms' } },
        h('b', {}, String(i + 1)),
        h('span', {}, l.name,
          h('em', {}, l.blurb),
          l.games.length
            ? h('em.rev-plays', {}, l.games.map(id => GAMES[id].label).join('  ·  '))
            : null)));
    });

    const total = LANDS.reduce((n, l) => n + peopleIn(l.id).length, 0);

    clear(stage).append(h('div.rev-ground.blue', {},
      h('div.rev-top', {}, h('b', {}, 'The Island of Reverie')),
      h('div.rev-map', {},
        h('div.rev-map-art', {}, h('div.rev-frame', {}, pic)),
        h('div.rev-legend', {},
          h('h2.rev-h', {}, 'Welcome to Reverie'),
          h('p', {}, 'Pick a number and go and stand there.'),
          list,
          h('div.rev-legend-foot', {},
            total
              ? total + ' ' + (total === 1 ? 'person is' : 'people are') + ' on the island.'
              : 'The island is quiet. Somebody will turn up.'))),
      h('div.rev-bar', {},
        portrait(face, session.name, { size: 34, cls: 'small me' }),
        btn('Change Face', () => { A.click(); showFaceMaker(); }),
        h('span.spacer'),
        h('span.rev-note', {}, 'Reverie is a made-up service. Everything in it is drawn.'))));
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

    clear(stage).append(h('div.rev-ground.pur', {},
      h('div.rev-top', {}, h('b', {}, l.name)),
      h('div.rev-land', {},
        h('div.rev-scene-wrap', {},
          h('div.rev-frame', {},
            h('div.rev-pic.rev-scene', {
              style: { backgroundImage: 'url(' + ART[l.art] + ')' },
            }, landAmbience(l.id)))),
        crowd,
        log,
        say.el),
      h('div.rev-bar', {},
        h('button.rev-back', { type: 'button', onclick: () => { A.doorClose(); showMap(); } },
          '◀ The Island'),
        ...l.games.map(id => btn(GAMES[id].label, () => {
          A.click();
          leaveLand();
          GAMES[id].open(stage, session, face, () => showLand(l));
        }, { cls: 'go' })),
        h('span.spacer'),
        h('span.rev-note', {}, l.blurb))));

    function drawCrowd() {
      const people = peopleIn(l.id);
      clear(crowd);
      for (const m of people) {
        const f = m.self ? face : faceFor(m.name);
        crowd.append(h('div.rev-person', { dataset: { name: m.name } },
          h('div.rev-bubble', { hidden: true }),
          portrait(f, m.name, {
            size: 58, cls: m.self ? 'me' : '',
            real: !!(m.human && !m.self),
          })));
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
