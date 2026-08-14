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

const { LINES } = await import(new URL('../episodes/e01-corazon/dialogue.js', import.meta.url));
const { TIMING } = await import(new URL('../episodes/e01-corazon/dialogue-timing.js', import.meta.url));
// Scene lengths and paces come straight from each scene module's meta, via the
// episode manifest — the numbers the director actually plays, not a regex over
// the source. Lines reference scenes by id, so an inserted or reordered scene
// changes nothing here.
const { episode } = await import(new URL('../episodes/e01-corazon/episode.js', import.meta.url));

// Director.pace — scenes that don't override the tempo run at this.
const DEFAULT_PACE = 1.32;

const GAP = 0.25;      // the shortest silence that still reads as a new speaker
let problems = 0;

for (const meta of episode.order) {
  const pace = meta.pace ?? DEFAULT_PACE;
  const lines = LINES.filter((l) => l.scene === meta.id).sort((a, b) => a.at - b.at);
  if (!lines.length) continue;
  console.log(`\n${meta.name}  (${meta.dur}s at pace ${pace} = ${(meta.dur / pace).toFixed(1)}s real)`);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = TIMING[l.id];
    if (!t) { console.log(`  ${l.id}: NO TIMING — clip missing`); problems++; continue; }
    const start = l.at / pace;
    const end = start + t.dur;
    const next = lines[i + 1];
    let note = '';
    if (next) {
      const nextStart = next.at / pace;
      const slack = nextStart - end;
      if (slack < GAP) {
        note = `  <-- OVERLAPS ${next.id} by ${(GAP - slack).toFixed(2)}s`;
        problems++;
      } else if (slack > 8) {
        note = `  (${slack.toFixed(1)}s of silence)`;
      }
    }
    if (end > meta.dur / pace) {
      note += `  <-- RUNS ${(end - meta.dur / pace).toFixed(2)}s PAST THE SCENE`;
      problems++;
    }
    console.log(`  ${l.id}  ${start.toFixed(1)}–${end.toFixed(1)}s  ${l.who.padEnd(10)} ${t.dur.toFixed(2)}s${note}`);
  }
}

// A line homed to a scene id that is not in the episode would otherwise be
// silently skipped by the per-scene loops above.
for (const l of LINES) {
  if (!episode.order.some((m) => m.id === l.scene)) {
    console.log(`\n${l.id}: scene '${l.scene}' is not in the episode`);
    problems++;
  }
}

console.log(problems ? `\n${problems} problem(s)` : '\nno overlaps');
process.exit(problems ? 1 : 0);
