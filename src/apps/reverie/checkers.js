/*
 * Checkers, in the Keep.
 *
 * A real game: forced captures, multi-jumps, kings, and an opponent that
 * looks two moves ahead. The board games were the whole point of the
 * graphical services — you went there to play somebody, not to read.
 *
 * The opponent here is a program wearing one of the regulars' faces,
 * which is the honest version of "somebody is playing you": it plays, it
 * takes a believable moment to think, and it says things out of the
 * phrase book like everybody else.
 */

const SIZE = 8;
export const EMPTY = 0, YOU = 1, THEM = 2, YOU_K = 3, THEM_K = 4;

const isYours = p => p === YOU || p === YOU_K;
const isTheirs = p => p === THEM || p === THEM_K;
const isKing = p => p === YOU_K || p === THEM_K;
const side = p => (isYours(p) ? YOU : isTheirs(p) ? THEM : 0);
const inBoard = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

export function newBoard() {
  const b = new Uint8Array(SIZE * SIZE);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < SIZE; c++) if ((r + c) % 2) b[r * SIZE + c] = THEM;
  for (let r = SIZE - 3; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if ((r + c) % 2) b[r * SIZE + c] = YOU;
  return b;
}

const DIRS = {
  [YOU]: [[-1, -1], [-1, 1]],
  [THEM]: [[1, -1], [1, 1]],
  king: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
};

function stepsFor(piece) {
  return isKing(piece) ? DIRS.king : DIRS[side(piece)];
}

/** Every jump available from one square, following multi-jumps to the end. */
function jumpsFrom(b, r, c, piece, seen = []) {
  const out = [];
  for (const [dr, dc] of stepsFor(piece)) {
    const mr = r + dr, mc = c + dc, lr = r + dr * 2, lc = c + dc * 2;
    if (!inBoard(lr, lc)) continue;
    const mid = b[mr * SIZE + mc];
    if (!mid || side(mid) === side(piece)) continue;
    if (b[lr * SIZE + lc] !== EMPTY) continue;
    if (seen.some(([sr, sc]) => sr === mr && sc === mc)) continue;

    const nb = b.slice();
    nb[r * SIZE + c] = EMPTY;
    nb[mr * SIZE + mc] = EMPTY;
    let np = piece;
    if (piece === YOU && lr === 0) np = YOU_K;
    if (piece === THEM && lr === SIZE - 1) np = THEM_K;
    nb[lr * SIZE + lc] = np;

    const chain = np === piece
      ? jumpsFrom(nb, lr, lc, np, [...seen, [mr, mc]])
      : [];                                  // crowning ends the turn
    if (chain.length) {
      for (const j of chain)
        out.push({ from: [r, c], to: j.to, board: j.board, captures: [[mr, mc], ...j.captures] });
    } else {
      out.push({ from: [r, c], to: [lr, lc], board: nb, captures: [[mr, mc]] });
    }
  }
  return out;
}

/** Legal moves for a side. Captures are compulsory, as they should be. */
export function legalMoves(b, who) {
  const jumps = [], plain = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const p = b[r * SIZE + c];
    if (!p || side(p) !== who) continue;
    jumps.push(...jumpsFrom(b, r, c, p));
    for (const [dr, dc] of stepsFor(p)) {
      const nr = r + dr, nc = c + dc;
      if (!inBoard(nr, nc) || b[nr * SIZE + nc] !== EMPTY) continue;
      const nb = b.slice();
      nb[r * SIZE + c] = EMPTY;
      let np = p;
      if (p === YOU && nr === 0) np = YOU_K;
      if (p === THEM && nr === SIZE - 1) np = THEM_K;
      nb[nr * SIZE + nc] = np;
      plain.push({ from: [r, c], to: [nr, nc], board: nb, captures: [] });
    }
  }
  return jumps.length ? jumps : plain;
}

/** Positive is good for THEM, which is the side the program plays. */
function evaluate(b) {
  let s = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const p = b[r * SIZE + c];
    if (!p) continue;
    const v = isKing(p) ? 5 : 3;
    const advance = isTheirs(p) ? r : SIZE - 1 - r;      // pushing forward is good
    const edge = (c === 0 || c === SIZE - 1) ? 0.4 : 0;  // the rail is safe
    const worth = v + advance * 0.12 + edge;
    s += isTheirs(p) ? worth : -worth;
  }
  return s;
}

function search(b, who, depth, alpha, beta) {
  const moves = legalMoves(b, who);
  if (!moves.length) return who === THEM ? -1000 : 1000;
  if (depth === 0) return evaluate(b);

  if (who === THEM) {
    let best = -Infinity;
    for (const m of moves) {
      best = Math.max(best, search(m.board, YOU, depth - 1, alpha, beta));
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  let best = Infinity;
  for (const m of moves) {
    best = Math.min(best, search(m.board, THEM, depth - 1, alpha, beta));
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

/**
 * The opponent's move. Two plies plus a little noise, which is about the
 * strength of somebody who plays a lot but is also talking to three other
 * people at the same time.
 */
export function chooseMove(b, depth = 2) {
  const moves = legalMoves(b, THEM);
  if (!moves.length) return null;
  let best = null, bestScore = -Infinity;
  for (const m of moves) {
    const s = search(m.board, YOU, depth, -Infinity, Infinity) + Math.random() * 0.5;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

export function countPieces(b) {
  let you = 0, them = 0;
  for (const p of b) { if (isYours(p)) you++; else if (isTheirs(p)) them++; }
  return { you, them };
}

/** null while the game is live, else 'you' | 'them' | 'draw'. */
export function outcome(b, turn) {
  const { you, them } = countPieces(b);
  if (!you) return 'them';
  if (!them) return 'you';
  if (!legalMoves(b, turn).length) return turn === YOU ? 'them' : 'you';
  return null;
}

export { SIZE, isYours, isTheirs, isKing };
