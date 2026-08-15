#!/usr/bin/env node
// Build the subtitles, timed off the audio rather than off the script.
//
//   node tools/subs.mjs            # dist/s01-testamento.{en,es}.srt
//
// Seedance can burn subtitles into a shot and must not be allowed to: the
// prompts explicitly forbid on-screen text, because text baked into the
// picture cannot be corrected, restyled, translated or turned off, and it
// arrives in whatever font and position the model felt like. Subtitles are a
// post decision. So we make them ourselves.
//
// The interesting part is the timing. The obvious approach is to place each
// line on the beat the prompt asked for — "3–4.5s: she asks…" — and it does
// not work, because the model treats those beats as a suggestion. The first
// take of 1B ran its line to the final frame; the voice plates did the same
// after being told twice not to. Subtitles placed on the written beat drift
// off the mouth, and a subtitle that leads or lags its actor is exactly the
// sort of detail that makes a thing feel cheap.
//
// So nothing here trusts the script for time. tools/speech.py measures where
// the voiced speech actually is inside each shot's trimmed range, and the
// declared lines are aligned to what it found. The script says *what* is
// said; the audio says *when*.

import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SCENE from '../scenes/s01-testamento/scene.js';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'shots');
const DIST = join(ROOT, 'dist');

// A subtitle that vanishes the instant the actor stops is read as a flicker.
// These are the small hangs a human subtitler leaves either side.
const LEAD = 0.08;
const TAIL = 0.30;
// Even a two-word line needs long enough on screen to be read.
const MIN_ON = 0.9;

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
};

export async function build({ quiet = false } = {}) {
  const cues = [];
  let offset = 0; // where this shot starts on the finished timeline

  for (const shot of SCENE.shots) {
    const from = shot.cut?.in ?? 0;
    const to = shot.cut?.out ?? Number(shot.duration);
    const lines = shot.lines || [];

    if (lines.length) {
      const { stdout } = await exec('python3', [
        join(ROOT, 'tools', 'speech.py'), join(SHOTS, `${shot.id}.mp4`),
        '--from', String(from), '--to', String(to),
      ]);
      const spans = JSON.parse(stdout);

      let placed;
      if (spans.length === lines.length) {
        placed = spans;
      } else if (spans.length) {
        // The detector and the script disagree about how many utterances are
        // in this shot — usually a reshoot that repunctuated a pause. Rather
        // than guess which line is which, spread them evenly across the whole
        // speaking range and say so, loudly. Wrong-but-close beats confidently
        // mismatched, and the warning is the cue to re-split the lines.
        const a = spans[0].start;
        const b = spans[spans.length - 1].end;
        const each = (b - a) / lines.length;
        placed = lines.map((_, i) => ({ start: a + i * each, end: a + (i + 1) * each }));
        if (!quiet) {
          console.warn(`  ! ${shot.id}: found ${spans.length} utterance(s) for ${lines.length} line(s) — spreading evenly. Re-split scene.js lines to match.`);
        }
      } else {
        if (!quiet) console.warn(`  ! ${shot.id}: no speech detected, skipping its ${lines.length} line(s)`);
        placed = [];
      }

      placed.forEach((span, i) => {
        const start = offset + Math.max(0, span.start - LEAD);
        let end = offset + span.end + TAIL;
        if (end - start < MIN_ON) end = start + MIN_ON;
        // Never let a cue run past the shot it belongs to; it would sit over
        // the next actor's face.
        cues.push({ start, end: Math.min(end, offset + (to - from)), ...lines[i] });
      });
    }

    offset += to - from;
  }

  // A cue must never outlive the start of the next one.
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start - 0.02;
  }

  await mkdir(DIST, { recursive: true });
  for (const lang of ['en', 'es']) {
    const body = cues
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c[lang]}\n`)
      .join('\n');
    await writeFile(join(DIST, `${SCENE.id}.${lang}.srt`), body, 'utf8');
  }

  if (!quiet) {
    for (const c of cues) {
      console.log(`  ${srtTime(c.start).slice(3)} → ${srtTime(c.end).slice(3)}  ${c.en}`);
    }
    console.log(`\n  ${cues.length} cue(s)  ->  dist/${SCENE.id}.en.srt, .es.srt`);
  }
  return cues;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`\ntiming subtitles for ${SCENE.title} off the audio\n`);
  await build();
}
