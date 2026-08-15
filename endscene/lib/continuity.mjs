// Objective checks across a scene's shots.
//
// Voice and grade drift are the two failures that survive a careful review,
// because both are gradual: no single shot looks wrong, and the scene as a
// whole feels off in a way people describe as "cheap" without being able to
// point at a frame. Measuring beats squinting.
//
// Everything here is ADVISORY and nothing gates a cut. A wide and a close-up
// legitimately differ in luma; a character genuinely does speak lower when the
// scene asks them to. The report's job is to put a number in front of a human,
// not to have an opinion about whether the take is good.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export async function pitch(file) {
  const { stdout } = await exec('python3', [join(HERE, 'voicecheck.py'), '--json', file]).catch(
    async () => {
      // voicecheck.py prints a table by default; the JSON flag is optional so
      // an older copy still works. Fall back to parsing the table.
      const { stdout } = await exec('python3', [join(HERE, 'voicecheck.py'), file]);
      const m = stdout.match(/([\d.]+)\s*Hz/);
      return { stdout: JSON.stringify(m ? [{ file, median: Number(m[1]) }] : []) };
    },
  );
  try {
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

// Compares each shot a character speaks in against their voice plate. The plate
// is the truth: it was recorded in a dead room, so it is the only measurement
// not contaminated by weather and props.
export async function voiceDrift({ plate, shots, tolerance = 0.10 }) {
  const [ref] = await pitch(plate);
  if (!ref?.median) return { ok: null, reason: 'no voiced speech in the plate' };

  const rows = [];
  for (const s of shots) {
    const [m] = await pitch(s.file);
    if (!m?.median) continue;
    const drift = (m.median - ref.median) / ref.median;
    rows.push({
      shot: s.id,
      hz: m.median,
      driftPct: drift * 100,
      flagged: Math.abs(drift) > tolerance,
    });
  }
  return { plateHz: ref.median, rows, flagged: rows.filter((r) => r.flagged) };
}

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

// Mean luma and saturation per shot, via ffmpeg's own signalstats. Cheap, and
// enough to catch the failure that matters: one shot in a scene that came back
// noticeably brighter or more washed out than its neighbours.
export async function levels(file, { from = 0, to = null } = {}) {
  const args = ['-v', 'error'];
  if (from) args.push('-ss', String(from));
  if (to) args.push('-to', String(to));
  args.push('-i', file, '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-');

  const { stderr, stdout } = await exec(FFMPEG, args, { maxBuffer: 1 << 26 });
  const values = [...`${stdout}${stderr}`.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { meanLuma: mean, frames: values.length };
}

export async function gradeDrift({ shots, tolerance = 18 }) {
  const rows = [];
  for (const s of shots) {
    const l = await levels(s.file, { from: s.in, to: s.out });
    rows.push({ shot: s.id, meanLuma: l?.meanLuma ?? null });
  }
  const pairs = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.meanLuma == null || b.meanLuma == null) continue;
    const delta = Math.abs(a.meanLuma - b.meanLuma);
    pairs.push({ from: a.shot, to: b.shot, delta, flagged: delta > tolerance });
  }
  return { rows, pairs, flagged: pairs.filter((p) => p.flagged) };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

// The failure this catches is specific and was found the hard way: a line that
// runs to the final frame leaves nothing to cut on and risks being clipped. The
// prompt's TIMING rule asks the model not to do that, and the model treats it
// as a suggestion — so it is checked rather than trusted.
export async function speechTail({ shots, minTail = 0.4 }) {
  const { speechSpans } = await import('./subs.mjs');
  const rows = [];
  for (const s of shots) {
    if (!s.lines?.length) continue;
    const spans = await speechSpans(s.file, s.in, s.out);
    if (!spans.length) {
      rows.push({ shot: s.id, tail: null, flagged: true, reason: 'no speech detected' });
      continue;
    }
    const tail = (s.out - s.in) - spans[spans.length - 1].end;
    rows.push({
      shot: s.id, tail,
      flagged: tail < minTail,
      reason: tail < minTail ? 'speech runs to the end of the shot — no handle to cut on' : null,
    });
  }
  return { rows, flagged: rows.filter((r) => r.flagged) };
}

export async function report({ shots, voices = [] }) {
  const [grade, timing] = await Promise.all([
    gradeDrift({ shots }),
    speechTail({ shots }),
  ]);
  const voice = [];
  for (const v of voices) {
    voice.push({
      character: v.character,
      ...(await voiceDrift({ plate: v.plate, shots: shots.filter((s) => v.shots.includes(s.id)) })),
    });
  }
  return { grade, timing, voice, advisory: true };
}
