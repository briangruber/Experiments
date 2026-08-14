#!/usr/bin/env node
// Push apart any dialogue cue that now collides, and rewrite src/dialogue.js.
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

const { LINES } = await import(new URL('../src/dialogue.js', import.meta.url));
const { TIMING } = await import(new URL('../src/dialogue-timing.js', import.meta.url));

// Scene durations and paces, read out of the screenplay.
const src = await readFile(join(ROOT, 'src/director.js'), 'utf8');
const sceneRe = /\n    scene\('([^']+)', '[^']*', ([\d.]+),/g;
const scenes = [...src.matchAll(sceneRe)].map((m) => ({ name: m[1], dur: +m[2], pace: 1.32, at: m.index }));
for (const m of src.matchAll(/\n {6}\], \{ pace: ([\d.]+) \}\)/g)) {
  let owner = 0;
  for (let i = 0; i < scenes.length; i++) if (scenes[i].at < m.index) owner = i;
  scenes[owner].pace = +m[1];
}
for (const m of src.matchAll(/\n {6}\{ pace: ([\d.]+) \}\)/g)) {
  let owner = 0;
  for (let i = 0; i < scenes.length; i++) if (scenes[i].at < m.index) owner = i;
  scenes[owner].pace = +m[1];
}

const moves = [];
const overruns = [];
for (let i = 0; i < scenes.length; i++) {
  const scene = scenes[i];
  const lines = LINES.filter((l) => l.scene === i).sort((a, b) => a.at - b.at);
  let freeAt = -Infinity;
  for (const l of lines) {
    const dur = TIMING[l.id] ? TIMING[l.id].dur : 2.5;
    let start = l.at / scene.pace;
    if (start < freeAt) {
      const to = +(freeAt * scene.pace).toFixed(1);
      moves.push({ id: l.id, from: l.at, to, scene: scene.name });
      start = to / scene.pace;
    }
    freeAt = start + dur + GAP;
    if (start + dur > scene.dur / scene.pace) {
      overruns.push({ id: l.id, scene: scene.name, over: +(start + dur - scene.dur / scene.pace).toFixed(2) });
    }
  }
}

for (const m of moves) console.log(`  ${m.id}  ${m.from} -> ${m.to}   (${m.scene})`);
for (const o of overruns) console.log(`  ${o.id}: runs ${o.over}s past the end of ${o.scene} — lengthen the scene`);
if (!moves.length) console.log('  nothing to move');

if (!DRY && moves.length) {
  let text = await readFile(join(ROOT, 'src/dialogue.js'), 'utf8');
  for (const m of moves) {
    const re = new RegExp(`(\\{ id: '${m.id}', scene: \\d+, at: )[\\d.]+`);
    if (!re.test(text)) throw new Error(`could not find ${m.id} to rewrite`);
    text = text.replace(re, `$1${m.to}`);
  }
  await writeFile(join(ROOT, 'src/dialogue.js'), text);
  console.log(`\nrewrote ${moves.length} cue(s) in src/dialogue.js`);
}
process.exit(overruns.length ? 1 : 0);
