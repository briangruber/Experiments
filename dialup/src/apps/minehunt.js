/* Mine Hunt. A real one: first click is always safe, chording works,
   the face changes, and the timer stops. */

import { h, clear, randInt } from '../core/dom.js';
import { openWindow, dialog } from '../core/wm.js';
import * as A from '../core/audio.js';

const LEVELS = {
  Beginner:     { w: 9,  hh: 9,  mines: 10 },
  Intermediate: { w: 16, hh: 16, mines: 40 },
  Expert:       { w: 30, hh: 16, mines: 99 },
};
const NUM_COLORS = ['', '#0000ff', '#008000', '#ff0000', '#000080',
                    '#800000', '#008080', '#000000', '#808080'];

export function open(ctx) {
  let level = 'Beginner';
  let g = null, timer = null;

  const win = openWindow({
    id: 'minehunt', title: 'Mine Hunt', icon: 'game',
    width: 220, height: 280, resizable: false,
    menu: [
      { label: 'Game', onclick: () => cycle() },
      { label: 'Help', onclick: () => dialog({
        title: 'Mine Hunt', icon: 'help',
        message: 'Left click clears a square. Right click flags one.\n' +
                 'Click a number with the right count of flags around it to clear\n' +
                 'its neighbours in one go.\n\n' +
                 'The first square you click is never a mine.' }) },
    ],
    onClose: () => { clearInterval(timer); return true; },
  });

  const counter = h('div.ms-lcd', {}, '000');
  const clock = h('div.ms-lcd', {}, '000');
  const face = h('button.ms-face', { type: 'button', onclick: () => start() }, ':)');
  const grid = h('div.ms-grid');

  clear(win.body).append(h('div.ms', {},
    h('div.ms-head.raised', {}, counter, face, clock),
    h('div.ms-board.sunken', {}, grid)));

  function cycle() {
    const keys = Object.keys(LEVELS);
    level = keys[(keys.indexOf(level) + 1) % keys.length];
    start();
  }

  function start() {
    clearInterval(timer);
    const { w, hh, mines } = LEVELS[level];
    g = {
      w, hh, mines, started: false, over: false, flags: 0, cleared: 0, time: 0,
      cells: Array.from({ length: w * hh }, () => ({ mine: false, open: false, flag: false, n: 0 })),
    };
    face.textContent = ':)';
    counter.textContent = pad(mines);
    clock.textContent = '000';
    win.setTitle('Mine Hunt - ' + level);
    draw();
    const cw = w * 17 + 22, ch = hh * 17 + 92;
    win.el.style.width = cw + 'px';
    win.el.style.height = ch + 'px';
  }

  function pad(n) { return String(Math.max(0, Math.min(999, n))).padStart(3, '0'); }

  function place(safeIdx) {
    const { w, hh, mines } = g;
    const banned = new Set([safeIdx, ...neighbours(safeIdx)]);
    let placed = 0;
    while (placed < mines) {
      const i = randInt(0, w * hh - 1);
      if (banned.has(i) || g.cells[i].mine) continue;
      g.cells[i].mine = true; placed++;
    }
    for (let i = 0; i < g.cells.length; i++)
      g.cells[i].n = neighbours(i).filter(j => g.cells[j].mine).length;
  }

  function neighbours(i) {
    const { w, hh } = g, x = i % w, y = (i / w) | 0, out = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < hh) out.push(ny * w + nx);
      }
    return out;
  }

  function draw() {
    clear(grid);
    grid.style.gridTemplateColumns = 'repeat(' + g.w + ', 16px)';
    g.cells.forEach((c, i) => {
      const el = h('button.ms-cell', { type: 'button', dataset: { i } });
      if (c.open) {
        el.classList.add('open');
        if (c.mine) { el.classList.add('boom'); el.textContent = '*'; }
        else if (c.n) { el.textContent = c.n; el.style.color = NUM_COLORS[c.n]; }
      } else if (c.flag) { el.textContent = 'P'; el.classList.add('flag'); }
      grid.append(el);
    });
  }

  grid.addEventListener('contextmenu', ev => ev.preventDefault());

  grid.addEventListener('pointerdown', ev => {
    const cell = ev.target.closest('.ms-cell');
    if (!cell || !g || g.over) return;
    const i = Number(cell.dataset.i);
    if (ev.button === 2) { flag(i); return; }
    face.textContent = ':o';
  });

  grid.addEventListener('pointerup', ev => {
    const cell = ev.target.closest('.ms-cell');
    if (!cell || !g || g.over) { if (g && !g.over) face.textContent = ':)'; return; }
    if (ev.button === 2) return;
    face.textContent = ':)';
    const i = Number(cell.dataset.i);
    g.cells[i].open ? chord(i) : reveal(i);
  });

  function tickStart() {
    if (g.started) return;
    g.started = true;
    timer = setInterval(() => {
      if (g.over) return;
      g.time++; clock.textContent = pad(g.time);
    }, 1000);
  }

  function flag(i) {
    const c = g.cells[i];
    if (c.open) return;
    c.flag = !c.flag;
    g.flags += c.flag ? 1 : -1;
    counter.textContent = pad(g.mines - g.flags);
    A.click();
    draw();
  }

  function reveal(i) {
    const c = g.cells[i];
    if (c.flag || c.open) return;
    if (!g.started) { place(i); tickStart(); }
    if (c.mine) return lose(i);
    flood(i);
    A.beep();
    draw();
    checkWin();
  }

  function flood(i) {
    const stack = [i];
    while (stack.length) {
      const j = stack.pop();
      const c = g.cells[j];
      if (c.open || c.flag) continue;
      c.open = true; g.cleared++;
      if (c.n === 0) for (const k of neighbours(j)) if (!g.cells[k].open) stack.push(k);
    }
  }

  function chord(i) {
    const c = g.cells[i];
    if (!c.open || !c.n) return;
    const ns = neighbours(i);
    if (ns.filter(j => g.cells[j].flag).length !== c.n) return;
    for (const j of ns) if (!g.cells[j].flag && !g.cells[j].open) {
      if (g.cells[j].mine) return lose(j);
      flood(j);
    }
    draw(); checkWin();
  }

  function lose(i) {
    g.over = true;
    clearInterval(timer);
    g.cells[i].open = true;
    g.cells.forEach(c => { if (c.mine) c.open = true; });
    face.textContent = 'X(';
    A.ding();
    draw();
  }

  function checkWin() {
    if (g.cleared < g.w * g.hh - g.mines) return;
    g.over = true;
    clearInterval(timer);
    face.textContent = 'B)';
    A.startupChime();
    g.cells.forEach(c => { if (c.mine && !c.flag) { c.flag = true; } });
    counter.textContent = '000';
    draw();
    setTimeout(() => dialog({
      title: 'Mine Hunt', icon: 'info',
      message: 'Cleared ' + level + ' in ' + g.time + ' seconds.',
    }), 300);
  }

  start();
  return win;
}
