/*
 * A terminal.
 *
 * Not an emulator — a stage that behaves like one. Text arrives at the
 * speed the modem negotiated, in the sixteen colours a PC could show, and
 * the only way to answer is to type at a prompt and wait.
 *
 * Colour is written in pipe codes — |15 for white, |04 for red — because
 * that is genuinely how the sysop of a Renegade or Telegard board wrote
 * their menus, and because it keeps escape characters out of the source.
 * A literal pipe is written twice.
 */

import { h, clear } from '../../core/dom.js';
import * as A from '../../core/audio.js';

/* The CGA sixteen, which every one of these boards was designed against. */
export const PALETTE = [
  '#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff',
];

const MAX_CHARS = 24000;          // how much scrollback the window keeps

/**
 * @param {{cols?: number, cps?: number}} opts
 *   cps is characters per second: 2400 baud is 240 of them, and the
 *   difference between that and 14400 is the whole texture of the thing.
 */
export function createTerminal({ cols = 80, cps = 1440 } = {}) {
  const out = h('div.term-out');
  const cursor = h('span.term-cursor', {}, ' ');
  const screen = h('div.term-screen', { tabindex: 0, style: { width: cols + 'ch' } },
    out, cursor);
  const el = h('div.term', {}, screen);

  let queue = [];                 // pending [text, fg, bg] runs
  let fg = 7, bg = 0;
  let timer = 0;
  let waiting = null;             // the active ask()/key()
  let live = true;
  let chars = 0;

  /* ── painting ──────────────────────────────────────────────────────── */

  function emit(text, f, b) {
    const last = out.lastElementChild;
    if (last && Number(last.dataset.f) === f && Number(last.dataset.b) === b) {
      last.appendChild(document.createTextNode(text));
    } else {
      out.append(h('span', {
        dataset: { f, b },
        style: { color: PALETTE[f], background: b ? PALETTE[b] : 'transparent' },
      }, text));
    }
    chars += text.length;
    if (chars > MAX_CHARS) {
      while (chars > MAX_CHARS * 0.75 && out.firstElementChild) {
        chars -= out.firstElementChild.textContent.length;
        out.firstElementChild.remove();
      }
    }
    screen.scrollTop = screen.scrollHeight;
  }

  /** Splits pipe-coded text into coloured runs, carrying colour across calls. */
  function parse(str) {
    const runs = [];
    let buf = '';
    for (let i = 0; i < str.length; i++) {
      if (str[i] !== '|') { buf += str[i]; continue; }
      if (str[i + 1] === '|') { buf += '|'; i++; continue; }
      const code = str.slice(i + 1, i + 3);
      const isBg = code[0] === 'b' || code[0] === 'B';
      const n = isBg ? Number(code[1]) : Number(code);
      if (!Number.isInteger(n) || (isBg ? n > 7 : n > 15)) { buf += '|'; continue; }
      if (buf) { runs.push([buf, fg, bg]); buf = ''; }
      if (isBg) bg = n; else fg = n;
      i += 2;
    }
    if (buf) runs.push([buf, fg, bg]);
    return runs;
  }

  function pump() {
    let budget = Math.max(1, Math.round(cps / 60));
    while (budget > 0 && queue.length) {
      const run = queue[0];
      if (run[0].length <= budget) {
        emit(run[0], run[1], run[2]);
        budget -= run[0].length;
        queue.shift();
      } else {
        emit(run[0].slice(0, budget), run[1], run[2]);
        run[0] = run[0].slice(budget);
        budget = 0;
      }
    }
    if (!queue.length) {
      clearInterval(timer); timer = 0;
      if (waiting && waiting.onDrained) { const fn = waiting.onDrained; waiting.onDrained = null; fn(); }
    }
  }

  function start() { if (!timer && live) timer = setInterval(pump, 16); }

  /** Everything queued is on screen. */
  function drained() {
    if (!queue.length) return Promise.resolve();
    return new Promise(res => { waiting = waiting || {}; waiting.onDrained = res; });
  }

  /* ── the keyboard ──────────────────────────────────────────────────── */

  const PRINTABLE = /^[\x20-\x7e]$/;

  screen.addEventListener('keydown', ev => {
    if (!waiting || !waiting.mode) return;
    const k = ev.key;
    if (k === 'Tab' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    ev.preventDefault();

    if (waiting.mode === 'key') {
      const ch = k === 'Enter' ? '\r' : k;
      if (ch !== '\r' && !PRINTABLE.test(ch)) return;
      const want = waiting.valid;
      const hit = ch === '\r' ? '\r' : ch.toUpperCase();
      if (want && !want.includes(hit)) { A.ding(); return; }
      if (ch !== '\r' && waiting.echo !== false) push(hit);
      push('\n');
      finish(hit);
      return;
    }

    // a typed line
    if (k === 'Enter') { push('\n'); finish(waiting.buf); return; }
    if (k === 'Backspace') {
      if (!waiting.buf.length) return;
      waiting.buf = waiting.buf.slice(0, -1);
      push('\b');
      return;
    }
    if (!PRINTABLE.test(k)) return;
    if (waiting.buf.length >= waiting.max) { A.ding(); return; }
    waiting.buf += k;
    push(waiting.mask ? waiting.mask : k);
  });

  /* Typed characters go straight up, ahead of anything still arriving —
     which is what full duplex felt like: the board is still talking and
     your own letters appear the instant you hit the key. */
  function push(ch) {
    if (ch === '\b') {
      const last = out.lastElementChild;
      if (!last) return;
      const t = last.textContent;
      last.textContent = t.slice(0, -1);
      chars--;
      if (!last.textContent) last.remove();
      return;
    }
    emit(ch, waiting && waiting.inputFg != null ? waiting.inputFg : 15, 0);
  }

  function finish(value) {
    const w = waiting;
    waiting = null;
    if (w && w.resolve) w.resolve(value);
  }

  /* ── the interface the board talks to ──────────────────────────────── */

  const api = {
    el, screen,

    focus() { screen.focus({ preventScroll: true }); },

    /** Queue pipe-coded text at the negotiated speed. */
    write(str) { queue.push(...parse(String(str))); start(); return api; },

    /** Straight to the glass — for echoing and for the local program. */
    now(str) { for (const r of parse(String(str))) emit(r[0], r[1], r[2]); return api; },

    /** Everything still in flight lands at once. */
    flush() {
      while (queue.length) { const r = queue.shift(); emit(r[0], r[1], r[2]); }
      if (timer) { clearInterval(timer); timer = 0; }
      if (waiting && waiting.onDrained) { const fn = waiting.onDrained; waiting.onDrained = null; fn(); }
      return api;
    },

    clear() { clear(out); chars = 0; return api; },

    speed(n) { cps = n; return api; },

    /** One keystroke, optionally from a set. '\r' stands for Enter. */
    async key(valid, opts = {}) {
      await drained();
      api.focus();
      return new Promise(resolve => {
        waiting = { mode: 'key', valid: valid ? valid.toUpperCase() : null, resolve, ...opts };
      });
    },

    /** A typed line. */
    async ask({ max = 30, mask = null, inputFg = 15 } = {}) {
      await drained();
      api.focus();
      return new Promise(resolve => {
        waiting = { mode: 'line', buf: '', max, mask, inputFg, resolve };
      });
    },

    async pause(text = '|08[|15Press ENTER|08]|07') {
      api.write('\n' + text + ' ');
      await api.key(null);
      A.click();
    },

    stop() {
      live = false;
      if (timer) clearInterval(timer);
      queue = [];
      finish(null);
    },
  };
  return api;
}

/** What a pipe-coded string looks like once the colour is taken out. */
export const bare = text => String(text)
  .replace(/\|\|/g, '\x01')
  .replace(/\|(?:b\d|B\d|\d\d)/g, '')
  .replace(/\x01/g, '|');

export const vlen = text => bare(text).length;

/** Pads to a visible width, ignoring the colour codes. */
export const padTo = (text, n) => text + ' '.repeat(Math.max(0, n - vlen(text)));

/** Centres a line in the terminal's width, for headings and art. */
export const centre = (text, cols = 80) =>
  ' '.repeat(Math.max(0, Math.floor((cols - vlen(text)) / 2))) + text;

/**
 * A single-line box around some pipe-coded rows, with the padding worked
 * out rather than counted by hand — every box drawn by eye in this
 * codebase came out one character short somewhere.
 * A row of '-' becomes a cross-bar.
 */
export function box(rows, { width = 68, edge = '|09' } = {}) {
  return drawn(rows, width, edge, '╔╗╚╝║═╠╣');
}

/** The same, in the single-line set, which is what a message frame used. */
export function panel(rows, { width = 72, edge = '|08' } = {}) {
  return drawn(rows, width, edge, '┌┐└┘│─├┤');
}

function drawn(rows, width, edge, [tl, tr, bl, br, side, fill, ml, mr]) {
  const rule = (l, r) => edge + l + fill.repeat(width - 2) + r + '\n';
  const body = rows.map(r => r === '-'
    ? rule(ml, mr)
    : edge + side + r + ' '.repeat(Math.max(0, width - 2 - vlen(r))) + edge + side + '\n').join('');
  return rule(tl, tr) + body + rule(bl, br);
}
