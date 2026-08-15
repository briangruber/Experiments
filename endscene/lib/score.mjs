// The music bed.
//
// A separate step for a structural reason rather than a tidy one. The video
// model will score each shot for you, and that is exactly what it must not do:
// a cue invented independently per shot restarts at every cut, so the music
// lurches each time the picture changes and the scene sounds broken however
// well the pictures match. It is the fastest way to make good coverage feel
// amateur.
//
// So the shot prompts forbid music outright and keep only the diegetic layer,
// which cuts cleanly because it is continuous room tone either side of the
// edit. The music is then one unbroken piece written across the whole scene and
// laid underneath, which is how a cutting room does it and the only arrangement
// where the cut can be invisible.
//
// One bed, longer than the scene, trimmed to fit. Never one bed per shot.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nextTake, writeJSON, hash } from './store.mjs';

// Generated long and trimmed. A bed cut to the exact length of the picture
// gives the mix nowhere to fade out, and one that ends on the last frame sounds
// like the power was cut.
export const HEADROOM_MS = 8000;

export async function compose({ dir, prompt, seconds, apiKey = process.env.ELEVENLABS_API_KEY, meta = {} }) {
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  await mkdir(join(dir, 'takes'), { recursive: true });
  const take = await nextTake(dir);

  const ms = Math.min(Math.round(seconds * 1000) + HEADROOM_MS, 300000);
  const res = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, music_length_ms: ms }),
  });
  if (!res.ok) throw new Error(`music ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const file = join(dir, 'takes', `${take}.mp3`);
  await writeFile(file, buf);

  await writeJSON(join(dir, 'takes', `${take}.json`), {
    take, kind: 'bed', prompt, music_length_ms: ms,
    made_at: new Date().toISOString(),
    inputsHash: hash({ prompt, ms, ...meta }),
    ...meta,
  });

  return { take, file };
}

// A default worth starting from: written to sit *under* dialogue, which means
// nothing percussive to fight the consonants and nothing parked in the vocal
// range. It also has to start and end in open air, because it will be faded
// rather than resolved.
export const BED_ADVICE =
  'Mixed to sit underneath spoken dialogue without competing with it. No drums, no ' +
  'percussion, no vocals. Restrained and spacious. Begins quietly and holds a steady mood ' +
  'throughout without a big climax.';
