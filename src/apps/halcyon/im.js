/* Instant messages and the Buddy List.
 *
 * Every IM window has a Report button. It is in period — you could always
 * notify staff — and it is the fastest honest answer to "what do I do
 * about this person", which matters more here than any word filter.
 */

import { h, clear, $$ } from '../../core/dom.js';
import { dialog, getWindow } from '../../core/wm.js';
import { icon } from '../../core/icons.js';
import * as A from '../../core/audio.js';
import { screen, LIMITS } from '../../core/safety.js';
import { nameColor, PERSONAS } from './people.js';

const convos = new Map();     // screen name -> { win, log }

/* ── one conversation ────────────────────────────────────────────────── */

export function openIM(session, who, firstLine = null) {
  const id = 'halcyon-im-' + who;
  const existing = getWindow(id);
  if (existing && convos.has(who)) {
    existing.focus();
    if (firstLine) append(who, who, firstLine);
    return existing;
  }

  const log = h('div.im-log.scroll');
  const box = h('textarea.field.im-box', {
    rows: 3, maxLength: LIMITS.imMaxChars, spellcheck: false,
    placeholder: 'Type a message',
  });

  const win = session.child({
    id, title: 'Instant Message From: ' + who, icon: 'chat',
    width: 400, height: 300, minWidth: 280, minHeight: 200,
    onClose: () => { convos.delete(who); return true; },
  });

  const send = () => {
    const raw = box.value;
    if (!raw.trim()) return;
    const res = screen(raw, session.bucket, { max: LIMITS.imMaxChars });
    if (!res.ok) {
      if (res.reason === 'conduct') {
        session.strikes.add('Language in an instant message.');
        box.value = '';
      } else appendSys(who, res.reason === 'flood'
        ? 'You are sending messages too quickly.'
        : 'One at a time, please.');
      A.ding();
      return;
    }
    box.value = '';
    append(who, session.name, res.text, true);
    for (const n of res.notices) appendSys(who, 'Halcyon: ' + n);
    session.net.im(who, res.text);
    A.click();
  };

  clear(win.body).append(h('div.im', {},
    log,
    h('div.im-entry', {}, box,
      h('div.im-btns', {},
        h('button.btn.small', { type: 'button', onclick: send }, 'Send'),
        h('button.btn.small', {
          type: 'button', title: 'Notify a Halcyon Guide about this person',
          onclick: () => report(session, who),
        }, 'Report'),
        h('button.btn.small', {
          type: 'button', onclick: () => { win.close(); },
        }, 'Close')))));

  box.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });

  convos.set(who, { win, log });
  win.setTitle('Instant Message: ' + who);
  if (firstLine) append(who, who, firstLine);
  setTimeout(() => box.focus(), 60);
  return win;
}

function append(who, from, text, mine = false) {
  const c = convos.get(who);
  if (!c) return;
  const line = h('div.im-line', {},
    h('b', { style: { color: mine ? '#000080' : nameColor(from) } }, from, ': '),
    h('span', {}, text));
  c.log.append(line);
  c.log.scrollTop = c.log.scrollHeight;
}

function appendSys(who, text) {
  const c = convos.get(who);
  if (!c) return;
  c.log.append(h('div.im-line.sys', {}, text));
  c.log.scrollTop = c.log.scrollHeight;
}

/** An instant message arrived from the wire. */
export function imFrom(session, ev) {
  const who = ev.from;
  if (session.ignored && session.ignored.has(who)) return;

  const existing = convos.get(who);
  if (existing) {
    append(who, who, ev.text);
    existing.win.flash(true);
    A.imChime();
    if (ev.suspicious) warnBanner(existing.win, who);
    return;
  }

  const win = openIM(session, who, ev.text);
  win.flash(true);
  A.imChime();
  if (ev.suspicious) warnBanner(win, who);
}

/** The one visual tell on a message that is trying something on. */
function warnBanner(win, who) {
  if (win.el.querySelector('.im-warn')) return;
  const bar = h('div.im-warn', {},
    icon('warn', 16),
    h('span', {}, 'Halcyon staff will never ask for your password. ' +
      'You can Report this member.'));
  bar.querySelector('svg').classList.remove('glyph');
  win.body.firstChild.prepend(bar);
}

async function report(session, who) {
  const choice = await dialog({
    title: 'Notify a Guide', icon: 'warn',
    message: 'Report ' + who + ' to a Halcyon Guide?\n\n' +
      'Nothing is sent anywhere — this machine is the whole service — but the\n' +
      'Guide will look at the conversation and come back to you.',
    buttons: ['Report', 'Cancel'],
  });
  if (choice !== 'Report') return;
  appendSys(who, 'Your report has been sent to a Halcyon Guide.');
  setTimeout(() => {
    const guide = 'HalcyonGuide MJ';
    openIM(session, guide);
    append(guide, guide,
      'Thanks for the report about ' + who + '. I have had a look. ' +
      'If anybody ever asks you for your password, your address, or your ' +
      'telephone number, the right answer is always no — and reporting them, ' +
      'which you just did, is exactly right.');
    A.imChime();
  }, 2600);
}

/* ── buddy list ──────────────────────────────────────────────────────── */

export function openBuddyList(session) {
  const win = session.child({
    id: 'halcyon-buddies', title: 'Buddy List Window', icon: 'people',
    width: 232, height: 360, minWidth: 200, minHeight: 220,
    x: 300, y: 40,
  });

  const tree = h('div.buddy-tree.scroll');
  const count = h('div.buddy-count', {}, '');

  clear(win.body).append(h('div.buddy', {},
    h('div.buddy-head', {}, 'Online'),
    tree, count,
    h('div.buddy-btns', {},
      h('button.btn.small', {
        type: 'button',
        onclick: () => {
          const sel = win.el.querySelector('.buddy-name.sel');
          if (!sel) return dialog({ title: 'Buddy List', icon: 'info', message: 'Pick a buddy first.' });
          openIM(session, sel.dataset.name);
        },
      }, 'IM'),
      h('button.btn.small', {
        type: 'button', onclick: () => setupBuddies(session, draw),
      }, 'Setup'))));

  function draw() {
    const online = session.net.knownBots();
    const peers = new Set();
    for (const r of ['lobby', 'coffee', 'trivia', 'tech', 'music', 'penpals'])
      for (const m of session.net.roster(r)) if (m.human && !m.self) peers.add(m.name);

    clear(tree);
    group('Buddies', online.slice(0, 4).map(b => b.name));
    group('Other Tabs', [...peers]);
    group('Family', online.slice(4, 6).map(b => b.name));
    group('Staff', ['HalcyonGuide MJ']);
    const n = online.length + peers.size + 1;
    count.textContent = n + ' of ' + (n + 3) + ' buddies online';
  }

  function group(label, names) {
    const kids = h('div.buddy-kids');
    const head = h('div.buddy-group', {}, h('span.buddy-caret', {}, '-'), label, ' (' + names.length + ')');
    head.addEventListener('click', () => {
      const open = kids.hidden;
      kids.hidden = !open;
      head.firstChild.textContent = open ? '-' : '+';
    });
    for (const n of names) {
      const row = h('div.buddy-name', {
        dataset: { name: n }, style: { color: nameColor(n) },
      }, n);
      row.addEventListener('pointerdown', () => {
        $$('.buddy-name', tree).forEach(r => r.classList.remove('sel'));
        row.classList.add('sel');
      });
      row.addEventListener('dblclick', () => openIM(session, n));
      kids.append(row);
    }
    if (!names.length) kids.append(h('div.buddy-empty', {}, 'nobody right now'));
    tree.append(head, kids);
  }

  draw();
  const off = session.net.on('roster', draw);
  win.onClose = () => { off(); return true; };

  // Somebody signs on every so often, with the sound everyone knew.
  const timer = setInterval(() => {
    if (Math.random() < 0.25) { A.buddyIn(); draw(); }
  }, 30000);
  const prevClose = win.onClose;
  win.onClose = () => { clearInterval(timer); return prevClose ? prevClose() : true; };

  return win;
}

function setupBuddies(session, redraw) {
  return dialog({
    title: 'Buddy List Setup', icon: 'people',
    message:
      'Your buddies are the people who happen to be in the rooms tonight, plus\n' +
      'any other tab you have open on this computer.\n\n' +
      'There is no server keeping a list for you. When you close the page,\n' +
      'everyone goes home.',
  });
}

export const knownPeople = () => PERSONAS.map(p => p.name);
