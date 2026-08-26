/*
 * Sector Run — the other door.
 *
 * The boards all carried one game of this shape too: a map of places, a
 * handful of commodities whose prices wander, and a number of jumps a day
 * that is always one fewer than you want. No combat, no other players —
 * just the arithmetic, which for a lot of callers was the point.
 */

import { randInt, pick, chance } from '../../../core/dom.js';
import { padTo } from '../screen.js';
import { bigText, picture, rule, shadowBox } from '../ansi.js';
import { PIC } from '../art.js';

const JUMPS = 25;

const GOODS = [
  { name: 'Ore',       base: 40,   swing: 0.55 },
  { name: 'Grain',     base: 22,   swing: 0.40 },
  { name: 'Medicine',  base: 180,  swing: 0.70 },
  { name: 'Machinery', base: 320,  swing: 0.45 },
];

/* Each port is biased: it makes one thing cheaply and wants another badly.
   The route is the game. */
const PORTS = [
  { name: 'Kettle', makes: 0, wants: 2, blurb: 'A rock with a smelter bolted to it.' },
  { name: 'Ambergris',      makes: 1, wants: 3, blurb: 'Farm domes as far as the curve.' },
  { name: 'Wick',           makes: 2, wants: 0, blurb: 'A hospital that grew a town around it.' },
  { name: 'The Yards',      makes: 3, wants: 1, blurb: 'Half-built hulls and a very good bar.' },
  { name: 'Longwater',      makes: -1, wants: -1, blurb: 'Nothing here but the bank and the view.' },
];

const EVENTS = [
  { odds: 0.08, run: (s, t) => {
    const take = Math.min(s.hold, randInt(1, 6));
    if (!take) return;
    for (const g in s.cargo) { const n = Math.min(s.cargo[g], take); s.cargo[g] -= n; break; }
    t.write('|12Boarders. They take what they can carry and are gone in ninety seconds.\n');
  } },
  { odds: 0.10, run: (s, t) => {
    const fee = randInt(40, 180);
    s.credits = Math.max(0, s.credits - fee);
    t.write('|12Docking fees have gone up again. |14-' + fee + '|12 credits.\n');
  } },
  { odds: 0.10, run: (s, t) => {
    const bonus = randInt(120, 600);
    s.credits += bonus;
    t.write('|10A short contract: run a sealed box two docks over. |14+' + bonus + '|10 credits.\n');
  } },
];

const store = handle => 'bbs.trader.' + handle.toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

const fresh = () => ({
  credits: 1200, bank: 0, hold: 0, holdMax: 40, jumps: JUMPS,
  at: 0, cargo: [0, 0, 0, 0], day: today(), best: 1200,
});

function load(handle) {
  let s;
  try { s = JSON.parse(localStorage.getItem(store(handle))); } catch { s = null; }
  s = { ...fresh(), ...(s && typeof s === 'object' ? s : {}) };
  if (s.day !== today()) { s.day = today(); s.jumps = JUMPS; }
  s.hold = s.cargo.reduce((a, b) => a + b, 0);
  return s;
}
const save = (handle, s) => {
  try { localStorage.setItem(store(handle), JSON.stringify(s)); } catch {}
};

/* Prices are a function of the port and the day, so the market is the same
   for every caller on a given day and you can talk about it afterwards. */
function priceAt(portIx, goodIx, tick) {
  const p = PORTS[portIx], g = GOODS[goodIx];
  let mult = 1;
  if (p.makes === goodIx) mult -= g.swing * 0.55;
  if (p.wants === goodIx) mult += g.swing * 0.75;
  const wobble = Math.sin((portIx * 7 + goodIx * 13 + tick) * 1.7) * g.swing * 0.35;
  return Math.max(4, Math.round(g.base * (mult + wobble)));
}

export async function playTrader(t, handle) {
  const s = load(handle);
  let tick = 0;
  let running = true;

  t.clear();
  t.write(picture(PIC.ship) + '\n');
  t.write(bigText('SECTOR', { fg: 11, shade: 3, indent: 13 }));
  t.write(bigText('RUN', { fg: 15, shade: 7, indent: 31 }));
  t.write(rule(78, { fg: 3, fade: true }));
  t.write('|08' + ' '.repeat(14) +
    'four ports, four cargoes, and never enough fuel\n\n' +
    '|07Ship registered to |15' + handle + '|07.  Jumps left today: |15' + s.jumps + '|07\n\n');
  await t.pause();

  while (running) await dock();

  save(handle, s);
  t.write('\n|08You leave the ship at the pad and the modem takes you with it.\n\n');

  function manifest() {
    const p = PORTS[s.at];
    t.clear();
    t.write(picture(PIC.port));
    t.write(rule(78, { fg: 8, ch: '▀' }));
    // Block capitals are six columns each, so a long name would run off
    // the right of an eighty-column screen.
    t.write(p.name.length <= 11
      ? bigText(p.name, { fg: 11, shade: 3, indent: 3 })
      : '|11  ' + p.name.toUpperCase().split('').join(' ') + '\n\n');
    t.write('|08  ' + p.blurb + '\n' +
            '|08  credits |14' + s.credits + '|08   banked |14' + s.bank +
            '|08   hold |15' + s.hold + '|08/|15' + s.holdMax +
            '|08   jumps |15' + s.jumps + '|08\n\n');

    const rows = ['|08 ' + padTo('cargo', 16) + padTo('price', 9) + padTo('you hold', 11) + 'here'];
    GOODS.forEach((g, i) => {
      const pr = priceAt(s.at, i, tick);
      const hot = PORTS[s.at].wants === i, cheap = PORTS[s.at].makes === i;
      rows.push('|11(' + (i + 1) + ')|15 ' + padTo(g.name, 13) +
        (cheap ? '|10' : hot ? '|12' : '|15') + padTo(String(pr), 9) +
        '|07' + padTo(String(s.cargo[i]), 11) +
        (cheap ? '|10cheap' : hot ? '|12wanted' : '|08—'));
    });
    t.write(shadowBox(rows, { width: 54, edge: 3, fill: 1, indent: 12 }));
  }

  async function dock() {
    manifest();
    t.write('\n|11 (B)|07uy  |11(S)|07ell  |11(J)|07ump  |11(K)|07 Bank  |11(Q)|07 Quit: |07');
    const k = await t.key('BSJKQ');
    if (k === 'B') return trade('buy');
    if (k === 'S') return trade('sell');
    if (k === 'J') return jump();
    if (k === 'K') return bank();
    running = false;
  }

  async function trade(side) {
    t.write('\n|07Which cargo? |11(1-4)|07 or |11(X)|07: |07');
    const k = await t.key('1234X');
    if (k === 'X') return;
    const i = Number(k) - 1;
    const price = priceAt(s.at, i, tick);
    const most = side === 'buy'
      ? Math.min(s.holdMax - s.hold, Math.floor(s.credits / price))
      : s.cargo[i];
    if (!most) {
      t.write(side === 'buy' ? '|12No room, or no money.\n' : '|12You have none of that.\n');
      return t.pause();
    }
    t.write('|08You can ' + side + ' up to |15' + most + '|08 at |14' + price +
            '|08 each.\n|07How many? |07');
    const n = Math.max(0, Math.min(most, Math.floor(Number(await t.ask({ max: 5 })) || 0)));
    if (!n) return;
    if (side === 'buy') { s.credits -= n * price; s.cargo[i] += n; }
    else { s.credits += n * price; s.cargo[i] -= n; }
    s.hold = s.cargo.reduce((a, b) => a + b, 0);
    s.best = Math.max(s.best, s.credits + s.bank);
    t.write('|10' + (side === 'buy' ? 'Loaded' : 'Sold') + ' |15' + n + '|10 ' +
            GOODS[i].name + ' for |14' + (n * price) + '|10 credits.\n');
    save(handle, s);
    await t.pause();
  }

  async function jump() {
    if (s.jumps <= 0) {
      t.write('|12The tanks are dry and the port will not sell you any more today.\n');
      return t.pause();
    }
    t.write('\n|07Jump where?\n');
    PORTS.forEach((p, i) => {
      t.write((i === s.at ? '|08' : '|07') + '  (' + (i + 1) + ') ' + p.name.padEnd(16) +
        (i === s.at ? 'you are here' : '') + '|07\n');
    });
    t.write('|11 (X)|07 Stay: |07');
    const k = await t.key('12345X');
    if (k === 'X') return;
    const to = Number(k) - 1;
    if (to === s.at) return;
    s.at = to; s.jumps--; tick++;
    t.write('|03...\n|10Docked at |11' + PORTS[to].name + '|10.\n');
    for (const e of EVENTS) if (chance(e.odds)) { e.run(s, t); break; }
    s.hold = s.cargo.reduce((a, b) => a + b, 0);
    save(handle, s);
    if (!s.jumps) t.write('|08That was the last of the fuel. Trade where you stand.\n');
  }

  async function bank() {
    if (PORTS[s.at].makes !== -1) {
      t.write('|12There is no bank here. Longwater has the only one.\n');
      return t.pause();
    }
    t.write('\n|03Longwater Mutual. The clerk is a recording.\n' +
            '|11 (D)|07eposit  |11(W)|07ithdraw  |11(X)|07: |07');
    const k = await t.key('DWX');
    if (k === 'X') return;
    t.write('\n|07How much? |07');
    const n = Math.max(0, Math.floor(Number(await t.ask({ max: 9 })) || 0));
    if (k === 'D') { const a = Math.min(n, s.credits); s.credits -= a; s.bank += a; }
    else { const a = Math.min(n, s.bank); s.bank -= a; s.credits += a; }
    t.write('|10Done. |08On you |14' + s.credits + '|08, banked |14' + s.bank + '|08.\n' +
            '|08Best you have ever been worth: |14' + s.best + '|08.\n');
    save(handle, s);
    await t.pause();
  }
}

export const TRADER_TIP = () => pick([
  'Ore is cheap at Kettle and dear at Wick.',
  'Nobody makes money standing still at Longwater.',
  'Machinery pays at Ambergris if you can get there with a full hold.',
]);
