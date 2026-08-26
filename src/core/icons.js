/* Hand-drawn 32×32 and 16×16 icons, as inline SVG on a 32-unit grid.
   Chunky on purpose: flat fills, one-unit black outline, a white top-left
   highlight and a grey bottom-right shade — the way a 256-colour icon
   editor made you draw. */

import { svg } from './dom.js';

const V = (...kids) => svg('svg', { viewBox: '0 0 32 32', 'shape-rendering': 'crispEdges' }, kids);
const R = (x, y, w, h, fill, extra = {}) => svg('rect', { x, y, width: w, height: h, fill, ...extra });
const P = (d, fill, extra = {}) => svg('path', { d, fill, ...extra });
const L = (d, stroke, w = 1) => svg('path', { d, stroke, 'stroke-width': w, fill: 'none' });

/* Shared pieces ------------------------------------------------------- */

const beige = '#d6d3c4', beigeD = '#8f8b7c', screenBlue = '#1a3f8f';

function monitor(scr) {
  return [
    P('M3 5h26v18H3z', '#2b2b2b'),
    R(4, 6, 24, 16, '#000'),
    scr,
    P('M12 23h8v3h-8z', beigeD),
    P('M8 26h16v3H8z', beige),
    P('M8 26h16v1H8z', '#f2efe2'),
  ];
}

/* The set -------------------------------------------------------------- */

export const ICONS = {

  computer: () => V(monitor([
    R(5, 7, 22, 14, screenBlue),
    R(6, 8, 20, 3, '#4a7fd4'),
    R(7, 13, 12, 1, '#9fc0f0'), R(7, 15, 16, 1, '#9fc0f0'), R(7, 17, 9, 1, '#9fc0f0'),
  ])),

  halcyon: () => V([
    // A rounded blue tile with a stylised messenger running out of it.
    P('M4 3h24a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z', '#1b4fb0'),
    P('M4 3h24a3 3 0 0 1 3 3v4H1V6a3 3 0 0 1 3-3z', '#3a7de0'),
    P('M13 8l-3 7h4l-2 9 9-11h-5l3-5z', '#ffd23a'),          // lightning courier
    P('M13 8l-3 7h4l-2 9 9-11h-5l3-5z', 'none',
      { stroke: '#a97b00', 'stroke-width': .75 }),
  ]),

  browser: () => V([
    P('M16 2a14 14 0 1 0 0 28 14 14 0 0 0 0-28z', '#0b2f6b'),
    P('M16 4a12 12 0 1 0 0 24 12 12 0 0 0 0-24z', '#2f7fd8'),
    L('M4 16h24M16 4c-4 4-4 20 0 24M16 4c4 4 4 20 0 24M6.5 9h19M6.5 23h19', '#cfe6ff', 1),
    P('M9 21l14-11-5 13-2-5z', '#ffe066'),                     // the comet cursor
    P('M9 21l14-11-5 13-2-5z', 'none', { stroke: '#8a6d00', 'stroke-width': .7 }),
  ]),

  mail: () => V([
    P('M2 8h28v17H2z', '#f4f1e4'), P('M2 8h28v17H2z', 'none', { stroke: '#5c5646' }),
    P('M2 8l14 10L30 8', 'none', { stroke: '#5c5646', 'stroke-width': 1.4 }),
    P('M2 25l10-8 4 3 4-3 10 8z', '#e7e3d2'),
    R(22, 3, 8, 6, '#d63a3a'), R(23, 4, 6, 4, '#ff6b6b'),
  ]),

  chat: () => V([
    P('M2 5h20v14H10l-6 5v-5H2z', '#fff'),
    P('M2 5h20v14H10l-6 5v-5H2z', 'none', { stroke: '#333' }),
    R(5, 9, 13, 1.6, '#7a7a7a'), R(5, 12.5, 10, 1.6, '#7a7a7a'),
    P('M12 12h18v12h-6l-4 4v-4h-8z', '#ffe9a8'),
    P('M12 12h18v12h-6l-4 4v-4h-8z', 'none', { stroke: '#8a6d00' }),
    R(15, 16, 12, 1.6, '#8a6d00'), R(15, 19.5, 8, 1.6, '#8a6d00'),
  ]),

  people: () => V([
    P('M11 16a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', '#f0c49a'),
    P('M2 29c0-6 4-9 9-9s9 3 9 9z', '#3a6ea5'),
    P('M22 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', '#e0b184'),
    P('M15 29c0-5 3-8 7-8s8 3 8 8z', '#2c5580'),
  ]),

  folder: () => V([
    P('M2 7h11l3 3h14v18H2z', '#e8b93c'),
    P('M2 10h28v18H2z', '#ffd35c'),
    P('M2 7h11l3 3h14v18H2z', 'none', { stroke: '#8a6a12' }),
  ]),

  doc: () => V([
    P('M6 2h14l6 6v22H6z', '#fff'), P('M6 2h14l6 6v22H6z', 'none', { stroke: '#666' }),
    P('M20 2l6 6h-6z', '#c9c9c9'),
    R(9, 12, 14, 1.4, '#8a8a8a'), R(9, 16, 14, 1.4, '#8a8a8a'),
    R(9, 20, 14, 1.4, '#8a8a8a'), R(9, 24, 8, 1.4, '#8a8a8a'),
  ]),

  paint: () => V([
    P('M4 20c0-9 6-16 14-16s11 5 11 10c0 4-3 5-6 5h-3c-2 0-3 1-3 3s1 2 1 4-2 3-4 3c-6 0-10-4-10-9z', '#f5f2e6'),
    P('M4 20c0-9 6-16 14-16s11 5 11 10c0 4-3 5-6 5h-3c-2 0-3 1-3 3s1 2 1 4-2 3-4 3c-6 0-10-4-10-9z', 'none', { stroke: '#5c5646' }),
    svg('circle', { cx: 10, cy: 13, r: 2.2, fill: '#e33' }),
    svg('circle', { cx: 15, cy: 8, r: 2.2, fill: '#39d' }),
    svg('circle', { cx: 21, cy: 10, r: 2.2, fill: '#3c3' }),
    svg('circle', { cx: 23, cy: 16, r: 2.2, fill: '#fd0' }),
  ]),

  game: () => V([
    P('M3 11h26v14H3z', '#8f8f9f'), P('M3 11h26v14H3z', 'none', { stroke: '#333' }),
    R(5, 13, 22, 10, '#c8c8d8'),
    ...[0, 1, 2, 3, 4].flatMap(i => [0, 1].map(j =>
      R(6 + i * 4.2, 14 + j * 4.2, 3.6, 3.6, (i + j) % 2 ? '#b0b0c0' : '#dcdce8'))),
    P('M13 16.5l2.5 4h-5z', '#111'), R(14.2, 20, 1.2, 2, '#111'),
    R(9, 6, 14, 5, '#5a5a6a'), R(10, 7, 12, 3, '#7d7d90'),
  ]),

  media: () => V([
    P('M3 6h26v20H3z', '#4a4a55'), P('M3 6h26v20H3z', 'none', { stroke: '#111' }),
    svg('circle', { cx: 16, cy: 16, r: 8.5, fill: '#c9ccd6' }),
    svg('circle', { cx: 16, cy: 16, r: 8.5, fill: 'none', stroke: '#5a5a66' }),
    svg('circle', { cx: 16, cy: 16, r: 2.6, fill: '#4a4a55' }),
    P('M11 10a9 9 0 0 1 10 2', 'none', { stroke: '#fff', 'stroke-width': 1.2 }),
  ]),

  defrag: () => V([
    R(2, 4, 28, 24, '#1c1c1c'), R(3, 5, 26, 22, '#0a0a0a'),
    ...Array.from({ length: 36 }, (_, i) => {
      const c = ['#3ad14a', '#3ad14a', '#d1c33a', '#d13a3a', '#2b2b2b'][i % 5];
      return R(4 + (i % 9) * 2.8, 6 + ((i / 9) | 0) * 5, 2.2, 4, c);
    }),
  ]),

  trash: () => V([
    P('M8 9h16l-1.5 20h-13z', '#b9bcc4'),
    P('M8 9h16l-1.5 20h-13z', 'none', { stroke: '#4a4d55' }),
    L('M13 13v13M16 13v13M19 13v13', '#7a7d85', 1.4),
    P('M6 6h20v3H6z', '#9ca0a8'), P('M6 6h20v3H6z', 'none', { stroke: '#4a4d55' }),
    P('M13 3h6v3h-6z', '#9ca0a8'),
  ]),

  cd: () => V([
    svg('circle', { cx: 16, cy: 16, r: 14, fill: '#dfe4ee' }),
    svg('circle', { cx: 16, cy: 16, r: 14, fill: 'none', stroke: '#8b90a0' }),
    svg('circle', { cx: 16, cy: 16, r: 10, fill: 'none', stroke: '#b7bccb', 'stroke-width': 3 }),
    svg('circle', { cx: 16, cy: 16, r: 4, fill: '#f5f7fb' }),
    svg('circle', { cx: 16, cy: 16, r: 1.7, fill: '#8b90a0' }),
    P('M16 2a14 14 0 0 1 12 7l-4 2A9 9 0 0 0 16 6z', '#a8c8ff', { opacity: .8 }),
  ]),

  floppy: () => V([
    P('M3 3h26v26H3z', '#2f3540'), P('M3 3h26v26H3z', 'none', { stroke: '#11141a' }),
    R(9, 3, 14, 11, '#c9ccd4'), R(12, 4, 6, 8, '#4a505c'),
    R(7, 18, 18, 11, '#e2e5ea'), R(9, 20, 10, 1.4, '#8b909a'), R(9, 23, 12, 1.4, '#8b909a'),
  ]),

  phone: () => V([
    P('M7 4h18v24H7z', '#3b4250'), P('M7 4h18v24H7z', 'none', { stroke: '#11141a' }),
    R(9, 6, 14, 6, '#7fd97f'),
    ...Array.from({ length: 12 }, (_, i) =>
      R(9.5 + (i % 3) * 4.5, 14 + ((i / 3) | 0) * 3.4, 3.6, 2.6, '#c3c8d2')),
  ]),

  help: () => V([
    svg('circle', { cx: 16, cy: 16, r: 13, fill: '#ffd84d' }),
    svg('circle', { cx: 16, cy: 16, r: 13, fill: 'none', stroke: '#9a7a00' }),
    svg('text', {
      x: 16, y: 24, 'text-anchor': 'middle', 'font-size': 20,
      'font-family': 'Tahoma, sans-serif', 'font-weight': 'bold', fill: '#4a3a00',
    }, '?'),
  ]),

  warn: () => V([
    P('M16 2l15 27H1z', '#ffd84d'), P('M16 2l15 27H1z', 'none', { stroke: '#7a5f00', 'stroke-width': 1.2 }),
    R(14.4, 11, 3.2, 10, '#3a2d00'), R(14.4, 23, 3.2, 3.2, '#3a2d00'),
  ]),

  info: () => V([
    svg('circle', { cx: 16, cy: 16, r: 13, fill: '#3a7de0' }),
    svg('circle', { cx: 16, cy: 16, r: 13, fill: 'none', stroke: '#123a78' }),
    R(14.4, 13, 3.2, 10, '#fff'), R(14.4, 8, 3.2, 3.2, '#fff'),
  ]),

  error: () => V([
    svg('circle', { cx: 16, cy: 16, r: 13, fill: '#d63a3a' }),
    svg('circle', { cx: 16, cy: 16, r: 13, fill: 'none', stroke: '#7a1414' }),
    L('M10 10l12 12M22 10L10 22', '#fff', 3.2),
  ]),

  clip: () => V([
    L('M20 8v13a5 5 0 0 1-10 0V7a3 3 0 0 1 6 0v13a1.5 1.5 0 0 1-3 0V9',
      '#b8bcc6', 3),
    L('M20 8v13a5 5 0 0 1-10 0V7a3 3 0 0 1 6 0v13a1.5 1.5 0 0 1-3 0V9',
      '#8a8f99', 1),
  ]),

  globe: () => V([
    svg('circle', { cx: 16, cy: 16, r: 13, fill: '#2f7fd8' }),
    P('M6 12c4 2 7 1 10 3s6 1 9-1M6 21c5-1 6 2 10 1s5 3 8 1', 'none',
      { stroke: '#8ed08e', 'stroke-width': 2.6, 'stroke-linecap': 'round' }),
    svg('circle', { cx: 16, cy: 16, r: 13, fill: 'none', stroke: '#123a78' }),
  ]),

  net: () => V([
    R(2, 18, 12, 9, '#c9ccd4'), R(3, 19, 10, 6, screenBlue),
    R(18, 18, 12, 9, '#c9ccd4'), R(19, 19, 10, 6, screenBlue),
    R(10, 4, 12, 9, '#c9ccd4'), R(11, 5, 10, 6, screenBlue),
    L('M16 13v6M8 19v-3h16v3', '#4a4d55', 1.4),
  ]),
};

/** 32×32 desktop-size icon element. */
export function icon(name, size = 32) {
  const make = ICONS[name] || ICONS.doc;
  const el = make();
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.classList.add('glyph');
  return el;
}
