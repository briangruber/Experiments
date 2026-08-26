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

/* Playwright ships an encode-only ffmpeg that cannot decode H.264, which
   is what the video model returns. imageio-ffmpeg carries a full build. */
const FFMPEG = (() => {
  try {
    return execFileSync('python3',
      ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8' }).trim();
  } catch {
    return 'ffmpeg';       // fall back to whatever is on PATH
  }
})();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = join(root, 'tools/.assets-raw');
const out = join(root, 'src/assets');
mkdirSync(raw, { recursive: true });
mkdirSync(out, { recursive: true });

const IMG_MODEL = 'fal-ai/flux/schnell';
const TTS_MODEL = 'fal-ai/kokoro/american-english';
const VID_MODEL = 'fal-ai/ltx-video';

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

/* The Reverie Network — the graphical world inside the service.
 *
 * The reference here is the cartoon-VGA look of the graphical services:
 * hand-painted, flat saturated colour, heavy outlines, an overhead
 * three-quarter view of a town rather than anything photographic. The
 * packer then knocks these down to 32 colours with dithering, which is
 * what a 256-colour screen shared between a backdrop and everything else
 * actually looked like.
 */
const REVERIE_STYLE =
  'early 1990s VGA adventure game background art, hand-painted cartoon, ' +
  'flat saturated colour, bold dark outlines, bright storybook palette, ' +
  'cheerful, simple shapes, NOT photographic, NOT realistic, ' +
  'no text, no letters, no words, no watermark';

const REVERIE = [
  /* The map screen, in the shape the graphical services actually used:
     a painted landscape you look across rather than a plan you look down
     on, with the buildings far enough apart to hang a sign on each. The
     signs are drawn by us — asking the model for lettering produces
     confident gibberish every time, hence 'no text' twice. */
  ['rev-town', 400, 240,
   'a busy bright cartoon landscape packed corner to corner with things to ' +
   'look at, seen from a low hill, buildings large and close to the viewer ' +
   'with winding dirt paths between them and no empty grass: a stone castle ' +
   'with pennants top left, a round open-air amphitheatre top centre, a big ' +
   'red-roofed clubhouse with a porch in the middle, a timber inn with a ' +
   'chimney, a little post office, a shop with a striped awning, a ' +
   'fairground with a red and white big top and a ferris wheel on the ' +
   'right, a grass airstrip with a red biplane bottom right, a blue lake ' +
   'with a fountain bottom left, leafy trees, hedges and flower beds ' +
   'filling every gap, blue sky with fat white clouds and a small airship, ' +
   'edge to edge composition, no text, no letters, no signs, no writing, ' +
   REVERIE_STYLE],
  ['rev-fountain', 256, 128,
   'a sunny cobbled town square with a round stone fountain splashing in ' +
   'the middle, flower beds, a bench and shop fronts behind, ' + REVERIE_STYLE],
  ['rev-post', 256, 128,
   'the inside of a village post office, no books anywhere: a long wooden ' +
   'counter with a brass grille, behind it a wall of small square ' +
   'pigeonholes crammed with white envelopes, brown paper parcels tied ' +
   'with string stacked on the floor, a set of brass weighing scales on ' +
   'the counter, a green postbox by the door, ' + REVERIE_STYLE],
  ['rev-inn', 256, 128,
   'the inside of a warm timber inn: a big stone fireplace with a fire ' +
   'lit, long wooden tables, tankards, and lanterns hanging from the ' +
   'beams, ' + REVERIE_STYLE],
  ['rev-keep', 256, 128,
   'a courtyard inside a stone castle with banners, a wooden games table ' +
   'and torches, ' + REVERIE_STYLE],
  ['rev-boardwalk', 256, 128,
   'a wooden seaside pier with striped awnings, coloured bulbs and a ' +
   'ferris wheel behind, ' + REVERIE_STYLE],
  ['rev-cloud', 256, 128,
   'a terrace of pale stone on a cloud in a pink and gold sunset sky, ' +
   'with potted plants and a railing, ' + REVERIE_STYLE],
  ['rev-airfield', 256, 128,
   'a grass airstrip with a red biplane, a windsock and a wooden hangar ' +
   'under a wide blue sky, ' + REVERIE_STYLE],
  /* The two game banners lead with the style rather than the subject:
     asked for "a crazy golf course on a pier" first, the model returns a
     photograph and ignores everything after the comma. */
  ['game-dawn', 320, 72,
   'flat cartoon poster illustration, thick black outlines, cel shaded: a ' +
   'red biplane and a green biplane chasing each other through fat white ' +
   'clouds at sunrise, wide banner composition, ' + REVERIE_STYLE],
  ['game-golf', 320, 72,
   'flat cartoon poster illustration, thick black outlines, cel shaded: a ' +
   'crazy golf course on a wooden seaside pier, a red windmill, a striped ' +
   'flag in the hole, bunting overhead, wide banner composition, ' +
   REVERIE_STYLE],
];

/* One short loop, used as the curtain when you enter the world. */
const ANIMS = [
  ['rev-fly', 176, 112,
   'gentle flight over a cartoon storybook town with a castle and a big ' +
   'top, drifting white clouds, flat saturated hand-painted colour, ' +
   'early 1990s adventure game art, no text'],
];

const VOICE = [
  ['welcome',  'Welcome!'],
  ['reverie',  'Welcome to the Reverie Network.'],
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

/**
 * Turns a generated clip into a small looping animated WebP: sixteen
 * frames, palette-quantised like everything else. An animated picture on
 * a page in 1997 was a GIF of about this size, and it should feel like
 * one.
 */
function packAnim(file, w, h) {
  const dir = file.replace(/\.mp4$/, '-frames');
  mkdirSync(dir, { recursive: true });
  execFileSync(FFMPEG, ['-y', '-i', file, '-vf',
    'fps=8,scale=' + w + ':' + h + ':flags=lanczos', '-frames:v', '16',
    join(dir, 'f%02d.png')], { stdio: 'pipe' });
  return py(`
import base64, io, glob
from PIL import Image
frames = [Image.open(f).convert('RGB') for f in sorted(glob.glob(${JSON.stringify(join(dir, '*.png'))}))]
frames = [f.quantize(colors=64, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).convert('RGB')
          for f in frames]
buf = io.BytesIO()
frames[0].save(buf, 'WEBP', save_all=True, append_images=frames[1:],
               duration=125, loop=0, quality=62, method=4)
print('data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode())
`);
}

/** Scene panels keep their full frame; same palette treatment. */
function packImage(file, w, h) {
  return py(`
import base64, io
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB').resize((${w}, ${h}), Image.LANCZOS)
im = im.quantize(colors=32, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).convert('RGB')
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

  for (const [name, w, h, prompt] of SCENES.concat(REVERIE)) {
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

  for (const [name, w, h, prompt] of ANIMS) {
    const mp4 = join(raw, 'anim-' + name + '.mp4');
    if (!existsSync(mp4)) {
      const r = await run(VID_MODEL, { prompt, num_inference_steps: 24 });
      const url = (r.video && r.video.url) || (r.videos && r.videos[0] && r.videos[0].url);
      if (!url) throw new Error('no video in response: ' + JSON.stringify(r).slice(0, 300));
      await download(url, mp4);
      process.stdout.write('.');
    }
    entries.push([name.replace(/-/g, '_'), packAnim(mp4, w, h)]);
  }

  const body = entries.map(([k, v]) => '  ' + k.replace(/-/g, '_') + ": '" + v + "',").join('\n');
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
