/* The desktop: icon grid, taskbar, Start menu, clock, and the idle timer
   that eventually gives up on you and starts the screensaver. */

import { h, svg, clear, $, $$, onDouble } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as A from '../core/audio.js';
import { launch, listBy } from '../apps/registry.js';
import { dialog, windows } from '../core/wm.js';
import { startSaver, stopSaver, saverRunning } from '../apps/screensaver.js';

let ctx = null;

export function initDesktop(context) {
  ctx = context;
  buildIcons();
  paintStartFlag();
  buildQuickLaunch();
  buildStartMenu();
  startClock();
  wireTray();
  wireIdle();
  wireDesktopClicks();
}

/* ── icons ───────────────────────────────────────────────────────────── */

function buildIcons() {
  const grid = clear($('#icons'));
  for (const app of listBy('desktop')) {
    const el = h('div.dicon', { tabIndex: 0, title: app.title },
      icon(app.icon, 32), h('div.label', {}, app.short || app.title));
    el.addEventListener('pointerdown', () => select(el));
    onDouble(el, () => { A.click(); launch(app.key, ctx); });
    el.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') launch(app.key, ctx);
    });
    grid.append(el);
  }
}

function select(el) {
  $$('.dicon.sel').forEach(d => d.classList.remove('sel'));
  if (el) el.classList.add('sel');
}

function wireDesktopClicks() {
  $('#desktop').addEventListener('pointerdown', ev => {
    if (!ev.target.closest('.dicon')) select(null);
    if (!ev.target.closest('#startmenu') && !ev.target.closest('#start-btn')) closeStart();
  });
}

/* ── quick launch ────────────────────────────────────────────────────── */

function buildQuickLaunch() {
  const bar = clear($('#quicklaunch'));
  bar.append(h('button.ql', {
    type: 'button', title: 'Show Desktop',
    onclick: () => { A.click(); windows().forEach(w => w.minimise()); },
  }, deskGlyph()));
  for (const app of listBy('quick')) {
    const g = icon(app.icon, 16); g.classList.remove('glyph');
    bar.append(h('button.ql', {
      type: 'button', title: app.title,
      onclick: () => { A.click(); launch(app.key, ctx); },
    }, g));
  }
}

function deskGlyph() {
  return svg('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'shape-rendering': 'crispEdges' },
    svg('rect', { x: 1, y: 2, width: 14, height: 9, fill: '#c9ccd4', stroke: '#333' }),
    svg('rect', { x: 2, y: 3, width: 12, height: 7, fill: '#1a3f8f' }),
    svg('rect', { x: 5, y: 12, width: 6, height: 2, fill: '#8b8f99' }));
}

/* ── start menu ──────────────────────────────────────────────────────── */

function buildStartMenu() {
  const menu = clear($('#startmenu'));
  const items = h('div.sm-items');

  for (const app of listBy('start')) {
    const g = icon(app.icon, 22); g.classList.remove('glyph');
    items.append(h('button.sm-item', {
      type: 'button',
      onclick: () => { closeStart(); A.click(); launch(app.key, ctx); },
    }, g, app.short || app.title));
  }

  items.append(h('div.sm-sep'));
  items.append(h('button.sm-item', {
    type: 'button',
    onclick: () => { closeStart(); A.click(); startSaver(pickSaver()); },
  }, icon('media', 22), 'Screen Saver'));

  items.append(h('button.sm-item', {
    type: 'button', onclick: () => { closeStart(); aboutBox(); },
  }, icon('info', 22), 'About this machine'));

  items.append(h('div.sm-sep'));
  items.append(h('button.sm-item', {
    type: 'button', onclick: () => { closeStart(); shutDown(); },
  }, icon('computer', 22), 'Shut Down...'));

  menu.append(
    h('div.sm-spine', {}, 'Panes', h('b', {}, '95')),
    items);

  $('#start-btn').addEventListener('click', ev => {
    ev.stopPropagation();
    A.click();
    toggleStart();
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') closeStart();
  });
}

/* The four-pane flag is four elements; CSS colours them. */
function paintStartFlag() {
  const flag = $('.start-flag');
  if (!flag || flag.childElementCount) return;
  for (let i = 0; i < 4; i++) flag.append(h('i'));
}

function toggleStart() {
  const m = $('#startmenu');
  m.hidden ? openStart() : closeStart();
}
function openStart() { $('#startmenu').hidden = false; $('#start-btn').classList.add('on'); }
function closeStart() { $('#startmenu').hidden = true; $('#start-btn').classList.remove('on'); }

function aboutBox() {
  dialog({
    title: 'About Panes 95',
    icon: 'computer',
    message:
      'Panes 95\n' +
      'Version 4.00.950 B\n\n' +
      'This machine: PACKARD HILL Legend 4200\n' +
      'Pentium(R) MMX(TM) 166MHz\n' +
      '64.0 MB RAM\n' +
      'Rockwell 33.6 Fax/Modem\n\n' +
      'Everything on this computer is a reconstruction. No part of it is\n' +
      'connected to any real service, then or now.',
  });
}

async function shutDown() {
  const choice = await dialog({
    title: 'Shut Down Panes',
    icon: 'computer',
    message: 'What would you like the computer to do?',
    buttons: ['Shut down', 'Restart', 'Cancel'],
  });
  if (!choice || choice === 'Cancel') return;
  ctx.shutdown(choice === 'Restart');
}

/* ── tray ────────────────────────────────────────────────────────────── */

function startClock() {
  const el = $('#clock');
  const tick = () => {
    const d = new Date();
    let hh = d.getHours(), ap = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12 || 12;
    el.textContent = hh + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap;
  };
  tick();
  setInterval(tick, 10000);
}

function wireTray() {
  const snd = $('#tray-sound');
  snd.addEventListener('click', () => {
    const on = !A.isEnabled();
    A.setEnabled(on);
    snd.classList.toggle('off', !on);
    if (on) A.beep();
  });
  const crt = $('#tray-crt');
  crt.addEventListener('click', () => {
    const flat = $('#crt').classList.toggle('flat');
    crt.classList.toggle('off', flat);
    A.click();
  });
}

/* ── idle / screensaver ──────────────────────────────────────────────── */

const SAVERS = ['floppies', 'starfield', 'mystify', 'marquee'];
const pickSaver = () => SAVERS[(Math.random() * SAVERS.length) | 0];

function wireIdle() {
  let last = Date.now();
  const bump = () => {
    last = Date.now();
    if (saverRunning()) stopSaver();
  };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel'])
    window.addEventListener(ev, bump, { passive: true });

  setInterval(() => {
    if (saverRunning()) return;
    if (Date.now() - last > 75000) startSaver(pickSaver());
  }, 4000);
}
