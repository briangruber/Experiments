/*
 * The thing you talk with.
 *
 * You type into it normally, and it shows you — before you commit — the
 * phrase it is going to send instead. Enter sends that phrase. Your actual
 * keystrokes are read by the matcher in phrasebook.js and then thrown
 * away; they never reach the network layer, another tab, or the relay.
 *
 * There is also a browser, because half the fun is finding out what the
 * service will let you say.
 */

import { h, clear, $$ } from '../../core/dom.js';
import * as A from '../../core/audio.js';
import { CATEGORIES, PHRASES, match, suggestions, PHRASE_COUNT } from './phrasebook.js';

export function createSayBox({ onSend, hint = 'Type what you mean and press Enter' }) {
  let picked = null;          // the phrase Enter will send
  let cursor = 0;             // which match is highlighted
  let current = [];           // the current match list

  const input = h('input.say-input', {
    type: 'text', spellcheck: false, maxLength: 60, placeholder: hint,
  });
  const preview = h('div.say-preview');
  const list = h('div.say-list');
  const browser = h('div.say-browser', { hidden: true });

  const sendBtn = h('button.aol-btn.small.say-send', { type: 'button', disabled: true }, 'Send');
  const browseBtn = h('button.say-browse', { type: 'button', title: 'Browse everything you can say' },
    'Phrase Book');

  /* ── the match list ────────────────────────────────────────────────── */

  function setPicked(p) {
    picked = p;
    sendBtn.disabled = !p;
    clear(preview);
    if (!p) {
      preview.append(h('span.say-none', {},
        input.value.trim()
          ? 'Nothing in the phrase book is close to that. Try the Phrase Book button.'
          : 'Halcyon sends a phrase, not your typing.'));
      return;
    }
    preview.append(h('span.say-label', {}, 'You will say:'), h('b', {}, p.text));
  }

  function draw(matches) {
    current = matches;
    cursor = 0;
    clear(list);
    matches.forEach((p, i) => {
      const b = h('button.say-hit', { type: 'button', class: i === 0 ? 'on' : '' },
        h('span', {}, p.text), h('em', {}, p.catName));
      b.addEventListener('pointerdown', ev => { ev.preventDefault(); cursor = i; highlight(); send(); });
      list.append(b);
    });
    setPicked(matches[0] || null);
  }

  function highlight() {
    $$('.say-hit', list).forEach((b, i) => b.classList.toggle('on', i === cursor));
    setPicked(current[cursor] || null);
  }

  function refresh() {
    const v = input.value.trim();
    draw(v ? match(v) : suggestions());
  }

  function send() {
    if (!picked) { A.ding(); return; }
    const text = picked.text;
    input.value = '';
    onSend(text);
    refresh();
    input.focus();
  }

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); send(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); cursor = Math.min(cursor + 1, current.length - 1); highlight(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); cursor = Math.max(cursor - 1, 0); highlight(); }
    if (ev.key === 'Escape' && !browser.hidden) { browser.hidden = true; }
  });
  sendBtn.addEventListener('click', send);

  /* ── the browser ───────────────────────────────────────────────────── */

  browseBtn.addEventListener('click', () => {
    A.click();
    browser.hidden = !browser.hidden;
    if (!browser.hidden && !browser.childElementCount) buildBrowser();
  });

  function buildBrowser() {
    const tabs = h('div.say-tabs');
    const body = h('div.say-cat.scroll');

    const show = cat => {
      $$('.say-tab', tabs).forEach(t => t.classList.toggle('on', t.dataset.cat === cat.id));
      clear(body);
      body.append(h('div.say-cat-hint', {}, cat.hint));
      for (const p of PHRASES.filter(x => x.cat === cat.id))
        body.append(h('button.say-pick', {
          type: 'button',
          onclick: () => { onSend(p.text); A.click(); input.focus(); },
        }, p.text));
    };

    for (const c of CATEGORIES) {
      const t = h('button.say-tab', { type: 'button', dataset: { cat: c.id } }, c.name);
      t.addEventListener('click', () => show(c));
      tabs.append(t);
    }

    browser.append(
      h('div.say-browser-head', {},
        h('b', {}, 'Phrase Book'),
        h('span', {}, PHRASE_COUNT + ' things you can say'),
        h('button.say-close', { type: 'button', onclick: () => { browser.hidden = true; } }, 'Close')),
      tabs, body);
    show(CATEGORIES[0]);
  }

  /* ── assembly ──────────────────────────────────────────────────────── */

  const el = h('div.say', {},
    browser,
    list,
    preview,
    h('div.say-row', {}, input, sendBtn, browseBtn));

  refresh();
  return { el, focus: () => input.focus(), refresh };
}
