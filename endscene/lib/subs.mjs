// Subtitles, timed off the audio rather than off the script.
//
// The video model will burn subtitles into a shot and must not be allowed to:
// the show's LOOK clause forbids on-screen text for the same reason the AUDIO
// clause forbids music. Text baked into the picture cannot be corrected,
// restyled, translated or turned off, and it arrives in whatever font and
// position the model felt like. Titling is a post decision.
//
// The interesting half is the timing, and it is where the model's word is worth
// least. Prompts give beats — "3–4.5s: she asks…" — and a rule that speech must
// finish before the end, and both are honoured loosely at best. Observed: a
// take that ran its line into the final frame, and voice plates that did the
// same after being told twice not to. A subtitle placed on the written beat
// drifts off the mouth, which is exactly the kind of detail that makes a thing
// feel cheap.
//
// So nothing here trusts the script for time. lib/speech.py measures where the
// voiced speech actually is; the declared lines are aligned to what it found.
// The script says *what* is said. The audio says *when*.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// The small hangs a human subtitler leaves either side. A cue that vanishes the
// instant the actor stops reads as a flicker.
const LEAD = 0.08;
const TAIL = 0.30;
const MIN_ON = 0.9;

export const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
};

export async function speechSpans(file, from, to) {
  const { stdout } = await exec('python3', [
    join(HERE, 'speech.py'), file, '--from', String(from), '--to', String(to),
  ]);
  return JSON.parse(stdout);
}

// `shots` is [{ id, file, in, out, lines }] in cut order.
export async function build(shots, { languages = ['en', 'es'] } = {}) {
  const cues = [];
  const warnings = [];
  let offset = 0;

  for (const shot of shots) {
    const lines = shot.lines || [];
    if (lines.length) {
      const spans = await speechSpans(shot.file, shot.in, shot.out);
      let placed;

      if (spans.length === lines.length) {
        placed = spans;
      } else if (spans.length) {
        // The detector and the script disagree about how many utterances are in
        // this shot — usually a reshoot that repunctuated a pause. Rather than
        // guess which line is which, spread them across the whole speaking
        // range and say so. Wrong-but-close beats confidently mismatched, and
        // the warning is the cue to re-split the lines.
        const a = spans[0].start;
        const b = spans[spans.length - 1].end;
        const each = (b - a) / lines.length;
        placed = lines.map((_, i) => ({ start: a + i * each, end: a + (i + 1) * each }));
        warnings.push(
          `${shot.id}: found ${spans.length} utterance(s) for ${lines.length} line(s) — spread evenly. Re-split the lines to match where the actor actually pauses.`,
        );
      } else {
        warnings.push(`${shot.id}: no speech detected, skipped its ${lines.length} line(s)`);
        placed = [];
      }

      placed.forEach((span, i) => {
        const start = offset + Math.max(0, span.start - LEAD);
        let end = offset + span.end + TAIL;
        if (end - start < MIN_ON) end = start + MIN_ON;
        // Never let a cue outlive the shot it belongs to; it would sit over the
        // next actor's face.
        cues.push({ start, end: Math.min(end, offset + (shot.out - shot.in)), ...lines[i] });
      });
    }
    offset += shot.out - shot.in;
  }

  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start - 0.02;
  }

  const files = {};
  for (const lang of languages) {
    files[lang] = cues
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c[lang] ?? c.text ?? ''}\n`)
      .join('\n');
  }

  return { cues, files, warnings };
}

export async function write(shots, dir, name, options) {
  const { cues, files, warnings } = await build(shots, options);
  await mkdir(dir, { recursive: true });
  const written = {};
  for (const [lang, body] of Object.entries(files)) {
    const path = join(dir, `${name}.${lang}.srt`);
    await writeFile(path, body, 'utf8');
    written[lang] = path;
  }
  return { cues, written, warnings };
}
