/*
 * The Midnight Carnival BBS.
 *
 * One computer in somebody's spare room with two telephone lines into it,
 * which is what all of them were. You log in, you read what people left
 * since yesterday, you play a door game until your time is up, and you get
 * off so the next caller can have the line.
 *
 * Nobody can post here and nobody can page anybody: the message bases are
 * an archive of what was already said, and the only thing you type into
 * this board is your own handle. That is deliberate — a board with an open
 * text field and no moderator is exactly the thing this whole prototype is
 * trying not to build.
 */

import { pick } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { screenConduct } from '../../core/safety.js';
import { centre, box, panel } from './screen.js';
import { playWyrm } from './doors/wyrm.js';
import { playTrader } from './doors/trader.js';

export const SYSOP = 'Nell Farrow';

/* Callers the board says are on the other node. They are the board's, not
   the network's: nothing here is another person. */
const NODE2 = [
  ['ThreeRiver', 'reading the Games Room'],
  ['Bex_from_Hull', 'in Tale of the Scarlet Wyrm'],
  ['gr8_scott', 'downloading (7% and falling)'],
  ['MoM2Three', 'at the main menu, idle 4 min'],
  ['Duskwalker', 'in Sector Run'],
];

const BULLETINS = [
  ['Rules of the house', [
    '1. One call a day, forty minutes. There are two lines and forty of you.',
    '2. Upload something before you ask about ratios.',
    '3. The Games Room is for games. The General base is for everything else.',
    '4. If you are rude to somebody I will know before you have hung up.',
    '',
    'That is the whole list and it has not changed since 1992.',
    '',
    '                                              -- ' + SYSOP + ', sysop',
  ]],
  ['New this month', [
    'Second line is IN. You can stop getting the busy signal at seven o clock.',
    'Tale of the Scarlet Wyrm is up to version 2.1 — the goose has been',
    'nerfed, which several of you will be relieved to hear.',
    'Sector Run is new. It is arithmetic with a spaceship on it. Try it.',
  ]],
  ['About this board', [
    'The Midnight Carnival runs on a 486DX2/66 with 16 megabytes of memory',
    'and two 14.4 modems, in the back bedroom, which is why the board goes',
    'down whenever somebody in this house wants to make a phone call.',
    '',
    'It has been up since March 1992. Thank you for calling.',
  ]],
];

const BASES = [
  {
    name: 'General', blurb: 'Anything at all',
    posts: [
      ['ThreeRiver', 'the fog last night',
       ['Anyone else out on the bypass about eleven? You could not see the',
        'end of the bonnet. I have never known it that thick.',
        '',
        'Got home eventually. Would not do it again.']],
      ['MoM2Three', 'RE: the fog last night',
       ['We had it here too. School rang at half seven to say they were open',
        'anyway, which was optimistic of them.']],
      [SYSOP, 'line two is in',
       ['BT finally came. The second modem is up and answering. If you get a',
        'busy signal now it is because there are genuinely two people on.',
        '',
        'Please do not test this by all calling at once.']],
      ['Bex_from_Hull', 'moving away',
       ['I am off to Leeds in April so this will be a long distance call and',
        'my dad will notice. Might be my last month on here.',
        '',
        'It has been six years. Thanks, all of you, honestly.']],
      ['gr8_scott', 'RE: moving away',
       ['Leeds has boards. Ask around when you get there and say we sent you.']],
    ],
  },
  {
    name: 'The Games Room', blurb: 'Doors, hints, and arguing',
    posts: [
      ['Duskwalker', 'I did it',
       ['Scarlet Wyrm is dead. Level twelve, full plate, and I still only had',
        'thirty hit points left at the end of it.',
        '',
        'Do not fight it under level twelve. I have tried. It is not close.']],
      ['gr8_scott', 'RE: I did it',
       ['Post your build or it did not happen.']],
      ['Duskwalker', 'RE: RE: I did it',
       ['Bank everything every single night. That is the whole secret. You',
        'lose what you are carrying when you die and you will die a lot.']],
      ['ThreeRiver', 'Sector Run — the short route',
       ['Ore at Kettle, sell at Wick, medicine at Wick, sell at Kettle. Round',
        'and round. It is boring and it works.',
        '',
        'You want a full hold before you go anywhere near Longwater.']],
      ['SkaterDude99', 'the goose',
       ['is it just me or is the goose harder than the boar']],
      [SYSOP, 'RE: the goose',
       ['It is not just you. It is fixed in 2.1.']],
    ],
  },
  {
    name: 'For Sale / Wanted', blurb: 'Buy, sell, beg',
    posts: [
      ['gr8_scott', 'FS: SoundBlaster 16, £45',
       ['Value edition, works fine, box and driver disk. Collection only,',
        'north side. Will swap for memory.']],
      ['MoM2Three', 'WANTED: 14.4 modem',
       ['My 2400 is killing me. Anything internal considered. Can pay cash or',
        'in home-made cake, your choice.']],
      ['ThreeRiver', 'RE: WANTED: 14.4 modem',
       ['Cake.']],
    ],
  },
];

const FILES = [
  ['CARNIVAL.ZIP',  '184,320', 'Board menus and ANSI, if you run one too'],
  ['WYRM21.ZIP',    '412,960', 'Tale of the Scarlet Wyrm 2.1 — door, full'],
  ['SECTRUN.ZIP',   '208,144', 'Sector Run 1.0 — door'],
  ['FOGPIC.GIF',    '  96,204', 'The bypass, last Tuesday. Worth it'],
  ['MODLIST.TXT',   '   8,912', 'Every board in this dialling code, updated'],
  ['NELLTUNE.MOD',  '318,004', 'The sysop has been at the tracker again'],
];

const banner = t => {
  t.write(
    '|00|b4                                                                            \n' +
    '|b4|14   ███ █  █ ███   ███ ███ ███ ███ █ █ ███ █   |15 T H E                       \n' +
    '|b4|14    █  █  █ █     █   █ █ █ █ █ █ █ █  █  █   |15 M I D N I G H T             \n' +
    '|b4|14    █  ████ ██    █   ███ ██  █ █ █ █  █  █   |15 C A R N I V A L             \n' +
    '|b4|14    █  █  █ █     █   █ █ █ █ █ █ █ █  █  █   |15 B B S                       \n' +
    '|b4|14    █  █  █ ███   ███ █ █ █ █ █ █  █  ███ ███ |07                             \n' +
    '|b4                                                                            \n' +
    '|b0|08 ' + centre('two nodes  ·  14400 bps  ·  up since March 1992', 76) + '\n' +
    '|08 ' + centre('sysop: ' + SYSOP + '  ·  ' + '"we are all still here"', 76) + '\n\n|07');
};

/**
 * Runs a whole call. Resolves when the caller logs off or the line drops.
 * @param {object} t   a terminal from screen.js
 * @param {string} who the screen name the machine's owner uses
 */
export async function runBoard(t, who) {
  banner(t);

  let handle = null;
  while (!handle) {
    t.write('|07Handle (|08the board has never heard of you|07): |07');
    const raw = (await t.ask({ max: 16 })).trim() || who || 'Caller';
    const got = checkHandle(raw);
    if (got.ok) { handle = got.name; break; }
    t.write('\n|12' + got.why + '\n');
  }

  const caller = 1284 + (new Date().getDate() % 40);
  t.write('\n|10Hello, |15' + handle + '|10.\n' +
          '|08You are caller number |15' + caller + '|08 and the ' +
          (Math.random() < 0.5 ? 'second' : 'first') + ' today.\n' +
          '|08Node 1 of 2. Forty minutes, same as everybody.\n\n');
  A.buddyIn();
  await t.pause();

  let on = true;
  while (on) on = await menu();

  t.write('\n|14Thanks for calling the Midnight Carnival.\n' +
          '|08Forty minutes tomorrow. Say hello to your mum from me.\n\n' +
          '|12NO CARRIER\n');
  A.buddyOut();

  /* ── the menus ─────────────────────────────────────────────────────── */

  async function menu() {
    t.write('\n' + box([
      ' |15M A I N   M E N U|09' + ' '.repeat(26) + '|08' + ('caller ' + handle).padEnd(22),
      '-',
      '  |11[M]|07 Message bases        |11[D]|07 Doors and online games',
      '  |11[F]|07 File areas           |11[W]|07 Who else is on',
      '  |11[B]|07 Bulletins            |11[P]|07 Page the sysop',
      '  |11[G]|07 Goodbye (log off)',
    ]) +
      '|15Command: |07');
    const k = await t.key('MDFWBPG');
    if (k === 'D') return doors();
    if (k === 'M') await bases();
    else if (k === 'F') await files();
    else if (k === 'W') await who();
    else if (k === 'B') await bulletins();
    else if (k === 'P') await page();
    else return false;
    return true;
  }

  async function bases() {
    t.write('\n|11 Message bases\n');
    BASES.forEach((b, i) =>
      t.write('|07  (' + (i + 1) + ') ' + b.name.padEnd(20) + '|08' + b.blurb +
              '  |15' + b.posts.length + '|08 messages|07\n'));
    t.write('|11  (X)|07 Back\n|15> |07');
    const k = await t.key('123X'.slice(0, BASES.length) + 'X');
    if (k === 'X') return;
    const base = BASES[Number(k) - 1];
    t.write('\n|14 ' + base.name + '|08 — ' + base.posts.length + ' messages\n' +
            '|08 You cannot post: this is a guest account and the sysop is asleep.\n\n');
    for (let i = 0; i < base.posts.length; i++) {
      const [from, subj, body] = base.posts[i];
      t.write(panel([
        ' |15#' + (i + 1) + '|08 from |11' + from,
        ' |14' + subj,
        '-',
        ...body.map(line => ' |07' + line),
      ]) + '\n');
      if (i < base.posts.length - 1) {
        t.write('|08[|15ENTER|08] next  [|15Q|08] quit reading |07');
        if (await t.key(null) === 'Q') break;
      }
    }
    t.write('\n|08That is the lot. Come back tomorrow and there will be four more.\n');
    await t.pause();
  }

  async function files() {
    t.write('\n|11 File areas |08— all areas, newest first\n\n' +
            '|08  filename        size      description\n' +
            '|08  ' + '─'.repeat(64) + '\n');
    FILES.forEach(([n, size, desc]) =>
      t.write('|07  ' + n.padEnd(15) + '|14' + size.padStart(8) + '  |07' + desc + '\n'));
    t.write('\n|07Download which? Type a name, or ENTER to go back: |07');
    const want = (await t.ask({ max: 16 })).trim().toUpperCase();
    const hit = FILES.find(f => f[0].startsWith(want) && want.length > 2);
    if (!hit) { t.write('\n|08Nothing doing.\n'); return t.pause(); }
    const bytes = Number(hit[1].replace(/[^\d]/g, ''));
    const mins = Math.ceil(bytes / 1440 / 60);
    t.write('\n|10' + hit[0] + '|08, ' + hit[1] + ' bytes.\n' +
            '|08At 14400 that is about |15' + mins + ' minutes|08 and you have ' +
            'thirty-one left.\n' +
            '|12Your upload ratio is 0:1. The sysop is not made of hard disk.\n');
    await t.pause();
  }

  async function who() {
    t.write('\n|11 Who else is on\n\n' +
            '|08  node  caller           doing what\n' +
            '|08  ' + '─'.repeat(58) + '\n' +
            '|07  1     ' + handle.padEnd(16) + 'that would be you\n');
    const other = pick(NODE2);
    t.write('|07  2     ' + other[0].padEnd(16) + other[1] + '\n\n' +
            '|08 Nobody on this board can send you a message and you cannot send\n' +
            '|08 them one. The sysop took node chat out in 1993 and has not missed it.\n');
    await t.pause();
  }

  async function bulletins() {
    t.write('\n|11 Bulletins\n');
    BULLETINS.forEach((b, i) => t.write('|07  (' + (i + 1) + ') ' + b[0] + '\n'));
    t.write('|11  (X)|07 Back\n|15> |07');
    const k = await t.key('123X');
    if (k === 'X') return;
    const b = BULLETINS[Number(k) - 1];
    t.write('\n|14 ' + b[0] + '\n|08 ' + '─'.repeat(b[0].length + 2) + '\n\n');
    for (const line of b[1]) t.write('|07 ' + line + '\n');
    await t.pause();
  }

  async function page() {
    t.write('\n|08Paging the sysop');
    for (let i = 0; i < 6; i++) { t.write('|14 *'); A.beep(); await sleepish(340); }
    t.write('\n|12The sysop is not answering. It is the middle of the night and\n' +
            '|12' + SYSOP + ' has work in the morning like everybody else.\n');
    await t.pause();
  }

  async function doors() {
    t.write('\n|11 Doors and online games\n\n' +
            '|07  (1) |14Tale of the Scarlet Wyrm|07   |08fantasy, 15 fights a day\n' +
            '|07  (2) |11Sector Run|07                 |08trading, 25 jumps a day\n' +
            '|11  (X)|07 Back to the main menu\n\n|15> |07');
    const k = await t.key('12X');
    if (k === 'X') return true;
    t.write('\n|08Dropping to door... |08loading ' +
            (k === '1' ? 'WYRM.EXE' : 'SECTRUN.EXE') + '\n');
    A.seek();
    await sleepish(900);
    if (k === '1') await playWyrm(t, handle);
    else await playTrader(t, handle);
    t.write('|08Returning to the board...\n');
    await sleepish(500);
    return true;
  }
}

/* Handles here are looser than Halcyon's screen names — underscores and
   hyphens were the whole aesthetic — but they go through the same conduct
   check, and the board says no in its own voice. */
function checkHandle(raw) {
  const n = String(raw).trim().replace(/\s+/g, '');
  if (n.length < 2) return { ok: false, why: 'Too short. Two characters at least.' };
  if (n.length > 16) return { ok: false, why: 'Too long. Sixteen at the most.' };
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(n))
    return { ok: false, why: 'Letters, numbers, underscore and hyphen, starting with a letter.' };
  const c = screenConduct(n);
  if (c.blocked || c.masked) return { ok: false, why: 'Not on my board. Pick another one.' };
  if (/^(sysop|nell|farrow|root|admin)/i.test(n))
    return { ok: false, why: 'That one is taken, obviously.' };
  return { ok: true, name: n };
}

/* The board pauses for its own reasons, not the caller's. */
const sleepish = ms => new Promise(res => setTimeout(res, ms));
