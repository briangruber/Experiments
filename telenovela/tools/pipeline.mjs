#!/usr/bin/env node
// One command from script to postable file.
//
//   node tools/pipeline.mjs e01-corazon
//   node tools/pipeline.mjs e01-corazon --skip-slow          # skip the audio timeline
//   node tools/pipeline.mjs e01-corazon --video --seconds 20 # also render video
//
// The steps run in order and the run stops on the first failure:
//
//   voices   compare each dialogue line against its clip's .mp3.hash sidecar
//            (see voice-hash.mjs) and re-record ONLY what is missing or stale.
//            When nothing changed — the common case — this makes no API call
//            and costs nothing.
//   measure  rewrite the generated timing tables, but only if some mp3 is
//            newer than the table built from it. The tables are committed, so
//            on a clean tree this is a skip.
//   fit      push apart any dialogue cues the measured durations now collide
//            (tools/fit-dialogue.mjs; it only rewrites dialogue.js when a cue
//            actually has to move).
//   check    tools/dialogue-check.mjs, then the full audio timeline unless
//            --skip-slow (it drives the real page through every scene, which
//            takes minutes).
//   bundle   flatten everything into dist/<episode>.html — and for e01 also
//            dist/corazon-de-gallina.html, the name the published page expects.
//   smoke    tools/shot.mjs against the module build and then the bundle under
//            the published CSP, on the first declared beat of three scenes.
//   video    only with --video: tools/render.mjs, trailer then full episode.
//            If the only ffmpeg around is Playwright's stripped build, this
//            step reports why and skips rather than failing the run — the
//            bundle above is still the postable artifact.
//
// Each step prints one line; a summary table lands at the end. Exit code is
// zero only if every step that ran succeeded.

import { spawn } from 'node:child_process';
import { copyFile, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineHash } from './voice-hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- arguments --------------------------------------------------------------

let EP = null, VIDEO = false, SKIP_SLOW = false, SECONDS = null;
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--video') VIDEO = true;
    else if (args[i] === '--skip-slow') SKIP_SLOW = true;
    else if (args[i] === '--seconds') SECONDS = args[++i];
    else if (!args[i].startsWith('--') && !EP) EP = args[i];
    else { console.error(`unknown argument: ${args[i]}`); process.exit(2); }
  }
}
if (!EP) {
  const eps = (await readdir(join(ROOT, 'episodes'), { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name);
  console.error(`usage: node tools/pipeline.mjs <episode> [--video] [--seconds N] [--skip-slow]`);
  console.error(`episodes: ${eps.join(', ')}`);
  process.exit(2);
}
const EP_DIR = join(ROOT, 'episodes', EP);
try { await stat(join(EP_DIR, 'dialogue.js')); } catch {
  console.error(`episodes/${EP}/dialogue.js does not exist — is '${EP}' an episode id?`);
  process.exit(2);
}

// --- plumbing ---------------------------------------------------------------

const summary = [];
let stepName = null, stepT0 = 0;

function begin(name) { stepName = name; stepT0 = Date.now(); }
function done(action) {
  summary.push({ step: stepName, action, secs: (Date.now() - stepT0) / 1000 });
  console.log(`${stepName}: ${action}`);
}
function fail(why, log) {
  summary.push({ step: stepName, action: `FAILED — ${why}`, secs: (Date.now() - stepT0) / 1000 });
  console.error(`${stepName}: FAILED — ${why}`);
  if (log) console.error(log.split('\n').slice(-40).map((l) => '  | ' + l).join('\n'));
  table();
  process.exit(1);
}
function table() {
  const w = Math.max(...summary.map((s) => s.action.length), 6);
  console.log('\nstep      action' + ' '.repeat(w - 4) + 'time');
  for (const s of summary) {
    console.log(`${s.step.padEnd(10)}${s.action.padEnd(w + 2)}${s.secs.toFixed(1)}s`);
  }
}

// Run a tool, capturing both streams so a green step stays one line and a red
// one can show its tail.
function run(argv) {
  return new Promise((res) => {
    const p = spawn(process.execPath, argv, { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
}

const mtime = async (p) => { try { return (await stat(p)).mtimeMs; } catch { return -Infinity; } };
async function newestMp3(dir) {
  let files; try { files = await readdir(dir); } catch { return -Infinity; }
  let newest = -Infinity;
  for (const f of files) if (f.endsWith('.mp3')) newest = Math.max(newest, await mtime(join(dir, f)));
  return newest;
}
const mb = async (p) => ((await stat(p)).size / 1048576).toFixed(1) + ' MB';

// --- 1 · voices -------------------------------------------------------------
// A line is stale when its clip is missing, has no sidecar, or the sidecar's
// hash no longer matches what dialogue.js would have voices.mjs render. Only
// stale lines cost an API call; a clean script costs nothing.

begin('voices');
const { LINES, VOICES } = await import(new URL(`../episodes/${EP}/dialogue.js`, import.meta.url));
const stale = [];
for (const line of LINES) {
  const clip = join(EP_DIR, 'voice', `${line.id}.mp3`);
  const want = lineHash(line, VOICES);
  const have = await readFile(clip + '.hash', 'utf8').then((s) => s.trim()).catch(() => null);
  if (await mtime(clip) === -Infinity) stale.push({ id: line.id, why: 'no clip on disk' });
  else if (!have) stale.push({ id: line.id, why: 'no .hash sidecar' });
  else if (have !== want) stale.push({ id: line.id, why: 'text or voice changed' });
}
if (!stale.length) {
  done(`${LINES.length} up to date`);
} else {
  console.log(`voices: ${stale.length} stale — ${stale.map((s) => `${s.id} (${s.why})`).join(', ')}`);
  for (const s of stale) {
    const r = await run(['tools/voices.mjs', '--episode', EP, '--only', s.id, '--force']);
    if (r.code) fail(`recording ${s.id}`, r.out);
  }
  done(`re-recorded ${stale.length} of ${LINES.length}`);
}

// --- 2 · measure ------------------------------------------------------------
// The timing tables are generated but committed, so a clean tree skips this.
// An mp3 newer than the table built from it means someone (usually step 1)
// re-recorded, and the measurements have to follow.

begin('measure');
const voiceNewest = await newestMp3(join(EP_DIR, 'voice'));
const libNewest = await newestMp3(join(ROOT, 'company/library/audio'));
const ran = [];
if (voiceNewest > await mtime(join(EP_DIR, 'dialogue-timing.js'))) {
  const r = await run(['tools/voices.mjs', '--episode', EP, '--measure-only']);
  if (r.code) fail('re-measuring the dialogue', r.out);
  ran.push('dialogue-timing.js');
}
if (Math.max(voiceNewest, libNewest) > await mtime(join(ROOT, 'company/library/audio-timing.js'))) {
  const r = await run(['tools/measure-audio.mjs']);
  if (r.code) fail('re-measuring the one-shots', r.out);
  ran.push('audio-timing.js');
}
done(ran.length ? `rewrote ${ran.join(' + ')}` : 'skipped — timing tables are newer than every mp3');

// --- 3 · fit ----------------------------------------------------------------

begin('fit');
{
  const r = await run(['tools/fit-dialogue.mjs', '--episode', EP]);
  if (r.code) fail('a line runs past the end of its scene — lengthen it', r.out);
  const moved = r.out.match(/rewrote (\d+) cue/);
  if (moved) {
    for (const l of r.out.split('\n').filter((l) => / -> /.test(l))) console.log(`fit:${l}`);
    done(`moved ${moved[1]} cue(s) in dialogue.js`);
  } else done('nothing to move');
}

// --- 4 · check --------------------------------------------------------------

begin('check');
{
  const r = await run(['tools/dialogue-check.mjs', '--episode', EP]);
  if (r.code) fail('dialogue overlaps', r.out);
  if (SKIP_SLOW) done('no overlaps (audio timeline skipped: --skip-slow)');
  else {
    const t = await run(['tools/audio-timeline.mjs']);
    if (t.code) fail('audio timeline', t.out);
    done('no overlaps; nothing masked, nothing doubled');
  }
}

// --- 5 · bundle -------------------------------------------------------------

begin('bundle');
const BUNDLE = `dist/${EP}.html`;
{
  const r = await run(['tools/bundle.mjs', '--out', BUNDLE]);
  if (r.code) fail('bundling', r.out);
  // The published artifact was named before episodes had ids; redeploys of it
  // expect the same file name, so e01 keeps writing both.
  let also = '';
  if (EP === 'e01-corazon') {
    await copyFile(join(ROOT, BUNDLE), join(ROOT, 'dist/corazon-de-gallina.html'));
    also = ' (+ dist/corazon-de-gallina.html)';
  }
  done(`${BUNDLE} · ${await mb(join(ROOT, BUNDLE))}${also}`);
}

// --- 6 · smoke --------------------------------------------------------------
// The first declared beat of three scenes — first, middle, last — which spans
// the episode without paying for a full contact sheet. The module build proves
// the sources; the bundle under --csp proves what will actually be published:
// shot.mjs exits non-zero there unless every frame is lit, fetch() really is
// blocked, every one-shot decoded, exactly one bed is live and the opening bed
// survived pressing play.

begin('smoke');
{
  const { episode } = await import(new URL(`../episodes/${EP}/episode.js`, import.meta.url));
  const order = episode.order.filter((m) => m.beats && m.beats.length);
  const picks = [...new Set([0, Math.floor(order.length / 2), order.length - 1])].map((i) => order[i]);
  const frames = picks.map((m) => `${m.id}:${m.beats[0]}`).join(',');

  const m = await run(['tools/shot.mjs', '--out', 'shots/pipeline-module.png', '--frames', frames]);
  if (m.code) fail('module build', m.out);

  const b = await run(['tools/shot.mjs', '--page', '/' + BUNDLE, '--csp',
    '--out', 'shots/pipeline-bundle.png', '--frames', frames]);
  if (b.code) fail('bundle under CSP', b.out);
  // Belt and braces: re-assert the CSP facts from the report rather than
  // trusting the exit code to keep meaning what it means today.
  let rep = null;
  try { rep = JSON.parse(b.out.slice(b.out.indexOf('{\n  "ok"'))); } catch { /* asserted below */ }
  if (!rep || rep.ok !== true || rep.audio?.fetchBlocked !== true || rep.audio?.beds !== 1
    || (rep.audio?.wantOpeningBed && rep.audio.openingBed !== rep.audio.wantOpeningBed)) {
    fail('bundle report missing an assertion', JSON.stringify(rep?.audio ?? rep));
  }
  done(`${frames} ok in both builds; CSP: fetch blocked, 1 bed, opening ${rep.audio.openingBed}`);
}

// --- 7 · video --------------------------------------------------------------

begin('video');
if (!VIDEO) {
  done('skipped (pass --video to render)');
} else {
  // These messages are render.mjs saying, precisely, that the box has no
  // capable ffmpeg. That is this sandbox, not a broken piece — the run keeps
  // its green with a note instead of failing on hardware it does not have.
  const NO_FFMPEG = /cannot decode JPEG|no usable video encoder|could not run ffmpeg/;
  const made = [];
  let skipped = null;
  for (const cut of ['trailer', 'episode']) {
    const argv = ['tools/render.mjs', '--cut', cut];
    if (SECONDS) argv.push('--seconds', SECONDS);
    const r = await run(argv);
    if (r.code && NO_FFMPEG.test(r.out)) {
      skipped = r.out.split('\n').find((l) => NO_FFMPEG.test(l)).trim();
      break;
    }
    if (r.code) fail(`rendering the ${cut}`, r.out);
    const outLine = r.out.split('\n').findLast((l) => /\.(mp4|webm)$/.test(l.trim()));
    made.push(outLine ? outLine.trim() : cut);
  }
  if (skipped) done(`skipped — ${skipped}`);
  else done(made.map((p) => p.replace(ROOT + '/', '')).join(' + '));
}

table();
