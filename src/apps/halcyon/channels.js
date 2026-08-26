/* Channels — the front door to the rest of the service, and the keyword
   box that skipped it. The departments are small but they all do
   something: the weather answers for whatever town you type, the quotes
   move, the horoscope is as specific as horoscopes are. */

import { h, clear, pick, randInt, hash } from '../../core/dom.js';
import { dialog, getWindow } from '../../core/wm.js';
import { icon } from '../../core/icons.js';
import * as A from '../../core/audio.js';
import { ROOMS, openChatRoom } from './chat.js';
import { wordmark } from './brand.js';
import { openMailbox } from './mail.js';
import { openBuddyList } from './im.js';

/*
 * Channel banners. Each was a small piece of artwork with its own
 * typography — that variety is the whole look, so every entry here
 * carries its own colours and type treatment rather than sharing one
 * button style.
 */
const CHANNELS = [
  { id: 'today',   name: 'Halcyon Today', go: 'welcome',
    style: { background: 'linear-gradient(105deg,#b57fd0,#e8b6d8)', color: '#4a1550' },
    type: { fontWeight: 700, fontStyle: 'italic' } },
  { id: 'news',    name: 'NEWS', go: 'news',
    style: { background: 'linear-gradient(105deg,#dfe6f2,#b9c7e2)', color: '#0b1d5c' },
    type: { fontWeight: 700, letterSpacing: '.06em' } },
  { id: 'sports',  name: 'SPORTS', go: 'sports',
    style: { background: 'linear-gradient(105deg,#1a1a1a,#5b5b5b)', color: '#fff' },
    type: { fontWeight: 700, fontStyle: 'italic', letterSpacing: '.04em' } },
  { id: 'computing', name: 'Computing', go: 'tech',
    style: { background: 'linear-gradient(105deg,#f0e2c8,#cfae7a)', color: '#4a3110' },
    type: { fontWeight: 700 } },
  { id: 'research', name: 'Research & Learn', go: 'search',
    style: { background: 'linear-gradient(105deg,#e8ecf6,#aab4d4)', color: '#2a2f52' },
    type: { fontWeight: 400 } },
  { id: 'ent',     name: 'entertainment', go: 'music',
    style: { background: 'linear-gradient(105deg,#6a3f9e,#c9a7e8)', color: '#fff' },
    type: { fontWeight: 700, fontStyle: 'italic' } },
  { id: 'games',   name: 'GAMES', go: 'games',
    style: { background: 'linear-gradient(105deg,#f6d79a,#ef9a72)', color: '#7a2600' },
    type: { fontWeight: 700, letterSpacing: '.12em' } },
  { id: 'interests', name: 'Interests', go: 'penpals',
    style: { background: 'linear-gradient(105deg,#dff0fb,#a8d4ef)', color: '#0d4a72' },
    type: { fontWeight: 700, fontStyle: 'italic' } },
  { id: 'lifestyles', name: 'Lifestyles', go: 'coffee',
    style: { background: 'linear-gradient(105deg,#fafaf6,#d8d8cc)', color: '#1a1a1a' },
    type: { fontWeight: 700 } },
  { id: 'shopping', name: 'Shopping', go: 'shopping',
    style: { background: 'linear-gradient(105deg,#c9342a,#f0a892)', color: '#fff' },
    type: { fontWeight: 700, fontStyle: 'italic' } },
  { id: 'health',  name: 'Health', go: 'health',
    style: { background: 'linear-gradient(105deg,#d7e8a8,#9cc46a)', color: '#25400d' },
    type: { fontWeight: 700 } },
  { id: 'families', name: 'families', go: 'penpals',
    style: { background: 'linear-gradient(105deg,#e8dfc4,#b7c2a4)', color: '#3a3f22' },
    type: { fontWeight: 400, fontStyle: 'italic' } },
  { id: 'kids',    name: 'KIDS ONLY', go: 'kids',
    style: { background: 'linear-gradient(105deg,#1f3d8a,#3f6bd0)', color: '#ffd23a' },
    type: { fontWeight: 700, letterSpacing: '.05em' } },
  { id: 'local',   name: 'Local', go: 'weather',
    style: { background: 'linear-gradient(105deg,#8a8a80,#c8c8bc)', color: '#22221c' },
    type: { fontWeight: 700 } },
  { id: 'travel',  name: 'TRAVEL', go: 'weather',
    style: { background: 'linear-gradient(105deg,#f3d94a,#f6ecae)', color: '#7a4a00' },
    type: { fontWeight: 700, letterSpacing: '.1em' } },
  { id: 'money',   name: 'Influence', go: 'money',
    style: { background: 'linear-gradient(105deg,#aac6e8,#dbe8f6)', color: '#123a78' },
    type: { fontWeight: 700, fontStyle: 'italic' } },
];

export function openChannels(session) {
  const existing = getWindow('halcyon-channels');
  if (existing) { existing.focus(); return existing; }

  const win = session.child({
    id: 'halcyon-channels', title: 'Channels', icon: 'globe',
    width: 660, height: 450, minWidth: 460, minHeight: 320,
    aol: true,
  });

  const grid = h('div.chan-grid');
  for (const c of CHANNELS) {
    grid.append(h('button.chan-banner', {
      type: 'button', style: c.style, title: c.name,
      onclick: () => { A.click(); session.go(c.go); },
    }, h('span', { style: c.type }, c.name)));
  }

  clear(win.body).append(h('div.chan', {},
    h('div.chan-rail', {},
      wordmark(0.52),
      h('div.chan-rail-title', {}, 'Channels'),
      h('button.chan-return', {
        type: 'button', onclick: () => session.go('welcome'),
      }, h('i', {}, '◀'), 'Return to Welcome'),
      h('button.chan-find', {
        type: 'button', onclick: () => session.go('search'),
      }, h('i', {}, '\u26B2'), 'Find')),
    grid));

  return win;
}

/* ── the Keyword dialog ──────────────────────────────────────────────── */

/**
 * The keyword box as its own window: badge, a heading, one field, and two
 * blue buttons. Straight off the screenshot.
 */
export function keywordDialog(session, prefill = '') {
  const field = h('input.kw-field', { type: 'text', spellcheck: false, value: prefill });

  const win = session.child({
    id: 'halcyon-keyword', title: 'Keyword', icon: 'keyword',
    width: 452, height: 226, resizable: false, aol: true,
  });

  const go = () => {
    const v = field.value.trim();
    if (!v) return;
    win.close();
    gotoKeyword(session, v);
  };
  field.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });

  clear(win.body).append(h('div.kw', {},
    h('div.kw-head', {}, wordmark(0.34), h('h2', {}, 'Halcyon Keyword')),
    h('div.kw-row', {}, h('label', {}, 'Enter Words:'), field),
    h('div.kw-btns', {},
      h('button.aol-btn', { type: 'button', onclick: go }, 'Go'),
      h('button.aol-btn', {
        type: 'button', onclick: () => { win.close(); session.go('favorites'); },
      }, 'Keyword List'))));

  setTimeout(() => { field.focus(); field.select(); }, 40);
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

const DEPTS = { news: "Today's News", weather: 'Weather', money: 'Quotes',
                stars: 'Your Stars Today', sports: 'Sports' };
const DEPT_ICONS = { news: 'doc', weather: 'globe', money: 'defrag',
                     stars: 'help', sports: 'game' };

export function openChannel(session, id) {
  const c = { name: DEPTS[id] || 'Halcyon', icon: DEPT_ICONS[id] || 'doc' };
  const win = session.child({
    id: 'halcyon-chan-' + id, title: c.name, icon: c.icon,
    width: 450, height: 350, minWidth: 340, aol: true,
  });
  const body = h('div.dept.scroll');
  clear(win.body).append(body);

  if (id === 'news') news(body);
  if (id === 'weather') weather(body);
  if (id === 'money') money(body, win);
  if (id === 'stars') stars(body);
  if (id === 'sports') sports(body);
  return win;
}

export function openRoomList(session) {
  const win = session.child({
    id: 'halcyon-rooms', title: 'People Connection', icon: 'chat',
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

const TEAMS = ['Cleveland', 'Detroit', 'Chicago', 'Boston', 'Seattle',
  'Denver', 'Phoenix', 'Atlanta', 'Toronto', 'Houston'];

function sports(root) {
  root.append(h('div.dept-head', {}, 'Scores'),
    h('div.dept-sub', {}, 'Final and in progress'));
  const table = h('div.tick');
  const pool = [...TEAMS].sort(() => Math.random() - 0.5);
  for (let i = 0; i < 8; i += 2) {
    const a = pool[i], b = pool[i + 1];
    const sa = randInt(58, 118), sb = randInt(58, 118);
    table.append(h('div.tick-row', {},
      h('b', {}, 'FINAL'),
      h('span.tick-name', {}, a + ' at ' + b),
      h('span.tick-px', {}, sa + ' - ' + sb),
      h('span.tick-ch', { class: sb > sa ? 'up' : 'down' }, (sb > sa ? b : a) + ' win')));
  }
  root.append(table,
    h('div.dept-foot', {}, 'Scores are invented and reshuffle every time you ' +
      'open this window, which is roughly how reliable they felt.'));
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
