/* Halcyon's wordmark, in the idiom of the period: a geometric badge, the
   name letterspaced in caps beneath it, and "Online" in a script face.
   The mark is a rounded diamond with a wave through it — deliberately not
   a triangle with a circle in it, which belonged to somebody. */

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';

export function wordmark(size = 1, { row = false } = {}) {
  const s = v => (v * size).toFixed(1) + 'px';
  const badge = icon('halcyonMark', 74 * size);
  badge.classList.remove('glyph');
  return h('div.hal-mark', { class: row ? 'row' : '' },
    h('div.hal-mark-badge', { style: { width: s(74), height: s(74) } }, badge),
    h('div.hal-mark-words', {},
      h('div.hal-mark-name', { style: { fontSize: s(15) } }, 'HALCYON'),
      h('div.hal-mark-online', { style: { fontSize: s(30) } }, 'Online')));
}
