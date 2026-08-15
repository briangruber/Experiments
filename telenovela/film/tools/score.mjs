#!/usr/bin/env node
// Generate the music bed the edit lays under the scene.
//
//   node tools/score.mjs            # write dist/bed.mp3 if it isn't there
//   node tools/score.mjs --force
//
// This exists as a separate step for a structural reason, not a tidiness one.
// The video model will happily score each shot for you, and that is exactly
// what you must not let it do: a cue invented independently per shot restarts
// at every cut, so the music lurches each time the picture changes and the
// scene sounds broken no matter how well the pictures match. So the shot
// prompts forbid music outright and keep only the diegetic layer — voices,
// rain, thunder, paper — which cuts cleanly because it is continuous room
// tone either side of the edit. The music is then one unbroken piece written
// across the whole scene and laid underneath, which is how a real cutting
// room does it and the only arrangement where the cut can be invisible.
//
// One bed, longer than the scene, trimmed to fit. Never one bed per shot.

import { mkdir, writeFile, access, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SCENE from '../scenes/s01-testamento/scene.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');

// Written to sit *under* dialogue, which means no percussion to fight the
// consonants and nothing in the vocal range. It also has to start and end in
// open air, because it is going to be faded rather than resolved.
const BED = {
  prompt:
    'Slow, sparse, tense telenovela underscore. Solo nylon-string Spanish guitar playing ' +
    'a simple mournful minor figure, with low sustained cello underneath and a distant ' +
    'tremolo string pad. Minor key, unresolved, quietly ominous. Absolutely no drums, no ' +
    'percussion, no vocals, no brass. Restrained and spacious, mixed to sit underneath ' +
    'spoken dialogue without competing with it. Begins quietly and holds a steady mood ' +
    'throughout without a big climax.',
  // Generated long and trimmed. A bed cut to the exact length of the picture
  // gives the mix nowhere to fade out, and a bed that ends on the last frame
  // sounds like the power was cut.
  ms: 30000,
};

const exists = (p) => access(p).then(() => true, () => false);
const path = join(OUT, 'bed.mp3');

if (!process.env.ELEVENLABS_API_KEY) {
  console.error('ELEVENLABS_API_KEY is not set');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
if (!FORCE && (await exists(path))) {
  console.log(`bed already written (${((await stat(path)).size / 1024).toFixed(0)} KB) — --force to redo`);
  process.exit(0);
}

console.log(`composing ${BED.ms / 1000}s of bed for ${SCENE.title}…`);
const res = await fetch('https://api.elevenlabs.io/v1/music', {
  method: 'POST',
  headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: BED.prompt, music_length_ms: BED.ms }),
});
if (!res.ok) throw new Error(`music ${res.status}: ${(await res.text()).slice(0, 400)}`);
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(path, buf);
console.log(`  ${(buf.length / 1024).toFixed(0)} KB  ->  dist/bed.mp3`);
