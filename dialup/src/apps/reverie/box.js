/*
 * Shut the Box, at the inn.
 *
 * The oldest game in this whole prototype by about three hundred years,
 * and the only one that needs no opponent: nine numbered flaps, two dice,
 * and the question of how to spend a seven. It belongs in a pub, which is
 * where it is.
 *
 * Shut all nine and you have shut the box, which most people never do.
 */

import { h, clear, randInt, pick } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { faceFor } from './faces.js';
import { portrait, btn, shell } from './ui.js';
import { PERSONAS } from '../halcyon/people.js';

const TILES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const BEST = 'reverie.box.best';

const CHATTER = {
  start: ['good luck', 'nice to meet you', 'anyone want to play?'],
  good: ['nice move', 'wow', 'i did not see that coming'],
  bad: ['oh no', 'that stinks', 'haha'],
  end: ['good game', 'one more?'],
};

const loadBest = () => {
  // Number(null) is 0, which is a perfect game — so read the raw value.
  const raw = localStorage.getItem(BEST);
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};

/** Can any set of the open tiles add up to n? */
function reachable(open, n) {
  if (n === 0) return true;
  if (!open.length) return false;
  const [first, ...rest] = open;
  return (first <= n && reachable(rest, n - first)) || reachable(rest, n);
}

/** Two dice, drawn as pips because a numeral is not a die. */
function die(n) {
  const spots = {
    1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
  }[n] || [];
  return h('div.box-die', {},
    ...Array.from({ length: 9 }, (_, i) =>
      h('u', { class: spots.includes(i) ? 'on' : '' })));
}

export function openShutTheBox(stage, session, myFace, onBack) {
  const rival = pick(PERSONAS);
  let open = [...TILES];
  let roll = null;                 // [a, b] or [a] on the one-die rule
  let chosen = [];
  let over = false;
  let best = loadBest();

  const tray = h('div.box-tray');
  const dice = h('div.box-dice');
  const said = h('div.gm-said');
  const card = h('div.gm-card');

  const { bar, note } = shell(stage, {
    ground: 'pur', title: 'Shut the Box  ·  The Bridge Inn',
    backLabel: 'The Inn', onBack,
    side: [
      portrait(myFace, session.name, { size: 60, cls: 'me' }),
      card,
      said,
      portrait(faceFor(rival.name), rival.name, { size: 40, cls: 'small' }),
    ],
    middle: h('div.box', {}, tray, dice,
      h('div.box-hint', {}, 'Roll, then flip down any flaps that add up to it.')),
    note: 'Nine flaps. Roll the dice and spend the number.',
  });
  const status = text => { note.textContent = text; };

  const rollBtn = btn('Roll', () => doRoll(), { cls: 'go' });
  const takeBtn = btn('Flip Them Down', () => take(), { off: true });
  bar.insertBefore(rollBtn, bar.querySelector('.spacer'));
  bar.insertBefore(takeBtn, bar.querySelector('.spacer'));

  function say(bank) {
    said.textContent = pick(CHATTER[bank]);
    setTimeout(() => { said.textContent = ''; }, 3600);
  }

  const total = () => chosen.reduce((a, b) => a + b, 0);
  const target = () => (roll || []).reduce((a, b) => a + b, 0);
  const left = () => open.reduce((a, b) => a + b, 0);

  function draw() {
    clear(tray);
    for (const n of TILES) {
      const down = !open.includes(n);
      tray.append(h('button.box-flap', {
        type: 'button',
        class: (down ? 'down' : '') + (chosen.includes(n) ? ' on' : ''),
        disabled: down || !roll || over,
        onclick: () => toggle(n),
      }, String(n)));
    }
    clear(dice).append(...(roll || []).map(die));
    takeBtn.disabled = !roll || over || total() !== target();

    clear(card).append(
      h('h4', {}, 'The Box'),
      h('div.row', {}, h('span', {}, 'Still up'), h('span', {}, String(left()))),
      h('div.row', {}, h('span', {}, 'Rolled'), h('span', {}, roll ? String(target()) : '–')),
      h('div', { class: 'row now' },
        h('span', {}, 'Picked'), h('span', {}, roll ? total() + '/' + target() : '–')),
      h('div', { class: 'row tot' },
        h('span', {}, 'Your best'), h('span', {}, best == null ? 'none yet' : String(best))));
  }

  function toggle(n) {
    if (chosen.includes(n)) chosen = chosen.filter(x => x !== n);
    else if (total() + n <= target()) chosen.push(n);
    else { A.ding(); return; }
    A.click();
    draw();
  }

  function doRoll() {
    if (over) return;
    chosen = [];
    // Once everything left is small, the house lets you roll one die.
    const one = open.every(n => n <= 6);
    roll = one ? [randInt(1, 6)] : [randInt(1, 6), randInt(1, 6)];
    A.beep();
    rollBtn.disabled = true;
    status('You rolled ' + target() + (one ? ' on one die.' : '.') +
           ' Flip down flaps that add up to it.');
    draw();
    if (!reachable(open, target())) finish();
  }

  function take() {
    if (total() !== target()) return;
    open = open.filter(n => !chosen.includes(n));
    chosen = [];
    roll = null;
    rollBtn.disabled = false;
    A.doorClose();
    if (!open.length) return finish(true);
    say(Math.random() < 0.4 ? 'good' : 'bad');
    status('Down they go. ' + left() + ' still up. Roll again.');
    draw();
  }

  function finish(shut = false) {
    over = true;
    rollBtn.disabled = true;
    takeBtn.disabled = true;
    const score = left();
    if (best == null || score < best) {
      best = score;
      try { localStorage.setItem(BEST, String(score)); } catch {}
    }
    say('end');
    if (shut) {
      A.startupChime();
      status('You have shut the box. Most people never do.');
    } else {
      A.ding();
      status('Nothing adds up to ' + target() + '. You are left with ' + score + '.');
    }
    draw();
    bar.insertBefore(
      btn('Play Again', () => openShutTheBox(stage, session, myFace, onBack), { cls: 'go' }),
      bar.querySelector('.spacer'));
  }

  say('start');
  draw();
}
