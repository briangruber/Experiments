/* Channels — the front door to the rest of the service, and the keyword
   box that skipped it. The departments are small but they all do
   something: the weather answers for whatever town you type, the quotes
   move, the horoscope is as specific as horoscopes are. */

import { h, clear, pick, randInt, hash } from '../../core/dom.js';
import { openWindow, dialog, getWindow } from '../../core/wm.js';
import { icon } from '../../core/icons.js';
import * as A from '../../core/audio.js';
import { ROOMS, openChatRoom } from './chat.js';
import { openMailbox } from './mail.js';
import { openBuddyList } from './im.js';

const CHANNELS = [
  { id: 'chat',    name: 'Chat & People',   icon: 'chat',     blurb: 'Rooms, buddies, instant messages' },
  { id: 'news',    name: "Today's News",    icon: 'doc',      blurb: 'Updated four times a day' },
  { id: 'weather', name: 'Weather',         icon: 'globe',    blurb: 'Your five day forecast' },
  { id: 'money',   name: 'Personal Finance',icon: 'defrag',   blurb: 'Quotes, delayed 20 minutes' },
  { id: 'games',   name: 'Games',           icon: 'game',     blurb: 'Play right now' },
  { id: 'stars',   name: 'Horoscopes',      icon: 'help',     blurb: 'Daily, and uncanny' },
  { id: 'web',     name: 'Internet',        icon: 'browser',  blurb: 'The World Wide Web' },
  { id: 'mail',    name: 'Mail Center',     icon: 'mail',     blurb: 'Read and write' },
];

export function openChannels(session) {
  const existing = getWindow('halcyon-channels');
  if (existing) { existing.focus(); return existing; }

  const win = openWindow({
    id: 'halcyon-channels', title: 'Halcyon Channels', icon: 'globe',
    width: 560, height: 400, minWidth: 420, minHeight: 300,
  });

  const kw = h('input.field', { type: 'text', placeholder: 'Keyword', spellcheck: false });
  kw.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    const v = kw.value.trim(); kw.value = '';
    if (v) gotoKeyword(session, v);
  });

  clear(win.body).append(h('div.chan', {},
    h('div.chan-head', {},
      h('div.hal-wordmark.small', {}, 'Halcyon', h('span', {}, 'CHANNELS')),
      h('div.chan-kw', {}, h('b', {}, 'Keyword:'), kw,
        h('button.btn.small', {
          type: 'button', onclick: () => { const v = kw.value.trim(); kw.value = ''; if (v) gotoKeyword(session, v); },
        }, 'Go'))),
    h('div.chan-grid', {}, CHANNELS.map(c =>
      h('button.chan-tile', {
        type: 'button', onclick: () => { A.click(); openChannel(session, c.id); },
      }, icon(c.icon, 32), h('b', {}, c.name), h('span', {}, c.blurb)))),
    h('div.chan-foot', {},
      'Try a keyword: ',
      h('code', {}, 'CHAT'), ' ', h('code', {}, 'TRIVIA'), ' ', h('code', {}, 'WEB'),
      ' ', h('code', {}, 'WEATHER'), ' ', h('code', {}, 'HELP'))));

  return win;
}

/* ── keyword routing ─────────────────────────────────────────────────── */

const KEYWORDS = {
  chat: s => openRoomList(s), rooms: s => openRoomList(s), people: s => openBuddyList(s),
  lobby: s => openChatRoom(s, 'lobby'),
  trivia: s => openChatRoom(s, 'trivia'), quiz: s => openChatRoom(s, 'trivia'),
  coffee: s => openChatRoom(s, 'coffee'), tech: s => openChatRoom(s, 'tech'),
  music: s => openChatRoom(s, 'music'), penpals: s => openChatRoom(s, 'penpals'),
  mail: s => openMailbox(s), email: s => openMailbox(s),
  buddy: s => openBuddyList(s), buddies: s => openBuddyList(s),
  news: s => openChannel(s, 'news'),
  weather: s => openChannel(s, 'weather'),
  money: s => openChannel(s, 'money'), stocks: s => openChannel(s, 'money'),
  games: s => openChannel(s, 'games'), game: s => openChannel(s, 'games'),
  horoscope: s => openChannel(s, 'stars'), stars: s => openChannel(s, 'stars'),
  channels: s => openChannels(s),
  web: s => s.ctx.launch('browser', { url: 'halcyon://start' }),
  internet: s => s.ctx.launch('browser', { url: 'halcyon://start' }),
  help: s => helpWindow(s),
  guide: s => helpWindow(s),
  tos: s => tosWindow(s),
  privacy: s => tosWindow(s),
};

export function gotoKeyword(session, keyword) {
  const k = String(keyword).toLowerCase().replace(/[^a-z]/g, '');
  const fn = KEYWORDS[k];
  if (fn) { A.click(); return fn(session); }
  dialog({
    title: 'Keyword', icon: 'error',
    message: 'Halcyon does not have a keyword called "' + keyword + '".\n\n' +
      'Try: CHAT, TRIVIA, MAIL, WEB, NEWS, WEATHER, MONEY, GAMES,\n' +
      'HOROSCOPE, BUDDY, HELP or TOS.',
  });
}

/* ── departments ─────────────────────────────────────────────────────── */

export function openChannel(session, id) {
  if (id === 'chat') return openRoomList(session);
  if (id === 'mail') return openMailbox(session);
  if (id === 'web') return session.ctx.launch('browser', { url: 'halcyon://start' });
  if (id === 'games') return session.ctx.launch('minehunt');

  const c = CHANNELS.find(x => x.id === id) || CHANNELS[1];
  const win = openWindow({
    id: 'halcyon-chan-' + id, title: 'Halcyon - ' + c.name, icon: c.icon,
    width: 460, height: 360, minWidth: 340,
  });
  const body = h('div.dept.scroll');
  clear(win.body).append(body);

  if (id === 'news') news(body);
  if (id === 'weather') weather(body);
  if (id === 'money') money(body, win);
  if (id === 'stars') stars(body);
  return win;
}

export function openRoomList(session) {
  const win = openWindow({
    id: 'halcyon-rooms', title: 'Find a Chat Room', icon: 'chat',
    width: 420, height: 330, minWidth: 320,
  });
  clear(win.body).append(h('div.roomlist', {},
    h('div.roomlist-head', {}, 'People Connection'),
    h('div.roomlist-body.scroll', {}, ROOMS.map(r =>
      h('button.room-row', {
        type: 'button',
        onclick: () => { openChatRoom(session, r.id); },
      }, h('b', {}, r.name), h('span', {}, r.blurb),
        h('em', {}, randInt(4, 11) + ' here')))),
    h('div.roomlist-foot', {},
      'Rooms hold about a dozen people. Double-click a name inside to send ' +
      'an instant message, or to stop seeing them.')));
  return win;
}

/* ── generated content ───────────────────────────────────────────────── */

const HEADS = [
  ['Pathfinder rover completes first month on Mars', 'The little one keeps going. Engineers say the battery is the question now.'],
  ['Chess champion still not over it', 'Six games, one machine, and an argument about what thinking is that will outlive everyone involved.'],
  ['Modem makers agree on 56k standard, mostly', 'Two rival flavours converge. Your existing modem is, as ever, the wrong one.'],
  ['Comet visible without a telescope this month', 'Look northwest after sunset. Nobody alive will see it again.'],
  ['Study: households with a second phone line up sharply', 'Researchers link the rise to "family arguments about the internet".'],
  ['Local library adds four public terminals', 'A one-hour limit is in force. There is already a list.'],
  ['DVD players appear in stores at $599', 'Retailers say the discs are the problem: there are eleven of them.'],
  ['Hotmail passes nine million accounts', 'Free e-mail, paid for by nobody knows what yet.'],
];

function news(root) {
  root.append(h('div.dept-head', {}, "Today's News"),
    h('div.dept-sub', {}, 'Updated 6:00 AM, 12:00 PM, 6:00 PM and midnight'));
  const set = [...HEADS].sort(() => Math.random() - 0.5).slice(0, 5);
  for (const [head, body] of set)
    root.append(h('div.news-item', {}, h('h4', {}, head), h('p', {}, body)));
  root.append(h('div.dept-foot', {}, 'Wire copy is invented. So is the wire.'));
}

const SKY = ['Sunny', 'Partly cloudy', 'Overcast', 'Thunderstorms', 'Light rain', 'Hazy and humid', 'Clear'];
const DAYS = ['Today', 'Tomorrow', 'Wednesday', 'Thursday', 'Friday'];

function weather(root) {
  const input = h('input.field', { type: 'text', placeholder: 'City or ZIP', spellcheck: false });
  const out = h('div.wx-out');
  const go = () => {
    const where = input.value.trim() || 'Your Town';
    const seed = hash(where.toLowerCase());
    const rnd = n => ((seed >> (n * 3)) % 100) / 100;
    clear(out).append(
      h('div.wx-now', {},
        h('div.wx-temp', {}, Math.round(52 + rnd(1) * 40) + String.fromCharCode(176)),
        h('div', {},
          h('b', {}, where),
          h('div', {}, SKY[(seed >> 2) % SKY.length]),
          h('div.wx-sub', {}, 'Humidity ' + Math.round(38 + rnd(3) * 55) + '%  ' +
            'Wind ' + Math.round(2 + rnd(4) * 18) + ' mph'))),
      h('div.wx-days', {}, DAYS.map((d, i) => h('div.wx-day', {},
        h('b', {}, d),
        h('span', {}, SKY[(seed >> (i + 1)) % SKY.length]),
        h('em', {}, Math.round(48 + rnd(i + 2) * 42) + ' / ' + Math.round(34 + rnd(i + 5) * 26))))));
  };
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
  root.append(
    h('div.dept-head', {}, 'Weather'),
    h('div.wx-form', {}, input, h('button.btn.small', { type: 'button', onclick: go }, 'Get Forecast')),
    out,
    h('div.dept-foot', {}, 'Forecasts are generated from the name you type and are, ' +
      'in that sense, as reliable as any other forecast.'));
  input.value = 'Cleveland';
  go();
  input.select();
}

const TICKERS = [
  ['HLCY', 'Halcyon Online', 31.25], ['MSFT', 'Microsoft', 138.75], ['INTC', 'Intel', 91.50],
  ['AAPL', 'Apple Computer', 19.38], ['NSCP', 'Netscape', 41.13], ['IOMG', 'Iomega', 24.75],
  ['CPQ', 'Compaq', 68.00], ['DELL', 'Dell', 84.25],
];

function money(root, win) {
  const table = h('div.tick');
  root.append(h('div.dept-head', {}, 'Quotes'),
    h('div.dept-sub', {}, 'Delayed at least 20 minutes'), table,
    h('div.dept-foot', {}, 'These are made up and move at random. Do not buy anything.'));
  const rows = TICKERS.map(([sym, name, base]) => {
    const price = h('span.tick-px', {}, base.toFixed(2));
    const chg = h('span.tick-ch', {}, '+0.00');
    table.append(h('div.tick-row', {},
      h('b', {}, sym), h('span.tick-name', {}, name), price, chg));
    return { base, cur: base, price, chg };
  });
  const step = () => {
    for (const r of rows) {
      r.cur = Math.max(1, r.cur + (Math.random() - 0.48) * (r.base * 0.012));
      const d = r.cur - r.base;
      r.price.textContent = r.cur.toFixed(2);
      r.chg.textContent = (d >= 0 ? '+' : '') + d.toFixed(2);
      r.chg.className = 'tick-ch ' + (d >= 0 ? 'up' : 'down');
    }
  };
  step();
  const t = setInterval(step, 2600);
  if (win) win.onClose = () => { clearInterval(t); return true; };
}

const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
const FORTUNE = [
  'Someone will pick up the phone while you are in the middle of something.',
  'A disk you thought was blank is not blank.',
  'Resist the urge to reply to all.',
  'The thing you are waiting to download will be worth it. The next one will not.',
  'A stranger in a room will say something you think about for years.',
  'Save your work. Save it again. You know why.',
  'Today is a good day to write to somebody you have not written to.',
  'The counter on your homepage is mostly you.',
];

function stars(root) {
  root.append(h('div.dept-head', {}, 'Your Stars Today'));
  const grid = h('div.stars-grid');
  for (const s of SIGNS)
    grid.append(h('button.stars-sign', {
      type: 'button',
      onclick: () => {
        clear(out).append(h('h4', {}, s), h('p', {}, pick(FORTUNE)),
          h('p.stars-lucky', {}, 'Lucky number: ' + randInt(2, 99) +
            '   Lucky colour: ' + pick(['teal', 'magenta', 'beige', 'silver'])));
      },
    }, s));
  const out = h('div.stars-out', {}, h('p', {}, 'Pick a sign.'));
  root.append(grid, out,
    h('div.dept-foot', {}, 'For entertainment purposes only, which was true then too.'));
}

/* ── help and terms ──────────────────────────────────────────────────── */

function helpWindow() {
  return dialog({
    title: 'Halcyon Help', icon: 'help',
    message:
      'KEYWORDS\n' +
      '  CHAT TRIVIA MAIL WEB NEWS WEATHER MONEY GAMES HOROSCOPE\n' +
      '  BUDDY HELP TOS\n\n' +
      'IN A ROOM\n' +
      '  Double-click any name for member options, including Ignore.\n' +
      '  Type SCORE in the Trivia Tavern to see the board.\n\n' +
      'INSTANT MESSAGES\n' +
      '  Every message window has a Report button. Use it.',
  });
}

function tosWindow() {
  return dialog({
    title: 'Terms of Service', icon: 'doc',
    message:
      'THE SHORT VERSION\n\n' +
      '1. Halcyon staff will never ask for your password. Nobody legitimate\n' +
      '   ever will, on any service, then or now.\n\n' +
      '2. Do not type your address, telephone number or full name into a\n' +
      '   room. Halcyon strips those out, but do not rely on it.\n\n' +
      '3. Be somebody other people want in the room. Guides remove people\n' +
      '   who are not, for a little while, and then let them back.\n\n' +
      '4. Nothing you type here leaves this computer unless you deliberately\n' +
      '   started the relay yourself.',
  });
}
