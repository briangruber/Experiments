/* The board, in the Keep. The rules live in checkers.js; this is the wood
   and the pieces and the opponent taking a moment to think. */

import { h, clear, pick } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { faceFor } from './faces.js';
import { portrait, btn, shell } from './ui.js';
import { PERSONAS } from '../halcyon/people.js';
import {
  newBoard, legalMoves, chooseMove, outcome, countPieces,
  SIZE, YOU, THEM, isYours, isKing,
} from './checkers.js';

const CHATTER = {
  start: ['good luck', 'nice to meet you', 'anyone want to play?'],
  good: ['nice move', 'i did not see that coming', 'wow'],
  bad: ['oh no', 'that stinks', 'haha'],
  win: ['good game', 'that was fun', 'one more?'],
  lose: ['good game', 'nice one', 'you are alright, you know that?'],
};

export function openCheckers(stage, session, myFace, onBack) {
  const rival = pick(PERSONAS);
  let board = newBoard();
  let turn = YOU;
  let sel = null;                 // [r,c] currently picked up
  let moves = legalMoves(board, YOU);
  let busy = false;

  const grid = h('div.ck-board');
  const said = h('div.gm-said');
  const card = h('div.gm-card');

  const { bar, note } = shell(stage, {
    ground: 'pur', title: 'Checkers  ·  Jouster’s Keep',
    backLabel: 'The Keep', onBack,
    side: [
      portrait(faceFor(rival.name), rival.name, { size: 62 }),
      said,
      portrait(myFace, session.name, { size: 62, cls: 'me' }),
      card,
    ],
    middle: h('div.rev-frame', {}, grid),
    note: 'Your move. Captures are compulsory.',
  });

  const status = text => { note.textContent = text; };

  function say(bank) {
    said.textContent = pick(CHATTER[bank]);
    setTimeout(() => { said.textContent = ''; }, 4200);
  }

  function draw() {
    clear(grid);
    const canMoveFrom = new Set(moves.map(m => m.from.join(',')));
    const targets = sel
      ? new Set(moves.filter(m => m.from.join(',') === sel.join(',')).map(m => m.to.join(',')))
      : new Set();

    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      const dark = (r + c) % 2 === 1;
      const p = board[r * SIZE + c];
      const key = r + ',' + c;
      const sq = h('button.ck-sq', {
        type: 'button',
        class: (dark ? 'dark' : 'light') +
               (targets.has(key) ? ' target' : '') +
               (sel && sel.join(',') === key ? ' sel' : ''),
        disabled: !dark,
      });
      if (p) sq.append(h('div.ck-piece', {
        class: (isYours(p) ? 'you' : 'them') + (isKing(p) ? ' king' : '') +
               (turn === YOU && canMoveFrom.has(key) && isYours(p) ? ' ready' : ''),
      }, isKing(p) ? h('span', {}, '★') : null));
      sq.addEventListener('click', () => onSquare(r, c));
      grid.append(sq);
    }

    const n = countPieces(board);
    clear(card).append(
      h('h4', {}, 'On the board'),
      h('div', { class: 'row now' }, h('span', {}, session.name), h('span', {}, String(n.you))),
      h('div.row', {}, h('span', {}, rival.name), h('span', {}, String(n.them))),
      h('div', { class: 'row tot' },
        h('span', {}, 'Turn'), h('span', {}, turn === YOU ? 'yours' : 'theirs')));
  }

  function onSquare(r, c) {
    if (busy || turn !== YOU) return;
    const key = r + ',' + c;

    if (sel) {
      const m = moves.find(x => x.from.join(',') === sel.join(',') && x.to.join(',') === key);
      if (m) return commit(m);
      sel = null;
    }
    if (moves.some(x => x.from.join(',') === key)) { sel = [r, c]; A.click(); }
    draw();
  }

  function commit(m) {
    board = m.board;
    sel = null;
    if (m.captures.length) { A.beep(); say('bad'); } else A.click();
    turn = THEM;
    moves = [];
    status(rival.name + ' is thinking about it.');
    draw();
    check();
    if (turn === THEM) setTimeout(theirMove, 700 + Math.random() * 1100);
  }

  function theirMove() {
    if (turn !== THEM) return;
    busy = true;
    const m = chooseMove(board);
    busy = false;
    if (!m) return check();
    board = m.board;
    if (m.captures.length) { A.doorClose(); say('good'); }
    turn = YOU;
    moves = legalMoves(board, YOU);
    status(moves.some(x => x.captures.length)
      ? 'Your move. You have a capture, and captures are compulsory.'
      : 'Your move.');
    draw();
    check();
  }

  function check() {
    const o = outcome(board, turn);
    if (!o) return;
    busy = true;
    status(o === 'you'
      ? 'You win. ' + rival.name + ' is being very gracious about it.'
      : 'You lose. ' + rival.name + ' has been practising.');
    say(o === 'you' ? 'lose' : 'win');
    if (o === 'you') A.startupChime(); else A.ding();
    bar.insertBefore(
      btn('Play Again', () => openCheckers(stage, session, myFace, onBack), { cls: 'go' }),
      bar.querySelector('.spacer'));
  }

  say('start');
  moves = legalMoves(board, YOU);
  draw();
}
