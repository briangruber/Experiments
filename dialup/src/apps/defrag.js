/* Disk Defragmenter. The blocks really do move: it holds a model of a
   fragmented disk and compacts it, which is why the progress slows down
   near the end exactly the way it used to. */

import { h, clear } from '../core/dom.js';
import { openWindow, dialog } from '../core/wm.js';
import * as A from '../core/audio.js';

const COLS = 40, ROWS = 18;
const FREE = 0, USED = 1, READING = 2, WRITING = 3, BAD = 4;
const CLASS = ['free', 'used', 'reading', 'writing', 'bad'];

export function open(ctx) {
  const total = COLS * ROWS;
  let disk = new Uint8Array(total);
  let running = false, timer = null, pass = 0, cursor = 0, moved = 0;

  const grid = h('div.df-grid');
  const bar = h('i');
  const label = h('div.df-label', {}, 'Ready.');
  const pct = h('div.df-pct', {}, '0%');

  const win = openWindow({
    id: 'defrag', title: 'Disk Defragmenter - Drive C:', icon: 'defrag',
    width: 460, height: 400, resizable: false,
    onClose: () => { clearInterval(timer); return true; },
  });

  clear(win.body).append(h('div.df', {},
    h('div.df-grid-wrap.sunken', {}, grid),
    h('div.df-legend', {},
      legend('used', 'Used'), legend('free', 'Free'),
      legend('reading', 'Reading'), legend('writing', 'Writing'), legend('bad', 'Bad')),
    label,
    h('div.df-bar', {}, bar), pct,
    h('div.df-btns', {},
      h('button.btn.small', { type: 'button', onclick: () => start() }, 'Start'),
      h('button.btn.small', { type: 'button', onclick: () => stop() }, 'Pause'),
      h('button.btn.small', { type: 'button', onclick: () => scramble() }, 'Fragment again'),
      h('button.btn.small', { type: 'button', onclick: () => details() }, 'Details'))));

  const cells = [];
  for (let i = 0; i < total; i++) {
    const c = h('i.df-cell');
    cells.push(c); grid.append(c);
  }

  function legend(cls, text) {
    return h('span.df-key', {}, h('i', { class: 'df-cell ' + cls }), text);
  }

  function scramble() {
    stop();
    disk = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const r = Math.random();
      disk[i] = r < 0.008 ? BAD : r < 0.62 ? USED : FREE;
    }
    pass = 0; cursor = 0; moved = 0;
    label.textContent = 'Ready. Drive C: is ' + fragmentation() + '% fragmented.';
    setBar(0);
    paint();
  }

  /** Holes that still have a used cluster somewhere after them. */
  function fragmentation() {
    let last = -1;
    for (let i = total - 1; i >= 0; i--) if (disk[i] === USED) { last = i; break; }
    let gaps = 0;
    for (let i = 0; i < last; i++) if (disk[i] === FREE) gaps++;
    return Math.min(99, Math.round(gaps / total * 220));
  }

  function paint() {
    for (let i = 0; i < total; i++) {
      const cls = 'df-cell ' + CLASS[disk[i]];
      if (cells[i].className !== cls) cells[i].className = cls;
    }
  }

  function setBar(p) {
    bar.style.width = (p * 100).toFixed(1) + '%';
    pct.textContent = Math.round(p * 100) + '% complete';
  }

  function start() {
    if (running) return;
    running = true;
    label.textContent = 'Reading drive C: ...';
    A.seek(3, 0.3);
    timer = setInterval(step, 55);
  }

  function stop() {
    running = false;
    clearInterval(timer);
    label.textContent = 'Paused.';
  }

  /** One compaction step: find the next hole, pull the next used block back. */
  function step() {
    // Undo any half-finished move left behind by a pause.
    for (let i = 0; i < total; i++) {
      if (disk[i] === READING) disk[i] = USED;
      else if (disk[i] === WRITING) disk[i] = FREE;
    }

    while (cursor < total && disk[cursor] !== FREE) cursor++;
    if (cursor >= total) return finish();

    let src = cursor + 1;
    while (src < total && disk[src] !== USED) src++;
    if (src >= total) return finish();

    disk[src] = READING;
    disk[cursor] = WRITING;
    paint();
    moved++;
    if (moved % 6 === 0) A.seek(1, 0.02);

    setTimeout(() => {
      if (!running) return;
      disk[src] = FREE;
      disk[cursor] = USED;
      cursor++;
      const done = cursor / total;
      setBar(done);
      label.textContent = 'Moving ' + moved.toLocaleString() + ' clusters. Do not switch off the computer.';
      paint();
    }, 40);
  }

  function finish() {
    running = false;
    clearInterval(timer);
    setBar(1);
    label.textContent = 'Defragmentation of drive C: is complete.';
    A.startupChime();
    dialog({
      title: 'Defragmenting Drive C', icon: 'info',
      message: 'Defragmentation of drive C: is complete.\n\n' +
        moved.toLocaleString() + ' clusters moved.\n\n' +
        'You may now use the computer, which you could have done the\n' +
        'whole time.',
    });
  }

  const details = () => dialog({
    title: 'Defragmenting Drive C', icon: 'defrag',
    message:
      'Each block is one cluster.\n\n' +
      '  Used     a file lives here\n' +
      '  Free     nothing here\n' +
      '  Reading  being copied out\n' +
      '  Writing  being copied in\n' +
      '  Bad      the disk gave up on this one\n\n' +
      'Watching this was, for a certain kind of person, the entire evening.',
  });

  scramble();
  return win;
}
