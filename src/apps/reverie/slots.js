/* The machine on the Boardwalk.
 *
 * Tokens only, and the machine says so. It costs nothing, pays nothing,
 * and exists because every one of these services had a room where the
 * whole activity was watching three drums come to a stop. */

import { h, pick, randInt } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { portrait, btn, shell } from './ui.js';

const REELS = ['★', '7', '♣', '♦', '●', '▲'];
const PAYS = { '★★★': 250, '777': 100, '♣♣♣': 40, '♦♦♦': 25, '●●●': 15, '▲▲▲': 10 };
const STORE = 'reverie.tokens';

const loadTokens = () => {
  try { const v = Number(localStorage.getItem(STORE)); return Number.isFinite(v) && v > 0 ? v : 50; }
  catch { return 50; }
};
const saveTokens = n => { try { localStorage.setItem(STORE, String(n)); } catch {} };

export function openSlots(stage, session, myFace, onBack) {
  let tokens = loadTokens();
  let spinning = false;

  const drums = [h('i'), h('i'), h('i')];
  const purse = h('span.sl-purse');
  const message = h('div.sl-msg', {}, 'Three of a kind pays.');
  const card = h('div.gm-card', {},
    h('h4', {}, 'What it pays'),
    ...Object.entries(PAYS).map(([line, n]) =>
      h('div.row', {}, h('span', {}, line), h('span', {}, String(n)))),
    h('div', { class: 'row tot' }, h('span', {}, 'In hand'), purse));

  const setPurse = () => { purse.textContent = tokens + ''; saveTokens(tokens); };
  const face = () => drums.forEach(d => { d.textContent = pick(REELS); });

  const pull = () => {
    if (spinning) return;
    if (tokens < 1) {
      message.textContent = 'The attendant tops you up. None of this is real.';
      tokens = 50; setPurse();
      return;
    }
    spinning = true;
    tokens -= 1; setPurse();
    A.click();

    let ticks = 0;
    const stops = [randInt(10, 14), randInt(16, 21), randInt(23, 30)];
    const timer = setInterval(() => {
      ticks++;
      drums.forEach((d, i) => { if (ticks < stops[i]) d.textContent = pick(REELS); });
      if (ticks % 3 === 0) A.beep();
      if (ticks >= stops[2]) {
        clearInterval(timer);
        spinning = false;
        const line = drums.map(d => d.textContent).join('');
        const win = PAYS[line];
        if (win) {
          tokens += win; setPurse();
          message.textContent = line + '  —  ' + win + ' tokens!';
          A.startupChime();
        } else if (drums[0].textContent === drums[1].textContent) {
          message.textContent = 'Two of a kind. So close it is almost worse.';
        } else {
          message.textContent = pick([
            'Nothing.', 'Not this time.', 'The machine is unmoved.',
            'Try again. Everybody did.',
          ]);
        }
      }
    }, 70);
  };

  shell(stage, {
    ground: 'pur', title: 'The Machine  ·  The Boardwalk',
    backLabel: 'The Boardwalk', onBack,
    side: [portrait(myFace, session.name, { size: 62, cls: 'me' }), card],
    middle: h('div.sl-cab', {},
      h('div.sl-marquee', {}, 'The Machine'),
      h('div.rev-frame', {}, h('div.sl-window', {}, ...drums)),
      message,
      h('div.sl-plate', {}, 'BOARDWALK AMUSEMENTS  ·  TOKENS ONLY')),
    buttons: [btn('PULL', pull, { cls: 'big go' })],
    note: 'Tokens are not money, cannot be bought, and reset when you run out.',
  });

  face();
  setPurse();
}
