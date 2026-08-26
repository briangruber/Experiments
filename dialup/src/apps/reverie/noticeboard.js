/*
 * The wishing fountain and the postcard board.
 *
 * Two places in the town where you leave something behind rather than say
 * it: a wish thrown in with a coin, a card pinned to the board. Both are
 * the same thing underneath — a face, a name, and one phrase out of the
 * book — which is the only reason they exist as one file.
 *
 * What you leave stays on this computer. It is not sent anywhere and no
 * other caller can see it: the entries already on the board when you
 * arrive are the town's own, so that neither place is ever empty. The
 * README says which is which, because a board that quietly invents its
 * neighbours is exactly the thing worth being straight about.
 */

import { h, clear } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { faceFor } from './faces.js';
import { portrait, shell } from './ui.js';
import { createSayBox } from '../halcyon/say-box.js';
import { isPhrase } from '../halcyon/phrasebook.js';
import { screen, LIMITS } from '../../core/safety.js';

const KINDS = {
  wish: {
    store: 'reverie.wishes',
    title: 'The Wishing Fountain  ·  The Fountain',
    back: 'The Fountain',
    heading: 'What people have wished for',
    action: 'Throw a Coin',
    note: 'A coin and a wish. The coins are not real either.',
    done: name => name + ' throws a coin in. It goes in without a sound.',
    seed: [
      ['ThreeRiver', 'i wish it was summer'],
      ['MoM2Three', 'be right back'],
      ['gr8_scott', 'i wish i had a modem like yours'],
      ['SkaterDude99', 'this is awesome'],
      ['Duskwalker', 'good luck everybody'],
    ],
  },
  postcard: {
    store: 'reverie.postcards',
    title: 'The Postcard Board  ·  The Post Office',
    back: 'The Post Office',
    heading: 'Cards pinned to the board',
    action: 'Pin a Card',
    note: 'One card each. The postmistress is strict about it.',
    done: name => name + ' pins a card up, slightly crooked.',
    seed: [
      ['Bex_from_Hull', 'hello everyone'],
      ['TheReal_Elvis', 'wish you were here'],
      ['LordPhoenix', 'see you tomorrow'],
      ['xXAngelBabyXx', 'thank you'],
      ['CoffeeAchiever', 'nice to meet you'],
    ],
  },
};

const load = (key, seed) => {
  let mine = [];
  try { mine = JSON.parse(localStorage.getItem(key)) || []; } catch { mine = []; }
  if (!Array.isArray(mine)) mine = [];
  return [...mine.slice(-12), ...seed.map(([n, t]) => ({ name: n, text: t, town: true }))];
};

function keep(key, entry) {
  let mine = [];
  try { mine = JSON.parse(localStorage.getItem(key)) || []; } catch { mine = []; }
  if (!Array.isArray(mine)) mine = [];
  mine.push(entry);
  try { localStorage.setItem(key, JSON.stringify(mine.slice(-12))); } catch {}
}

/** Both places, told apart by `kind`. */
export function openNoticeboard(kind, stage, session, myFace, onBack) {
  const K = KINDS[kind];
  const wall = h('div.nb-wall.scroll');
  const say = createSayBox({ onSend: pin, hint: 'Type what you mean' });

  const { note } = shell(stage, {
    ground: kind === 'wish' ? 'blue' : 'red',
    title: K.title, backLabel: K.back, onBack,
    side: [portrait(myFace, session.name, { size: 60, cls: 'me' })],
    middle: h('div.nb', {},
      h('h4.nb-head', {}, K.heading),
      wall,
      h('div.nb-say', {}, say.el)),
    note: K.note,
  });

  let list = load(K.store, K.seed);
  draw();
  setTimeout(() => say.focus(), 80);

  function draw() {
    clear(wall);
    for (const item of list.slice().reverse()) {
      wall.append(h('div', { class: 'nb-item ' + kind },
        portrait(item.name === session.name ? myFace : faceFor(item.name), item.name,
          { size: 44, cls: 'small' + (item.mine ? ' me' : '') }),
        h('p', {}, item.text)));
    }
  }

  function pin(text) {
    if (!isPhrase(text)) return;
    const res = screen(text, session.bucket, { max: LIMITS.maxChars });
    if (!res.ok) { A.ding(); return; }
    const entry = { name: session.name, text: res.text, mine: true };
    list = [...list, entry];
    keep(K.store, { name: entry.name, text: entry.text, mine: true });
    draw();
    wall.scrollTop = 0;
    kind === 'wish' ? A.ding() : A.doorClose();
    note.textContent = K.done(session.name);
    setTimeout(() => { note.textContent = K.note; }, 4200);
  }
}

export const openWish = (stage, session, face, onBack) =>
  openNoticeboard('wish', stage, session, face, onBack);
export const openPostcard = (stage, session, face, onBack) =>
  openNoticeboard('postcard', stage, session, face, onBack);
