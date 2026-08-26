/*
 * The other people in the rooms.
 *
 * Each persona is a voice, not a script: a set of quirks that transform
 * plain sentences into how that particular person typed in 1997, plus a
 * bank of things they might say, keyed loosely on what was just said.
 * The transform is what sells it — the abbreviations, the doubled
 * punctuation, the person who never once used the shift key, the person
 * who uses it for everything.
 */

import { pick, chance, randInt, hash } from '../../core/dom.js';

/* ── style transforms ────────────────────────────────────────────────── */

const SHORTHAND = [
  [/\byou\b/gi, 'u'], [/\byour\b/gi, 'ur'], [/\byou're\b/gi, 'ur'],
  [/\bare\b/gi, 'r'], [/\bfor\b/gi, '4'], [/\bto\b/gi, '2'], [/\btoo\b/gi, '2'],
  [/\bbe\b/gi, 'b'], [/\bsee\b/gi, 'c'], [/\bplease\b/gi, 'plz'],
  [/\bthanks\b/gi, 'thx'], [/\bwhat\b/gi, 'wat'], [/\bbecause\b/gi, 'cuz'],
  [/\bpeople\b/gi, 'ppl'], [/\banyone\b/gi, 'ne1'], [/\bsomeone\b/gi, 'sum1'],
  [/\bgreat\b/gi, 'gr8'], [/\blater\b/gi, 'l8r'], [/\bwait\b/gi, 'w8'],
];

const FACES = [':)', ':-)', ':D', ';)', ':P', '=)', ':o)', '^_^'];
const SAD   = [':(', ':-(', ':\'(', '=/'];

function typo(s) {
  if (s.length < 6) return s;
  const i = randInt(1, s.length - 2);
  if (chance(0.5)) return s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2); // swap
  return s.slice(0, i) + s.slice(i + 1);                                     // drop
}

/** Applies a persona's quirks to a neutral line. */
export function inflect(line, p) {
  let s = line;
  if (p.shorthand) for (const [re, to] of SHORTHAND) if (chance(p.shorthand)) s = s.replace(re, to);
  if (p.lower)      s = s.toLowerCase();
  if (p.caps)       s = s.toUpperCase();
  if (p.noPunct)    s = s.replace(/[.,]/g, '');
  if (p.stretch && chance(p.stretch)) s = s.replace(/([aeiouy])(\b|[.!?])/i, (m, v, e) => v.repeat(randInt(2, 4)) + e);
  if (p.bang && chance(p.bang)) s = s.replace(/[.!?]?$/, '!'.repeat(randInt(1, 4)));
  if (p.ellipsis && chance(p.ellipsis)) s = s.replace(/[.!?]?$/, '...');
  if (p.typos && chance(p.typos)) s = typo(s);
  if (p.face && chance(p.face)) s += ' ' + pick(p.sadMood ? SAD : FACES);
  if (p.spaced) s = s.split('').join(' ');
  return s;
}

/* ── the regulars ────────────────────────────────────────────────────── */

/* topics: what pulls them into a conversation.
   lines:  neutral sentences; the inflector makes them sound like a person. */

export const PERSONAS = [
  {
    name: 'SkaterDude420', color: '#0a5c2e', asl: '16/m/CA',
    style: { lower: 1, shorthand: .8, noPunct: 1, bang: .3, typos: .12, face: .3 },
    wpm: 34,
    greet: ['sup', 'yo whats up everyone', 'hey room'],
    lines: [
      'anyone else got a dial up that keeps dropping', 'i just landed a kickflip finally',
      'my mom keeps picking up the phone', 'downloading a song its been like 40 minutes',
      'that new blink album is sick', 'school tomorrow lame',
    ],
    topics: {
      music: ['punk is the only real music', 'blink 182 all day', 'do you have any mp3s'],
      games: ['goldeneye is the greatest game ever made', 'i play quake on my dads computer'],
      computer: ['my pentium is 133 megahertz', 'i have 16 megs of ram'],
      bye: ['later', 'peace'],
    },
  },
  {
    name: 'xXAngelBabyXx', color: '#a4157d', asl: '15/f/NJ',
    style: { shorthand: .5, bang: .6, face: .75, stretch: .35, typos: .08 },
    wpm: 52,
    greet: ['hi everybody', 'hey hey', 'hiii room'],
    lines: [
      'i am so bored right now', 'does anyone want to be pen pals',
      'i just made my homepage go see it', 'i love this song on the radio',
      'my little brother wont get off the computer', 'i put glitter on my binder today',
    ],
    topics: {
      music: ['spice girls forever', 'i have every backstreet boys single'],
      web: ['my homepage has a hit counter and it is at 400 something', 'i know how to do html now'],
      compliment: ['aw thank you', 'that is so sweet'],
      bye: ['bye everyone', 'ttyl'],
    },
  },
  {
    name: 'LordPhoenix77', color: '#7a2f00', asl: '19/m/TX',
    style: { caps: 1, bang: .8 },
    wpm: 41,
    greet: ['GREETINGS MORTALS', 'THE PHOENIX HAS ENTERED'],
    lines: [
      'DOES ANYONE ELSE PLAY MAGIC THE GATHERING',
      'I AM CURRENTLY LISTENING TO METALLICA', 'MY CAPS LOCK IS NOT BROKEN THIS IS A CHOICE',
      'I HAVE BEEN ON THIS SERVICE SINCE VERSION ONE POINT FIVE',
    ],
    topics: {
      games: ['I HAVE BEATEN FINAL FANTASY SEVEN THREE TIMES', 'DIABLO IS SUPERIOR'],
      caps: ['I WILL NOT TURN IT OFF', 'THIS IS MY VOICE'],
      bye: ['FAREWELL', 'THE PHOENIX DEPARTS'],
    },
  },
  {
    name: 'MoM2Three', color: '#1a4f7a', asl: '38/f/OH',
    style: { face: .3, ellipsis: .4 },
    wpm: 22,
    greet: ['Hello everyone', 'Good evening all'],
    lines: [
      'Does anyone have a good recipe for casserole',
      'I finally figured out how to send a picture',
      'My son set this up for me', 'It is so nice to talk to people from all over',
      'I am supposed to be doing laundry',
    ],
    topics: {
      help: ['Try clicking the little blue E', 'I had that problem, unplug it and plug it back in'],
      family: ['I have three, they are 6, 9 and 14', 'They grow up so fast'],
      bye: ['Goodnight everyone', 'Take care now'],
    },
  },
  {
    name: 'DrWebmaster', color: '#0b3d91', asl: '27/m/WA',
    style: { shorthand: .1 },
    wpm: 68,
    greet: ['hello all', 'evening'],
    lines: [
      'I just upgraded to 64 megabytes of RAM',
      'Netscape 4 renders tables much better than 3 did',
      'Frames are a design mistake and I will die on this hill',
      'I am running a web server out of my apartment',
      'Anyone tried this new Java thing',
    ],
    topics: {
      computer: ['what processor are you running', 'you want at least a 28.8 for that'],
      web: ['I can help you with your HTML if you like', 'validate your markup, it matters'],
      internet: ['the whole internet is going to be like this in ten years', 'get a domain now while they are cheap'],
      bye: ['later all', 'logging off, good night'],
    },
  },
  {
    name: 'CoffeeAchiever', color: '#5b3a1a', asl: '31/f/IL',
    style: { ellipsis: .5, face: .2 },
    wpm: 45,
    greet: ['morning, or whatever time it is where you are', 'hi all'],
    lines: [
      'On my fourth cup and the sun is not up yet',
      'I work nights so this is my lunch break',
      'Anyone else up at this hour', 'The office is very quiet right now',
    ],
    topics: {
      night: ['the room is always better after midnight', 'the weirdos come out and I mean that kindly'],
      bye: ['back to work', 'night all'],
    },
  },
  {
    name: 'TheReal_Elvis', color: '#6a1b6a', asl: '62/m/TN',
    style: { bang: .4, face: .2 },
    wpm: 28,
    greet: ['thank you, thank you very much', 'well hello there'],
    lines: [
      'I am not dead I just needed some time to myself',
      'The peanut butter and banana sandwich is underrated',
      'Somebody put a quarter in that jukebox',
    ],
    topics: {
      music: ['now that is a song', 'they do not write them like that anymore'],
      doubt: ['believe what you want, friend'],
      bye: ['Elvis has left the room'],
    },
  },
  {
    name: 'gr8_scott', color: '#2f6b2f', asl: '24/m/MI',
    style: { lower: 1, shorthand: .6, noPunct: 1, typos: .15 },
    wpm: 39,
    greet: ['hey', 'anyone here'],
    lines: [
      'my roommate is hogging the phone line again',
      'i got a free trial disk in a cereal box',
      'i have like 300 free hours saved up', 'does the free trial ever actually end',
    ],
    topics: {
      trial: ['i have a drawer full of those disks', 'i use them as coasters'],
      bye: ['cya', 'im out'],
    },
  },
];

/* ── the staff ───────────────────────────────────────────────────────── */

export const GUIDE = {
  name: 'HalcyonGuide MJ', color: '#8a0000', staff: true,
  style: {}, wpm: 75,
};

/* The scammer. He appears rarely, asks for your password by instant
   message, and is immediately busted — the point of the beat is the
   Guide's explanation, which is the actual advice. */
export const PHISHER = {
  name: 'HaIcyon Billing', color: '#444', suspicious: true, wpm: 60,
  // Note the capital i in place of the l. That was the whole trick.
};

export const ALL_NAMES = PERSONAS.map(p => p.name);

/* ── the brain ───────────────────────────────────────────────────────── */

const RULES = [
  { key: 'asl',     re: /\ba\s*\/?\s*s\s*\/?\s*l\b|age.*sex.*loc/i },
  { key: 'greeting',re: /\b(hi|hey|hello|yo|sup|howdy|greetings|hola)\b/i },
  { key: 'bye',     re: /\b(bye|goodbye|later|l8r|cya|gtg|g2g|night|leaving|logging off)\b/i },
  { key: 'music',   re: /\b(music|song|band|album|cd|mp3|radio|guitar|concert)\b/i },
  { key: 'games',   re: /\b(game|nintendo|n64|playstation|doom|quake|mario|zelda|sega)\b/i },
  { key: 'computer',re: /\b(computer|pc|ram|megabyte|processor|pentium|modem|hard drive|windows)\b/i },
  { key: 'web',     re: /\b(homepage|website|web page|html|geocities|angelfire|link|url)\b/i },
  { key: 'internet',re: /\b(internet|online|web|surf|net|email|e-mail)\b/i },
  { key: 'help',    re: /\b(help|how do i|how does|anyone know|question)\b/i },
  { key: 'family',  re: /\b(kids|children|son|daughter|family|mom|dad)\b/i },
  { key: 'compliment', re: /\b(nice|cool|awesome|great|love (it|that)|thank)\b/i },
  { key: 'night',   re: /\b(late|midnight|tired|sleep|awake|3am|insomnia)\b/i },
  { key: 'trial',   re: /\b(free trial|disk|cd-rom|hours|sign ?up)\b/i },
  { key: 'caps',    re: /^[^a-z]*[A-Z]{8,}/ },
  { key: 'doubt',   re: /\b(really|sure|prove|fake|lying|yeah right)\b/i },
];

const GENERIC = [
  'ha', 'lol', 'seriously', 'same here', 'oh wow', 'no way',
  'that is wild', 'tell me about it', 'agreed', 'i was just thinking that',
  'hm', 'good point', 'exactly', 'you and me both',
];

const ASL_ASKS = ['a/s/l?', 'asl', 'a/s/l anyone?'];

/**
 * Builds a stateful conversational agent for one persona.
 * Everything it returns is neutral text; `inflect` gives it the voice.
 */
export function makeBrain(p) {
  let lastSpoke = 0;
  let saidGreeting = false;
  const usedLines = new Set();

  function fresh(bank) {
    const unused = bank.filter(l => !usedLines.has(l));
    const line = pick(unused.length ? unused : bank);
    usedLines.add(line);
    if (usedLines.size > 40) usedLines.clear();
    return line;
  }

  return {
    persona: p,

    greeting() {
      saidGreeting = true;
      return inflect(pick(p.greet), p.style);
    },

    /** Something to say unprompted. Returns null when they have nothing. */
    idle(ctx) {
      const now = Date.now();
      if (now - lastSpoke < 9000) return null;
      lastSpoke = now;
      if (!saidGreeting && chance(0.7)) return this.greeting();
      if (chance(0.12)) return inflect(pick(ASL_ASKS), p.style);
      return inflect(fresh(p.lines), p.style);
    },

    /**
     * React to a line someone else said.
     * @returns {null | string}
     */
    reply(text, from, ctx = {}) {
      const now = Date.now();
      const addressed = new RegExp('\\b' + p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text);
      if (!addressed && now - lastSpoke < 4500) return null;

      const hits = RULES.filter(r => r.re.test(text)).map(r => r.key);
      const topical = hits.map(k => p.topics && p.topics[k]).filter(Boolean);

      let base = null;
      if (hits.includes('asl')) base = p.asl;
      else if (topical.length) base = pick(pick(topical));
      else if (hits.includes('greeting') && !saidGreeting) return (lastSpoke = now, this.greeting());
      else if (hits.includes('greeting')) base = chance(.5) ? 'hey ' + from : 'hi ' + from;
      else if (hits.includes('bye')) base = pick(p.topics?.bye || ['bye']);
      else if (addressed) base = pick(['what', 'yeah?', 'you rang', 'im here']);
      else if (chance(addressed ? 1 : 0.35)) base = pick(GENERIC);

      if (!base) return null;
      lastSpoke = now;
      return inflect(base, p.style);
    },

    /** How long this person would take to type that. */
    typingMs(text) {
      const perChar = 60000 / ((p.wpm || 40) * 5);
      return Math.round(text.length * perChar * (0.75 + Math.random() * 0.6)) + randInt(250, 1100);
    },

    markSpoke() { lastSpoke = Date.now(); },
  };
}

/** Stable per-name colour for anyone we do not have a persona for. */
export function nameColor(name) {
  const p = PERSONAS.find(x => x.name === name);
  if (p) return p.color;
  const hues = ['#0b3d91', '#7a2f00', '#0a5c2e', '#a4157d', '#5b3a1a', '#1a4f7a', '#6a1b6a'];
  return hues[hash(name) % hues.length];
}

/* ── period-accurate room furniture ──────────────────────────────────── */

export const CHAIN_LETTERS = [
  'FORWARD THIS TO 10 PEOPLE OR YOU WILL HAVE BAD LUCK FOR 7 YEARS. IT REALLY WORKS. MY COUSIN DID NOT AND HIS DOG RAN AWAY.',
  'Bill Gates is testing an e-mail tracking program and will send you $245 for every person you forward this to. This is not a hoax.',
  'A little girl named Amy needs your help. For every time this message is forwarded a hospital gets 3 cents. Please do not break the chain.',
];

export const ASCII_ART = [
  ['     .-"""-.', "    / .===. \\", "    \\/ 6 6 \\/", "    ( \\___/ )", " ___ooo___ooo___", "  I AM A COW"],
  ['<><  <><  <><   ><>  ><>', '   swimming through the lobby'],
  ['[]==============[]', '||   HALCYON   ||', '[]==============[]'],
  ['  *    .  *       .', '.   *  I AM ONLINE  *', '   *      .    *  .'],
];

export const ROOM_EVENTS = [
  { kind: 'chain',  weight: 1 },
  { kind: 'art',    weight: 1 },
  { kind: 'punt',   weight: 1 },
  { kind: 'guide',  weight: 1 },
];
