#!/usr/bin/env node
// Draw the references before you shoot the scene.
//
//   node tools/refs.mjs                 # everything the scene needs, skipping what exists
//   node tools/refs.mjs rosalinda       # just one
//   node tools/refs.mjs --force         # redraw regardless
//
// These images are the entire consistency mechanism. Seedance 2.5 has no seed
// input — you cannot ask it for the same roll of the dice twice — so the only
// thing tying shot two to shot one is that both were handed the same pictures
// and the same words. That makes these files load-bearing, and it is why they
// are committed rather than regenerated per run: a redraw is a recast.
//
// The sheets are deliberately plain. It is tempting to build a lavish
// turnaround with expression rows and costume call-outs, but every reference
// competes with every other for influence over the generation, and a busy
// sheet spends that influence on the wrong things. Three views of one
// character on a grey backdrop is what transfers.

import { mkdir, access } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SCENE from '../scenes/s01-testamento/scene.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'refs');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const want = args.filter((a) => !a.startsWith('--'));

// The character sheet's job is identity transfer, and fal's guidance for that
// is explicit: well-lit, single-subject, plainly presented. Everything
// atmospheric — the candles, the night, the rain — is the video model's job
// later. Putting mood in the sheet only teaches it the wrong lighting.
const SHEET_FRAME =
  'Character reference sheet on a plain seamless neutral grey backdrop. Three views of ' +
  'the SAME character standing in a relaxed neutral pose, side by side, evenly spaced, ' +
  'all three the same height and all fully inside the frame: front view on the left, ' +
  'three-quarter view in the middle, side profile view on the right. Full body, head to ' +
  'feet, wearing the same costume in every view. Flat even studio lighting, no cast ' +
  'shadows, no rim light, no props, no text, no labels, no watermark, no border.';

// The plate is the opposite job: this one *is* the mood, because it is what
// locks two independently generated shots to the same lighting and grade.
const PLATE_FRAME =
  'A single cinematic film still, 16:9, no people in the frame at all. 40mm lens, shallow ' +
  'depth of field. No text, no watermark, no border.';

const STYLE =
  'Stylized 3D animated feature film look, high-end animated feature rendering, appealing ' +
  'cartoon-realist design, soft subsurface shading, detailed feather grooming.';

const SUBJECTS = {
  ...Object.fromEntries(
    Object.entries(SCENE.cast).map(([key, c]) => [
      key,
      { prompt: `${c.sheet}\n\n${SHEET_FRAME}\n\n${STYLE}`, size: '1536x1024' },
    ]),
  ),
  [SCENE.location.key]: {
    prompt: `${SCENE.location.sheet}\n\n${PLATE_FRAME}\n\n${STYLE}`,
    size: '1536x1024',
  },
};

const exists = (p) => access(p).then(() => true, () => false);

async function draw(key) {
  const path = join(OUT, `${key}.png`);
  if (!FORCE && (await exists(path))) {
    console.log(`  ${key.padEnd(12)} already drawn, skipping`);
    return path;
  }
  const { prompt, size } = SUBJECTS[key];
  const res = await fetch('https://ai-gateway.vercel.sh/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'openai/gpt-image-2', prompt, n: 1, size }),
  });
  if (!res.ok) throw new Error(`${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${key}: no image in response`);
  const buf = Buffer.from(b64, 'base64');
  await writeFile(path, buf);
  console.log(`  ${key.padEnd(12)} ${(buf.length / 1024).toFixed(0)} KB  ->  refs/${key}.png`);
  return path;
}

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('AI_GATEWAY_API_KEY is not set');
  process.exit(1);
}

const keys = want.length ? want.filter((k) => SUBJECTS[k]) : Object.keys(SUBJECTS);
if (!keys.length) {
  console.error(`usage: node tools/refs.mjs [--force] [${Object.keys(SUBJECTS).join('|')}]`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
console.log(`drawing ${keys.length} reference(s) for ${SCENE.title}\n`);
for (const key of keys) await draw(key);
console.log(`\nreferences in film/refs/`);
