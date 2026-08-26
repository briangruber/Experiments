/* The board, in the Keep. The rules live in checkers.js; this is the wood
   and the pieces and the opponent taking a moment to think. */

import { h, clear, pick } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { faceFor, faceSvg } from './faces.js';
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
  const status = h('div.ck-status', {}, 'Your move. Captures are compulsory.');
  const said = h('div.ck-said', {}, '');

  clear(stage).append(h('div.ck', {},
    h('div.ck-bar', {},
      h('button.rev-back', { type: 'button', onclick: onBack }, '◀ The Keep'),
      h('b', {}, 'Checkers')),
    h('div.ck-main', {},
      h('div.ck-side', {},
        h('div.ck-seat', {},
          h('div.ck-seat-face', {}, faceSvg(faceFor(rival.name), 44)),
          h('b', {}, rival.name)),
        said,
        h('div.ck-seat.me', {},
          h('div.ck-seat-face', {}, faceSvg(myFace, 44)),
          h('b', {}, session.name)),
        h('div.ck-count')),
      h('div.ck-boardwrap', {}, grid)),
    status));

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
    stage.querySelector('.ck-count').textContent = 'You ' + n.you + '   ' + rival.name + ' ' + n.them;
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
    status.textContent = moves.some(x => x.captures.length)
      ? 'Your move. You have a capture, and captures are compulsory.'
      : 'Your move.';
    draw();
    check();
  }

  function check() {
    const o = outcome(board, turn);
    if (!o) return;
    busy = true;
    status.textContent = o === 'you'
      ? 'You win. ' + rival.name + ' is being very gracious about it.'
      : 'You lose. ' + rival.name + ' has been practising.';
    say(o === 'you' ? 'lose' : 'win');
    if (o === 'you') A.startupChime(); else A.ding();
    stage.querySelector('.ck-bar').append(h('button.aol-btn.small', {
      type: 'button',
      onclick: () => openCheckers(stage, session, myFace, onBack),
    }, 'Play Again'));
  }

  say('start');
  moves = legalMoves(board, YOU);
  draw();
}
