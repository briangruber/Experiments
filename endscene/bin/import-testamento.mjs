#!/usr/bin/env node
// Import El Testamento — the scene this whole approach was proved on — from
// the original hardcoded prototype into the project schema.
//
//   node bin/import-testamento.mjs <path-to-telenovela/film>
//
// This exists as the correctness test rather than as a convenience. The
// prototype produced a finished scene; if the same assets and the same marks
// cut to the same result through the general code path, the generalisation did
// not lose anything. It is also the only way to be sure the new prompt builder
// composes the same clauses in the same order, since a difference there would
// silently change every future shot.
//
// Existing takes are carried over as take 1 and selected. Nothing is
// regenerated: the video endpoint has no seed, so these particular
// performances cannot be got back if they are lost.

import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJSON, select, exists } from '../lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILM = resolve(process.argv[2] || join(HERE, '../../telenovela/film'));
const OUT = resolve(join(HERE, '../projects/telenovela'));

if (!(await exists(join(FILM, 'scenes/s01-testamento/scene.js')))) {
  console.error(`no prototype at ${FILM}\nusage: node bin/import-testamento.mjs <path-to-telenovela/film>`);
  process.exit(1);
}

const src = await import(join(FILM, 'scenes/s01-testamento/scene.js'));
const { CAST, LOCATION, SHOTS, STYLE, LOOK, AUDIO } = src;

// ---------------------------------------------------------------------------
// The show
// ---------------------------------------------------------------------------

await writeJSON(join(OUT, 'show.json'), {
  id: 'telenovela',
  title: 'Corazón de Gallina',
  premise: 'A scene from a Spanish-language telenovela.',
  language: 'Spanish',
  aspect_ratio: '16:9',
  resolution: '720p',
  // The spine, verbatim from the prototype. These three strings are what every
  // shot prompt repeats, and repeating them identically is the entire reason
  // two independently generated shots look like the same production.
  style: STYLE,
  look: LOOK,
  audio: AUDIO,
  models: {
    video: 'bytedance/seedance-2.5/reference-to-video',
    image: 'fal-ai/nano-banana-2',
    edit: 'fal-ai/nano-banana-2/edit',
  },
});

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

for (const [key, c] of Object.entries(CAST)) {
  await writeJSON(join(OUT, 'company', key, 'character.json'), {
    id: key,
    name: c.name,
    sheet: c.sheet,
    note: c.note,
    line: c.line,
    direction: c.direction,
    defaultLook: 'default',
  });

  // The prototype had one wardrobe per character and no concept of a look, so
  // its sheet becomes the default — the root every other look is edited from.
  const lookDir = join(OUT, 'company', key, 'looks', 'default');
  await writeJSON(join(lookDir, 'look.json'), {
    id: 'default',
    label: 'Default',
    wardrobe: null,
    derivedFrom: null,
    note: 'Imported from the prototype, where wardrobe was baked into the character description.',
  });
  await mkdir(join(lookDir, 'takes'), { recursive: true });
  await copyFile(join(FILM, 'refs', `${key}.png`), join(lookDir, 'takes', '1.png'));
  await writeJSON(join(lookDir, 'takes', '1.json'), {
    take: 1, kind: 'import', from: `refs/${key}.png`, made_at: new Date().toISOString(),
  });
  await select(lookDir, 1);
  await copyFile(join(lookDir, 'takes', '1.png'), join(lookDir, 'sheet.png'));

  const voiceDir = join(OUT, 'company', key, 'voice');
  await mkdir(join(voiceDir, 'takes'), { recursive: true });
  await copyFile(join(FILM, 'refs', `voice-${key}.mp4`), join(voiceDir, 'takes', '1.mp4'));
  await copyFile(join(FILM, 'refs', `voice-${key}.mp3`), join(voiceDir, 'takes', '1.mp3'));
  await select(voiceDir, 1);
  await copyFile(join(voiceDir, 'takes', '1.mp3'), join(voiceDir, 'voice.mp3'));
  await copyFile(join(voiceDir, 'takes', '1.mp4'), join(voiceDir, 'plate.mp4'));
  console.log(`  company/${key}  sheet + voice`);
}

// ---------------------------------------------------------------------------
// The location
// ---------------------------------------------------------------------------

await writeJSON(join(OUT, 'locations', LOCATION.key, 'location.json'), {
  id: LOCATION.key,
  name: 'The hacienda dining room',
  sheet: LOCATION.sheet,
  note: LOCATION.note,
  defaultState: 'night-storm',
});

const stateDir = join(OUT, 'locations', LOCATION.key, 'states', 'night-storm');
await writeJSON(join(stateDir, 'state.json'), {
  id: 'night-storm',
  label: 'Night, storm',
  lighting: 'Night. Lit only by the candelabra on the table, with cold blue spill from the rain-streaked window.',
});
await mkdir(join(stateDir, 'takes'), { recursive: true });
await copyFile(join(FILM, 'refs', `${LOCATION.key}.png`), join(stateDir, 'takes', '1.png'));
await select(stateDir, 1);
await copyFile(join(stateDir, 'takes', '1.png'), join(stateDir, 'plate.png'));
console.log(`  locations/${LOCATION.key}/night-storm  plate`);

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

// The prototype spelled out the 180-degree line as prose. Here it is derived
// from where each character sits, so the rule can never disagree with the
// blocking it describes.
const scene = {
  id: 'testamento',
  title: 'El Testamento',
  location: LOCATION.key,
  state: 'night-storm',
  cast: [
    { character: 'rosalinda', look: 'default', side: 'left' },
    { character: 'perpetua', look: 'default', side: 'right' },
  ],
  bed: {
    prompt:
      'Slow, sparse, tense telenovela underscore. Solo nylon-string Spanish guitar playing a ' +
      'simple mournful minor figure, with low sustained cello underneath and a distant tremolo ' +
      'string pad. Minor key, unresolved, quietly ominous. Absolutely no drums, no percussion, ' +
      'no vocals, no brass.',
  },
  shots: SHOTS.map((s) => ({
    id: s.id,
    slate: s.slate,
    duration: s.duration,
    cut: s.cut,
    action: s.action,
    lines: s.lines || [],
    // In the prototype these were spelled out per shot as `images`/`audios`.
    // Here subjects are who is visible, voices default to whoever speaks, and
    // the set plate is added by the prompt builder — so a shot never names a
    // reference it does not actually need.
    subjects: s.images.filter((k) => CAST[k]),
    voices: s.audios,
    chain: s.videos?.[0] ?? null,
  })),
};

await writeJSON(join(OUT, 'episodes', 'e01', 'episode.json'), {
  id: 'e01', title: 'Episode One', scenes: ['testamento'],
});
await writeJSON(join(OUT, 'episodes', 'e01', 'scenes', 'testamento', 'scene.json'), scene);

for (const shot of scene.shots) {
  const dir = join(OUT, 'episodes', 'e01', 'scenes', 'testamento', 'shots', shot.id);
  await mkdir(join(dir, 'takes'), { recursive: true });
  await copyFile(join(FILM, 'shots', `${shot.id}.mp4`), join(dir, 'takes', '1.mp4'));
  if (await exists(join(FILM, 'shots', `${shot.id}.json`))) {
    await copyFile(join(FILM, 'shots', `${shot.id}.json`), join(dir, 'takes', '1.json'));
  }
  await select(dir, 1);
  await copyFile(join(dir, 'takes', '1.mp4'), join(dir, 'selected.mp4'));
  console.log(`  shots/${shot.id}  take 1 selected`);
}

const distDir = join(OUT, 'episodes', 'e01', 'scenes', 'testamento', 'dist');
await mkdir(distDir, { recursive: true });
if (await exists(join(FILM, 'dist', 'bed.mp3'))) {
  await copyFile(join(FILM, 'dist', 'bed.mp3'), join(distDir, 'bed.mp3'));
}

console.log(`\nimported to projects/telenovela`);
