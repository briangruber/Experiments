/*
 * Bakes the artwork and the voice clips.
 *
 *   node tools/gen-assets.mjs            everything
 *   node tools/gen-assets.mjs art        just the pictures
 *   node tools/gen-assets.mjs voice      just the announcer
 *
 * Generates with fal.ai, then squeezes hard and writes src/assets/*.js as
 * data URIs, so the prototype keeps working with no network, no key and no
 * second file to fetch. The generated modules are committed; this script
 * only needs running when the art should change.
 *
 * The audio is deliberately reduced to 11 kHz 8-bit mono. That is both
 * what a .wav on a 1997 machine actually was and, conveniently, about a
 * tenth of the bytes.
 *
 * Needs FAL_KEY.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, download } from './fal.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = join(root, 'tools/.assets-raw');
const out = join(root, 'src/assets');
mkdirSync(raw, { recursive: true });
mkdirSync(out, { recursive: true });

const IMG_MODEL = 'fal-ai/flux/schnell';
const TTS_MODEL = 'fal-ai/kokoro/american-english';

/* A house style, so sixteen separate generations still look like one set.
   Pushed hard away from photography: these were airbrush and gradient-mesh
   illustrations, not product shots. */
const STYLE =
  '1997 airbrushed illustration, glossy vector art, smooth gradient mesh, ' +
  'bright saturated colour, soft specular highlight, clip-art style, ' +
  'centred single object, plain flat background, NOT a photograph, ' +
  'no text, no letters, no words, no watermark, no border';

/* [key, subject, left colour, right colour] — the flat field the type sits
   on is composed here rather than generated, so the label always reads. */
const BANNERS = [
  ['today',      'a sunrise over a city skyline',        '#7d4a9e', '#c98fd0'],
  ['news',       'a satellite dish beside a globe',      '#0d1f52', '#41609e'],
  ['sports',     'a basketball',                         '#141414', '#5a5a5a'],
  ['computing',  'a beige desktop computer',             '#7a5a24', '#d8b26a'],
  ['research',   'an open book',                         '#2f3a5e', '#8f9cc0'],
  ['ent',        'a film reel',                          '#4a1f7a', '#b06ad0'],
  ['games',      'a video game controller',              '#a33a10', '#f0a070'],
  ['interests',  'a camera',                             '#0d4a72', '#6fb6de'],
  ['lifestyles', 'a coffee cup',                         '#4a4038', '#c8bcae'],
  ['shopping',   'a paper shopping bag',                 '#9e1a2a', '#e8707a'],
  ['health',     'a red apple',                          '#2d5a1a', '#9fcc6a'],
  ['families',   'a small house',                        '#5a5a30', '#c0c090'],
  ['kids',       'a paper aeroplane',                    '#16307a', '#5a8ae0'],
  ['local',      'a red kerbside mailbox',               '#4a4a44', '#a8a89c'],
  ['travel',     'a suitcase',                           '#8a6410', '#f0d070'],
  ['money',      'a stack of gold coins',                '#1a4a7a', '#7fb0d8'],
];

const SCENES = [
  ['marble', 96, 384,
   'macro photograph of swirled indigo and cobalt oil paint marbling, ' +
   'organic curling eddies and feathered veins, deep navy and bright ' +
   'cyan highlights, no straight lines, no bands, abstract, no text'],
  ['hero', 384, 128,
   'mid-1990s online service welcome banner, airbrushed collage of a ' +
   'telephone handset, a globe and drifting envelopes, warm blue and ' +
   'gold, soft lens flare, no text, no letters, no words'],
];

const VOICE = [
  ['welcome',  'Welcome!'],
  ['mail',     'Welcome!  You have mail!'],
  ['goodbye',  'Goodbye.'],
  ['gotmail',  'You have mail!'],
];

/* ── helpers ─────────────────────────────────────────────────────────── */

const py = script => execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();

/**
 * Builds one banner: a flat gradient field for the label, the generated
 * subject fading in on the right, then the whole thing quantised to an
 * 8-bit palette with dithering — which is what a banner on this service
 * would have been, and which also unifies sixteen separate generations.
 */
function packBanner(file, left, right) {
  return py(`
import base64, io
from PIL import Image, ImageDraw
W, H = 256, 64
def rgb(h): return tuple(int(h[i:i+2], 16) for i in (1, 3, 5))
a, b = rgb(${JSON.stringify(left)}), rgb(${JSON.stringify(right)})

base = Image.new('RGB', (W, H))
d = ImageDraw.Draw(base)
for x in range(W):
    t = x / (W - 1)
    d.line([(x, 0), (x, H)], fill=tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)))

art = Image.open(${JSON.stringify(file)}).convert('RGB')
side = min(art.size)
art = art.crop(((art.width - side) // 2, (art.height - side) // 2,
                (art.width + side) // 2, (art.height + side) // 2))

art = art.resize((H, H), Image.LANCZOS)

# Fade the subject in from the left so it sits on the field rather than
# looking pasted on top of it.
mask = Image.new('L', (H, H))
md = ImageDraw.Draw(mask)
for x in range(H):
    md.line([(x, 0), (x, H)], fill=int(255 * min(1.0, max(0.0, (x / H) * 2.4))))
base.paste(art, (W - H, 0), mask)

# Darken the left field so the white label always reads, without losing
# the channel's hue.
shade = Image.new('L', (W, H))
sd = ImageDraw.Draw(shade)
for x in range(W):
    t = min(1.0, x / (W * 0.62))
    sd.line([(x, 0), (x, H)], fill=int(255 * (0.70 + 0.30 * t)))
base = Image.composite(base, Image.new('RGB', (W, H), (0, 0, 0)), shade)

out = base.quantize(colors=64, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).convert('RGB')
buf = io.BytesIO()
out.save(buf, 'WEBP', quality=80, method=6)
print('data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode())
`);
}

/** Scene panels keep their full frame; same palette treatment. */
function packImage(file, w, h) {
  return py(`
import base64, io
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB').resize((${w}, ${h}), Image.LANCZOS)
im = im.quantize(colors=64, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).convert('RGB')
buf = io.BytesIO()
im.save(buf, 'WEBP', quality=80, method=6)
print('data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode())
`);
}

/**
 * Down to 11 kHz 8-bit mono, which is what a sound on this machine would
 * have been, and about a tenth of the bytes of the original.
 */
function packAudio(file) {
  return py(`
import base64, io, wave, audioop
src = wave.open(${JSON.stringify(file)}, 'rb')
n, w, rate = src.getnchannels(), src.getsampwidth(), src.getframerate()
data = src.readframes(src.getnframes())
src.close()
if n > 1: data = audioop.tomono(data, w, .5, .5)
if w != 2: data = audioop.lin2lin(data, w, 2); w = 2
# Normalise before the bit depth drops: 8-bit has no headroom to waste,
# and a quiet 8-bit sample is mostly quantisation hiss.
peak = audioop.max(data, w)
if peak: data = audioop.mul(data, w, min(8.0, 0.92 * 32767 / peak))
data, _ = audioop.ratecv(data, w, 1, rate, 11025, None)
data = audioop.bias(audioop.lin2lin(data, w, 1), 1, 128)
buf = io.BytesIO()
out = wave.open(buf, 'wb')
out.setnchannels(1); out.setsampwidth(1); out.setframerate(11025)
out.writeframes(data); out.close()
print('data:audio/wav;base64,' + base64.b64encode(buf.getvalue()).decode())
`);
}

const kb = s => (s.length / 1024).toFixed(0) + ' KB';

/* ── generation ──────────────────────────────────────────────────────── */

async function makeArt() {
  const entries = [];

  for (const [name, subject, left, right] of BANNERS) {
    const file = join(raw, 'banner-' + name + '.jpg');
    if (!existsSync(file)) {
      const r = await run(IMG_MODEL, {
        prompt: subject + ', ' + STYLE,
        image_size: { width: 384, height: 384 },
        num_images: 1, num_inference_steps: 4,
      });
      await download(r.images[0].url, file);
      process.stdout.write('.');
    }
    entries.push([name, packBanner(file, left, right)]);
  }

  for (const [name, w, h, prompt] of SCENES) {
    const file = join(raw, 'scene-' + name + '.jpg');
    if (!existsSync(file)) {
      const r = await run(IMG_MODEL, {
        prompt, image_size: { width: w * 2, height: h * 2 },
        num_images: 1, num_inference_steps: 4,
      });
      await download(r.images[0].url, file);
      process.stdout.write('.');
    }
    entries.push([name, packImage(file, w, h)]);
  }

  const body = entries.map(([k, v]) => '  ' + k + ": '" + v + "',").join('\n');
  writeFileSync(join(out, 'art.js'),
    '/* Generated by tools/gen-assets.mjs — do not edit by hand.\n' +
    '   Channel artwork and scene panels, baked in as data URIs so the\n' +
    '   prototype never fetches anything. */\n\n' +
    'export const ART = {\n' + body + '\n};\n');
  console.log('\nart.js  ' + entries.length + ' images, ' +
    kb(readFileSync(join(out, 'art.js'), 'utf8')));
}

async function makeVoice() {
  const entries = [];
  for (const [name, text] of VOICE) {
    const file = join(raw, 'voice-' + name + '.wav');
    if (!existsSync(file)) {
      const r = await run(TTS_MODEL, { prompt: text, voice: 'am_michael', speed: 0.95 });
      await download(r.audio.url, file);
      process.stdout.write('.');
    }
    entries.push([name, packAudio(file)]);
  }
  const body = entries.map(([k, v]) => '  ' + k + ": '" + v + "',").join('\n');
  writeFileSync(join(out, 'voice.js'),
    '/* Generated by tools/gen-assets.mjs — do not edit by hand.\n' +
    '   The service announcer, reduced to 11 kHz 8-bit mono, which is what\n' +
    '   a .wav on a machine of this vintage actually was. */\n\n' +
    'export const VOICE = {\n' + body + '\n};\n');
  console.log('\nvoice.js  ' + entries.length + ' clips, ' +
    kb(readFileSync(join(out, 'voice.js'), 'utf8')));
}

const what = process.argv[2] || 'all';
if (what === 'all' || what === 'art') await makeArt();
if (what === 'all' || what === 'voice') await makeVoice();
