#!/usr/bin/env node
// Generate the soundtrack with ElevenLabs: music beds, sound effects and the
// announcer. Writes into company/library/audio/ and skips anything already
// there, so re-running is free.
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
const OUT = join(ROOT, 'company/library/audio');
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }

const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const FORCE = args.includes('--force');

// 64kbps mono-ish mp3 keeps the whole soundtrack near two megabytes, which
// matters because it all ends up base64'd inside one HTML file.
const FMT = 'mp3_44100_64';

// The announcer. Cast by measurement, twice. The first one was the brightest
// voice in the library (centroid 1711Hz) and sounded like a BBC continuity
// reader; the second overcorrected — 54% of its energy sat under 300Hz, which
// is less "telenovela" than "film trailer from 1997".
//
// This one is a Mexican narrator, and the settings were measured too: at
// stability 0.45 / style 0.6 he lands at 1570Hz with 31% under 300Hz — between
// the two mistakes, and still well clear of Don Gallo's 13% and Esteban's 9%.
// Pushing style higher for melodrama made him BRIGHTER, not more theatrical,
// which is the opposite of what the scene wants.
const ANNOUNCER = 'TNuNcwk4LzbPpi1XEANc';

const MUSIC = {
  'mus-theme': [42, 'Opening theme of a 1980s Mexican telenovela. Solo nylon guitar arpeggios over warm sustained strings, slow, minor key, nostalgic and melodramatic. Instrumental, no vocals, no drums.'],
  'mus-romance': [34, 'Tender telenovela love theme. Nylon guitar and lush legato strings, slow bolero feel, warm, longing, romantic. Instrumental, no vocals.'],
  'mus-suspense': [30, 'Suspense underscore for a soap opera. Tremolo strings holding a tense minor chord, low pulsing cello drone, ominous, unresolved, creeping dread. Instrumental, no vocals, no drums.'],
  'mus-storm': [30, 'High drama orchestral cue. Urgent tremolo strings, timpani rolls, brass stabs, storm and betrayal, relentless. Instrumental, no vocals.'],
  'mus-tragedy': [34, 'Heartbroken telenovela lament. Solo violin melody over sparse nylon guitar, very slow, tearful, minor key, resigned. Instrumental, no vocals.'],
  // The opening title song. Sung, because a telenovela announces itself.
  'mus-opening': [34, 'Opening title song of a 1980s Mexican telenovela, sung in Spanish as a passionate duet between a man and a woman, lush strings, nylon guitar, dramatic bolero rhythm, anthemic and melodramatic. Lyrics: "Corazon de gallina, corazon sin piedad, me juraste tu amor bajo la oscuridad. Corazon de gallina, no te puedo olvidar, en el patio de luna te vuelvo a esperar."'],
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
  'sfx-fountain': [12, 'water splashing and trickling steadily from a stone fountain into a basin, close, continuous, no music'],
  'sfx-night': [14, 'a warm summer night in the countryside, a steady chorus of crickets and chirping insects, gentle wind in dry leaves, continuous, no music'],
  // Added once the story pass found beats the audience could not hear.
  'sfx-gate-creak': [3, 'a heavy wooden gate latch lifting and an old iron hinge creaking open slowly, night, close, no music'],
  'sfx-cloth-whip': [2, 'a heavy cloth being yanked off something in one sharp motion, fabric snap and whoosh, close, no music'],
  'sfx-hen-gasp': [3, 'a small crowd of hens gasping and clucking in shock all at once, scandalised, offstage, no music'],
  'sfx-footsteps-mud': [4, 'slow deliberate footsteps of a large bird walking through wet mud and shallow puddles, rain in the background, close'],
  'sfx-organ-hold': [6, 'a single sustained dissonant church organ chord, held without decay, slowly swelling, dread, no percussion'],
};

// The announcer: the voice on the title cards and the credits. The cast's own
// dialogue is a separate job — see tools/voices.mjs and the episode's dialogue.js.
const VOICE = {
  'vo-title': 'Corazón... de gallina.',
  'vo-capitulo': 'Capítulo final.',
  'vo-continuara': 'Continuará...',
  // The opening titles. He introduces them one at a time, as he should.
  // Tight, because the shots are 3.6s apart and this voice is unhurried.
  'vo-name-rosalinda': 'Rosalinda. La inocente.',
  'vo-name-esteban': 'Esteban. El galán.',
  'vo-name-valentina': 'Valentina. La villana.',
  'vo-name-dongallo': 'Don Gallo. El patrón.',
  'vo-name-ricardo': 'Ricardo. El gemelo.',
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
      voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true, speed: 1.04 },
    }, name,
  ))) || 0;
}

console.log(`\nnew audio: ${(total / 1048576).toFixed(2)} MB`);
