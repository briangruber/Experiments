/*
 * ANSI art, the way the doors did it.
 *
 * Three tools, which between them are most of what a 1993 title screen
 * actually was:
 *
 *   bigText  chunky block capitals, lit from above
 *   pixels   half-block pictures — two rows of colour per character cell,
 *            which is the trick the whole art form is built on
 *   rule     shaded dividers out of the four block densities
 *
 * The half-block trick: a cell holds ▀ with a foreground and a background,
 * so one character shows two stacked pixels and the screen is effectively
 * 80x50 rather than 80x25. The catch is that backgrounds only go up to
 * seven — bright backgrounds were the blink attribute — so a bright colour
 * underneath a different bright colour has to fall back to its dark twin.
 * Artists worked around exactly this, and so does the art in here.
 */

/* 5 wide, 5 tall, on-pixels marked with #. Four wide was a character
   short: W, M and X all came out as the same blob. */
const GLYPHS = {
  A: '.###.|#...#|#####|#...#|#...#', B: '####.|#...#|####.|#...#|####.',
  C: '.####|#....|#....|#....|.####', D: '####.|#...#|#...#|#...#|####.',
  E: '#####|#....|####.|#....|#####', F: '#####|#....|####.|#....|#....',
  G: '.####|#....|#..##|#...#|.####', H: '#...#|#...#|#####|#...#|#...#',
  I: '#####|..#..|..#..|..#..|#####', J: '....#|....#|....#|#...#|.###.',
  K: '#...#|#..#.|###..|#..#.|#...#', L: '#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#',
  O: '.###.|#...#|#...#|#...#|.###.', P: '####.|#...#|####.|#....|#....',
  Q: '.###.|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|####.|#..#.|#...#',
  S: '.####|#....|.###.|....#|####.', T: '#####|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#.#.#|##.##|#...#', X: '#...#|.#.#.|..#..|.#.#.|#...#',
  Y: '#...#|.#.#.|..#..|..#..|..#..', Z: '#####|...#.|..#..|.#...|#####',
  0: '.###.|#..##|#.#.#|##..#|.###.', 1: '..#..|.##..|..#..|..#..|.###.',
  2: '####.|....#|.###.|#....|#####', 3: '####.|....#|.###.|....#|####.',
  4: '#...#|#...#|#####|....#|....#', 5: '#####|#....|####.|....#|####.',
  6: '.###.|#....|####.|#...#|.###.', 7: '#####|....#|...#.|..#..|..#..',
  8: '.###.|#...#|.###.|#...#|.###.', 9: '.###.|#...#|.####|....#|.###.',
  ' ': '.....|.....|.....|.....|.....', '.': '.....|.....|.....|.....|..#..',
  '!': '..#..|..#..|..#..|.....|..#..', '-': '.....|.....|#####|.....|.....',
  "'": '..#..|..#..|.....|.....|.....', ':': '.....|..#..|.....|..#..|.....',
};

const two = n => String(n).padStart(2, '0');

/**
 * Block capitals. The last row goes a shade darker, which is the cheapest
 * way to make flat blocks look lit from above.
 * @returns {string} five pipe-coded lines, newline-terminated
 */
export function bigText(text, { fg = 12, shade = 4, indent = 1 } = {}) {
  const chars = [...String(text).toUpperCase()].map(c => (GLYPHS[c] || GLYPHS[' ']).split('|'));
  const out = [];
  for (let r = 0; r < 5; r++) {
    let line = '|' + two(r < 4 ? fg : shade) + ' '.repeat(indent);
    for (const g of chars) line += g[r].replace(/#/g, '█').replace(/\./g, ' ') + ' ';
    out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n') + '\n';
}

/**
 * A picture. Each row is one line of pixels written as 16-colour hex
 * digits; a dot or a space is the background and drops through.
 * Two picture rows make one text row.
 */
export function pixels(rows, { indent = 0 } = {}) {
  const px = rows.map(r => [...r]);
  const wide = Math.max(...px.map(r => r.length));
  const val = ch => (ch === '.' || ch === ' ' || ch === undefined) ? -1 : parseInt(ch, 16);
  const out = [];

  for (let y = 0; y < px.length; y += 2) {
    let line = ' '.repeat(indent);
    let fg = null, bg = null;
    const put = (f, b, ch) => {
      if (f !== fg) { line += '|' + two(f); fg = f; }
      if (b !== bg) { line += '|b' + b; bg = b; }
      line += ch;
    };
    for (let x = 0; x < wide; x++) {
      const t = val(px[y][x]), b = val((px[y + 1] || [])[x]);
      if (t < 0 && b < 0) { put(fg == null ? 7 : fg, 0, ' '); continue; }
      if (t === b) { put(t, 0, '█'); continue; }
      if (b < 0) { put(t, 0, '▀'); continue; }
      if (t < 0) { put(b, 0, '▄'); continue; }
      // Both set. Backgrounds stop at seven, so the lower pixel loses its
      // brightness rather than the picture losing the pixel.
      if (b < 8) put(t, b, '▀');
      else if (t < 8) put(b, t, '▄');
      else put(t, b - 8, '▀');
    }
    out.push(line.replace(/\s+$/, '') + '|b0');
  }
  return out.join('\n') + '\n';
}

/** The same picture, centred in the terminal. */
export function picture(rows, { cols = 80 } = {}) {
  const wide = Math.max(...rows.map(r => r.length));
  return pixels(rows, { indent: Math.max(0, Math.floor((cols - wide) / 2)) });
}

/* The four densities, which is the whole ANSI gradient vocabulary. */
export const SHADES = ['░', '▒', '▓', '█'];

/** A divider. `fade` runs light-to-solid-to-light across the width. */
export function rule(width = 78, { fg = 8, fade = false, ch = '▄' } = {}) {
  if (!fade) return '|' + two(fg) + ch.repeat(width) + '\n';
  let out = '';
  for (let i = 0; i < width; i++) {
    const d = 1 - Math.abs(i / (width - 1) - 0.5) * 2;
    out += SHADES[Math.min(3, Math.floor(d * 4))];
  }
  return '|' + two(fg) + out + '\n';
}

/**
 * A box with a shadow under it, which is what a door menu looked like once
 * the sysop had discovered TheDraw.
 */
export function shadowBox(rows, { width = 60, edge = 9, fill = 1, text = 15, indent = 2 } = {}) {
  const pad = ' '.repeat(indent);
  const inner = width - 2;
  const bar = (l, r) => pad + '|' + two(edge) + '|b' + (fill % 8) + l + '═'.repeat(inner) + r + '|b0';
  const out = [bar('╔', '╗') + ' \n'];
  for (const r of rows) {
    const body = r === '-'
      ? '|' + two(edge) + '╠' + '═'.repeat(inner) + '╣'
      : '|' + two(edge) + '║|' + two(text) + fit(r, inner) + '|' + two(edge) + '║';
    out.push(pad + '|b' + (fill % 8) + body + '|b0|08░\n');
  }
  out.push(bar('╚', '╝') + '|08░\n' + pad + ' |08' + '░'.repeat(inner + 2) + '|07\n');
  return out.join('');
}

/** Pads (or clips) pipe-coded text to a visible width. */
function fit(text, n) {
  const plain = text.replace(/\|\|/g, '\x01').replace(/\|(?:b\d|\d\d)/g, '').replace(/\x01/g, '|');
  return text + ' '.repeat(Math.max(0, n - plain.length));
}

/**
 * A meter in the block characters rather than in equals signs, which is
 * the single change that makes a status line look like a door and not
 * like a spreadsheet.
 */
export function meter(n, max, width = 20, { on = 10, off = 8 } = {}) {
  const lit = Math.max(0, Math.min(width, Math.round((n / Math.max(1, max)) * width)));
  return '|' + two(on) + '█'.repeat(lit) + '|' + two(off) + '░'.repeat(width - lit) + '|07';
}
