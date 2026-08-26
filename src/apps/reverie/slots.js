/* The machine on the Boardwalk.
 *
 * Tokens only, and the machine says so. It costs nothing, pays nothing,
 * and exists because every one of these services had a room where the
 * whole activity was watching three drums come to a stop. */

import { h, clear, pick, randInt } from '../../core/dom.js';
import * as A from '../../core/audio.js';

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
  const message = h('div.sl-msg', {}, 'Three of a kind pays. Tokens have no value.');

  const setPurse = () => { purse.textContent = tokens + ' tokens'; saveTokens(tokens); };
  const face = () => drums.forEach(d => { d.textContent = pick(REELS); });

  const pull = () => {
    if (spinning) return;
    if (tokens < 1) {
      message.textContent = 'Out of tokens. The attendant tops you up, because none of this is real.';
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

  clear(stage).append(h('div.sl', {},
    h('div.sl-bar', {},
      h('button.rev-back', { type: 'button', onclick: onBack }, '◀ The Boardwalk'),
      h('b', {}, 'The Machine'),
      purse),
    h('div.sl-cabinet', {},
      h('div.sl-window', {}, drums),
      message,
      h('button.aol-btn.sl-pull', { type: 'button', onclick: pull }, 'PULL')),
    h('div.sl-foot', {},
      'Tokens are not money, cannot be bought, and reset when you run out. ' +
      'The odds are printed nowhere, which is also period-accurate.')));

  face();
  setPurse();
}
