#!/usr/bin/env node
// Push apart any dialogue cue that now collides, and rewrite the episode's dialogue.js.
//
//   node tools/fit-dialogue.mjs --dry     # show what would move
//   node tools/fit-dialogue.mjs
//
// Recasting a voice changes every line's length — the deeper announcer runs
// about 60% longer than the one before him — and a line only has as much room
// as the pace of its scene allows. Rather than hand-shuffle fifteen cues and
// re-check by eye, this walks each scene in order and moves a line later only
// if the one before it is still speaking, keeping every other cue on the beat
// it was written for.
//
// It never moves a line earlier: the `at` in the script is where the acting is.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const GAP = 0.3;      // real seconds of silence between two speakers

const { LINES } = await import(new URL('../episodes/e01-corazon/dialogue.js', import.meta.url));
const { TIMING } = await import(new URL('../episodes/e01-corazon/dialogue-timing.js', import.meta.url));
// Scene durations and paces come from the scene modules' meta, via the episode
// manifest; lines reference scenes by id.
const { episode } = await import(new URL('../episodes/e01-corazon/episode.js', import.meta.url));

// Director.pace — scenes that don't override the tempo run at this.
const DEFAULT_PACE = 1.32;

const moves = [];
const overruns = [];
for (const meta of episode.order) {
  const pace = meta.pace ?? DEFAULT_PACE;
  const lines = LINES.filter((l) => l.scene === meta.id).sort((a, b) => a.at - b.at);
  let freeAt = -Infinity;
  for (const l of lines) {
    const dur = TIMING[l.id] ? TIMING[l.id].dur : 2.5;
    let start = l.at / pace;
    if (start < freeAt) {
      const to = +(freeAt * pace).toFixed(1);
      moves.push({ id: l.id, from: l.at, to, scene: meta.name });
      start = to / pace;
    }
    freeAt = start + dur + GAP;
    if (start + dur > meta.dur / pace) {
      overruns.push({ id: l.id, scene: meta.name, over: +(start + dur - meta.dur / pace).toFixed(2) });
    }
  }
}

for (const m of moves) console.log(`  ${m.id}  ${m.from} -> ${m.to}   (${m.scene})`);
for (const o of overruns) console.log(`  ${o.id}: runs ${o.over}s past the end of ${o.scene} — lengthen the scene`);
if (!moves.length) console.log('  nothing to move');

if (!DRY && moves.length) {
  let text = await readFile(join(ROOT, 'episodes/e01-corazon/dialogue.js'), 'utf8');
  for (const m of moves) {
    const re = new RegExp(`(\\{ id: '${m.id}', scene: '[^']+', at: )[\\d.]+`);
    if (!re.test(text)) throw new Error(`could not find ${m.id} to rewrite`);
    text = text.replace(re, `$1${m.to}`);
  }
  await writeFile(join(ROOT, 'episodes/e01-corazon/dialogue.js'), text);
  console.log(`\nrewrote ${moves.length} cue(s) in episodes/e01-corazon/dialogue.js`);
}
process.exit(overruns.length ? 1 : 0);
