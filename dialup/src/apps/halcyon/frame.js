/*
 * The Halcyon application frame.
 *
 * Built from screenshots of America Online 2.5 and 3.0 for Windows, which
 * is the shape everybody actually remembers:
 *
 *   - one application window, and everything else is an MDI child inside
 *     it rather than a window on the desktop
 *   - a menu bar of File / Edit / Go To / Mail / Members / Window / Help
 *   - a single row of small icon buttons under it, in raised frames,
 *     grouped by separators, with no text labels at all
 *   - the keyword box at the right-hand end of that row
 *
 * The accelerators in the Go To menu are the real ones: Keyword was
 * Ctrl+K, the Lobby was Ctrl+L, Favorite Places was Ctrl+B, and the Main
 * Menu was Ctrl+D.
 */

import { h, clear, $$ } from '../../core/dom.js';
import { openWindow, menuBar, dialog } from '../../core/wm.js';
import { icon } from '../../core/icons.js';
import * as A from '../../core/audio.js';

/** Toolbar groups: [iconName, tooltip, action] with null as a separator. */
const TOOLS = session => [
  ['mailRead',  'Read New Mail',        () => session.go('mail')],
  ['mailWrite', 'Compose Mail',         () => session.go('compose')],
  null,
  ['globe',     'Channels',             () => session.go('channels')],
  ['keyword',   'Keyword',              () => session.go('keyword')],
  ['find',      'Find Central',         () => session.go('search')],
  ['star',      'Favorite Places',      () => session.go('favorites')],
  null,
  ['chat',      'People Connection',    () => session.go('rooms')],
  ['people',    'Buddy List',           () => session.go('buddies')],
  ['directory', 'Member Directory',     () => session.go('directory')],
  null,
  ['browser',   'Internet',             () => session.go('web')],
  ['clock',     'Online Clock',         () => session.go('clock')],
  ['print',     'Print',                () => session.go('print')],
  null,
  ['help',      'Help',                 () => session.go('help')],
];

export function openFrame(session) {
  const client = h('div.hal-client');
  const kwInput = h('input.field.hal-kw-input', {
    type: 'text', spellcheck: false, title: 'Type a keyword and press Enter',
    placeholder: 'Keyword',
  });

  const win = openWindow({
    id: 'halcyon-frame',
    title: 'Halcyon Online',
    icon: 'halcyon',
    width: 860, height: 620, minWidth: 560, minHeight: 380,
    x: 24, y: 16,
    status: ['', ''],
    onClose: () => { session.signOff(); return true; },
    onResize: () => reflowMaximised(),
  });

  const bar = menuBar(menus(session));
  const toolbar = h('div.hal-bar');

  for (const t of TOOLS(session)) {
    if (!t) { toolbar.append(h('div.hal-bar-sep')); continue; }
    const [name, tip, fn] = t;
    const g = icon(name, 20);
    g.classList.remove('glyph');
    toolbar.append(h('button.hal-bar-btn', {
      type: 'button', title: tip,
      onclick: () => { A.click(); fn(); },
    }, g));
  }

  toolbar.append(
    h('div.hal-bar-gap'),
    h('div.hal-kw', {},
      h('label', {}, 'Keyword:'), kwInput,
      h('button.btn.small', {
        type: 'button', onclick: () => submitKeyword(),
      }, 'Go')));

  clear(win.body).append(h('div.hal-frame', {}, bar, toolbar, client));

  function submitKeyword() {
    const v = kwInput.value.trim();
    kwInput.value = '';
    if (v) session.go('keyword', v);
  }
  kwInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); submitKeyword(); }
  });

  /* Accelerators, the ones the real Go To menu advertised. */
  const keys = ev => {
    if (!ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const map = {
      k: 'keyword', l: 'lobby', b: 'favorites', d: 'welcome',
      m: 'compose', r: 'mail', i: 'im', f: 'locate',
      4: 'news', 5: 'money', 6: 'trivia', 7: 'web',
    };
    const what = map[ev.key.toLowerCase()];
    if (!what) return;
    ev.preventDefault();
    session.go(what);
  };
  document.addEventListener('keydown', keys);

  const prevClose = win.onClose;
  win.onClose = () => {
    document.removeEventListener('keydown', keys);
    return prevClose ? prevClose() : true;
  };

  /** A maximised child has to be re-fitted when the frame resizes. */
  function reflowMaximised() {
    for (const el of $$('.win.mdi.maxed', client)) {
      el.style.width = '100%';
      el.style.height = '100%';
    }
  }

  win.client = client;
  win.focusKeyword = () => { kwInput.focus(); kwInput.select(); };
  return win;
}

/* ── the menus ───────────────────────────────────────────────────────── */

function menus(session) {
  const go = (what, arg) => () => session.go(what, arg);
  return [
    { label: 'File', items: [
      { label: 'New', accel: 'Ctrl+N', onclick: go('notepad') },
      { label: 'Open...', accel: 'Ctrl+O', onclick: go('unavailable') },
      { label: 'Save', accel: 'Ctrl+S', disabled: true },
      '-',
      { label: 'Print...', accel: 'Ctrl+P', onclick: go('print') },
      '-',
      { label: 'Exit', onclick: go('signoff') },
    ] },

    { label: 'Edit', items: [
      { label: 'Undo', accel: 'Ctrl+Z', disabled: true },
      '-',
      { label: 'Cut', accel: 'Ctrl+X', disabled: true },
      { label: 'Copy', accel: 'Ctrl+C', disabled: true },
      { label: 'Paste', accel: 'Ctrl+V', disabled: true },
    ] },

    // Straight from the 2.x screenshot, minus the items we do not have.
    { label: 'Go To', items: [
      { label: 'Set Up & Sign On', disabled: true },
      '-',
      { label: 'Main Menu', accel: 'Ctrl+D', onclick: go('welcome') },
      { label: 'Keyword...', accel: 'Ctrl+K', onclick: go('keyword') },
      { label: 'Lobby', accel: 'Ctrl+L', onclick: go('lobby') },
      { label: 'Favorite Places', accel: 'Ctrl+B', onclick: go('favorites') },
      { label: 'Online Clock', onclick: go('clock') },
      '-',
      { label: 'Edit Go To Menu', disabled: true },
      '-',
      { label: 'Top News', accel: 'Ctrl+4', onclick: go('news') },
      { label: 'Stock Quotes', accel: 'Ctrl+5', onclick: go('money') },
      { label: 'Center Stage', accel: 'Ctrl+6', onclick: go('trivia') },
      { label: 'Internet Connection', accel: 'Ctrl+7', onclick: go('web') },
    ] },

    { label: 'Mail', items: [
      { label: 'Read New Mail', accel: 'Ctrl+R', onclick: go('mail') },
      { label: 'Compose Mail', accel: 'Ctrl+M', onclick: go('compose') },
      '-',
      { label: 'Mail Center', onclick: go('mail') },
    ] },

    { label: 'Members', items: [
      { label: 'Member Directory', onclick: go('directory') },
      { label: 'Buddy Lists', onclick: go('buddies') },
      { label: 'Send Instant Message', accel: 'Ctrl+I', onclick: go('im') },
      { label: 'Locate a Member Online', accel: 'Ctrl+F', onclick: go('locate') },
      '-',
      { label: 'Terms of Service', onclick: go('tos') },
    ] },

    { label: 'Window', items: [
      { label: 'Cascade', onclick: () => session.arrange('cascade') },
      { label: 'Tile', onclick: () => session.arrange('tile') },
      { label: 'Close All', onclick: () => session.arrange('close') },
    ] },

    { label: 'Help', items: [
      { label: 'Halcyon Help', onclick: go('help') },
      '-',
      { label: 'About Halcyon Online', onclick: () => dialog({
        title: 'About Halcyon Online', icon: 'halcyon',
        message:
          'Halcyon Online for Panes 95\n' +
          'Version 3.0\n\n' +
          'Halcyon is invented. It is not, and is not meant to be mistaken\n' +
          'for, any service that actually existed.\n\n' +
          'The layout of this window follows screenshots of the online\n' +
          'services of the period: one application frame, a menu bar, a row\n' +
          'of unlabelled icons, and every window living inside.',
      }) },
    ] },
  ];
}
