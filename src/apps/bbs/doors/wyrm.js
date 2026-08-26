/*
 * Tale of the Scarlet Wyrm — the door game.
 *
 * Every board had one of these: a turn-limited fantasy game you could only
 * play so much of a day, so that everybody hit the same wall at the same
 * time and had something to argue about on the message base tomorrow. The
 * shape is the genre's: a village of single-key destinations, a forest
 * that is the only place experience comes from, a master who will not
 * teach you until you have earned it, and a dragon at the end of twelve
 * levels.
 *
 * It is its own game. The names, the monsters, the masters and every line
 * of the writing are invented; what is borrowed is the form, which was
 * common to dozens of these.
 *
 * There is no player-versus-player and nobody can leave anybody a message:
 * the whole game is you against the board's own numbers.
 */

import { randInt, pick, chance } from '../../../core/dom.js';
import { box, padTo } from '../screen.js';

const DAY_FIGHTS = 15;

/* Twelve levels, each with somebody who will not teach you until you have
   done the work, and the thing you get when they do. */
const MASTERS = [
  { xp: 100,    name: 'Old Kalder the woodcutter',   str: 3,  def: 2,  hp: 12,
    line: 'He puts down the axe and looks you over. "Grip it lower," he says.' },
  { xp: 300,    name: 'Marda of the Long Bridge',    str: 4,  def: 3,  hp: 16,
    line: 'She fights you with a broom handle and wins twice before you land one.' },
  { xp: 800,    name: 'The Tanner, who has no name', str: 6,  def: 4,  hp: 20,
    line: 'He says nothing at all for an hour, then nods once. That is the lesson.' },
  { xp: 2000,   name: 'Brother Ansel',               str: 8,  def: 6,  hp: 26,
    line: '"Anger is a short candle," he says, and hits you with a psalter.' },
  { xp: 4500,   name: 'Vess the Quarryman',          str: 11, def: 8,  hp: 32,
    line: 'She teaches you to hit things that are harder than you are.' },
  { xp: 9000,   name: 'Cobb, late of the watch',     str: 14, def: 11, hp: 40,
    line: 'He shows you the four places a person stops being dangerous.' },
  { xp: 17000,  name: 'The Widow Halloran',          str: 18, def: 14, hp: 50,
    line: 'She has buried three husbands and every one of them a swordsman.' },
  { xp: 30000,  name: 'Sir Ewan, who fell off',      str: 23, def: 18, hp: 62,
    line: 'He teaches you the thing he was not told, which is when to stop.' },
  { xp: 52000,  name: 'Nell of the Nine Winters',    str: 29, def: 23, hp: 76,
    line: 'She fights you in the snow until you understand the cold.' },
  { xp: 88000,  name: 'The Bellfounder',             str: 36, def: 29, hp: 92,
    line: 'He tunes you the way he tunes a bell: by taking things away.' },
  { xp: 150000, name: 'Ardith, first of the field',  str: 45, def: 36, hp: 112,
    line: 'She is the best there has ever been here, and she says so.' },
];

/* The thing the game is named after. It is not a master and it does not
   teach: it is the last screen, and it is meant to take you a few days. */
const WYRM = {
  name: 'the Scarlet Wyrm', hp: 2600, max: 2600, str: 340,
  die: 'It goes out like a furnace door closing, and the fells are cold again.',
};

const WEAPONS = [
  ['a stout stick', 0], ['a bread knife', 180], ['a hand axe', 600],
  ['a short sword', 1800], ['a boar spear', 5000], ['a cavalry sabre', 14000],
  ['a bearded axe', 38000], ['the Quarry Hammer', 92000], ['a wyrmtooth dagger', 210000],
  ['the Long Answer', 480000],
];
const ARMOURS = [
  ['a wool coat', 0], ['a leather jerkin', 160], ['a padded gambeson', 550],
  ['a mail shirt', 1700], ['a brigandine', 4800], ['a breastplate', 13000],
  ['the Quarryman’s plate', 36000], ['scaled harness', 88000], ['wyrmhide', 200000],
  ['the Last Coat', 460000],
];

/* Monsters by level band. Every one of them dies in its own way, because
   that is the part everybody actually remembers. */
const BEASTS = [
  { lv: 1, name: 'a bad-tempered goose',   hp: 9,   str: 4,   xp: 12,   gold: 14,
    die: 'It goes very still, which is the most peaceful you have ever seen it.' },
  { lv: 1, name: 'a mud-caked boar',       hp: 13,  str: 5,   xp: 18,   gold: 20,
    die: 'It sits down in the mud it came from.' },
  { lv: 2, name: 'a hedge-thief',          hp: 20,  str: 8,   xp: 40,   gold: 55,
    die: 'He drops a purse that was never his and runs into the dark.' },
  { lv: 2, name: 'a starving wolf',        hp: 24,  str: 9,   xp: 48,   gold: 40,
    die: 'It looks almost grateful.' },
  { lv: 3, name: 'a bog-lurker',           hp: 36,  str: 13,  xp: 110,  gold: 120,
    die: 'It comes apart like wet bread.' },
  { lv: 3, name: 'the miller’s dog, loose', hp: 32, str: 15,  xp: 120,  gold: 90,
    die: 'You feel terrible. The miller will not.' },
  { lv: 4, name: 'a road-troll',           hp: 58,  str: 20,  xp: 300,  gold: 340,
    die: 'It falls across its own bridge and blocks the road for a week.' },
  { lv: 4, name: 'a rusted sentinel',      hp: 52,  str: 23,  xp: 320,  gold: 300,
    die: 'It stops mid-swing and stays there, which is somehow worse.' },
  { lv: 5, name: 'a fen-hag',              hp: 84,  str: 30,  xp: 700,  gold: 760,
    die: 'She curses you thoroughly and at length before she goes.' },
  { lv: 5, name: 'a boar the size of a cart', hp: 96, str: 28, xp: 720, gold: 700,
    die: 'The ground takes a moment to stop shaking.' },
  { lv: 6, name: 'a knight who will not say why', hp: 130, str: 40, xp: 1500, gold: 1600,
    die: 'The visor is empty. It has been empty the whole time.' },
  { lv: 6, name: 'a colony of grave-beetles', hp: 118, str: 44, xp: 1600, gold: 1400,
    die: 'They go back down one by one, unhurried.' },
  { lv: 7, name: 'the Ash Widow',          hp: 190,  str: 58,  xp: 3200, gold: 3400,
    die: 'She thanks you, which you will think about for years.' },
  { lv: 7, name: 'a stone lion, walking',  hp: 210,  str: 54,  xp: 3300, gold: 3000,
    die: 'It settles onto its plinth and is a statue again.' },
  { lv: 8, name: 'a drowned bell-ringer',  hp: 280,  str: 76,  xp: 6500, gold: 6800,
    die: 'The bell rings once, a long way off.' },
  { lv: 8, name: 'a wyrmling, half-grown', hp: 300,  str: 80,  xp: 7000, gold: 7400,
    die: 'It is smaller than you expected, and that is the frightening part.' },
  { lv: 9, name: 'the Sheriff of Nine Winters', hp: 420, str: 104, xp: 14000, gold: 15000,
    die: 'His men do not avenge him. They had been waiting.' },
  { lv: 9, name: 'a thing wearing a miner', hp: 400, str: 110, xp: 14500, gold: 13000,
    die: 'What is left is only a miner, and you bury him properly.' },
  { lv: 10, name: 'the Bellfounder’s failure', hp: 600, str: 140, xp: 28000, gold: 30000,
    die: 'It rings flat all the way down.' },
  { lv: 10, name: 'a wyrm of the low fields', hp: 640, str: 134, xp: 29000, gold: 28000,
    die: 'The field is scorched in a perfect circle and nothing grows there.' },
  { lv: 11, name: 'Ardith’s old master',  hp: 900,  str: 180, xp: 56000, gold: 58000,
    die: 'He is pleased. That is the last thing he is.' },
  { lv: 11, name: 'the Scarlet Wyrm’s herald', hp: 860, str: 190, xp: 58000, gold: 55000,
    die: 'It delivers its message anyway, out of habit, and then stops.' },
  { lv: 12, name: 'a wyrm of the high fells', hp: 1300, str: 250, xp: 110000, gold: 115000,
    die: 'It falls a long way and takes the weather with it.' },
];

const RUMOURS = [
  'the Wyrm has not been seen since the year of the flood',
  'Ardith once fought a bear and the bear apologised',
  'there is money buried under the third bridge',
  'the Tanner used to be somebody, up north',
  'the goose by the mill has killed four men',
  'a caller from the coast beat the Wyrm and never came back to say how',
  'the Widow Halloran keeps a sword in the thatch',
  'the healer waters the medicine and charges for the water',
];

const DRINKS = [
  'Odette pours something brown and does not name it.',
  'The fire spits. Somebody at the back is telling the story wrong.',
  'The ale is better than it has any right to be.',
  'Odette tops you up without being asked, which is how you know she likes you.',
];

/* The board's own records, so the hall is never a list of one. */
const FAME = [
  ['Duskwalker', 12, 'slew the Scarlet Wyrm'],
  ['Bex_from_Hull', 11, 'lost to the Wyrm twice'],
  ['ThreeRiver', 10, 'still trying'],
  ['gr8_scott', 8, 'took the summer off'],
  ['MoM2Three', 7, 'plays after the school run'],
  ['SkaterDude99', 5, 'keeps dying to the goose'],
];

const store = handle => 'bbs.wyrm.' + handle.toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

function fresh() {
  return {
    level: 1, xp: 0, hp: 20, maxHp: 20, str: 6, def: 3,
    gold: 60, bank: 0, weapon: 0, armour: 0,
    fights: DAY_FIGHTS, day: today(), dead: false, slain: false, days: 1,
  };
}

function load(handle) {
  let s;
  try { s = JSON.parse(localStorage.getItem(store(handle))); } catch { s = null; }
  if (!s || typeof s !== 'object') s = fresh();
  else s = { ...fresh(), ...s };
  if (s.day !== today()) { s.day = today(); s.fights = DAY_FIGHTS; s.dead = false; s.days++; }
  return s;
}
const save = (handle, s) => {
  try { localStorage.setItem(store(handle), JSON.stringify(s)); } catch {}
};

const bar = (n, max, width = 20) => {
  const on = Math.max(0, Math.min(width, Math.round((n / max) * width)));
  return '|10' + '█'.repeat(on) + '|08' + '░'.repeat(width - on) + '|07';
};

export async function playWyrm(t, handle) {
  const s = load(handle);
  let running = true;

  const topped = () => s.level > MASTERS.length;          // nothing left to teach
  const master = () => MASTERS[Math.min(s.level - 1, MASTERS.length - 1)];
  const ready = () => !topped() && s.xp >= master().xp;

  t.clear();
  t.write(
    '|04 █   █ █   █ ███  █   █    |14T A L E   O F   T H E\n' +
    '|04 █   █  █ █  █  █ ██ ██\n' +
    '|04 █ █ █   █   ███  █ █ █    |12S C A R L E T   W Y R M\n' +
    '|04 ██ ██   █   █ █  █   █\n' +
    '|04 █   █   █   █  █ █   █    |08a door by Nell Farrow, 1994\n\n');
  t.write('|07Welcome back, |15' + handle + '|07. This is day |15' + s.days +
          '|07 of your service.\n');
  if (s.slain) t.write('|14They still talk about the Wyrm. Nobody says your name without it.\n');
  t.write('\n');
  await t.pause();

  while (running) await town();

  save(handle, s);
  t.write('\n|08You walk back out of the village and the modem takes you with it.\n\n');

  /* ── the village ───────────────────────────────────────────────────── */

  async function town() {
    t.clear();
    t.write(box([
      '  |14T H E   V I L L A G E   O F   L O W   B R I D G E',
    ], { width: 58, edge: '|02' }));
    status();
    const row = (a, b) => '  ' + padTo(a, 24) + (b || '') + '\n';
    t.write('\n' +
      row('|11(F)|07 The forest', '|11(T)|07 The training hall') +
      row('|11(H)|07 The healer', '|11(W)|07 The weaponsmith') +
      row('|11(A)|07 The armourer', '|11(B)|07 The bank') +
      row('|11(I)|07 The inn', '|11(L)|07 The hall of fame') +
      row('|11(Q)|07 Leave the village') + '\n' +
      (ready() ? '|14  ' + master().name + ' has been asking after you.\n\n' : '') +
      '|15Your choice: |07');
    const k = await t.key('FTHWABILQ');
    if (k === 'F') return forest();
    if (k === 'T') return training();
    if (k === 'H') return healer();
    if (k === 'W') return shop('weapon');
    if (k === 'A') return shop('armour');
    if (k === 'B') return bank();
    if (k === 'I') return inn();
    if (k === 'L') return fame();
    running = false;
  }

  function status() {
    t.write('\n|08 Level |15' + s.level + '|08   Hit points |07' + bar(s.hp, s.maxHp, 16) +
            ' |15' + s.hp + '|08/|15' + s.maxHp + '\n' +
            '|08 Strength |15' + s.str + '|08  Defence |15' + s.def +
            '|08  Gold |14' + s.gold + '|08  Banked |14' + s.bank + '\n' +
            '|08 Fights left today |15' + s.fights +
            '|08   Experience |15' + s.xp + '|08 of |15' + master().xp + '\n');
  }

  /* ── the forest ────────────────────────────────────────────────────── */

  async function forest() {
    while (true) {
      const fells = topped() && !s.slain;
      t.write('\n|02The forest is quiet in the way that means nothing good.\n' +
              '|11  (L)|07 Look for something   |11(H)|07 Bind your wounds   ' +
              '|11(R)|07 Back to the village\n' +
              (fells ? '|12  (F)|07 Climb to the high fells\n' : '') +
              '|15> |07');
      const k = await t.key(fells ? 'LHRF' : 'LHR');
      if (k === 'R') return;
      if (k === 'F') {
        if (s.dead) { t.write('|12Not in the state you are in.\n'); continue; }
        t.write('\n|12The path runs out. The heather is burnt for half a mile in every\n' +
                '|12direction, and something very large is breathing.\n' +
                '|07Go on? |11(Y)|07es or |11(N)|07o: |07');
        if (await t.key('YN') === 'N') { t.write('|08You go back down. Nobody has to know.\n'); continue; }
        const alive = await fight({ ...WYRM }, true);
        if (!alive) return;
        s.slain = true;
        s.xp += 400000; s.gold += 250000;
        t.write('\n|14You have killed the Scarlet Wyrm.\n' +
                '|07They will put it on the board tonight and argue about it for a year.\n' +
                '|08(|15400000|08 experience and |14250000|08 gold, for whatever that is worth now.)\n');
        save(handle, s);
        await t.pause();
        continue;
      }
      if (k === 'H') {
        if (s.gold < s.level * 8) { t.write('|12You cannot afford a bandage.\n'); continue; }
        s.gold -= s.level * 8;
        s.hp = Math.min(s.maxHp, s.hp + Math.ceil(s.maxHp * 0.2));
        t.write('|10You bind up what you can. |15' + s.hp + '|10 hit points.\n');
        save(handle, s);
        continue;
      }
      if (s.dead) { t.write('|12You are in no condition. Sleep it off at the inn.\n'); continue; }
      if (s.fights <= 0) {
        t.write('|12You are done in. There is nothing left in you today.\n');
        continue;
      }
      s.fights--;
      const beast = pickBeast();
      if (await fight(beast)) continue;
      return;                                     // died; the inn is next
    }
  }

  function pickBeast() {
    const band = BEASTS.filter(b => b.lv === Math.min(s.level, 12));
    const b = pick(band.length ? band : BEASTS);
    const drift = 0.85 + Math.random() * 0.35;
    return {
      ...b,
      hp: Math.round(b.hp * drift), max: Math.round(b.hp * drift),
      str: Math.round(b.str * drift),
    };
  }

  /** @returns {boolean} true if you are still standing. */
  async function fight(beast, isMaster = false) {
    t.write('\n|12You have met |15' + beast.name + '|12.\n');
    while (true) {
      t.write('|08 ' + beast.name + ' |07' + bar(beast.hp, beast.max, 14) +
              '   |08you |07' + bar(s.hp, s.maxHp, 14) + '\n' +
              '|11 (A)|07ttack  |11(S)|07tats  ' + (isMaster ? '' : '|11(R)|07un') + '  |15> |07');
      const k = await t.key(isMaster ? 'AS' : 'ASR');

      if (k === 'S') { status(); continue; }
      if (k === 'R') {
        if (chance(0.55)) { t.write('|14You get out of it. Not gracefully.\n'); return true; }
        t.write('|12It will not let you go.\n');
      } else {
        const dmg = Math.max(1, randInt(Math.round(s.str * 0.7), Math.round(s.str * 1.4)));
        beast.hp -= dmg;
        t.write('|10You hit for |15' + dmg + '|10.\n');
        if (beast.hp <= 0) return win(beast, isMaster);
      }

      const back = Math.max(1, randInt(Math.round(beast.str * 0.6), Math.round(beast.str * 1.2))
        - Math.round(s.def * 0.5));
      s.hp -= back;
      t.write('|12It hits back for |15' + back + '|12.\n');
      if (s.hp <= 0) return die(beast);
      save(handle, s);
    }
  }

  function win(beast, isMaster) {
    t.write('|14' + beast.die + '\n');
    if (isMaster) return true;
    s.xp += beast.xp; s.gold += beast.gold;
    t.write('|10You take |15' + beast.xp + '|10 experience and |14' + beast.gold + '|10 gold.\n');
    if (ready()) t.write('|14You are ready. ' + master().name + ' will see you now.\n');
    save(handle, s);
    return true;
  }

  function die(beast) {
    s.hp = 0; s.dead = true; s.fights = 0;
    const lost = s.gold;
    s.gold = 0;
    t.write('\n|04██ |12You are killed by |15' + beast.name + '|12. |04██\n' +
            '|08They carry you back over the bridge. You lose the |14' + lost +
            '|08 gold you were carrying;\n|08the bank keeps what it has. Sleep at the inn ' +
            'and try again tomorrow.\n');
    save(handle, s);
    return false;
  }

  /* ── the rest of the village ───────────────────────────────────────── */

  async function training() {
    const m = master();
    t.write('\n|02The training hall smells of sweat and old rope.\n');
    if (topped()) {
      t.write('|14There is nothing anybody here can add.\n' +
        (s.slain
          ? '|08They ask you to tell it again. You do.\n'
          : '|12The Scarlet Wyrm is on the high fells. Go up through the forest.\n'));
      return t.pause();
    }
    if (!ready()) {
      t.write('|15' + m.name + '|07 looks at you and shakes their head.\n' +
              '|08"Come back with |15' + (m.xp - s.xp) + '|08 more behind you."\n');
      return t.pause();
    }
    t.write('|15' + m.name + '|07 will fight you for it. |11(Y)|07es or |11(N)|07o? |07');
    if (await t.key('YN') === 'N') return;
    const won = await fight({
      name: m.name, hp: m.hp * 3, max: m.hp * 3, str: m.str,
      die: m.line,
    }, true);
    if (!won) return;
    s.level++;
    s.str += m.str; s.def += m.def; s.maxHp += m.hp; s.hp = s.maxHp;
    t.write('|14You are level |15' + s.level + '|14 now.\n' +
            '|10Strength |15+' + m.str + '|10  Defence |15+' + m.def +
            '|10  Hit points |15+' + m.hp + '|10, and you are healed.\n');
    if (topped()) t.write('\n|12The Scarlet Wyrm is on the high fells. You know the way.\n');
    save(handle, s);
    await t.pause();
  }

  async function healer() {
    const missing = s.maxHp - s.hp;
    const price = missing * s.level * 2;
    t.write('\n|02The healer has a bench, a bowl and no bedside manner.\n');
    if (s.dead) {
      t.write('|12"You are past my help until morning. Go to bed."\n');
      return t.pause();
    }
    if (!missing) { t.write('|10"Nothing wrong with you." \n'); return t.pause(); }
    t.write('|07Full healing costs |14' + price + '|07 gold. You have |14' + s.gold +
            '|07. |11(Y)|07es or |11(N)|07o? |07');
    if (await t.key('YN') === 'N') return;
    if (s.gold < price) { t.write('|12"Then bleed."\n'); return t.pause(); }
    s.gold -= price; s.hp = s.maxHp;
    t.write('|10Patched up. |15' + s.hp + '|10 hit points.\n');
    save(handle, s);
    await t.pause();
  }

  async function shop(kind) {
    const list = kind === 'weapon' ? WEAPONS : ARMOURS;
    const have = kind === 'weapon' ? s.weapon : s.armour;
    t.write('\n|02The ' + (kind === 'weapon' ? 'weaponsmith' : 'armourer') +
            ' does not look up.\n|08You carry |15' + list[have][0] + '|08.\n\n');
    list.forEach((w, i) => {
      const owned = i <= have;
      t.write((owned ? '|08' : '|07') + '  (' + String.fromCharCode(65 + i) + ') ' +
        w[0].padEnd(24) + (owned ? 'yours' : '|14' + w[1] + ' gold') + '|07\n');
    });
    t.write('\n|07Buy which? |11(A-' + String.fromCharCode(64 + list.length) +
            ')|07 or |11(X)|07 to leave: |07');
    const k = await t.key('ABCDEFGHIJ'.slice(0, list.length) + 'X');
    if (k === 'X') return;
    const i = k.charCodeAt(0) - 65;
    if (i <= have) { t.write('|08You already have that.\n'); return t.pause(); }
    if (s.gold < list[i][1]) { t.write('|12"Come back with the money."\n'); return t.pause(); }
    s.gold -= list[i][1];
    if (kind === 'weapon') { s.weapon = i; s.str += 4 + i * 5; }
    else { s.armour = i; s.def += 3 + i * 4; }
    t.write('|10You take |15' + list[i][0] + '|10 and it feels right.\n');
    save(handle, s);
    await t.pause();
  }

  async function bank() {
    t.write('\n|02The bank is one clerk and a very good lock.\n' +
            '|08On you |14' + s.gold + '|08   Banked |14' + s.bank + '|08\n' +
            '|11 (D)|07eposit  |11(W)|07ithdraw  |11(X)|07 Leave: |07');
    const k = await t.key('DWX');
    if (k === 'X') return;
    t.write('\n|07How much? |07');
    const raw = await t.ask({ max: 9 });
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    if (k === 'D') {
      const amt = Math.min(n, s.gold);
      s.gold -= amt; s.bank += amt;
      t.write('|10Deposited |14' + amt + '|10.\n');
    } else {
      const amt = Math.min(n, s.bank);
      s.bank -= amt; s.gold += amt;
      t.write('|10Withdrew |14' + amt + '|10.\n');
    }
    save(handle, s);
    await t.pause();
  }

  async function inn() {
    while (true) {
      t.write('\n|06The Bridge Inn is warm and low-ceilinged. Odette is behind the bar.\n' +
              '|11 (B)|07uy a drink (12g)  |11(L)|07isten by the fire  ' +
              '|11(S)|07leep until morning  |11(X)|07 Leave\n|15> |07');
      const k = await t.key('BLSX');
      if (k === 'X') return;
      if (k === 'B') {
        if (s.gold < 12) { t.write('|12Odette looks at your hands. They are empty.\n'); continue; }
        s.gold -= 12;
        s.hp = Math.min(s.maxHp, s.hp + Math.ceil(s.maxHp * 0.08) + 2);
        t.write('|14' + pick(DRINKS) + '|10 (|15' + s.hp + '|10 hit points)\n');
        save(handle, s);
        continue;
      }
      if (k === 'L') {
        t.write('|06Somebody at the next table swears blind that |15' + pick(RUMOURS) + '|06.\n');
        continue;
      }
      // sleep
      const interest = Math.floor(s.bank * 0.1);
      s.bank += interest;
      s.fights = DAY_FIGHTS;
      s.dead = false;
      s.hp = s.maxHp;
      s.days++;
      s.day = today();
      t.write('|10You sleep like the dead and wake up better than them.\n' +
              '|08The bank paid |14' + interest + '|08 in interest overnight.\n' +
              '|14Day ' + s.days + '. Fifteen fights again.\n');
      save(handle, s);
      await t.pause();
      return;
    }
  }

  async function fame() {
    t.write('\n|14  T H E   H A L L   O F   L O W   B R I D G E\n' +
            '|08  (the board keeps its own records; these are its callers)\n\n');
    const rows = [...FAME, [handle, s.level, s.slain ? 'slew the Scarlet Wyrm' : 'still at it']]
      .sort((a, b) => b[1] - a[1]);
    rows.forEach((r, i) => {
      const mine = r[0] === handle;
      t.write((mine ? '|15' : '|07') + '  ' + String(i + 1).padStart(2) + '. ' +
        String(r[0]).padEnd(16) + '|08level |15' + String(r[1]).padStart(2) +
        '|08   ' + r[2] + '|07\n');
    });
    await t.pause();
  }
}
