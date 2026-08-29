#!/usr/bin/env node
// Turn the blockout into a painted backdrop.
//
//   node tools/plate.mjs blockout            # render the composition, free
//   node tools/plate.mjs paint --dry         # show what would be submitted
//   node tools/plate.mjs paint               # spend one image credit
//   node tools/plate.mjs paint --strength 0.5 --force
//
// The order matters and it is the whole argument of this prototype. Generating
// a backdrop from a text prompt gives you a beautiful picture whose floor is in
// the wrong place, whose horizon does not match your scale anchors, and whose
// props are not where your hotspots are. Every one of those is an hour of
// re-annotation, and it recurs per room.
//
// Generating it from a blockout does not have that problem. The blockout is
// the same code the game renders, so the composition, the floor line, the
// light direction and the prop positions are already correct by construction;
// the model is asked only to repaint it. The annotations — walk polygons,
// scale anchors, hotspot rects, occluder baselines — survive untouched, which
// means they are authored once and the painting is the cheap, replaceable part.
//
// This is also why the placeholder art is worth writing properly rather than
// as grey boxes: it is not a placeholder, it is the conditioning signal.
//
// Provider choice follows directly from that. A text-to-image endpoint that
// only emits fixed aspect ratios (1024x1024, 1536x1024) cannot be used here at
// all: a 1920x720 room comes back reframed, and reframing is exactly the thing
// the blockout exists to prevent. fal's image-to-image keeps the input's
// dimensions, so it is the default. The Vercel AI Gateway path is kept for
// square-ish plates and for models it fronts that fal does not.

import { writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const PROVIDER = opt('provider', 'fal');
const MODEL = opt('model', PROVIDER === 'fal' ? 'fal-ai/flux/dev/image-to-image' : 'openai/gpt-image-1');
const SIZE = opt('size', '1536x1024');
// How far the repaint is allowed to travel from the blockout. Low keeps the
// geometry and barely paints; high paints beautifully and moves the floor.
const STRENGTH = +opt('strength', 0.62);

const ASSETS = join(ROOT, 'assets');
const BLOCKOUT = join(ASSETS, 'dock-blockout.png');
const PLATE = join(ASSETS, 'dock-plate.png');
const LEDGER = join(ASSETS, 'provenance.json');

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// What the painting must preserve, said explicitly, because "keep the layout"
// is the one instruction an image model will quietly ignore.
const PROMPT = [
  'Repaint this scene as a hand-painted background for a 2D cartoon point-and-click',
  'adventure game, in the style of a late-1990s LucasArts adventure: lush painted',
  'gouache and airbrush, warm saturated colour, soft painterly brushwork, strong',
  'silhouettes, slightly exaggerated cartoon proportions, cinematic moonlit night.',
  '',
  'CRITICAL — keep the exact composition of the input image. Do not move, add or',
  'remove anything. The tavern stays on the left with its lit window and hanging',
  'sign, the grog barrel stays where it is, the crate stack stays where it is, the',
  'net pile stays where it is, the pier and the moored ship stay on the right, and',
  'the moon and its reflection stay exactly where they are. Above all, the wooden',
  'dock floor must occupy exactly the same band of the frame, with its far edge on',
  'the same line — a character walks on that edge and it cannot move.',
  '',
  'No characters, no people, no text, no watermark, no UI, no border, no letterboxing.',
].join(' ');

async function renderBlockout() {
  const { port, close } = await serve();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/tools/blockout.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready, null, { timeout: 10000 });
  await mkdir(ASSETS, { recursive: true });
  const buf = await page.locator('#c').screenshot();
  await writeFile(BLOCKOUT, buf);
  await browser.close();
  close();
  if (errors.length) { console.error('blockout render errors:\n  ' + errors.join('\n  ')); process.exit(1); }
  console.log(`blockout -> assets/dock-blockout.png  ${(buf.length / 1024).toFixed(0)} KB`);
}

async function ledger(entry) {
  let log = [];
  if (await exists(LEDGER)) log = JSON.parse(await readFile(LEDGER, 'utf8'));
  log.push({ ...entry, at: new Date().toISOString() });
  await writeFile(LEDGER, JSON.stringify(log, null, 2) + '\n');
}

async function paint() {
  if (!(await exists(BLOCKOUT))) { console.error('no blockout yet — run: node tools/plate.mjs blockout'); process.exit(1); }
  // A generation you already paid for is on disk. Re-running by accident is the
  // easiest way to spend a budget on a picture you already have.
  if ((await exists(PLATE)) && !FORCE) { console.error('assets/dock-plate.png exists — pass --force to redraw'); process.exit(1); }
  if (DRY) {
    console.log(`would submit via ${PROVIDER}\n  model:    ${MODEL}\n  strength: ${STRENGTH}\n  image:    assets/dock-blockout.png\n  prompt:   ${PROMPT}`);
    return;
  }
  const buf = PROVIDER === 'fal' ? await paintFal() : await paintGateway();
  await writeFile(PLATE, buf);
  await ledger({
    kind: 'plate', file: 'assets/dock-plate.png', provider: PROVIDER, model: MODEL,
    strength: PROVIDER === 'fal' ? STRENGTH : undefined, size: PROVIDER === 'fal' ? '1920x720' : SIZE,
    from: 'assets/dock-blockout.png', prompt: PROMPT,
  });
  console.log(`plate -> assets/dock-plate.png  ${(buf.length / 1024).toFixed(0)} KB  (${PROVIDER} ${MODEL})`);
  console.log('reload the game; src/game/dock.js picks it up automatically.');
}

// fal keeps the input image's dimensions, which is the only reason the walk
// polygons still line up with the painting afterwards.
async function paintFal() {
  const key = process.env.FAL_KEY;
  if (!key) { console.error('FAL_KEY not set'); process.exit(1); }
  const dataUri = 'data:image/png;base64,' + (await readFile(BLOCKOUT)).toString('base64');
  const headers = { Authorization: `Key ${key}`, 'content-type': 'application/json' };

  const submit = await fetch(`https://queue.fal.run/${MODEL}`, {
    method: 'POST', headers,
    body: JSON.stringify({
      image_url: dataUri, prompt: PROMPT, strength: STRENGTH,
      num_inference_steps: 40, guidance_scale: 3.5, num_images: 1,
      enable_safety_checker: false, output_format: 'png',
    }),
  });
  const queued = await submit.json();
  if (!submit.ok) { console.error(`fal submit ${submit.status}: ${JSON.stringify(queued).slice(0, 500)}`); process.exit(1); }
  console.log(`  queued ${queued.request_id}`);

  let out = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await (await fetch(queued.status_url, { headers })).json();
    if (st.status === 'COMPLETED') { out = await (await fetch(queued.response_url, { headers })).json(); break; }
    if (st.status === 'FAILED') { console.error('fal failed: ' + JSON.stringify(st).slice(0, 500)); process.exit(1); }
    if (i % 5 === 0) console.log(`  ${st.status}...`);
  }
  if (!out) { console.error('fal timed out'); process.exit(1); }
  const img = out.images?.[0];
  if (!img?.url) { console.error('no image: ' + JSON.stringify(out).slice(0, 400)); process.exit(1); }
  console.log(`  painted ${img.width}x${img.height}`);
  return Buffer.from(await (await fetch(img.url)).arrayBuffer());
}

async function paintGateway() {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) { console.error('AI_GATEWAY_API_KEY not set'); process.exit(1); }

  const form = new FormData();
  form.set('model', MODEL);
  form.set('prompt', PROMPT);
  form.set('size', SIZE);
  form.set('image', new Blob([await readFile(BLOCKOUT)], { type: 'image/png' }), 'blockout.png');

  const res = await fetch('https://ai-gateway.vercel.sh/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) { console.error(`images/edits ${res.status}: ${text.slice(0, 600)}`); process.exit(1); }
  const json = JSON.parse(text);
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) { console.error('no image in response: ' + text.slice(0, 400)); process.exit(1); }
  return Buffer.from(b64, 'base64');
}

if (cmd === 'blockout') await renderBlockout();
else if (cmd === 'paint') await paint();
else { console.error('usage: node tools/plate.mjs <blockout|paint> [--dry] [--force] [--provider fal|gateway] [--model M] [--strength 0..1]'); process.exit(1); }
