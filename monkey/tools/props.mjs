#!/usr/bin/env node
// Repaint the clickable things, one at a time, with their backgrounds cut away.
//
//   node tools/props.mjs --dry
//   node tools/props.mjs                    # all of them
//   node tools/props.mjs barrel cup --force
//   node tools/props.mjs --rematte          # re-cut, no repaint, no spend
//
// The plate can only ever be scenery (see src/art/props.js for why), which
// leaves the props looking like what they are: flat vector shapes sitting on a
// painting. This closes that seam by putting every prop through the same
// blockout-then-repaint route the backdrop takes, one object at a time.
//
// Doing them individually rather than in the plate buys the thing that makes
// the whole pipeline work: the sprite comes back into a box we chose, so its
// hotspot, its occluder baseline and its draw order are all still correct no
// matter what the model did inside that box. A prop can be regenerated fifty
// times and never cost a single re-annotation.
//
// The alpha does not come from a background remover. The blockout draws each
// prop on transparent, so its own alpha is already the exact silhouette the
// hotspots were authored against — the repaint is composited onto a flat grey
// only so the model has something neutral to paint against, and that same
// matte is re-applied afterwards. This is the plate's lesson one level down:
// the geometry was never lost, only painted over, so there is nothing to
// recover it with a model.
//
// It is also strictly better. A background remover was tried first and cut the
// tavern down to its lit window, because a segmentation model finds the
// salient object and a building's salient object is the bright bit.

import { writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, launch, serve } from './harness.mjs';

const { PROP_RECTS } = await import(new URL('../src/art/props.js', import.meta.url));

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const STRENGTH = +opt('strength', 0.7);
const MODEL = opt('model', 'fal-ai/flux/dev/image-to-image');

const REMATTE = args.includes('--rematte');
const OUT = join(ROOT, 'assets/props');
// The repaint before it was cut out. Kept so the matte can be changed — and it
// was, twice — without paying for the painting again.
const RAW = join(OUT, 'raw');
const LEDGER = join(ROOT, 'assets/provenance.json');
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// Style words shared with the backdrop, so the props and the plate come out of
// the same imagined studio rather than two different ones.
const STYLE = 'Hand-painted prop for a late-1990s LucasArts point-and-click adventure '
  + 'background. Traditional gouache and oil on board: visible directional brushwork, '
  + 'loaded impasto in the lights, thin scumbled darks, broken colour, soft lost-and-found '
  + 'edges. Cool blue-violet moonlight from the upper right with warm amber lamplight '
  + 'spilling from the left. Deep transparent shadows that still hold colour. '
  + 'Not flat vector art, not cel shading, not a clean digital illustration.';

const KEEP = 'CRITICAL — keep the exact silhouette, position, scale and proportions of the '
  + 'object in the input image. Do not move it, do not resize it, do not add anything beside '
  + 'it. Keep the plain flat grey background completely empty and unchanged — no scenery, '
  + 'no floor, no horizon, no shadow cast onto the background. No text, no lettering, no '
  + 'watermark.';

// Compositing helpers that run in the page, because canvas is the only image
// editor in this toolchain. Data URIs rather than remote URLs, so the canvas
// never becomes tainted and stays readable.
const ON_GREY = (dataUri) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.fillStyle = '#7b7f86';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, 0, 0);
    resolve(c.toDataURL('image/png'));
  };
  img.src = dataUri;
});

// How far to grow the matte before cutting. An exact silhouette is right for a
// solid object and wrong for a wispy one: the blockout draws a net as a few
// thin strokes, so cutting to it exactly returned a handful of scribbled
// strands instead of a pile of rope, and the tin cup came back almost empty.
// Everything gets a pixel or two anyway, which closes the hairline gap an
// antialiased edge leaves behind.
const DILATE = { nets: 8, cup: 4, tavern: 2, barrel: 2, crates: 2 };

const APPLY_MATTE = ([paintedUri, matteUri, w, h, grow]) => Promise.all(
  [paintedUri, matteUri].map((src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; })),
).then(([painted, matte]) => {
  // Dilation by stamping the matte around a ring — cheap, and at these radii
  // indistinguishable from a real morphological dilate.
  let cut = matte;
  if (grow > 0) {
    const d = document.createElement('canvas');
    d.width = w; d.height = h;
    const dx = d.getContext('2d');
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      dx.drawImage(matte, Math.cos(t) * grow, Math.sin(t) * grow, w, h);
    }
    dx.drawImage(matte, 0, 0, w, h);
    cut = d;
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.drawImage(painted, 0, 0, w, h);
  // destination-in keeps the repaint only where the matte is opaque. The
  // repaint is allowed to bleed past the silhouette; it is simply trimmed back
  // to the shape the game already believes in.
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(cut, 0, 0, w, h);
  return c.toDataURL('image/png');
});

const SUBJECT = {
  tavern: 'The weathered clapboard front of a small dockside tavern at night: silvered grey-brown '
    + 'timber boards, a shingled roof, a heavy plank door with black iron hinges, and one small '
    + 'many-paned window glowing warm amber from the fire inside. A carved wooden sign hangs from '
    + 'a wrought-iron bracket. Salt-stained, sun-bleached, a century old.',
  barrel: 'A squat oak grog barrel with iron hoops, standing upright on a dock. Weathered staves, '
    + 'rust bleeding from the hoops, a brass spigot low on the right-hand side.',
  crates: 'A stack of three battered wooden cargo crates, rough sawn planks with cross-braces, '
    + 'chipped corners, damp stains, old stencilling worn to nothing.',
  nets:   'A heap of coiled tarred fishing net on a dock, dark and damp, with a long wooden boat '
    + 'hook lying across it, its iron hook catching the moonlight.',
  cup:    'A dented tin drinking cup with a curved handle, hanging from a single nail, its metal '
    + 'scratched and tarnished with a bright highlight along one edge.',
};

async function ledger(entry) {
  let log = [];
  if (await exists(LEDGER)) log = JSON.parse(await readFile(LEDGER, 'utf8'));
  log.push({ ...entry, at: new Date().toISOString() });
  await writeFile(LEDGER, JSON.stringify(log, null, 2) + '\n');
}

// --- fal --------------------------------------------------------------------

const KEY = process.env.FAL_KEY;
const headers = () => ({ Authorization: `Key ${KEY}`, 'content-type': 'application/json' });

async function falRun(model, input, label) {
  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(input),
  });
  const queued = await submit.json();
  if (!submit.ok) throw new Error(`${label} submit ${submit.status}: ${JSON.stringify(queued).slice(0, 400)}`);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await (await fetch(queued.status_url, { headers: headers() })).json();
    if (st.status === 'COMPLETED') return (await fetch(queued.response_url, { headers: headers() })).json();
    if (st.status === 'FAILED') throw new Error(`${label} failed: ${JSON.stringify(st).slice(0, 400)}`);
  }
  throw new Error(`${label} timed out`);
}

const toDataUri = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;
const fetchBuf = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());

// --- render the blockouts ---------------------------------------------------

const names = args.filter((a) => !a.startsWith('--') && PROP_RECTS[a]);
const todo = names.length ? names : Object.keys(PROP_RECTS);

if (DRY) {
  for (const n of todo) {
    const [x, y, w, h] = PROP_RECTS[n];
    console.log(`  ${n.padEnd(8)} ${String(w).padStart(4)}x${String(h).padStart(3)} at ${x},${y}  "${SUBJECT[n].slice(0, 64)}..."`);
  }
  console.log(`\n${todo.length} props, ${todo.length} repaints (matte comes from the blockout, not a model)`);
  process.exit(0);
}
if (!KEY) { console.error('FAL_KEY not set'); process.exit(1); }

await mkdir(RAW, { recursive: true });
const { port, close } = await serve();
const browser = await launch();
const page = await browser.newPage();

for (const name of todo) {
  const dest = join(OUT, `${name}.png`);
  const rawFile = join(RAW, `${name}.png`);
  const haveRaw = await exists(rawFile);
  if ((await exists(dest)) && !FORCE && !REMATTE) { console.log(`  ${name}: on disk, skipping (--force to redraw)`); continue; }
  if (REMATTE && !haveRaw) { console.log(`  ${name}: no raw repaint to re-cut, skipping`); continue; }
  const [, , w, h] = PROP_RECTS[name];

  await page.setViewportSize({ width: Math.max(w, 64), height: Math.max(h, 64) });
  await page.goto(`http://127.0.0.1:${port}/tools/blockout.html?only=${name}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready, null, { timeout: 10000 });
  const matte = toDataUri(await page.locator('#c').screenshot({ omitBackground: true }));
  const onGrey = await page.evaluate(ON_GREY, matte);

  let rawBuf;
  if (REMATTE || (haveRaw && !FORCE)) {
    rawBuf = await readFile(rawFile);
  } else {
    const painted = await falRun(MODEL, {
      image_url: onGrey,
      prompt: `${SUBJECT[name]} ${STYLE} ${KEEP}`,
      strength: STRENGTH, num_inference_steps: 40, guidance_scale: 3.5,
      num_images: 1, enable_safety_checker: false, output_format: 'png',
    }, name);
    const paintedUrl = painted.images?.[0]?.url;
    if (!paintedUrl) throw new Error(`${name}: no repaint returned`);
    rawBuf = await fetchBuf(paintedUrl);
    await writeFile(rawFile, rawBuf);
  }

  const final = await page.evaluate(APPLY_MATTE, [toDataUri(rawBuf), matte, w, h, DILATE[name] ?? 2]);
  const buf = Buffer.from(final.split(',')[1], 'base64');
  await writeFile(dest, buf);
  await ledger({
    kind: 'prop', name, file: `assets/props/${name}.png`, rect: PROP_RECTS[name],
    provider: 'fal', model: MODEL, matte: 'blockout alpha', dilate: DILATE[name] ?? 2,
    strength: STRENGTH, prompt: SUBJECT[name],
  });
  console.log(`  ${name.padEnd(8)} ${(buf.length / 1024).toFixed(0).padStart(4)} KB  ${w}x${h}`);
}

await browser.close();
close();
console.log('\nprops -> assets/props/');
