/* The whole World Wide Web, as of a Tuesday in 1997.
 *
 * Each page is data. browser.js knows how to draw exactly these node
 * types and nothing else, which is what makes the fake web safe: there is
 * no path from page content to markup or script. */

export const HOME = 'halcyon://start';

const TUNE_HAPPY = {
  bpm: 124,
  voices: [
    { type: 'square', gain: 1, step: 0.5,
      notes: ['C5', 'E5', 'G5', 'E5', 'C5', 'E5', 'G5', 'B5', 'A5', 'F5', 'D5', 'F5', 'E5', 'C5', '-', '-'] },
    { type: 'triangle', gain: .8, step: 1,
      notes: ['C3', 'C3', 'G2', 'G2', 'A2', 'A2', 'F2', 'F2'] },
  ],
};

const TUNE_MOODY = {
  bpm: 96,
  voices: [
    { type: 'triangle', gain: 1, step: 0.5,
      notes: ['A4', '-', 'C5', '-', 'E5', 'D5', 'C5', '-', 'B4', '-', 'A4', '-', 'G4', '-', 'A4', '-'] },
    { type: 'sine', gain: .7, step: 2, notes: ['A2', 'F2', 'C3', 'G2'] },
  ],
};

const TUNE_ROCK = {
  bpm: 150,
  voices: [
    { type: 'sawtooth', gain: .55, step: 0.25,
      notes: ['E3', 'E3', 'E3', 'E3', 'G3', 'G3', 'A3', 'A3', 'E3', 'E3', 'E3', 'E3', 'D3', 'D3', 'C3', 'C3'] },
    { type: 'square', gain: .5, step: 1, notes: ['E5', 'G5', 'A5', 'G5'] },
  ],
};

/* ── the sites ───────────────────────────────────────────────────────── */

const PAGES = {

  'halcyon://start': {
    title: 'Halcyon Internet Center',
    theme: 'halcyon',
    nodes: [
      { t: 'center', kids: [{ t: 'h1', text: 'The Internet' }] },
      { t: 'center', kids: [{ t: 'p', text: 'A directory of interesting places, kept by hand.' }] },
      { t: 'hr' },
      { t: 'h2', text: 'Start here' },
      { t: 'ul', items: [
        { kids: [{ t: 'a', href: 'http://www.hotspider.com/', text: 'HotSpider' }, ' - search four million pages'] },
        { kids: [{ t: 'a', href: 'http://www.geocitadel.com/silicon_alley/4412/', text: "Dr. Webmaster's Home Page" }, ' - a personal page with frames and regrets'] },
        { kids: [{ t: 'a', href: 'http://www.geocitadel.com/sunset_strip/2207/', text: 'THE OFFICIAL UNOFFICIAL FAN PAGE' }, ' - loud'] },
        { kids: [{ t: 'a', href: 'http://www.modemring.org/', text: 'The 33.6 Webring' }, ' - eleven sites, one theme'] },
        { kids: [{ t: 'a', href: 'http://www.oldnet.example/museum/', text: 'What happened to all this' }, ' - a short note'] },
      ] },
      { t: 'hr' },
      { t: 'p', text: 'Type an address in the Location box to go anywhere. Most of the web is not here yet.' },
    ],
  },

  'http://www.hotspider.com/': {
    title: 'HotSpider - Search',
    theme: 'search',
    nodes: [
      { t: 'center', kids: [{ t: 'h1', text: 'HotSpider', style: { color: '#c2410c' } }] },
      { t: 'center', kids: [{ t: 'p', text: 'Searching 4,102,881 pages. Adding about 60,000 a week.' }] },
      { t: 'search' },
      { t: 'hr' },
      { t: 'h2', text: 'Browse by category' },
      { t: 'table', rows: [
        [{ t: 'a', href: 'http://www.geocitadel.com/silicon_alley/4412/', text: 'Computers' },
         { t: 'a', href: 'http://www.geocitadel.com/sunset_strip/2207/', text: 'Entertainment' }],
        [{ t: 'a', href: 'http://www.modemring.org/', text: 'Internet' },
         { t: 'a', href: 'http://www.oldnet.example/museum/', text: 'Reference' }],
      ] },
      { t: 'hr' },
      { t: 'p', text: 'HotSpider is a directory compiled by people. If your page is not listed, write to us and somebody will look at it within about six weeks.' },
    ],
  },

  'http://www.geocitadel.com/silicon_alley/4412/': {
    title: "Dr. Webmaster's Home Page",
    theme: 'geo',
    slow: true,
    midi: TUNE_HAPPY,
    bg: { backgroundColor: '#000030' },
    nodes: [
      { t: 'center', kids: [{ t: 'img', kind: 'flame', text: "DR. WEBMASTER'S PAGE" }] },
      { t: 'marquee', text: '*** WELCOME TO MY CORNER OF CYBERSPACE *** BEST VIEWED IN NETSCAPE 3.0 AT 800x600 *** SIGN MY GUESTBOOK ***' },
      { t: 'center', kids: [{ t: 'img', kind: 'construction' }] },
      { t: 'hr' },
      { t: 'h1', text: 'Hi, and welcome to my home page!', style: { color: '#ffe066' } },
      { t: 'p', text: 'My name is Dr. Webmaster (not a real doctor) and this is my page. I built it by hand in Notepad. It took three weekends and I would do it again.' },
      { t: 'p', kids: ['I am 27 and I live in Washington. I have a Pentium 166 with ',
                       { t: 'blink', text: '64 MEGABYTES' }, ' of RAM.'] },
      { t: 'center', kids: [{ t: 'img', kind: 'photo', seed: 3, w: 200, h: 130, sky: '#7fa8dd' }] },
      { t: 'center', kids: [{ t: 'p', text: '(the view from my apartment, taken with a borrowed digital camera)' }] },
      { t: 'hr' },
      { t: 'h2', text: 'My Links', style: { color: '#7fd97f' } },
      { t: 'ul', items: [
        { kids: [{ t: 'a', href: 'http://www.hotspider.com/', text: 'HotSpider' }, ' - I use this every day'] },
        { kids: [{ t: 'a', href: 'http://www.geocitadel.com/sunset_strip/2207/', text: "My friend's page" }, ' - be warned, it is loud'] },
        { kids: [{ t: 'a', href: 'http://www.modemring.org/', text: 'The 33.6 Webring' }, ' - I am site 4'] },
      ] },
      { t: 'hr' },
      { t: 'h2', text: 'Things I believe', style: { color: '#7fd97f' } },
      { t: 'ul', items: [
        'Frames are a design mistake.',
        'I used frames on this page. I am aware.',
        'Every page should say when it was last updated.',
        'The web will be like this forever.',
      ] },
      { t: 'quote', text: 'Last updated: August 16, 1997. Next update: when something happens.' },
      { t: 'hr' },
      { t: 'counter', id: 'drwebmaster', start: 4127 },
      { t: 'center', kids: [{ t: 'img', kind: 'new' }] },
      { t: 'guestbook', id: 'drwebmaster' },
      { t: 'hr' },
      { t: 'webring', name: 'The 33.6 Webring', index: 4, total: 11,
        prev: 'http://www.geocitadel.com/sunset_strip/2207/',
        next: 'http://www.modemring.org/',
        random: 'http://www.oldnet.example/museum/' },
      { t: 'center', kids: [{ t: 'img', kind: 'mailbox' }] },
      { t: 'center', kids: [{ t: 'p', text: 'You are visitor to this page. Thank you for visiting. Come back soon!' }] },
    ],
  },

  'http://www.geocitadel.com/sunset_strip/2207/': {
    title: 'THE OFFICIAL UNOFFICIAL FAN PAGE',
    theme: 'loud',
    slow: true,
    midi: TUNE_ROCK,
    bg: { backgroundColor: '#1a0033' },
    nodes: [
      { t: 'marquee', text: '!!! THE OFFICIAL UNOFFICIAL FAN PAGE !!! UPDATED DAILY !!! TELL YOUR FRIENDS !!!',
        style: { color: '#ff4dff' } },
      { t: 'center', kids: [{ t: 'h1', text: 'WELCOME 2 MY PAGE', style: { color: '#ffff00' } }] },
      { t: 'center', kids: [{ t: 'img', kind: 'flame', text: 'ENTER IF U DARE' }] },
      { t: 'p', text: 'HI EVERY1 this is my page about the greatest band of all time. i made it myself. if u dont like it dont look at it!!!!', style: { color: '#00ffcc' } },
      { t: 'center', kids: [{ t: 'img', kind: 'construction' }] },
      { t: 'h2', text: 'TOUR DATES', style: { color: '#ff4dff' } },
      { t: 'pre', text: 'OCT 14  CLEVELAND OH    AGORA        SOLD OUT\nOCT 16  DETROIT MI      ST ANDREWS   few left\nOCT 19  CHICAGO IL      METRO        SOLD OUT\nOCT 22  MINNEAPOLIS MN  FIRST AVE    on sale fri' },
      { t: 'h2', text: 'MY TOP 5 SONGS', style: { color: '#ff4dff' } },
      { t: 'ul', items: [
        '1. the fast one',
        '2. the slow one at the end',
        '3. the one from the movie',
        '4. the one nobody likes but me',
        '5. the b-side, obviously',
      ] },
      { t: 'center', kids: [{ t: 'img', kind: 'photo', seed: 11, w: 160, h: 110, sky: '#5a2a6a', ground: '#2a1a3a' }] },
      { t: 'center', kids: [{ t: 'p', text: '(this is a picture i scanned in. it took 40 minutes to upload.)' }] },
      { t: 'hr' },
      { t: 'award', title: 'COOL SITE OF THE DAY', text: 'awarded by my friend Steve, who has a page too' },
      { t: 'counter', id: 'fanpage', start: 918 },
      { t: 'guestbook', id: 'fanpage' },
      { t: 'webring', name: 'The 33.6 Webring', index: 3, total: 11,
        prev: 'http://www.modemring.org/',
        next: 'http://www.geocitadel.com/silicon_alley/4412/' },
      { t: 'center', kids: [{ t: 'p', text: 'THIS PAGE IS BEST VIEWED WITH YOUR EYES OPEN', style: { color: '#ffff00' } }] },
    ],
  },

  'http://www.modemring.org/': {
    title: 'The 33.6 Webring',
    theme: 'geo',
    midi: TUNE_MOODY,
    bg: { backgroundColor: '#102030' },
    nodes: [
      { t: 'center', kids: [{ t: 'h1', text: 'The 33.6 Webring', style: { color: '#9fd0ff' } }] },
      { t: 'center', kids: [{ t: 'p', text: 'Eleven personal pages about modems, linked in a circle. Click Next until you come back here.' }] },
      { t: 'hr' },
      { t: 'h2', text: 'Member sites' },
      { t: 'ul', items: [
        { kids: [{ t: 'a', href: 'http://www.geocitadel.com/silicon_alley/4412/', text: "4. Dr. Webmaster's Home Page" }] },
        { kids: [{ t: 'a', href: 'http://www.geocitadel.com/sunset_strip/2207/', text: '3. THE OFFICIAL UNOFFICIAL FAN PAGE' }] },
        '5. Carl\'s Big Page Of Modem Strings (temporarily down)',
        '6. THE BAUD SHED (moved, no forwarding address)',
        '7. angelfire page, owner unreachable',
      ] },
      { t: 'hr' },
      { t: 'p', text: 'To join the ring, put the ring HTML at the bottom of your page and mail the ringmaster. Please do not mail the ringmaster about site 6.' },
      { t: 'webring', name: 'The 33.6 Webring', index: 1, total: 11,
        prev: 'http://www.geocitadel.com/silicon_alley/4412/',
        next: 'http://www.geocitadel.com/sunset_strip/2207/' },
      { t: 'counter', id: 'modemring', start: 22450 },
    ],
  },

  'http://www.oldnet.example/museum/': {
    title: 'A short note about all this',
    theme: 'plain',
    nodes: [
      { t: 'h1', text: 'A short note about all this' },
      { t: 'p', text: 'Everything you have been clicking on is a reconstruction, written from memory and running entirely inside your browser. There is no server. Nothing you type in a chat room, a guestbook or a mail window leaves this machine.' },
      { t: 'p', text: 'The service is called Halcyon because it never existed. The screen names in the rooms are small programs. The web pages are a few hundred lines of data. The modem noise is six oscillators and a filter.' },
      { t: 'h2', text: 'The parts that were real' },
      { t: 'ul', items: [
        'The handshake really did go: dial tone, touch tones, ring, answer tone, a warble, four bongs, a descending hiss, then silence.',
        'A 47 kilobyte photograph really did take four minutes, and really did arrive a few lines at a time.',
        'Somebody really did ask for your password by instant message, and the capital i really was the trick.',
        'Guides really did remove people from rooms for scrolling, and it really did work.',
      ] },
      { t: 'h2', text: 'The parts worth keeping' },
      { t: 'p', text: 'Rooms small enough that you recognised people. A moderator with a name. A limit on how fast you could talk. Nothing that followed you home.' },
      { t: 'hr' },
      { t: 'p', text: 'Back to the start: ' },
      { t: 'a', href: 'halcyon://start', text: 'Halcyon Internet Center' },
    ],
  },
};

/* ── results pages are generated ─────────────────────────────────────── */

const DIRECTORY = [
  ['Dr. Webmaster\'s Home Page', 'http://www.geocitadel.com/silicon_alley/4412/',
   'Personal page. Frames, a hit counter, and a photograph of a car park.',
   ['computer', 'pentium', 'ram', 'html', 'homepage', 'modem', 'frames', 'web']],
  ['THE OFFICIAL UNOFFICIAL FAN PAGE', 'http://www.geocitadel.com/sunset_strip/2207/',
   'Tour dates, a top five, and a scanned photograph.',
   ['band', 'music', 'tour', 'concert', 'fan', 'rock', 'song']],
  ['The 33.6 Webring', 'http://www.modemring.org/',
   'Eleven personal pages about modems, linked in a circle.',
   ['modem', 'webring', 'ring', 'links', '336', '56k', 'baud']],
  ['A short note about all this', 'http://www.oldnet.example/museum/',
   'What is real here and what is not.',
   ['history', 'about', 'aol', 'nostalgia', 'real', 'help', 'museum']],
  ['HotSpider', 'http://www.hotspider.com/',
   'Searching 4,102,881 pages.', ['search', 'find', 'directory', 'index']],
];

function results(query) {
  const q = String(query).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const scored = DIRECTORY.map(([title, url, blurb, tags]) => {
    let score = 0;
    for (const w of q) {
      if (tags.some(t => t.includes(w) || w.includes(t))) score += 3;
      if (title.toLowerCase().includes(w)) score += 2;
      if (blurb.toLowerCase().includes(w)) score += 1;
    }
    return { title, url, blurb, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);

  const nodes = [
    { t: 'center', kids: [{ t: 'h1', text: 'HotSpider', style: { color: '#c2410c' } }] },
    { t: 'search' },
    { t: 'hr' },
    { t: 'p', text: 'Results 1 - ' + scored.length + ' of about ' + (scored.length ? scored.length : 0) +
      ' for "' + query + '". Search took 4.2 seconds.' },
  ];

  if (!scored.length) {
    nodes.push({ t: 'p', text: 'Your search did not match any documents in the index.' });
    nodes.push({ t: 'p', text: 'Suggestions: check your spelling, try fewer words, or try one of these:' });
    nodes.push({ t: 'ul', items: ['modem', 'band', 'homepage', 'webring', 'history'] });
  } else {
    for (const r of scored) {
      nodes.push({ t: 'p', kids: [{ t: 'a', href: r.url, text: r.title }] });
      nodes.push({ t: 'p', text: r.blurb, style: { marginTop: '-6px', color: '#356' } });
    }
  }
  nodes.push({ t: 'hr' });
  nodes.push({ t: 'p', text: 'The index contains five documents. It was a smaller web.' });
  return { title: 'HotSpider: ' + query, theme: 'search', nodes };
}

/* ── resolver ────────────────────────────────────────────────────────── */

export function resolve(rawUrl) {
  let url = String(rawUrl).trim();
  if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
  url = url.replace(/\s+/g, '');

  const m = /^http:\/\/www\.hotspider\.com\/results\?q=(.*)$/i.exec(url);
  if (m) { try { return results(decodeURIComponent(m[1])); } catch { return results(m[1]); } }

  if (PAGES[url]) return PAGES[url];
  if (PAGES[url + '/']) return PAGES[url + '/'];
  if (PAGES[url.replace(/\/$/, '')]) return PAGES[url.replace(/\/$/, '')];
  return null;
}

export const KNOWN = Object.keys(PAGES);
