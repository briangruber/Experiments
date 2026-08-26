/*
 * The Halcyon application frame.
 *
 * Rebuilt from screenshots of the 4.x online-service client, with the
 * palette sampled off them rather than guessed:
 *
 *   - a title bar that runs blue → purple → red across its width
 *   - a short menu bar: File / Edit / Window / Sign Off / Help
 *   - a deep blue toolbar of large colour icons with light labels beneath,
 *     in groups, several carrying a drop-down caret
 *   - beneath it a cream navigation bar: back, forward, stop, reload,
 *     home, a Find drop-down, a wide address box, then Go and Keyword
 *   - the service's badge on a blue panel at the right-hand end
 *
 * Everything else in the service is an MDI child inside this window.
 */

import { h, clear, $$ } from '../../core/dom.js';
import { openWindow, menuBar, dialog } from '../../core/wm.js';
import { icon } from '../../core/icons.js';
import * as A from '../../core/audio.js';

/* Toolbar groups. `menu` gives the button a caret and a drop-down. */
const GROUPS = session => {
  const go = what => () => session.go(what);
  return [
    [
      { icon: 'mailRead',  label: 'Read',    on: go('mail') },
      { icon: 'mailWrite', label: 'Write',   on: go('compose') },
      { icon: 'mail',      label: 'Mail Center', on: go('mail'), menu: [
        { label: 'Read New Mail', accel: 'Ctrl+R', onclick: go('mail') },
        { label: 'Compose Mail', accel: 'Ctrl+M', onclick: go('compose') },
        '-',
        { label: 'Old Mail', disabled: true },
        { label: 'Sent Mail', disabled: true },
        { label: 'Address Book', disabled: true },
      ] },
      { icon: 'print',     label: 'Print',   on: go('print') },
    ],
    [
      { icon: 'folder',    label: 'My Files', on: go('myfiles'), menu: [
        { label: 'Download Manager', onclick: go('myfiles') },
        { label: 'Personal Filing Cabinet', disabled: true },
        { label: 'Log Manager', disabled: true },
      ] },
      { icon: 'halcyonMark', label: 'My Halcyon', on: go('preferences'), menu: [
        { label: 'Set Up Halcyon', disabled: true },
        { label: 'Preferences', onclick: go('preferences') },
        '-',
        { label: 'My Member Profile', onclick: go('profile') },
        { label: 'Screen Names', onclick: go('screennames') },
        { label: 'Passwords', onclick: go('passwords') },
        { label: 'Parental Controls', onclick: go('parental') },
        '-',
        { label: 'Online Clock', onclick: go('clock') },
        { label: 'Buddy List', onclick: go('buddies') },
        { label: 'Stock Portfolios', onclick: go('money') },
        { label: 'Reminder Service', disabled: true },
        { label: 'News Profiles', onclick: go('news') },
      ] },
      { icon: 'star',      label: 'Favorites', on: go('favorites'), menu: [
        { label: 'Favorite Places', accel: 'Ctrl+B', onclick: go('favorites') },
        { label: 'Add Top Window to Favorite Places', onclick: go('addfav') },
        '-',
        { label: 'Go To Keyword', accel: 'Ctrl+K', onclick: go('keyword') },
      ] },
    ],
    [
      { icon: 'browser',   label: 'Internet', on: go('web'), menu: [
        { label: 'Go to the Web', onclick: go('web') },
        { label: 'Search the Web', onclick: go('search') },
        '-',
        { label: 'Newsgroups', disabled: true },
        { label: 'FTP', disabled: true },
      ] },
      { icon: 'globe',     label: 'Channels', on: go('channels') },
      { icon: 'people',    label: 'People',   on: go('rooms'), menu: [
        { label: 'People Connection', accel: 'Ctrl+L', onclick: go('lobby') },
        { label: 'Find a Chat', onclick: go('rooms') },
        '-',
        { label: 'Send Instant Message', accel: 'Ctrl+I', onclick: go('im') },
        { label: 'Buddy List', onclick: go('buddies') },
        { label: 'Member Directory', onclick: go('directory') },
      ] },
    ],
  ];
};

export function openFrame(session) {
  const client = h('div.hal-client');
  const addr = h('input.hal-addr', {
    type: 'text', spellcheck: false,
    placeholder: 'Type Keyword or Web Address here and click Go',
  });

  const win = openWindow({
    id: 'halcyon-frame',
    title: 'Halcyon Online',
    icon: 'halcyon',
    width: 900, height: 640, minWidth: 620, minHeight: 420,
    x: 18, y: 10,
    status: ['', ''],
    aol: true,
    onFavorite: () => session.go('favorites'),
    onClose: () => { session.signOff(); return true; },
    onResize: () => reflowMaximised(),
  });

  /* ── row 1: the icon toolbar ──────────────────────────────────────── */

  const toolbar = h('div.hal-bar');
  let openPop = null;
  const closePop = () => {
    if (!openPop) return;
    openPop.pop.remove();
    openPop.btn.classList.remove('on');
    openPop = null;
    document.removeEventListener('pointerdown', awayPop, true);
  };
  const awayPop = ev => { if (!ev.target.closest('.hal-bar')) closePop(); };

  for (const group of GROUPS(session)) {
    const box = h('div.hal-bar-group');
    for (const t of group) {
      const g = icon(t.icon, 30);
      g.classList.remove('glyph');
      const btn = h('button.hal-tool', { type: 'button', title: t.label },
        h('div.hal-tool-icon', {}, g),
        h('div.hal-tool-label', {}, t.label, t.menu ? h('i.hal-caret', {}, '') : null));

      btn.addEventListener('click', ev => {
        A.click();
        // The caret half opens the drop-down; the icon runs the action.
        const wantsMenu = t.menu &&
          (ev.target.closest('.hal-caret') || ev.altKey);
        if (!wantsMenu) { closePop(); t.on(); return; }
        const wasOpen = openPop && openPop.btn === btn;
        closePop();
        if (wasOpen) return;
        const pop = h('div.menu-pop.hal-pop');
        for (const it of t.menu) {
          if (it === '-') { pop.append(h('div.menu-sep')); continue; }
          pop.append(h('button.menu-item', {
            type: 'button', disabled: !!it.disabled,
            onclick: () => { closePop(); it.onclick ? it.onclick() : A.beep(); },
          }, h('span', {}, it.label), h('em', {}, it.accel || '')));
        }
        toolbar.append(pop);
        pop.style.left = Math.min(
          btn.getBoundingClientRect().left - toolbar.getBoundingClientRect().left,
          toolbar.clientWidth - 210) + 'px';
        btn.classList.add('on');
        openPop = { btn, pop };
        document.addEventListener('pointerdown', awayPop, true);
      });

      box.append(btn);
    }
    toolbar.append(box);
  }

  const badge = icon('halcyonMark', 40);
  badge.classList.remove('glyph');
  toolbar.append(h('div.hal-bar-spacer'), h('div.hal-bar-badge', {}, badge));

  /* ── row 2: the navigation bar ────────────────────────────────────── */

  const navBtn = (glyph, tip, on, cls = '') =>
    h('button.hal-nav-btn', { type: 'button', title: tip, class: cls, onclick: on }, glyph);

  const nav = h('div.hal-nav', {},
    navBtn('◀', 'Back', () => session.go('back'), 'arrow'),
    navBtn('▶', 'Forward', () => session.go('forward'), 'arrow'),
    navBtn('✕', 'Stop', () => A.beep()),
    navBtn('↻', 'Reload', () => session.go('welcome')),
    navBtn('⌂', 'Home', () => session.go('welcome')),
    h('button.hal-find', { type: 'button', onclick: () => session.go('search') },
      'Find ', h('i.hal-caret', {}, '')),
    addr,
    h('button.aol-btn.small', { type: 'button', onclick: () => submit() }, 'Go'),
    h('button.aol-btn.small', { type: 'button', onclick: () => session.go('keyword') }, 'Keyword'));

  clear(win.body).append(h('div.hal-frame', {},
    menuBar(menus(session)), toolbar, nav, client));

  function submit() {
    const v = addr.value.trim();
    addr.value = '';
    if (!v) return;
    if (/^(https?:\/\/|www\.)/i.test(v)) session.ctx.launch('browser', { url: v });
    else session.go('keyword', v);
  }
  addr.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
  });

  /* Accelerators, the ones the menus advertise. */
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
    closePop();
    return prevClose ? prevClose() : true;
  };

  function reflowMaximised() {
    for (const el of $$('.win.mdi.maxed', client)) {
      el.style.width = '100%';
      el.style.height = '100%';
    }
  }

  win.client = client;
  win.focusKeyword = () => { addr.focus(); addr.select(); };
  return win;
}

/* ── the menu bar ────────────────────────────────────────────────────── */

/* The 4.x client's menu bar was short: the toolbar had taken over. */
function menus(session) {
  const go = (what, arg) => () => session.go(what, arg);
  return [
    { label: 'File', items: [
      { label: 'New', accel: 'Ctrl+N', onclick: go('notepad') },
      { label: 'Open...', accel: 'Ctrl+O', disabled: true },
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
      '-',
      { label: 'Find in Top Window', accel: 'Ctrl+F', disabled: true },
    ] },

    { label: 'Window', items: [
      { label: 'Cascade', onclick: () => session.arrange('cascade') },
      { label: 'Tile', onclick: () => session.arrange('tile') },
      { label: 'Close All Except Front', onclick: () => session.arrange('closeRest') },
      '-',
      { label: 'Remember Window Size and Position', disabled: true },
    ] },

    { label: 'Sign Off', items: [
      { label: 'Sign Off', onclick: go('signoff') },
      { label: 'Switch Screen Name', disabled: true },
    ] },

    { label: 'Help', items: [
      { label: 'Halcyon Help', onclick: go('help') },
      { label: 'Keyword List', onclick: go('favorites') },
      '-',
      { label: 'Terms of Service', onclick: go('tos') },
      '-',
      { label: 'About Halcyon Online', onclick: () => dialog({
        title: 'About Halcyon Online', icon: 'halcyon', aol: true,
        message:
          'Halcyon Online for Panes 95\n' +
          'Version 3.0\n\n' +
          'Halcyon is invented. It is not, and is not meant to be mistaken\n' +
          'for, any service that actually existed.\n\n' +
          'The window chrome, the toolbar and the palette follow screenshots\n' +
          'of the online services of the period. The name, the badge and\n' +
          'every icon here are ours.',
      }) },
    ] },
  ];
}
