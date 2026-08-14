#!/usr/bin/env node
// Generate the soundtrack with ElevenLabs: music beds, sound effects and the
// announcer. Writes into audio/ and skips anything already there, so re-running
// is free.
//
//   ELEVENLABS_API_KEY=... node tools/audio.mjs
//   node tools/audio.mjs --only vo-title --force
//
// The cues are named here and referenced by name from score/director code; the
// bundler inlines whatever this produced as data URIs.

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'audio');
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }

const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const FORCE = args.includes('--force');

// 64kbps mono-ish mp3 keeps the whole soundtrack near two megabytes, which
// matters because it all ends up base64'd inside one HTML file.
const FMT = 'mp3_44100_64';

// Voice: a formal broadcaster, which is exactly the register a telenovela
// announcer uses to tell you a chicken has a secret twin.
const ANNOUNCER = 'onwK4e9ZLuTAKqWW03F9';

const MUSIC = {
  'mus-theme': [42, 'Opening theme of a 1980s Mexican telenovela. Solo nylon guitar arpeggios over warm sustained strings, slow, minor key, nostalgic and melodramatic. Instrumental, no vocals, no drums.'],
  'mus-romance': [34, 'Tender telenovela love theme. Nylon guitar and lush legato strings, slow bolero feel, warm, longing, romantic. Instrumental, no vocals.'],
  'mus-suspense': [30, 'Suspense underscore for a soap opera. Tremolo strings holding a tense minor chord, low pulsing cello drone, ominous, unresolved, creeping dread. Instrumental, no vocals, no drums.'],
  'mus-storm': [30, 'High drama orchestral cue. Urgent tremolo strings, timpani rolls, brass stabs, storm and betrayal, relentless. Instrumental, no vocals.'],
  'mus-tragedy': [34, 'Heartbroken telenovela lament. Solo violin melody over sparse nylon guitar, very slow, tearful, minor key, resigned. Instrumental, no vocals.'],
  'mus-credits': [50, 'End credits theme of a Latin American telenovela. Nylon guitar and strings, bittersweet but gently uplifting, warm, a little grand, classic television outro. Instrumental, no vocals.'],
};

const SFX = {
  'sfx-crow': [3, 'a single rooster crowing loudly, close microphone, night, no music'],
  'sfx-cluck': [2, 'a hen clucking softly a few times, close, gentle, no music'],
  'sfx-squawk': [2, 'a chicken squawking in sudden alarm, one sharp startled screech, close'],
  'sfx-flap': [2, 'a bird flapping its wings hard twice, feathers whooshing, close'],
  'sfx-thunder': [5, 'a huge thunder crack followed by a long deep rolling rumble, heavy rain storm'],
  'sfx-slap': [2, 'a single hard sharp slap across a face, dramatic, close, with a short reverb tail'],
  'sfx-egg-crack': [3, 'an eggshell cracking and splitting open slowly, delicate crackling, close'],
  'sfx-peep': [2, 'a newly hatched baby chick peeping twice, tiny and high, close'],
  'sfx-heartbeat': [3, 'two slow deep heartbeats, muffled, close, subwoofer thump'],
  'sfx-sting': [3, 'dramatic soap opera organ sting, three chords, dun dun DUNNN, cheesy and theatrical, big vibrato on the last chord'],
  'sfx-sting-reveal': [4, 'huge orchestral shock sting for a soap opera plot twist, strings and brass rising then a held dissonant chord with tremolo'],
  'sfx-rain': [14, 'steady heavy rain falling on stone tiles in a courtyard, continuous, no thunder, no music'],
  'sfx-fountain': [12, 'a small stone fountain trickling water gently in a quiet courtyard at night, continuous, no music'],
  'sfx-night': [14, 'quiet warm night ambience, distant crickets, very faint breeze, no music, no animals'],
};

// The announcer. Spanish, because the register only works in Spanish.
const VOICE = {
  'vo-title': 'Corazón... de gallina.',
  'vo-capitulo': 'Capítulo final.',
  'vo-continuara': 'Continuará...',
  'vo-credits-1': 'Dirección, guion, fotografía, vestuario, y absolutamente todas las plumas: Claude Opus Cinco.',
  'vo-credits-2': 'Escenografía construida a mano, polígono por polígono, en Three punto JS.',
  'vo-credits-3': 'Música original, truenos, y todos los suspiros: ElevenLabs.',
  'vo-credits-4': 'Escribió unos cuantos prompts... Brian Gruber.',
  'vo-credits-5': 'Ninguna gallina resultó herida durante esta producción. Varias resultaron traicionadas.',
};

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function post(url, body, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      const wait = 2 ** attempt * 1000;
      console.error(`  ${label}: ${res.status}, retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`${label}: ${res.status} ${text.slice(0, 300)}`);
  }
  throw new Error(`${label}: gave up after retries`);
}

async function gen(name, make) {
  if (ONLY && name !== ONLY) return null;
  const path = join(OUT, name + '.mp3');
  if (!FORCE && await exists(path)) { console.log(`  ${name}: exists, skipping`); return null; }
  const buf = await make();
  await writeFile(path, buf);
  console.log(`  ${name}: ${(buf.length / 1024).toFixed(0)} KB`);
  return buf.length;
}

await mkdir(OUT, { recursive: true });
let total = 0;

console.log('music');
for (const [name, [secs, prompt]] of Object.entries(MUSIC)) {
  total += (await gen(name, () => post(
    `https://api.elevenlabs.io/v1/music?output_format=${FMT}`,
    { prompt, music_length_ms: secs * 1000 }, name,
  ))) || 0;
}

console.log('sound effects');
for (const [name, [secs, text]] of Object.entries(SFX)) {
  total += (await gen(name, () => post(
    `https://api.elevenlabs.io/v1/sound-generation?output_format=${FMT}`,
    { text, duration_seconds: secs, prompt_influence: 0.65 }, name,
  ))) || 0;
}

console.log('announcer');
for (const [name, text] of Object.entries(VOICE)) {
  total += (await gen(name, () => post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ANNOUNCER}?output_format=${FMT}`,
    {
      text,
      model_id: 'eleven_multilingual_v2',
      // Slow, stable and theatrical: the voice that introduces the episode.
      voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.65, use_speaker_boost: true, speed: 0.9 },
    }, name,
  ))) || 0;
}

console.log(`\nnew audio: ${(total / 1048576).toFixed(2)} MB`);
