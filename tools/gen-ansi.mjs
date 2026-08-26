/*
 * Bakes the pictures for the BBS doors, as ANSI half-block art.
 *
 *   node tools/gen-ansi.mjs
 *
 * Generates each subject with fal.ai, knocks it down to the size the
 * terminal can show it at, and quantises it to the CGA sixteen — which is
 * the entire palette an ANSI screen had. The result is written to
 * src/apps/bbs/art.js as rows of hex digits; src/apps/bbs/ansi.js turns
 * two picture rows into one character cell with ▀.
 *
 * That is close to how a lot of BBS artists actually worked once scanners
 * were cheap: trace something down to sixteen colours and clean it up by
 * hand. The generated module is committed, so nobody else needs a key.
 *
 * Needs FAL_KEY.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, download } from './fal.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = join(root, 'tools/.assets-raw');
mkdirSync(raw, { recursive: true });

const IMG_MODEL = 'fal-ai/flux/schnell';

/* Sixteen colours and a hard black key. Everything is drawn on black
   because black is what the terminal already is. */
const STYLE =
  'bright flat cartoon game art, thick black outlines, strong saturated ' +
  'colours, evenly lit with no dark shadows, subject fills the frame, on a ' +
  'plain solid pure black background, no text, no letters, no watermark, ' +
  'no border, no frame';

/* [key, cols, rows(pixels), prompt]. Rows must be even: two make one cell. */
const ART = [
  ['wyrm', 42, 26,
   'the head of a bright scarlet cartoon dragon seen from the side facing ' +
   'left and filling the whole picture, mouth open wide with white fangs, ' +
   'one large yellow eye with a slit pupil, two curved horns swept back, ' +
   STYLE],
  ['village', 76, 16,
   'a wide cartoon row of medieval village cottages with red roofs and ' +
   'yellow lit windows, a stone bridge, a green tree, ' + STYLE],
  ['forest', 76, 16,
   'a wide cartoon row of bright green pine trees and one bare brown ' +
   'trunk, a path between them, ' + STYLE],
  ['beast', 40, 26,
   'a cartoon grey wolf head facing the viewer, snarling, yellow eyes, ' +
   'bared white teeth, pink tongue, ' + STYLE],
  ['brute', 40, 26,
   'a big dark green cartoon troll seen from the chest up and filling the ' +
   'picture, thick green skin, small angry eyes, a heavy brow, one white ' +
   'tusk sticking up from the jaw, bare shoulders, ' + STYLE],
  ['knight', 40, 26,
   'a cartoon knight in shining silver plate armour from the chest up, ' +
   'visor down, blue plume on the helmet, ' + STYLE],
  ['ship', 42, 26,
   'a chunky cartoon cargo spaceship in three-quarter view, light grey ' +
   'hull with orange stripes and bright yellow windows, cyan engine ' +
   'flames, ' + STYLE],
  ['port', 76, 16,
   'a wide cartoon ringed space station in grey and orange above the ' +
   'bright blue curve of a planet, yellow lights along the ring, ' + STYLE],
  ['carnival', 76, 16,
   'a wide cartoon fairground: a ferris wheel, a red and white striped ' +
   'big top tent and coloured bunting, ' + STYLE],
];

const round16 = n => Math.max(256, Math.round(n / 16) * 16);

const py = script => execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();

/** Downsample, quantise to the CGA sixteen, and return rows of hex digits. */
function trace(file, cols, rows) {
  return py(`
from PIL import Image, ImageOps, ImageEnhance
CGA = [(0,0,0),(0,0,170),(0,170,0),(0,170,170),(170,0,0),(170,0,170),(170,85,0),(170,170,170),
       (85,85,85),(85,85,255),(85,255,85),(85,255,255),(255,85,85),(255,85,255),(255,255,85),(255,255,255)]
im = Image.open(${JSON.stringify(file)}).convert('RGB').resize((${cols}, ${rows}), Image.LANCZOS)

# What is inside the subject is decided before the palette gets involved:
# quantising first throws every mid-tone at black, and then the keying
# eats the middle of the picture along with the background.
lum = im.convert('L')
mask = lum.point(lambda v: 255 if v > 34 else 0).load()

# Sixteen colours is not many. Spending them all is the difference between
# a picture and a smudge — but stretch the channels separately and a green
# forest comes out grey, because the red and blue get stretched to match.
try:
    im = ImageOps.autocontrast(im, cutoff=1, preserve_tone=True)
except TypeError:
    im = ImageOps.autocontrast(im, cutoff=1)
im = ImageEnhance.Color(im).enhance(1.45)
px = im.load()

out = []
for y in range(${rows}):
    line = ''
    for x in range(${cols}):
        if not mask[x, y]:
            line += '.'
            continue
        r, g, b = px[x, y]
        i = min(range(16), key=lambda k: (CGA[k][0]-r)**2 + (CGA[k][1]-g)**2 + (CGA[k][2]-b)**2)
        # Inside the subject, black is an outline, not a hole.
        line += '0123456789abcdef'[8 if i == 0 else i]
    out.append(line)

# Nearest-colour in a sixteen-colour space turns JPEG noise into confetti.
# A pixel that agrees with almost none of its neighbours is noise, so it
# joins the majority around it.
grid = [list(r) for r in out]
clean = [r[:] for r in grid]
for y in range(${rows}):
    for x in range(${cols}):
        here = grid[y][x]
        if here == '.':
            continue
        tally = {}
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == dy == 0:
                    continue
                yy, xx = y + dy, x + dx
                if 0 <= yy < ${rows} and 0 <= xx < ${cols}:
                    n = grid[yy][xx]
                    if n != '.':
                        tally[n] = tally.get(n, 0) + 1
        if not tally:
            continue
        best = max(tally, key=tally.get)
        if tally.get(here, 0) <= 1 and tally[best] >= 5:
            clean[y][x] = best
print('\\n'.join(''.join(r) for r in clean))
`).split('\n');
}

const entries = [];
for (const [name, cols, rows, prompt] of ART) {
  const file = join(raw, 'ansi-' + name + '.jpg');
  if (!existsSync(file)) {
    /* The generated frame has to have the same shape as the grid it is
       going into. Ask for a wide picture of a wolf's head and the wolf
       arrives centred in a letterbox, using a third of the columns. */
    const r = await run(IMG_MODEL, {
      prompt,
      image_size: { width: round16(cols * 16), height: round16(rows * 16) },
      num_images: 1, num_inference_steps: 4,
    });
    await download(r.images[0].url, file);
    process.stdout.write('.');
  }
  entries.push([name, trace(file, cols, rows)]);
}

const body = entries.map(([k, rows]) =>
  '  ' + k + ': [\n' + rows.map(r => "    '" + r + "',").join('\n') + '\n  ],').join('\n');

writeFileSync(join(root, 'src/apps/bbs/art.js'),
  '/* Generated by tools/gen-ansi.mjs — do not edit by hand.\n' +
  '   Each row is one line of pixels in the CGA sixteen, written as hex\n' +
  '   digits; a dot is the background. Two rows make one character cell.\n' +
  '   Render with pixels() from ./ansi.js. */\n\n' +
  'export const PIC = {\n' + body + '\n};\n');

console.log('\nart.js  ' + entries.length + ' pictures, ' +
  entries.reduce((n, [, r]) => n + r.length * r[0].length, 0) + ' pixels');
