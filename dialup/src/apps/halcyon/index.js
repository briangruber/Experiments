/*
 * Halcyon Online 3.0 — the service.
 *
 * The shape of this follows screenshots of America Online 2.5 and 3.0 for
 * Windows: a "Welcome" sign-on window with a textured panel down the left
 * and the wordmark centred on the right, then one application frame with a
 * menu bar and an unlabelled icon toolbar, inside which every other window
 * lives as an MDI child.
 *
 * Halcyon itself is invented — the name, the wordmark and the artwork are
 * ours. What is borrowed is the layout grammar of the era, which nobody
 * owns.
 */

import { h, clear, sleep } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { openWindow, dialog, getWindow, windows } from '../../core/wm.js';
import * as A from '../../core/audio.js';
import { createNet } from '../../core/net.js';
import { createBucket, createStrikes, screenName as validateName, LIMITS } from '../../core/safety.js';
import { runDialer } from './dialer.js';
import { ROOMS, openChatRoom } from './chat.js';
import { openBuddyList, imFrom, openIM } from './im.js';
import { openMailbox, unreadCount, composeMail } from './mail.js';
import { openChannels, gotoKeyword, openRoomList, openChannel, keywordDialog, findCentral }
  from './channels.js';
import { ART } from '../../assets/art.js';
import { openFrame } from './frame.js';
import { wordmark } from './brand.js';

const STORE = 'halcyon.session';

let session = null;
export const currentSession = () => session;

/* ── entry point ─────────────────────────────────────────────────────── */

export async function open(ctx) {
  if (session) { session.frame.focus(); return session.frame; }
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

  const select = h('select.field.hal-so-field', {},
    names.map(n => h('option', { value: n, selected: n === prev.last }, n)),
    h('option', { value: '__new' }, '<New Screen Name>'));

  const pass = h('input.field.hal-so-field', {
    type: 'password', value: 'hunter2', maxLength: 24, spellcheck: false,
  });

  const relay = h('input', { type: 'checkbox' });
  const relayUrl = h('input.field', {
    type: 'text', value: 'ws://localhost:8790', spellcheck: false, disabled: true,
  });
  relay.addEventListener('change', () => { relayUrl.disabled = !relay.checked; });

  const win = openWindow({
    id: 'halcyon-signon', title: 'Welcome', icon: 'halcyon',
    width: 470, height: 404, resizable: false, aol: true,
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
      save({ names: [...new Set([name, ...names])].slice(0, 6) });
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
    h('div.hal-signon-marble', { style: { backgroundImage: 'url(' + ART.marble + ')' } }),
    h('div.hal-signon-main', {},
      wordmark(1),
      h('div.hal-signon-ver', {}, 'Halcyon Online v3.0'),

      h('div.hal-so-label', {}, 'Select Screen Name'),
      select,
      h('div.hal-so-label', {}, 'Enter Password'),
      pass,

      h('div.hal-so-loc', {}, h('span', {}, 'Location:'), h('b', {}, 'Home')),

      h('details.hal-relay', {},
        h('summary', {}, 'Connect through a relay'),
        h('label.hal-check', {}, relay, ' Use a relay on my network'),
        relayUrl,
        h('div.hal-relay-note', {},
          'Off by default. The service then runs entirely inside this ',
          'browser, and other tabs on this computer appear as other people.')),

      h('div.hal-signon-btns', {},
        h('button.aol-btn', { type: 'button', onclick: setupBox }, 'SETUP'),
        h('button.aol-btn', { type: 'button', onclick: helpBox }, 'HELP'),
        h('button.aol-btn.hal-go', { type: 'button', onclick: doSignOn }, 'SIGN ON')),

      h('div.hal-signon-foot', {}, 'Press Alt + F4 to Exit'))));

  pass.addEventListener('keydown', ev => { if (ev.key === 'Enter') doSignOn(); });
  return win;
}

const setupBox = () => dialog({
  title: 'Halcyon Setup', icon: 'phone',
  message:
    'Modem:         Rockwell 33.6 Fax/Modem on COM2\n' +
    'Access number: 555-0199 (local)\n' +
    'Backup number: 555-0198\n\n' +
    'Dial: Tone       Speaker: On until connected\n\n' +
    'These settings are decorative. There is no telephone.',
});

const helpBox = () => dialog({
  title: 'Halcyon Help', icon: 'help',
  message:
    'Sign on with any screen name you like.\n\n' +
    'Nothing you type leaves this browser unless you tick the relay box and\n' +
    'run tools/relay.mjs yourself, and even then it only reaches machines on\n' +
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
    name, net, ctx, mode,
    since: Date.now(),
    bucket: createBucket(),
    rooms: new Map(),
    frame: null,
    signOff: () => signOff(ctx),
    strikes: null,
    child: opts => openWindow({ aol: true, ...opts, parent: session.frame.client }),
    go: (what, arg) => route(what, arg),
    arrange,
  };
  session.strikes = createStrikes(tosWarning, tosBoot);

  await net.connect();
  net.on('im', ev => imFrom(session, ev));
  net.on('status', ev => {
    if (ev.state === 'relay-lost' && session)
      dialog({ title: 'Halcyon Online', icon: 'warn',
        message: 'The relay stopped responding. You are still signed on locally.' });
  });

  session.frame = openFrame(session);
  updateStatus();
  setInterval(updateStatus, 30000);

  welcome();
}

function updateStatus() {
  if (!session || !session.frame) return;
  const mins = Math.max(1, Math.round((Date.now() - session.since) / 60000));
  session.frame.setStatus([
    session.name + '  •  ' + (session.mode === 'relay' ? 'Relay' : 'Local') + ' session',
    'Online ' + mins + ' min   33,600 bps',
  ]);
}

/* What the service is pushing tonight. On the real thing this was the
   only part of the screen that ever changed. */
const FEATURED = [
  { title: 'Trivia Tavern', blurb: 'A quiz at the top of every hour',
    art: 'games', go: 'trivia' },
  { title: 'Tonight in the Lobby', blurb: 'Forty people and nobody leaving',
    art: 'today', go: 'lobby' },
  { title: 'Comet Watch', blurb: 'Northwest, after sunset, all month',
    art: 'news', go: 'news' },
];

/* ── the Welcome child window ────────────────────────────────────────── */

function welcome() {
  const mail = unreadCount();

  const win = session.child({
    id: 'halcyon-welcome', title: 'Welcome, ' + session.name + '!',
    icon: 'halcyon', width: 560, height: 400, x: 18, y: 14,
  });

  const promo = (label, sub, iconName, what) =>
    h('button.hal-promo', { type: 'button', onclick: () => session.go(what) },
      icon(iconName, 32),
      h('div.hal-promo-text', {}, h('b', {}, label), h('span', {}, sub)));

  clear(win.body).append(h('div.hal-welcome', {},
    h('div.hal-welcome-top', { style: { backgroundImage: 'url(' + ART.hero + ')' } },
      wordmark(0.5, { row: true }),
      h('div.hal-welcome-hi', {},
        h('b', {}, 'Welcome, ' + session.name + '!'),
        h('span', {}, 'You are member number ' + (1200000 + (Date.now() % 90000) | 0).toLocaleString()))),

    h('div.hal-welcome-mid', {},
      h('button.hal-mailbox', {
        type: 'button', onclick: () => session.go('mail'),
      }, mailboxArt(mail), h('b', {}, mail ? 'You Have Mail' : 'No New Mail')),

      h('div.hal-promos', {},
        promo('People Connection', 'Chat rooms', 'chat', 'rooms'),
        promo('Channels', 'The whole service', 'globe', 'channels'),
        promo('Buddy List', 'Who is online', 'people', 'buddies'),
        promo('Find Central', 'Search the service', 'find', 'search'))),

    h('div.hal-promo-strip', {},
      h('div.hal-strip-head', {}, 'Today on Halcyon'),
      h('div.hal-strip-row', {}, FEATURED.map(f =>
        h('button.hal-feature', {
          type: 'button', title: f.blurb,
          style: { backgroundImage: 'url(' + ART[f.art] + ')' },
          onclick: () => session.go(f.go),
        }, h('b', {}, f.title), h('span', {}, f.blurb))))),

    h('div.hal-welcome-foot', {},
      h('span', {}, mail
        ? mail + ' new message' + (mail === 1 ? '' : 's') + ' waiting'
        : 'Your mailbox is empty'),
      h('span', {}, 'Keyword: press Ctrl+K'))));

  A.mailFanfare();
  setTimeout(() => A.announce(mail ? 'mail' : 'welcome'), 300);
  return win;
}

/** The mailbox, drawn: yellow box, red flag up when there is mail. */
function mailboxArt(hasMail) {
  const g = icon(hasMail ? 'mailboxFull' : 'mailboxEmpty', 56);
  g.classList.remove('glyph');
  return g;
}

/* ── the router behind the menus and the toolbar ─────────────────────── */

function route(what, arg) {
  const s = session;
  if (!s) return;
  switch (what) {
    case 'welcome':   return getWindow('halcyon-welcome') ? getWindow('halcyon-welcome').focus() : welcome();
    case 'keyword':   return arg ? gotoKeyword(s, arg) : keywordDialog(s);
    case 'lobby':     return openChatRoom(s, 'lobby');
    case 'trivia':    return openChatRoom(s, 'trivia');
    case 'tech':      return openChatRoom(s, 'tech');
    case 'music':     return openChatRoom(s, 'music');
    case 'coffee':    return openChatRoom(s, 'coffee');
    case 'penpals':   return openChatRoom(s, 'penpals');
    case 'sports':    return openChannel(s, 'sports');
    case 'weather':   return openChannel(s, 'weather');
    case 'stars':     return openChannel(s, 'stars');
    case 'games':     return s.ctx.launch('minehunt');
    case 'back': case 'forward': A.beep(); return;
    case 'rooms':     return openRoomList(s);
    case 'channels':  return openChannels(s);
    case 'mail':      return openMailbox(s);
    case 'compose':   return composeMail(s);
    case 'buddies':   return openBuddyList(s);
    case 'news':      return openChannel(s, 'news');
    case 'money':     return openChannel(s, 'money');
    case 'notepad':   return s.ctx.launch('notepad');
    case 'signoff':   return signOff(s.ctx);
    case 'addfav':    return dialog({
      title: 'Favorite Places', icon: 'star', aol: true,
      message: 'The front window has been added to your Favorite Places.\n\n' +
        'Press Ctrl+B to see the list.' });

    case 'myfiles': return dialog({
      title: 'Download Manager', icon: 'folder', aol: true, message:
        'Files waiting to download:  0\n' +
        'Files downloaded:           1\n\n' +
        '  SUNSET.JPG   47,318 bytes   complete\n\n' +
        'Downloads finish while you are online. If you sign off in the\n' +
        'middle of one, it starts again from the beginning. Everybody\n' +
        'learned this the same way.' });

    case 'preferences': return dialog({
      title: 'Preferences', icon: 'halcyon', aol: true, message:
        'Chat        Double-space incoming messages    off\n' +
        '            Alphabetise the member list        on\n' +
        '            Notify me when members arrive      on\n\n' +
        'Graphics    Download art automatically         on\n' +
        'Passwords   Store password for this name       off\n\n' +
        'These are decorative, except the last one, which is off for the\n' +
        'reason it should always be off.' });

    case 'profile': return dialog({
      title: 'My Member Profile', icon: 'people', aol: true, message:
        'Screen name:   ' + s.name + '\n' +
        'Member since:  Friday\n' +
        'Location:      Home\n\n' +
        'A profile is public to everybody on the service. Leave the boxes\n' +
        'you are not sure about empty — that was good advice then and it\n' +
        'has not changed.' });

    case 'screennames': return dialog({
      title: 'Screen Names', icon: 'people', aol: true, message:
        'This account may hold up to five screen names.\n\n' +
        '  ' + s.name + '   (signed on)\n\n' +
        'Sign off and back on to use a different one.' });

    case 'passwords': return dialog({
      title: 'Passwords', icon: 'warn', aol: true, message:
        'Storing your password means anybody at this computer can sign on\n' +
        'as you. It is off, and this reconstruction will not turn it on.\n\n' +
        'Halcyon staff will never ask you for your password. Nobody\n' +
        'legitimate ever will, on any service, then or now.' });

    case 'parental': return dialog({
      title: 'Parental Controls', icon: 'people', aol: true, message:
        'Parental Controls set what a screen name is allowed to reach:\n' +
        'chat rooms, instant messages, the web, and file downloads.\n\n' +
        'There is nothing to control here — every room on this machine is\n' +
        'a program, and nothing you type leaves the browser. The control\n' +
        'that actually does the work is in src/core/safety.js.' });

    case 'im': return dialog({
      title: 'Send Instant Message', icon: 'chat',
      message: 'Send an instant message to which member?',
      buttons: ['OK', 'Cancel'], input: { value: '', maxLength: LIMITS.nameMax },
    }).then(r => { if (r && r.button === 'OK' && r.value) openIM(s, r.value.trim()); });

    case 'locate': return dialog({
      title: 'Locate a Member Online', icon: 'people',
      message: 'Members are only visible in the rooms they are sitting in.\n\n' +
        'Open the People Connection and look at the list on the right of\n' +
        'any room.',
    });

    case 'directory': return dialog({
      title: 'Member Directory', icon: 'directory',
      message: 'The Member Directory is compiled overnight.\n\n' +
        'Yours has not been indexed yet. It never will be — there is no\n' +
        'directory, and there is no overnight.',
    });

    case 'favorites': return dialog({
      title: 'Favorite Places', icon: 'star',
      message:
        'KEYWORDS\n\n' +
        '  CHAT      TRIVIA    MAIL      WEB\n' +
        '  NEWS      WEATHER   MONEY     GAMES\n' +
        '  HOROSCOPE BUDDY     HELP      TOS\n\n' +
        'Press Ctrl+K, type one, and press Enter.',
    });

    case 'clock': {
      const mins = Math.round((Date.now() - s.since) / 60000);
      const now = new Date();
      return dialog({
        title: 'Online Clock', icon: 'clock',
        message:
          'Current time:      ' + now.toLocaleTimeString() + '\n' +
          'Time online:       ' + mins + ' minutes\n' +
          'Connected at:      33,600 bps\n\n' +
          'On the real thing this window was how you worked out how much\n' +
          'trouble you were in.',
      });
    }

    case 'print': return dialog({
      title: 'Print', icon: 'print', message:
        'The printer is not responding.\n\n' +
        'Check that it is switched on, that it is on line, and that the\n' +
        'paper is not jammed. It is jammed.',
    });

    case 'search': case 'find': return findCentral(s);

    case 'help': return dialog({
      title: 'Halcyon Help', icon: 'help', message:
        'GETTING AROUND\n' +
        '  Ctrl+K  Keyword          Ctrl+L  Lobby\n' +
        '  Ctrl+D  Main Menu        Ctrl+B  Favorite Places\n' +
        '  Ctrl+M  Compose Mail     Ctrl+R  Read Mail\n' +
        '  Ctrl+I  Instant Message  Ctrl+4  Top News\n\n' +
        'IN A ROOM\n' +
        '  Double-click any name for member options, including Ignore.\n' +
        '  Type SCORE in the Trivia Tavern to see the board.\n\n' +
        'INSTANT MESSAGES\n' +
        '  Every message window has a Notify Halcyon button. Use it.',
    });

    case 'tos': return dialog({
      title: 'Terms of Service', icon: 'doc', message:
        'THE SHORT VERSION\n\n' +
        '1. Halcyon staff will never ask for your password. Nobody\n' +
        '   legitimate ever will, on any service, then or now.\n\n' +
        '2. Do not type your address, telephone number or full name into a\n' +
        '   room. Halcyon strips those out, but do not rely on it.\n\n' +
        '3. Be somebody other people want in the room. Guides remove people\n' +
        '   who are not, for a little while, and then let them back.\n\n' +
        '4. Nothing you type leaves this computer unless you deliberately\n' +
        '   started the relay yourself.',
    });

    default: return dialog({
      title: 'Halcyon Online', icon: 'info',
      message: 'That part of the service is not available in this reconstruction.',
    });
  }
}

/** Window menu: cascade, tile, close all — over the MDI children only. */
function arrange(mode) {
  if (!session || !session.frame) return;
  const kids = windows().filter(w => w.el.parentElement === session.frame.client);
  if (!kids.length) return;
  const area = session.frame.client.getBoundingClientRect();

  if (mode === 'close') { kids.forEach(w => w.close()); return; }

  if (mode === 'cascade') {
    kids.forEach((w, i) => {
      w.el.classList.remove('maxed');
      Object.assign(w.el.style, {
        left: (10 + i * 22) + 'px', top: (10 + i * 22) + 'px',
        width: Math.min(560, area.width - 40) + 'px',
        height: Math.min(400, area.height - 40) + 'px',
      });
      w.focus();
    });
    return;
  }

  const cols = Math.ceil(Math.sqrt(kids.length));
  const rows = Math.ceil(kids.length / cols);
  kids.forEach((w, i) => {
    w.el.classList.remove('maxed');
    Object.assign(w.el.style, {
      left: ((i % cols) * (area.width / cols)) + 'px',
      top: (Math.floor(i / cols) * (area.height / rows)) + 'px',
      width: (area.width / cols) + 'px',
      height: (area.height / rows) + 'px',
    });
  });
}

/* ── the TOS ladder ──────────────────────────────────────────────────── */

async function tosWarning(reason, n) {
  await dialog({
    title: 'Terms of Service', icon: 'warn',
    message:
      'A Halcyon Guide has issued you a warning.\n\n' + reason + '\n\n' +
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

  // Everything inside the frame goes with it.
  for (const w of windows()) {
    if (w.el.parentElement === s.frame.client) { w.onClose = null; w.close(); }
  }
  s.frame.onClose = null;
  s.frame.close();

  A.goodbyeChime();
  setTimeout(() => A.announce('goodbye'), 200);
  await sleep(120);
  await dialog({
    title: 'Halcyon Online', icon: 'halcyon',
    message: 'Goodbye.\n\nThe phone line is free again.',
    sound: false,
  });
}

export { ROOMS };
