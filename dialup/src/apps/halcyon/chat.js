/* A chat room.
 *
 * Everything anybody says arrives here as plain text and is put on screen
 * with textContent — there is no path from a message to markup. Your own
 * lines go through the safety pipeline first, and anything it objects to
 * comes back as a Guide line in the room rather than as an error dialog,
 * because that is how it felt at the time.
 */

import { h, clear, $$, pick } from '../../core/dom.js';
import { dialog, getWindow } from '../../core/wm.js';
import * as A from '../../core/audio.js';
import { screen, LIMITS } from '../../core/safety.js';
import { nameColor } from './people.js';
import { openIM } from './im.js';

export const ROOMS = [
  { id: 'lobby',   name: 'Lobby 42',          blurb: 'Where everybody lands first.' },
  { id: 'coffee',  name: 'The Coffee House',  blurb: 'Slower, kinder, mostly nocturnal.' },
  { id: 'trivia',  name: 'Trivia Tavern',     blurb: 'A host, a question, a race to answer.' },
  { id: 'tech',    name: 'Computers & Tech',  blurb: 'Modems, RAM, and strong opinions about frames.' },
  { id: 'music',   name: 'Music & Bands',     blurb: 'Tape trading and tour dates.' },
  { id: 'penpals', name: 'Friends & Pen Pals',blurb: 'A/S/L, and then actual conversation.' },
];

const roomName = id => (ROOMS.find(r => r.id === id) || { name: id }).name;

const COLORS = ['#000080', '#8a0000', '#0a5c2e', '#6a1b6a', '#8a5a00', '#1a4f7a', '#000000'];

export function openChatRoom(session, roomId) {
  const id = 'halcyon-room-' + roomId;
  const existing = getWindow(id);
  if (existing) { existing.focus(); return existing; }

  if (session.bootedUntil && Date.now() < session.bootedUntil) {
    dialog({
      title: 'Terms of Service', icon: 'warn',
      message: 'You were removed from the rooms a moment ago.\nTry again in ' +
        Math.ceil((session.bootedUntil - Date.now()) / 1000) + ' seconds.',
    });
    return null;
  }

  const state = {
    ignored: new Set(),
    typing: new Map(),
    myColor: COLORS[0],
    bold: false,
    roster: [],
  };
  session.rooms.set(roomId, state);

  const log = h('div.chat-log.scroll');
  const list = h('div.chat-list.scroll');
  const typingLine = h('div.chat-typing', {}, ' ');
  const counter = h('span.chat-count', {}, '0/240');

  const input = h('input.field.chat-input', {
    type: 'text', maxLength: LIMITS.maxChars, spellcheck: false,
    placeholder: 'Say something to the room',
  });
  const sendBtn = h('button.btn.chat-send', { type: 'button' }, 'Send');

  const win = session.child({
    id, title: roomName(roomId), icon: 'chat',
    width: 600, height: 400, minWidth: 420, minHeight: 260,
    status: [roomName(roomId), ''],
    onClose: () => {
      session.net.leave(roomId);
      session.rooms.delete(roomId);
      offs.forEach(fn => fn());
      A.doorClose();
      return true;
    },
  });

  const swatches = h('div.chat-colors', {}, COLORS.map(c =>
    h('button.chat-swatch', {
      type: 'button', style: { background: c }, title: 'Text colour',
      onclick: ev => {
        state.myColor = c;
        $$('.chat-swatch', win.el).forEach(s => s.classList.remove('on'));
        ev.currentTarget.classList.add('on');
        input.focus();
      },
    })));
  swatches.firstChild.classList.add('on');

  clear(win.body).append(h('div.chat', {},
    h('div.chat-main', {},
      log,
      h('div.chat-side', {},
        h('div.chat-side-head', {}, 'People Here'),
        list,
        h('button.btn.small', {
          type: 'button', onclick: () => memberAction(session, state, win, roomId),
        }, 'Member Info'))),
    typingLine,
    h('div.chat-bar', {},
      h('button.chat-style', {
        type: 'button', title: 'Bold',
        onclick: ev => { state.bold = !state.bold; ev.currentTarget.classList.toggle('on', state.bold); input.focus(); },
      }, h('b', {}, 'B')),
      swatches,
      counter),
    h('div.chat-entry', {}, input, sendBtn)));

  /* ── rendering ─────────────────────────────────────────────────────── */

  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 40; }
  function push(el) {
    const stick = atBottom();
    log.append(el);
    while (log.childElementCount > 300) log.firstChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function sysLine(text, cls = 'sys') {
    push(h('div.chat-line', { class: cls }, text));
  }

  function sayLine(ev) {
    if (state.ignored.has(ev.from)) return;
    const color = ev.staff ? '#a00000' : (ev.self ? state.myColor : nameColor(ev.from));
    const line = h('div.chat-line', { class: ev.staff ? 'staff' : '' });
    line.append(h('b.chat-who', {
      style: { color },
      title: 'Double-click for member options',
      ondblclick: () => memberMenu(session, ev.from),
    }, ev.from, ':'));
    line.append(' ');
    line.append(h('span.chat-text', {
      style: ev.self && state.bold ? { fontWeight: '700' } : null,
    }, ev.text));
    push(line);
  }

  function drawRoster(names) {
    state.roster = names;
    clear(list);
    for (const m of names) {
      const row = h('div.chat-member', { class: m.self ? 'me' : '' },
        h('span.chat-dot', { style: { background: m.staff ? '#a00' : (m.human ? '#0a0' : nameColor(m.name)) } }),
        h('span', { style: { color: nameColor(m.name) } }, m.name),
        m.self ? h('i', {}, ' (you)') : (m.peer ? h('i', {}, ' (tab)') : null));
      row.addEventListener('pointerdown', () => {
        $$('.chat-member', list).forEach(r => r.classList.remove('sel'));
        row.classList.add('sel');
        state.selected = m.name;
      });
      row.addEventListener('dblclick', () => memberMenu(session, m.name));
      list.append(row);
    }
    win.setStatus([roomName(roomId), names.length + ' in the room']);
  }

  function drawTyping() {
    const now = Date.now();
    const who = [...state.typing.entries()].filter(([, t]) => now - t < 6000).map(([n]) => n);
    typingLine.textContent = who.length === 0 ? ' '
      : who.length === 1 ? who[0] + ' is typing...'
      : who.length + ' people are typing...';
  }
  const typingTimer = setInterval(drawTyping, 1200);

  /* ── net wiring ────────────────────────────────────────────────────── */

  const net = session.net;
  const offs = [
    net.on('chat', ev => { if (ev.room === roomId) sayLine(ev); }),
    net.on('join', ev => {
      if (ev.room !== roomId || ev.self) return;
      sysLine(ev.name + ' has entered the room.');
      A.doorOpen();
    }),
    net.on('part', ev => {
      if (ev.room !== roomId) return;
      sysLine(ev.name + ' has left the room.');
      state.typing.delete(ev.name);
      A.doorClose();
    }),
    net.on('typing', ev => {
      if (ev.room !== roomId) return;
      ev.on ? state.typing.set(ev.name, Date.now()) : state.typing.delete(ev.name);
      drawTyping();
    }),
    net.on('roster', ev => { if (ev.room === roomId) drawRoster(ev.names); }),
    () => clearInterval(typingTimer),
  ];

  sysLine('*** You have entered ' + roomName(roomId) + '. ***', 'sys head');
  const r = ROOMS.find(x => x.id === roomId);
  if (r) sysLine(r.blurb, 'sys');
  net.join(roomId);
  drawRoster(net.roster(roomId));
  A.doorOpen();

  /* ── sending ───────────────────────────────────────────────────────── */

  let typingSent = 0;
  input.addEventListener('input', () => {
    counter.textContent = input.value.length + '/' + LIMITS.maxChars;
    const now = Date.now();
    if (input.value && now - typingSent > 2500) { typingSent = now; net.typing(roomId, true); }
  });

  function send() {
    const raw = input.value;
    if (!raw.trim()) return;
    const res = screen(raw, session.bucket, { max: LIMITS.maxChars });

    if (!res.ok) {
      if (res.reason === 'flood') {
        sysLine('You are sending messages too quickly. Slow down a moment.', 'sys warn');
        session.strikes.add('Flooding a chat room.');
      } else if (res.reason === 'slow') {
        sysLine('One at a time, please.', 'sys warn');
      } else if (res.reason === 'conduct') {
        input.value = '';
        counter.textContent = '0/' + LIMITS.maxChars;
        session.strikes.add('Language that violates the Terms of Service.');
      }
      A.ding();
      return;
    }

    input.value = '';
    counter.textContent = '0/' + LIMITS.maxChars;
    net.typing(roomId, false);
    net.say(roomId, res.text);
    for (const n of res.notices) sysLine('Halcyon Guide: ' + n, 'sys warn');
    A.click();
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
  setTimeout(() => input.focus(), 60);

  return win;

  /* ── member options ────────────────────────────────────────────────── */

  async function memberAction(sess, st, w, rid) {
    if (!st.selected) {
      dialog({ title: 'Member Info', icon: 'info', message: 'Select a name in the list first.' });
      return;
    }
    memberMenu(sess, st.selected);
  }

  async function memberMenu(sess, who) {
    if (who === sess.name) {
      dialog({ title: 'Member Profile', icon: 'people',
        message: 'Screen name: ' + who + '\n\nThat is you.' });
      return;
    }
    const ignoring = state.ignored.has(who);
    const choice = await dialog({
      title: 'Member: ' + who, icon: 'people',
      message: 'Screen name: ' + who + '\nLocation: ' + fakeProfile(who) +
        '\n\nWhat would you like to do?',
      buttons: ['Send Message', ignoring ? 'Un-ignore' : 'Ignore', 'Cancel'],
    });
    if (choice === 'Send Message') openIM(sess, who);
    else if (choice === 'Ignore') {
      state.ignored.add(who);
      sysLine('You are now ignoring ' + who + '. Their messages will not appear.', 'sys');
    } else if (choice === 'Un-ignore') {
      state.ignored.delete(who);
      sysLine('You are no longer ignoring ' + who + '.', 'sys');
    }
  }
}

const PLACES = ['somewhere with a second phone line', 'the basement', 'a college computer lab',
  'the kitchen table', 'work, quietly', 'a bedroom with the door shut'];
const fakeProfile = who => pick(PLACES);
