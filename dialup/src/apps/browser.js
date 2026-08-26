/* NetScrape Navigator 3.02 Gold.
 *
 * Pages are data, not HTML: sites.js describes each one as a list of
 * whitelisted node types and this module turns them into DOM. Nothing on
 * the fake web can inject markup, and there is no network — the "loading"
 * is a deliberate performance, because a page appearing instantly would
 * be the one detail that broke the spell.
 */

import { h, svg, clear, sleep } from '../core/dom.js';
import { openWindow, dialog } from '../core/wm.js';
import * as A from '../core/audio.js';
import { resolve, HOME } from './sites/web.js';

let seq = 0;

export function open(ctx, args = {}) {
  const id = 'browser';
  const win = openWindow({
    id, title: 'NetScrape Navigator', icon: 'browser',
    width: 720, height: 520, minWidth: 420, minHeight: 300,
    status: ['Document: Done', ''],
    menu: [{ label: 'File' }, { label: 'Edit' }, { label: 'View' },
           { label: 'Go' }, { label: 'Bookmarks' }, { label: 'Help' }],
    onClose: () => { stopTune(); return true; },
  });

  const history = [];
  let cursor = -1;
  let loading = null;

  const page = h('div.web-page.scroll');
  const url = h('input.field.web-url', { type: 'text', spellcheck: false });
  const throb = throbber();
  const back = navBtn('Back', () => go(cursor - 1));
  const fwd = navBtn('Forward', () => go(cursor + 1));
  const stop = navBtn('Stop', () => abort());
  const reload = navBtn('Reload', () => load(history[cursor], true));
  const home = navBtn('Home', () => visit(HOME));

  clear(win.body).append(h('div.web', {},
    h('div.web-nav', {}, back, fwd, home, reload, stop,
      h('div.web-throb', {}, throb)),
    h('div.web-loc', {}, h('b', {}, 'Location:'), url),
    page,
    h('div.web-status', {},
      h('span.web-msg', {}, 'Document: Done'),
      h('span.web-lock', {}, 'unsecured'))));

  const msg = win.el.querySelector('.web-msg');

  url.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') visit(url.value.trim());
  });

  function navBtn(label, onclick) {
    return h('button.btn.small.web-btn', { type: 'button', onclick }, label);
  }

  function visit(target) {
    if (!target) return;
    history.splice(cursor + 1);
    history.push(target);
    cursor = history.length - 1;
    load(target);
  }

  function go(i) {
    if (i < 0 || i >= history.length) { A.ding(); return; }
    cursor = i;
    load(history[i]);
  }

  function abort() {
    if (!loading) return;
    loading.cancelled = true;
    loading = null;
    throb.classList.remove('on');
    msg.textContent = 'Transfer interrupted.';
  }

  async function load(target, force = false) {
    abort();
    stopTune();
    const token = { cancelled: false, n: ++seq };
    loading = token;
    url.value = target;
    back.disabled = cursor <= 0;
    fwd.disabled = cursor >= history.length - 1;
    throb.classList.add('on');
    clear(page);

    const steps = [
      ['Looking up host ' + hostOf(target) + '...', 320],
      ['Contacting host...', 260],
      ['Host contacted. Waiting for reply...', 420],
    ];
    for (const [s, ms] of steps) {
      msg.textContent = s;
      await sleep(ms);
      if (token.cancelled) return;
    }

    const doc = resolve(target);
    if (!doc) {
      throb.classList.remove('on');
      msg.textContent = 'Error.';
      loading = null;
      await dialog({
        title: 'NetScrape', icon: 'error',
        message: 'The server does not have a DNS entry.\n\n' +
          'Check the server name in the Location field and try again.',
      });
      page.append(notFound(target));
      return;
    }

    win.setTitle(doc.title + ' - NetScrape');
    applyBackground(page, doc);

    // Text first, then the pictures crawl in, exactly in that order.
    const built = doc.nodes.map(n => buildNode(n, visit, doc));
    for (let i = 0; i < built.length; i++) {
      if (token.cancelled) return;
      page.append(built[i]);
      msg.textContent = 'Read ' + (2 + i * 3) + 'K of ' + (2 + built.length * 3) + 'K';
      await sleep(doc.slow ? 150 : 55);
    }

    const imgs = [...page.querySelectorAll('.web-img')];
    for (let i = 0; i < imgs.length; i++) {
      if (token.cancelled) return;
      msg.textContent = 'Read ' + (i + 1) + ' of ' + imgs.length + ' images...';
      await sleep(280);
      imgs[i].classList.add('loaded');
      A.seek(1, 0.03);
    }

    if (token.cancelled) return;
    throb.classList.remove('on');
    msg.textContent = 'Document: Done';
    loading = null;
    bumpCounters(page);
    if (doc.midi) startTune(doc.midi);
  }

  visit(args.url || HOME);
  return win;
}

const hostOf = u => (/^[a-z]+:\/\/([^/]+)/i.exec(u) || [, u])[1];

/* ── the throbber ────────────────────────────────────────────────────── */

function throbber() {
  const el = h('div.throb', {},
    svg('svg', { viewBox: '0 0 24 24', width: 22, height: 22 },
      svg('circle', { cx: 12, cy: 12, r: 11, fill: '#0b1b3a' }),
      svg('path', { d: 'M6 17V7l8 10V7', fill: 'none', stroke: '#7fb3ff', 'stroke-width': 2.4 }),
      svg('circle', { class: 'throb-dot', cx: 12, cy: 12, r: 9, fill: 'none',
                      stroke: '#4d8bff', 'stroke-width': 1.6,
                      'stroke-dasharray': '4 6' })));
  return el;
}

/* ── page building ───────────────────────────────────────────────────── */

function applyBackground(page, doc) {
  page.className = 'web-page scroll';
  page.removeAttribute('style');
  if (doc.theme) page.classList.add('theme-' + doc.theme);
  if (doc.bg) Object.assign(page.style, doc.bg);
}

function buildNode(n, visit, doc) {
  switch (n.t) {
    case 'h1': return h('h1.web-h1', { style: n.style }, n.text);
    case 'h2': return h('h2.web-h2', { style: n.style }, n.text);
    case 'p':  return h('p.web-p', { style: n.style }, inline(n, visit));
    case 'pre': return h('pre.web-pre', {}, n.text);
    case 'hr': return h('hr.web-hr');
    case 'br': return h('br');
    case 'center': return h('div.web-center', {}, n.kids.map(k => buildNode(k, visit, doc)));
    case 'marquee': return marquee(n.text, n.style);
    case 'blink': return h('span.web-blink', {}, n.text);
    case 'ul': return h('ul.web-ul', {}, n.items.map(it =>
      h('li', {}, typeof it === 'string' ? it : inline(it, visit))));
    case 'a': return link(n, visit);
    case 'img': return picture(n);
    case 'counter': return counter(n);
    case 'guestbook': return guestbook(n);
    case 'webring': return webring(n, visit);
    case 'table': return table(n, visit);
    case 'quote': return h('blockquote.web-quote', {}, n.text);
    case 'award': return h('div.web-award', {}, h('b', {}, n.title), h('span', {}, n.text));
    case 'search': return searchBox(n, visit);
    default: return h('span');
  }
}

function inline(n, visit) {
  if (n.kids) return n.kids.map(k => typeof k === 'string' ? k : buildNode(k, visit));
  return [n.text || ''];
}

function link(n, visit) {
  return h('a.web-a', {
    href: '#', title: n.href,
    onclick: ev => { ev.preventDefault(); A.click(); visit(n.href); },
  }, n.text);
}

/* ── pictures, drawn rather than fetched ─────────────────────────────── */

function picture(n) {
  const box = h('div.web-img', { class: 'img-' + n.kind });
  switch (n.kind) {
    case 'construction':
      box.append(h('div.gif-construction', {},
        h('span', {}, 'UNDER CONSTRUCTION')));
      break;
    case 'new':
      box.append(h('div.gif-new', {}, 'NEW!'));
      break;
    case 'mailbox':
      box.append(svg('svg', { viewBox: '0 0 48 32', width: 48, height: 32 },
        svg('rect', { x: 2, y: 8, width: 34, height: 20, fill: '#c9ccd4', stroke: '#333' }),
        svg('path', { d: 'M2 8l17 12L36 8', fill: 'none', stroke: '#333' }),
        svg('rect', { x: 38, y: 4, width: 3, height: 16, fill: '#666' }),
        svg('rect', { x: 38, y: 4, width: 9, height: 6, fill: '#d63a3a' })));
      break;
    case 'flame':
      box.append(h('div.gif-flame', {}, n.text || 'HOT'));
      break;
    case 'photo':
      box.append(photoCanvas(n));
      break;
    case 'rule':
      box.append(h('div.gif-rule'));
      break;
    default:
      box.append(h('div.gif-broken', {}, h('span', {}, n.alt || 'image')));
  }
  return box;
}

/** A little procedurally drawn "photograph" so pages have something real. */
function photoCanvas(n) {
  const W = n.w || 180, H = n.h || 120;
  const c = h('canvas', { width: W, height: H, class: 'web-photo' });
  const g = c.getContext('2d');
  const seed = (n.seed || 1) * 2654435761 % 1000;
  const rnd = (i) => ((Math.sin(seed + i * 12.9898) * 43758.5453) % 1 + 1) % 1;

  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, n.sky || '#8fb8e8');
  sky.addColorStop(1, '#dfe8f4');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);

  g.fillStyle = n.ground || '#3f6b3a';
  g.beginPath(); g.moveTo(0, H);
  for (let x = 0; x <= W; x += 6)
    g.lineTo(x, H * 0.62 + Math.sin(x * 0.03 + seed) * 8);
  g.lineTo(W, H); g.closePath(); g.fill();

  for (let i = 0; i < 7; i++) {
    const x = rnd(i) * W, hgt = 12 + rnd(i + 9) * 26;
    g.fillStyle = '#2b4a2a';
    g.beginPath(); g.arc(x, H * 0.62 - hgt * 0.4, hgt * 0.5, 0, 6.284); g.fill();
    g.fillStyle = '#5a3a20';
    g.fillRect(x - 1.5, H * 0.62 - hgt * 0.4, 3, hgt * 0.5);
  }
  g.strokeStyle = '#000'; g.lineWidth = 2; g.strokeRect(1, 1, W - 2, H - 2);
  return c;
}

/* ── the furniture of a personal home page ───────────────────────────── */

function marquee(text, style) {
  const inner = h('span.web-marq-in', { style }, text);
  const box = h('div.web-marq', {}, inner);
  return box;
}

function counter(n) {
  const key = 'web.counter.' + n.id;
  let v = 0;
  try { v = Number(localStorage.getItem(key) || n.start || 1) || 1; } catch { v = n.start || 1; }
  const digits = String(v).padStart(6, '0').split('');
  const box = h('div.web-counter', { dataset: { key } },
    digits.map(d => h('i', {}, d)));
  box.dataset.value = v;
  return h('div.web-center', {},
    h('div.web-counter-wrap', {},
      h('span', {}, 'You are visitor number'), box));
}

function bumpCounters(page) {
  for (const c of page.querySelectorAll('.web-counter')) {
    const key = c.dataset.key;
    const v = Number(c.dataset.value || 1) + 1;
    try { localStorage.setItem(key, String(v)); } catch {}
    clear(c).append(String(v).padStart(6, '0').split('').map(d => h('i', {}, d)));
    c.dataset.value = v;
  }
}

function guestbook(n) {
  const key = 'web.guestbook.' + n.id;
  const read = () => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } };
  const list = h('div.web-gb-list');
  const nameF = h('input.field', { type: 'text', placeholder: 'Your name', maxLength: 24, spellcheck: false });
  const noteF = h('input.field', { type: 'text', placeholder: 'Say something nice', maxLength: 140, spellcheck: false });

  const draw = () => {
    const entries = read();
    clear(list);
    if (!entries.length) list.append(h('div.web-gb-empty', {}, 'No entries yet. Be the first!'));
    for (const e of entries.slice(-12).reverse())
      list.append(h('div.web-gb-entry', {},
        h('b', {}, e.n), h('span', {}, ' - ' + e.d), h('div', {}, e.m)));
  };

  const sign = () => {
    const nm = (nameF.value || 'Anonymous').trim().slice(0, 24);
    const m = noteF.value.trim().slice(0, 140);
    if (!m) return;
    const entries = read();
    entries.push({ n: nm, m, d: new Date().toLocaleDateString() });
    try { localStorage.setItem(key, JSON.stringify(entries.slice(-60))); } catch {}
    nameF.value = ''; noteF.value = '';
    draw();
    A.mailFanfare();
  };

  noteF.addEventListener('keydown', ev => { if (ev.key === 'Enter') sign(); });
  draw();

  return h('div.web-gb', {},
    h('h3', {}, 'Sign My Guestbook!'),
    h('div.web-gb-form', {}, nameF, noteF,
      h('button.btn.small', { type: 'button', onclick: sign }, 'Sign')),
    list,
    h('div.web-gb-note', {},
      'Entries are stored in this browser only. Nobody else can read them.'));
}

function webring(n, visit) {
  return h('div.web-ring', {},
    h('b', {}, n.name),
    h('div.web-ring-nav', {},
      h('a.web-a', { href: '#', onclick: e => { e.preventDefault(); visit(n.prev); } }, '[ Previous ]'),
      h('a.web-a', { href: '#', onclick: e => { e.preventDefault(); visit(n.random || n.next); } }, '[ Random ]'),
      h('a.web-a', { href: '#', onclick: e => { e.preventDefault(); visit(n.next); } }, '[ Next ]')),
    h('div.web-ring-note', {}, 'This site is site ' + (n.index || 4) + ' of ' + (n.total || 11) + ' in the ring.'));
}

function table(n, visit) {
  return h('table.web-table', {}, h('tbody', {}, n.rows.map(r =>
    h('tr', {}, r.map(cell =>
      h('td', {}, typeof cell === 'string' ? cell : buildNode(cell, visit)))))));
}

function searchBox(n, visit) {
  const input = h('input.field', { type: 'text', placeholder: 'Search the Web', spellcheck: false,
                                   style: { width: '260px' } });
  const go = () => {
    const q = input.value.trim();
    if (q) visit('http://www.hotspider.com/results?q=' + encodeURIComponent(q));
  };
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
  return h('div.web-search', {}, input,
    h('button.btn.small', { type: 'button', onclick: go }, 'Search'));
}

function notFound(target) {
  return h('div.web-404', {},
    h('h1', {}, '404 Not Found'),
    h('p', {}, 'The requested URL ' + target + ' was not found on this server.'),
    h('hr'),
    h('address', {}, 'NCSA/1.5.2 Server at localhost Port 80'));
}

/* ── page music ──────────────────────────────────────────────────────── */

let tune = null;
function startTune(t) { stopTune(); tune = A.playTune(t, { bpm: t.bpm || 118, gain: 0.032 }); }
function stopTune() { if (tune) { tune.stop(); tune = null; } }
