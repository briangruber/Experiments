/*
 * The pieces every Reverie screen is made of.
 *
 * The graphical services were visually repetitive on purpose: a picture in
 * a mounted frame, a portrait with a yellow plate under the chin, and a row
 * of chunky buttons along the bottom. Once you had seen one screen you
 * could operate all of them. Keeping those three things in one file is the
 * cheapest way to make sure the four games and the four screens agree.
 */

import { h, clear } from '../../core/dom.js';
import { faceSvg } from './faces.js';

/** A picture in a mount. `pic` is either an element or a background URL. */
export function frame(pic, cls) {
  const inner = typeof pic === 'string'
    ? h('div.rev-pic', { class: cls || '', style: { backgroundImage: 'url(' + pic + ')' } })
    : pic;
  return h('div.rev-frame', {}, inner);
}

/** Somebody, framed, with their name on a plate under them. */
export function portrait(face, name, opts = {}) {
  const { size = 64, cls = '', real = false, title = '' } = opts;
  return h('div.rev-port', { class: cls, title },
    real ? h('i.rev-real', { title: 'Another person, really here' }) : null,
    h('div.rev-frame', {}, faceSvg(face, size)),
    name ? h('span.rev-plate', {}, name) : null);
}

/** A button for the bottom bar. */
export function btn(label, onclick, opts = {}) {
  return h('button.rev-btn', {
    type: 'button', class: opts.cls || '', disabled: !!opts.off, onclick,
  }, label);
}

/**
 * The suit all four games wear: title strip, a middle row of side panel and
 * playing area, and a button bar. Returns the parts worth keeping.
 */
export function shell(stage, opts) {
  const { ground = 'pur', title, art, backLabel, onBack,
          side = [], middle, buttons = [], note } = opts;
  const bar = h('div.rev-bar', {},
    onBack ? h('button.rev-back', { type: 'button', onclick: onBack }, '◀ ' + backLabel) : null,
    ...buttons,
    h('span.spacer'),
    note ? h('span.rev-note', {}, note) : null);

  const root = h('div.gm.rev-ground', { class: ground },
    h('div.rev-top', {}, h('b', {}, title)),
    art ? h('div.gm-art', {}, frame(art)) : null,
    h('div.gm-main', {},
      h('div.gm-side', {}, ...side),
      h('div.gm-stage', {}, middle)),
    bar);

  clear(stage).append(root);
  return { root, bar, note: bar.querySelector('.rev-note') };
}
