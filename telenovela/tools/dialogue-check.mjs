#!/usr/bin/env node
// Does the dialogue fit? Cue times are scene-seconds and the voice runs on the
// wall clock, so a scene at pace 1.32 gives a line only 1/1.32 of the gap the
// script appears to leave it. This converts every cue to real time and reports
// where one character talks over the next — and where a line runs past the end
// of its own scene.
//
//   node tools/dialogue-check.mjs
//
// Exits non-zero if anything overlaps, so it can sit in front of a build.
//
// One caveat it does not model: a scene that calls setSpeed() stretches real
// time for every cue after it, so LA BOFETADA's lines from the slap onward have
// far more room than this reports. The error is in the safe direction.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { LINES } = await import(new URL('../episodes/e01-corazon/dialogue.js', import.meta.url));
const { TIMING } = await import(new URL('../episodes/e01-corazon/dialogue-timing.js', import.meta.url));

// Scene lengths and paces, read out of the screenplay rather than duplicated.
const src = await readFile(join(ROOT, 'episodes/e01-corazon/screenplay.js'), 'utf8');
const scenes = [...src.matchAll(/\n    scene\('([^']+)', '[^']*', ([\d.]+),/g)].map((m) => ({
  name: m[1], dur: +m[2], pace: 1.32,
}));
// Scenes that override the tempo close with `], { pace: N })`.
const overrides = [...src.matchAll(/\n {6}\], \{ pace: ([\d.]+) \}\)/g)].map((m) => +m[1]);
{
  // Match each override to its scene by source position.
  const sceneAt = [...src.matchAll(/\n    scene\('([^']+)'/g)].map((m) => m.index);
  const overAt = [...src.matchAll(/\n {6}\], \{ pace: [\d.]+ \}\)/g)].map((m) => m.index);
  for (let i = 0; i < overAt.length; i++) {
    let owner = 0;
    for (let s = 0; s < sceneAt.length; s++) if (sceneAt[s] < overAt[i]) owner = s;
    scenes[owner].pace = overrides[i];
  }
}
// The credits scene sets its pace inline.
const creditsPace = src.match(/\}, \{ pace: ([\d.]+) \}\)/);
if (creditsPace && scenes[6]) scenes[6].pace = +creditsPace[1];

const GAP = 0.25;      // the shortest silence that still reads as a new speaker
let problems = 0;

for (let s = 0; s < scenes.length; s++) {
  const scene = scenes[s];
  const lines = LINES.filter((l) => l.scene === s).sort((a, b) => a.at - b.at);
  if (!lines.length) continue;
  console.log(`\n${scene.name}  (${scene.dur}s at pace ${scene.pace} = ${(scene.dur / scene.pace).toFixed(1)}s real)`);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = TIMING[l.id];
    if (!t) { console.log(`  ${l.id}: NO TIMING — clip missing`); problems++; continue; }
    const start = l.at / scene.pace;
    const end = start + t.dur;
    const next = lines[i + 1];
    let note = '';
    if (next) {
      const nextStart = next.at / scene.pace;
      const slack = nextStart - end;
      if (slack < GAP) {
        note = `  <-- OVERLAPS ${next.id} by ${(GAP - slack).toFixed(2)}s`;
        problems++;
      } else if (slack > 8) {
        note = `  (${slack.toFixed(1)}s of silence)`;
      }
    }
    if (end > scene.dur / scene.pace) {
      note += `  <-- RUNS ${(end - scene.dur / scene.pace).toFixed(2)}s PAST THE SCENE`;
      problems++;
    }
    console.log(`  ${l.id}  ${start.toFixed(1)}–${end.toFixed(1)}s  ${l.who.padEnd(10)} ${t.dur.toFixed(2)}s${note}`);
  }
}

console.log(problems ? `\n${problems} problem(s)` : '\nno overlaps');
process.exit(problems ? 1 : 0);
