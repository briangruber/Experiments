/* Kip.
   He is a paperclip. He would like to help. He cannot help. */

import { h, clear, pick, chance, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as A from '../core/audio.js';

const TIPS = [
  'It looks like you are writing a letter. Would you like help with that?',
  'It looks like you are waiting for something to download. Would you like a tip?',
  'Did you know you can press Enter to send a message? You did know that.',
  'It looks like you are talking to a stranger. Remember not to give out your address.',
  'You have been on the internet for a while. Somebody may be trying to call.',
  'It looks like you are trying to think. Would you like me to keep talking?',
  'Tip: hold down Shift while double-clicking for no reason at all.',
  'It looks like you are having a nice time. Would you like me to interrupt?',
];

let el = null, hideTimer = null, idleTimer = null;

export function initAssistant() {
  idleTimer = setInterval(() => {
    if (el || !$('#desktop') || $('#desktop').hidden) return;
    if (chance(0.12)) show(pick(TIPS));
  }, 45000);
}

export function show(text) {
  hide();
  const clip = icon('clip', 40);
  clip.classList.remove('glyph');

  el = h('div.kip', {},
    h('div.kip-bubble', {},
      h('div.kip-text', {}, text),
      h('div.kip-btns', {},
        h('button.btn.small', { type: 'button', onclick: () => hide() }, 'No thanks'),
        h('button.btn.small', {
          type: 'button',
          onclick: () => { clear(el.querySelector('.kip-text')).append(pick(TIPS)); A.beep(); },
        }, 'Tell me more'))),
    h('div.kip-body', { title: 'Kip', onclick: () => hide() }, clip));

  $('#desktop').append(el);
  A.beep();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, 26000);
}

export function hide() {
  clearTimeout(hideTimer);
  if (el) { el.remove(); el = null; }
}

export function stopAssistant() {
  clearInterval(idleTimer);
  hide();
}
