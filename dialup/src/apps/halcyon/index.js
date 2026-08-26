/*
 * Halcyon Online 3.0 — the service.
 *
 * This module owns the session: signing on, the toolbar that stays up for
 * as long as you are connected, and the shared context every other part of
 * the service (chat, instant messages, mail, keywords) is handed.
 *
 * Halcyon is invented. It is not, and is not meant to be mistaken for,
 * any service that actually existed.
 */

import { h, clear, sleep } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { openWindow, dialog, getWindow } from '../../core/wm.js';
import * as A from '../../core/audio.js';
import { createNet } from '../../core/net.js';
import { createBucket, createStrikes, screenName as validateName, LIMITS } from '../../core/safety.js';
import { runDialer } from './dialer.js';
import { ROOMS } from './chat.js';
import { openBuddyList, imFrom } from './im.js';
import { openMailbox, unreadCount } from './mail.js';
import { openChannels, gotoKeyword, openRoomList } from './channels.js';

const STORE = 'halcyon.session';

/** The one live session, or null when signed off. */
let session = null;
export const currentSession = () => session;

/* ── entry point ─────────────────────────────────────────────────────── */

export async function open(ctx) {
  if (session) { session.toolbar?.focus(); return session.toolbar; }
  return signOnWindow(ctx);
}

function saved() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function save(patch) {
  try { localStorage.setItem(STORE, JSON.stringify({ ...saved(), ...patch })); } catch {}
}

/* ── the sign-on window ──────────────────────────────────────────────── */

function signOnWindow(ctx) {
  const prev = saved();
  const names = prev.names && prev.names.length ? prev.names : ['Guest'];

  const select = h('select.field', { style: { width: '100%' } },
    names.map(n => h('option', { value: n, selected: n === prev.last }, n)),
    h('option', { value: '__new' }, '<New Screen Name>'));

  const pass = h('input.field', {
    type: 'password', value: 'hunter2', maxLength: 24,
    style: { width: '100%' }, spellcheck: false,
  });

  const where = h('select.field', { style: { width: '100%' } },
    h('option', {}, 'Home'), h('option', {}, 'Work'), h('option', {}, 'Away'));

  const relay = h('input', { type: 'checkbox' });
  const relayUrl = h('input.field', {
    type: 'text', value: 'ws://localhost:8790', spellcheck: false,
    disabled: true, style: { width: '100%' },
  });
  relay.addEventListener('change', () => { relayUrl.disabled = !relay.checked; });

  const win = openWindow({
    id: 'halcyon-signon', title: 'Halcyon Online 3.0', icon: 'halcyon',
    width: 452, height: 388, resizable: false,
  });

  const doSignOn = async () => {
    let name = select.value;
    if (name === '__new') {
      const r = await dialog({
        title: 'Choose a Screen Name', icon: 'halcyon',
        message: 'Your screen name is how everyone on Halcyon will know you.\n' +
                 'It can be ' + LIMITS.nameMin + ' to ' + LIMITS.nameMax + ' characters.',
        buttons: ['OK', 'Cancel'], input: { value: '', maxLength: LIMITS.nameMax },
      });
      if (!r || r.button !== 'OK' || !r.value) return;
      const v = validateName(r.value);
      if (!v.ok) { await dialog({ title: 'Halcyon Online', icon: 'error', message: v.reason }); return; }
      name = v.name;
      const list = [...new Set([name, ...names.filter(n => n !== 'Guest' || names.length === 1)])].slice(0, 6);
      save({ names: list });
    }
    save({ last: name });
    win.close();
    connect(ctx, {
      name,
      mode: relay.checked ? 'relay' : 'local',
      relayUrl: relay.checked ? relayUrl.value.trim() : '',
    });
  };

  clear(win.body).append(h('div.hal-signon', {},
    h('div.hal-signon-art', {},
      h('div.hal-wordmark', {}, 'Halcyon', h('span', {}, 'ONLINE')),
      h('div.hal-signon-ver', {}, 'version 3.0')),

    h('div.hal-signon-form', {},
      h('label', {}, 'Select Screen Name'), select,
      h('label', {}, 'Enter Password'), pass,
      h('label', {}, 'Select Location'), where,

      h('div.hal-relay', {},
        h('label.hal-check', {}, relay, ' Connect through a relay on my network'),
        relayUrl,
        h('div.hal-relay-note', {},
          'Leave this off and the service runs entirely inside this browser. ',
          'Other tabs on this computer will still appear as other people.')),

      h('div.hal-signon-btns', {},
        h('button.btn', { type: 'button', onclick: () => setupBox() }, 'SETUP'),
        h('button.btn', { type: 'button', onclick: () => helpBox() }, 'HELP'),
        h('button.btn.hal-go', { type: 'button', onclick: doSignOn }, 'SIGN ON')))));

  pass.addEventListener('keydown', ev => { if (ev.key === 'Enter') doSignOn(); });
  return win;
}

const setupBox = () => dialog({
  title: 'Halcyon Setup', icon: 'phone',
  message:
    'Modem:        Rockwell 33.6 Fax/Modem on COM2\n' +
    'Access number: 555-0199 (local)\n' +
    'Backup number: 555-0198\n\n' +
    'Dial: Tone      Speaker: On until connected\n\n' +
    'These settings are decorative. There is no telephone.',
});

const helpBox = () => dialog({
  title: 'Halcyon Help', icon: 'help',
  message:
    'Sign on with any screen name you like.\n\n' +
    'Nothing you type leaves this browser unless you tick the relay box and\n' +
    'run tools/relay.mjs yourself. Even then it only reaches machines on\n' +
    'your own network.\n\n' +
    'Open this page in a second tab and you will meet yourself in the chat\n' +
    'rooms. That is the multiplayer.',
});

/* ── connecting ──────────────────────────────────────────────────────── */

async function connect(ctx, { name, mode, relayUrl }) {
  const result = await runDialer({ name, mode });
  if (result !== 'connected') return;

  const net = createNet({ mode, screenName: name, relayUrl });
  session = {
    name, net, ctx,
    bucket: createBucket(),
    rooms: new Map(),
    toolbar: null,
    signOff: () => signOff(ctx),
    strikes: null,
  };
  session.strikes = createStrikes(
    (reason, n) => tosWarning(reason, n),
    reason => tosBoot(reason));

  await net.connect();

  net.on('im', ev => imFrom(session, ev));
  net.on('status', ev => {
    if (ev.state === 'relay-lost' && session)
      dialog({ title: 'Halcyon Online', icon: 'warn',
        message: 'The relay stopped responding. You are still signed on locally.' });
  });

  openToolbar(ctx);
  await welcome(ctx);
}

function welcome(ctx) {
  const mail = unreadCount();
  const win = openWindow({
    id: 'halcyon-welcome', title: 'Welcome, ' + session.name + '!',
    icon: 'halcyon', width: 520, height: 380,
  });

  const tile = (label, sub, iconName, onclick) => h('button.hal-tile', { type: 'button', onclick },
    icon(iconName, 32), h('b', {}, label), h('span', {}, sub));

  clear(win.body).append(h('div.hal-welcome', {},
    h('div.hal-welcome-head', {},
      h('div.hal-wordmark.small', {}, 'Halcyon', h('span', {}, 'ONLINE')),
      h('div.hal-welcome-hi', {}, 'Welcome, ', h('b', {}, session.name), '!')),

    h('div.hal-mailbox', {},
      h('button.hal-mail-btn', {
        type: 'button', onclick: () => { win.close(); openMailbox(session); },
      }, icon('mail', 32),
        h('span', {}, mail ? 'You have mail!' : 'No new mail')),
      h('div.hal-mail-count', {}, mail
        ? mail + ' new message' + (mail === 1 ? '' : 's') + ' waiting'
        : 'Your mailbox is empty')),

    h('div.hal-tiles', {},
      tile('Chat', 'Rooms and people', 'chat', () => { openRoomList(session); }),
      tile('Channels', 'The whole service', 'globe', () => { openChannels(session); }),
      tile('Buddy List', 'Who is online', 'people', () => openBuddyList(session)),
      tile('The Web', 'NetScrape Navigator', 'browser',
        () => session.ctx.launch('browser', { url: 'halcyon://start' }))),

    h('div.hal-welcome-foot', {},
      'Connected at 33,600 bps  ',
      h('b', {}, 'Keyword: '),
      keywordBox())));

  A.mailFanfare();
  setTimeout(() => A.say(mail ? 'Welcome! You have mail.' : 'Welcome!'), 260);
  return win;
}

function keywordBox() {
  const input = h('input.field', {
    type: 'text', placeholder: 'type a keyword', spellcheck: false,
    style: { width: '150px' },
  });
  input.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    const kw = input.value.trim();
    input.value = '';
    if (kw) gotoKeyword(session, kw);
  });
  return input;
}

/* ── the toolbar that stays up ───────────────────────────────────────── */

function openToolbar(ctx) {
  const btn = (label, iconName, onclick) => h('button.hal-tool', { type: 'button', title: label, onclick },
    icon(iconName, 22), h('span', {}, label));

  const win = openWindow({
    id: 'halcyon-toolbar', title: 'Halcyon Online 3.0 - ' + session.name,
    icon: 'halcyon', width: 560, height: 96, resizable: false,
    y: 8, x: 60,
    onClose: () => { signOff(ctx); return true; },
  });

  clear(win.body).append(h('div.hal-toolbar', {},
    btn('Mail', 'mail', () => openMailbox(session)),
    btn('Chat', 'chat', () => openRoomList(session)),
    btn('People', 'people', () => openBuddyList(session)),
    btn('Channels', 'globe', () => openChannels(session)),
    btn('Web', 'browser', () => session.ctx.launch('browser', { url: 'halcyon://start' })),
    h('div.hal-tool-gap'),
    btn('Sign Off', 'phone', () => signOff(ctx))));

  session.toolbar = win;
  return win;
}

/* ── the TOS ladder ──────────────────────────────────────────────────── */

async function tosWarning(reason, n) {
  await dialog({
    title: 'Terms of Service', icon: 'warn',
    message:
      'A Halcyon Guide has issued you a warning.\n\n' +
      reason + '\n\n' +
      'This is warning ' + n + ' of 3. Three warnings and you will be removed\n' +
      'from the room for a short while.',
  });
}

async function tosBoot(reason) {
  const s = session;
  if (!s) return;
  for (const room of [...s.rooms.keys()]) {
    const w = getWindow('halcyon-room-' + room);
    if (w) w.close();
    s.net.leave(room);
  }
  A.doorClose();
  await dialog({
    title: 'Terms of Service', icon: 'error',
    message:
      'You have been removed from the chat rooms.\n\n' + reason + '\n\n' +
      'You may rejoin in a minute. Halcyon Guides do this so that rooms stay\n' +
      'places people want to be.',
  });
  s.bootedUntil = Date.now() + 60000;
}

/* ── signing off ─────────────────────────────────────────────────────── */

export async function signOff(ctx) {
  if (!session) return;
  const s = session;
  session = null;
  s.net.disconnect();
  for (const id of ['halcyon-toolbar', 'halcyon-welcome', 'halcyon-channels',
                    'halcyon-mail', 'halcyon-buddies']) {
    const w = getWindow(id);
    if (w) { w.onClose = null; w.close(); }
  }
  for (const room of s.rooms.keys()) {
    const w = getWindow('halcyon-room-' + room);
    if (w) w.close();
  }
  A.goodbyeChime();
  setTimeout(() => A.say('Goodbye.'), 200);
  await sleep(120);
  await dialog({
    title: 'Halcyon Online', icon: 'halcyon',
    message: 'Goodbye.\n\nThe phone line is free again.',
    sound: false,
  });
}

export { ROOMS };
