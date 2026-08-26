/*
 * Telepath 2.6 — the terminal program.
 *
 * Before the service and before the browser, this is how you got out of
 * the house: a comms program, a dialling directory somebody posted on a
 * board, and a lot of patience. Four numbers are in the book. One of them
 * answers, one is engaged, one rings out, and one has been disconnected —
 * which is roughly the hit rate anybody had.
 *
 * The speed you dial at is a real setting, because the difference between
 * text arriving at 2400 baud and at 14400 is most of the feeling.
 */

import { h, clear } from '../../core/dom.js';
import { openWindow, menuBar, dialog } from '../../core/wm.js';
import * as A from '../../core/audio.js';
import { createTerminal } from './screen.js';
import { runBoard, SYSOP } from './board.js';

const SPEEDS = [
  ['2400 bps', 240], ['9600 bps', 960], ['14400 bps', 1440], ['33600 bps', 3360],
];

const BOOK = [
  { name: 'The Midnight Carnival', number: '555-0142', speed: 2, nodes: '2 nodes',
    note: 'Doors, message bases. Sysop ' + SYSOP + '.', answers: 'board' },
  { name: 'Antler Lodge', number: '555-0188', speed: 0, nodes: '1 node',
    note: 'Never free after six.', answers: 'busy' },
  { name: 'The Pixel Foundry', number: '555-0175', speed: 2, nodes: '1 node',
    note: 'Art and trackers. Up and down lately.', answers: 'noanswer' },
  { name: 'County Library Catalogue', number: '555-0100', speed: 0, nodes: 'public',
    note: 'Was free. Is not any more.', answers: 'dead' },
];

export function open() {
  const win = openWindow({
    id: 'telepath', title: 'Telepath 2.6', icon: 'phone',
    width: 700, height: 520, minWidth: 520, minHeight: 360,
    onClose: () => { hangUp(true); return true; },
  });

  let term = null, controls = null, online = false, clock = 0, started = 0;
  let skipping = null;              // resolves the current dial-time wait
  const status = h('div.tp-status');
  const stage = h('div.tp-stage');

  win.body.classList.add('tp-body');
  clear(win.body).append(
    menuBar([
      { label: 'File', items: [
        { label: 'Dialling Directory', onclick: () => showBook() },
        { label: 'Hang Up', onclick: () => hangUp() },
        { label: 'Exit', onclick: () => win.close() },
      ] },
      { label: 'Settings', items: SPEEDS.map(([label], i) => ({
        label: 'Connect at ' + label,
        onclick: () => { speed = i; showBook(); },
      })) },
      { label: 'Help', items: [
        { label: 'About Telepath', onclick: () => dialog({
          title: 'About Telepath 2.6', icon: 'phone',
          message: 'Telepath 2.6 for Windows\n\n' +
            'Terminal emulation: ANSI-BBS, 80 columns.\n' +
            'This copy is unregistered. Please send £25 to the address in\n' +
            'the documentation, which nobody has ever done.',
        }) },
      ] },
    ]),
    stage, status);

  let speed = 2;
  showBook();
  tickClock();

  /* ── the dialling directory ────────────────────────────────────────── */

  function showBook() {
    if (online) return;
    setStatus('OFFLINE');
    clear(stage).append(h('div.tp-book', {},
      h('div.tp-book-head', {}, 'Dialling Directory',
        h('span', {}, 'Connect at ' + SPEEDS[speed][0])),
      h('div.tp-rows', {}, ...BOOK.map((b, i) => h('button.tp-row', {
        type: 'button', onclick: () => dial(b),
      },
        h('b', {}, String(i + 1)),
        h('span.tp-name', {}, b.name, h('em', {}, b.note)),
        h('span.tp-num', {}, b.number),
        h('span.tp-nodes', {}, b.nodes)))),
      h('div.tp-book-foot', {},
        'Pick a board. Long distance is charged by the minute, so this one ' +
        'is not — it is all 555 and none of it is real.')));
  }

  /* ── dialling ──────────────────────────────────────────────────────── */

  async function dial(entry) {
    online = true;
    term = createTerminal({ cps: SPEEDS[speed][1] });
    clear(stage).append(term.el);
    const skipBtn = h('button.btn.small.tp-skip', {
      type: 'button', title: 'Jump to the end of the handshake',
      onclick: () => skipNoise(),
    }, 'Skip the noise');
    controls = h('div.tp-abort', {}, skipBtn,
      h('button.btn.small', { type: 'button', title: 'Land everything still in flight',
        onclick: () => { term.flush(); term.focus(); } }, 'Faster'),
      h('button.btn.small', { type: 'button', onclick: () => hangUp() }, 'Hang Up'));
    stage.append(controls);
    setStatus('DIALLING');
    term.focus();

    const ctx = A.unlock();
    let at = ctx.currentTime + 0.2;
    at = A.offHook(at);
    term.now('|10ATZ\n|07OK\n|10ATDT' + entry.number.replace('-', '') + '\n');
    at = A.dialDigits(entry.number.replace('-', ''), at);

    if (entry.answers === 'dead') {
      await waitOrSkip((at - ctx.currentTime) * 1000 + 400);
      A.ding();
      term.now('|12\nNO DIALTONE\n\n|08That number has been disconnected. ' +
               'It was in the list for years.\n');
      return dropped();
    }
    if (entry.answers === 'busy') {
      await waitOrSkip((at - ctx.currentTime) * 1000 + 200);
      A.busySignal(ctx.currentTime, 3);
      term.now('|12\nBUSY\n\n|08Somebody else got there first. They always do.\n');
      await waitOrSkip(2600);
      return dropped();
    }
    if (entry.answers === 'noanswer') {
      const ring = A.ringback(at + 0.3, 4);
      term.now('|08\n(ringing)\n');
      await waitOrSkip((ring - ctx.currentTime) * 1000);
      term.now('|12NO ANSWER\n\n|08It has been off more than on this month.\n');
      return dropped();
    }

    // it answers
    const ring = A.ringback(at + 0.25, 1);
    const shake = ring - 1.1;
    const end = A.handshake(shake);
    setStatus('CONNECTING');
    await waitOrSkip((end - ctx.currentTime) * 1000);
    skipping = null;
    if (!online) return;
    skipBtn.remove();
    term.now('|10CONNECT ' + SPEEDS[speed][0].replace(' bps', '') + '/ARQ\n\n');
    started = Date.now();
    setStatus('ONLINE');

    try {
      await runBoard(term, localName());
    } catch { /* the caller hung up mid-call, which is allowed */ }
    if (online) {
      await wait(1200);
      dropped();
    }
  }

  /* The line is down. The transcript stays on the glass — you always got
     to read what the board said last — and the only button left redials. */
  function dropped() {
    if (term) term.stop();
    online = false;
    started = 0;
    setStatus('OFFLINE');
    if (controls) {
      clear(controls).append(
        h('button.btn', { type: 'button', onclick: () => showBook() }, 'Dialling Directory'));
    }
  }

  function hangUp(closing) {
    if (!online) { if (!closing) showBook(); return; }
    A.panic();
    if (term) { term.now('\n|12NO CARRIER\n'); }
    if (closing) { if (term) term.stop(); online = false; return; }
    dropped();
  }

  function setStatus(state) {
    const secs = online && started ? Math.floor((Date.now() - started) / 1000) : 0;
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    clear(status).append(
      h('b', { class: online ? 'on' : '' }, state),
      h('span', {}, 'ANSI-BBS  ' + SPEEDS[speed][0] + '  8-N-1'),
      h('span', {}, 'ONLINE ' + mm + ':' + ss),
      h('span.tp-hint', {}, 'Alt-Z would be help, if this copy were registered'));
  }

  function tickClock() {
    clock = setInterval(() => {
      if (!document.body.contains(status)) { clearInterval(clock); return; }
      setStatus(online ? 'ONLINE' : 'OFFLINE');
    }, 1000);
  }

  const wait = ms => new Promise(res => setTimeout(res, Math.max(0, ms)));

  /* The modem noise is the best part exactly once. After that there has to
     be a way past it, the same as the service's dialer has. */
  function skipNoise() {
    if (!skipping) return;
    A.panic();
    const fn = skipping; skipping = null;
    fn();
  }

  /** Waits out a schedule, unless somebody presses the button. */
  function waitOrSkip(ms) {
    return new Promise(res => {
      const timer = setTimeout(() => { skipping = null; res(); }, Math.max(0, ms));
      skipping = () => { clearTimeout(timer); res(); };
    });
  }

  return win;
}

/* The handle the board offers you first, if you have one. */
function localName() {
  try { return JSON.parse(localStorage.getItem('halcyon.session') || 'null')?.name || ''; }
  catch { return ''; }
}
