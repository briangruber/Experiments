// Bootstrap: build the world, run the episode, wire the few controls.

import * as THREE from '../vendor/three/three.module.min.js';
import { buildSet, updateSet } from '../company/sets/courtyard.js';
import { dressSet, updateDressing } from '../company/props/dressing.js';
import { buildCast } from '../company/cast/index.js';
import { buildWeather, updateWeather } from './weather.js';
import { Cinematographer } from './camera.js';
import { Post } from './post.js';
import { Score } from './score.js';
import { Soundtrack } from './audio.js';
import { Titles } from './titles.js';
import { Director, buildProps } from './director.js';
import { episode } from '../episodes/e01-corazon/episode.js';
import { Recorder, deliver, canDeliver, formatLabel, saveCapBytes } from './record.js';
import { exportSteppedVideo, probeSteppedExport, wavBytes } from './exporter.js';
import { drawCards } from './cards.js';
import { clamp } from './util.js';

const canvas = document.getElementById('gl');
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
const overlay = document.getElementById('overlay');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;   // the composite pass does the grade
renderer.setClearColor(0x05070f, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 16 / 9, 0.05, 200);

const set = buildSet(scene, renderer);
const actors = buildCast(scene);
const props = buildProps(scene);
const weather = buildWeather(scene);
const cam = new Cinematographer(camera);
cam.obstacles = set.obstacles;
const titles = new Titles();

// The cards are drawn, not DOM: a transparent canvas above #gl, painted every
// frame by the same drawCards() the export mixer and the offline renderer use,
// so what the page shows and what a file carries cannot drift apart. It lives
// inside #overlay, which the 'no-ui' class deliberately does not touch —
// captions are content, not chrome, and hiding the interface (or recording,
// which does the same) must not hide them.
const cardCanvas = document.createElement('canvas');
overlay.appendChild(cardCanvas);
const cardCtx = cardCanvas.getContext('2d');
let cardsDrawn = false;
function drawOverlay() {
  const w = cardCanvas.width, h = cardCanvas.height;
  // Nothing live and nothing lingering: skip the clear-and-repaint entirely,
  // which is most frames of most scenes.
  if (!titles.cards.length && !cardsDrawn) return;
  cardCtx.clearRect(0, 0, w, h);
  cardsDrawn = false;
  for (const c of titles.cards) if (c.alpha > 0.002) cardsDrawn = true;
  if (cardsDrawn) drawCards(cardCtx, titles, w, h);
}
// The generated soundtrack, with the procedural synth standing by in case the
// audio can't be fetched or decoded (opening index.html off the filesystem,
// say). Both present the same surface, so the director never has to know.
const soundtrack = new Soundtrack();
const synth = new Score();

let dpr = 1, width = 0, height = 0;
const post = new Post(renderer, 1280, 720);

const ctx = { scene, camera, renderer, set, actors, props, weather, cam, post, score: soundtrack, titles };

// The modelled props load over the procedural courtyard. If they never arrive,
// the piece is exactly what it was before them.
const dressed = dressSet(set).catch((e) => {
  console.warn('set dressing unavailable:', e.message);
  return null;
});
const dir = new Director(ctx, episode);
ctx.dir = dir;
// The export cuts come from the episode too; the recorder only ever sees
// whichever one is being played out.
const CUTS = episode.cuts;

// --- sizing ----------------------------------------------------------------

let quality = 1;
function resize() {
  const w = Math.max(320, window.innerWidth);
  const h = Math.max(240, window.innerHeight);
  dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
  width = Math.floor(w * dpr);
  height = Math.floor(h * dpr);
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, true);
  canvas.width = width; canvas.height = height;
  renderer.setSize(width, height, false);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  cam.setAspect(w / h);
  post.setSize(width, height);
  // The caption overlay renders at the device's real resolution — not scaled
  // by the adaptive `quality` knob, which trades scene pixels for frame rate;
  // text is cheap to draw and blurry captions read as a bug. drawCards() is
  // handed the BACKING size, so type is sized against the same pixels it is
  // rasterised into and stays crisp on a retina display; at 1x the backing
  // equals the client size and the clamps behave exactly as the export's do.
  const cardDpr = Math.min(window.devicePixelRatio || 1, 2);
  cardCanvas.width = Math.floor(w * cardDpr);
  cardCanvas.height = Math.floor(h * cardDpr);
  cardCanvas.style.width = w + 'px';
  cardCanvas.style.height = h + 'px';
  cardsDrawn = false;   // resizing wipes the canvas; repaint on the next frame
}
window.addEventListener('resize', resize);
resize();

// --- HUD -------------------------------------------------------------------

const hud = {
  scene: document.getElementById('hud-scene'),
  shot: document.getElementById('hud-shot'),
  fps: document.getElementById('hud-fps'),
  bar: document.getElementById('progress-bar'),
  chapters: document.getElementById('chapters'),
};

dir.onScene = (s, i) => {
  hud.scene.textContent = `${i + 1}. ${s.name}`;
  for (const [k, el] of chapterButtons.entries()) el.classList.toggle('on', k === i);
};

const chapterButtons = new Map();
dir.scenes.forEach((s, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = s.name;
  b.title = s.subtitle;
  b.addEventListener('click', () => { if (offline) return; startAudio(); dir.goTo(i); });
  hud.chapters.appendChild(b);
  chapterButtons.set(i, b);
});

// --- controls ---------------------------------------------------------------

let showUI = true;
function setUI(v) {
  showUI = v;
  document.body.classList.toggle('no-ui', !v);
}

const playBtn = document.getElementById('play');
const startCard = document.getElementById('start');

let audioStarted = false;
async function startAudio() {
  if (audioStarted) return;
  audioStarted = true;
  const ok = await soundtrack.start();
  if (!ok) { ctx.score = synth; synth.start(); }
  // Which engine actually came up. A silent fall back to the synth once went
  // unnoticed for a whole release, so say so somewhere findable.
  soundBtn.title = ok ? 'Sound (M) · ElevenLabs' : 'Sound (M) · synth fallback';
  // Whatever the scene on screen asked for while the audio was still coming
  // up — not a hardcoded mood. This said 'theme', which was right for exactly
  // as long as the episode opened on PRELUDIO; once the sung titles became
  // scene 0 it crossfaded the opening song out a beat after it started, and
  // the song was only ever audible on the replay, when this path is skipped.
  ctx.score.setMood(soundtrack.mood ?? 'theme', 3);
}

function begin() {
  if (offline) return;
  startCard.classList.add('gone');
  running = true;
  dir.goTo(0);
  startAudio();
}
playBtn.addEventListener('click', begin);

// The transport is inert while the stepped exporter owns the world — a scene
// jump mid-render would splice itself into the file.
document.getElementById('btn-prev').addEventListener('click', () => { if (!offline) dir.prev(); });
document.getElementById('btn-next').addEventListener('click', () => { if (!offline) dir.next(); });
const pauseBtn = document.getElementById('btn-pause');
pauseBtn.addEventListener('click', () => {
  if (offline) return;
  dir.paused = !dir.paused;
  pauseBtn.textContent = dir.paused ? '▶' : '❚❚';
  if (dir.paused) ctx.score.suspend(); else ctx.score.resume();
});
const soundBtn = document.getElementById('btn-sound');
let sound = true;
soundBtn.addEventListener('click', () => {
  sound = !sound;
  ctx.score.setEnabled(sound);
  soundBtn.textContent = sound ? '♪' : '✕';
  soundBtn.classList.toggle('off', !sound);
});

// --- video export -----------------------------------------------------------

const recorder = new Recorder();
const exportPanel = document.getElementById('export-panel');
const recBar = document.getElementById('rec');
const recLabel = document.getElementById('rec-label');
const recTime = document.getElementById('rec-time');
const exportBtn = document.getElementById('btn-export');

// program: null when not recording, otherwise the shot list being played out.
let program = null;
// stepped: null when idle, otherwise the WebCodecs export in flight.
let stepped = null;

// Whether this browser can drive the stepped exporter, probed once at the
// trailer's size — it is the larger frame, so a yes here covers both cuts.
// The answer only shows the button and rewrites the panel's fine print; each
// export re-probes at its own dimensions before committing.
const steppedProbe = probeSteppedExport({ width: 1280, height: 720, fps: 30 })
  .catch(() => ({ ok: false }));

exportBtn.hidden = true;
Promise.all([canDeliver(), steppedProbe]).then(([ok, probe]) => {
  exportBtn.hidden = !(ok && (Recorder.supported || probe.ok));
  // The realtime warning is wrong for the stepped path: it runs faster than
  // the piece and survives a hidden tab.
  const note = exportPanel.querySelector('.export-note');
  if (note && probe.ok) note.textContent = 'Exportación acelerada: más rápida que verla. Puedes cambiar de pestaña.';
});
exportBtn.addEventListener('click', () => { exportPanel.hidden = false; });
document.getElementById('export-close').addEventListener('click', () => { exportPanel.hidden = true; });
document.getElementById('rec-stop').addEventListener('click', () => {
  if (stepped) { stepped.cancelled = true; recLabel.textContent = 'cancelando…'; return; }
  finishRecording('cancelado');
});
for (const b of exportPanel.querySelectorAll('[data-cut]')) {
  b.addEventListener('click', () => startExport(b.dataset.cut));
  // The panel's markup carries a length, and nothing was updating it — it had
  // been advertising 4:25 since the episode grew past five minutes. CUTS is the
  // only place that number should live.
  const note = b.querySelector('.cut-note');
  const cut = CUTS[b.dataset.cut];
  if (note && cut) note.textContent = cut.note + (b.dataset.cut === 'trailer' ? ' · para redes' : '');
}

// One button, two engines. The stepped WebCodecs exporter is preferred — it is
// deterministic and faster than realtime on hardware with an H.264 encoder —
// and the realtime recorder stays exactly what it was for everything else,
// including the one case where the stepped path cannot keep its promise: on a
// published page a long cut at the bitrate floor cannot land under the 16 MiB
// save ceiling, and the realtime recorder is the path whose budget the user
// already accepts there.
async function startExport(cutName) {
  const cut = CUTS[cutName];
  if (!cut || program || stepped) return;
  let probe = null;
  try { probe = await probeSteppedExport({ width: cut.width, height: cut.height, fps: 30 }); } catch { probe = null; }
  if (probe && probe.ok) {
    const capBytes = await saveCapBytes();
    const seconds = cut.segments
      ? cut.segments.reduce((a, s) => a + s[2], 0)
      : dir.scenes.reduce((a, s) => a + s.dur / (s.pace ?? dir.pace), 0);
    const floored = capBytes > 0
      && (capBytes * 8) / Math.max(20, seconds) - (probe.audio ? 160_000 : 0) < 220_000;
    if (!floored || !Recorder.supported) return startSteppedExport(cutName, cut, probe, capBytes);
  }
  return startRecording(cutName);
}

async function startSteppedExport(cutName, cut, probe, capBytes) {
  exportPanel.hidden = true;
  stepped = { cancelled: false };
  recBar.hidden = false;
  recLabel.textContent = `EXPORTANDO · MP4 · H.264${probe.audio ? ' + AAC' : ''}`;
  recTime.textContent = '…';
  const t0 = performance.now();
  let res;
  try {
    res = await exportSteppedVideo({
      cut, width: cut.width, height: cut.height, fps: 30,
      // A megabyte of headroom under the ceiling, the same margin the
      // realtime recorder's TARGET_BYTES keeps.
      maxBytes: capBytes ? capBytes - 2 * 1024 * 1024 : 0,
      world: offlineWorld,
      cancelled: () => stepped.cancelled,
      onProgress: ({ phase, done, total }) => {
        recTime.textContent = phase === 'audio' ? 'sonido…' : `${done} / ${total} cuadros`;
      },
    });
  } catch (e) {
    res = { ok: false, reason: (e && e.message) || String(e) };
  }
  offlineEnd();   // safety net — the exporter calls world.end() itself
  stepped = null;
  if (!res.ok) {
    recBar.hidden = true;
    if (res.cancelled) return;
    // Probed fine but failed anyway (an encoder quirk, b-frames the muxer
    // refuses). The realtime recorder still works; use it rather than losing
    // the export.
    console.warn('stepped export failed, falling back to realtime:', res.reason);
    if (Recorder.supported) return startRecording(cutName);
    return;
  }
  const blob = new Blob([res.bytes], { type: 'video/mp4' });
  const wall = +(((performance.now() - t0) / 1000).toFixed(1));
  window.__lastExport = {
    cut: cutName, stepped: true, frames: res.frames, wall,
    fps: +(res.frames / Math.max(0.1, wall)).toFixed(1),
    mb: +(blob.size / 1048576).toFixed(1), codec: res.codec, silent: res.silent,
  };
  recLabel.textContent = `${res.frames} cuadros · ${wall}s${res.silent ? ' · sin sonido (AAC no disponible)' : ''}`;
  recTime.textContent = `${(blob.size / 1048576).toFixed(1)} MB`;
  setTimeout(() => { if (!program && !stepped) recBar.hidden = true; }, 9000);
  const saved = await deliver(blob, `corazon-de-gallina-${cutName}.mp4`);
  // No AAC encoder: the mp4 is silent, so the mixed soundtrack rides along as
  // a WAV rather than being lost.
  if (saved.ok && res.silent && res.wav) {
    await deliver(new Blob([res.wav], { type: 'audio/wav' }), `corazon-de-gallina-${cutName}.wav`);
  }
  const failure = {
    too_large: 'archivo demasiado grande',
    blocked: 'descarga bloqueada aquí — abre la página fuera del marco',
    declined: 'guardado cancelado',
    error: 'no se pudo guardar',
  }[saved.how];
  if (!saved.ok && failure) {
    recLabel.textContent = failure;
    recTime.textContent = `${(blob.size / 1048576).toFixed(1)} MB`;
    recBar.hidden = false;
    setTimeout(() => { if (!stepped) recBar.hidden = true; }, 6000);
  }
}

async function startRecording(cutName) {
  const cut = CUTS[cutName];
  if (!cut || program || stepped) return;
  exportPanel.hidden = true;

  // The export is the thing being watched now; give it the whole window and
  // full sound, and get the audio graph running before the first frame.
  await startAudio();
  const wasMuted = !sound;
  if (wasMuted) { sound = true; ctx.score.setEnabled(true); soundBtn.textContent = '♪'; soundBtn.classList.remove('off'); }
  document.body.classList.add('no-ui');

  const seconds = cut.segments
    ? cut.segments.reduce((a, s) => a + s[2], 0)
    : dir.scenes.reduce((a, s) => a + s.dur / (s.pace ?? dir.pace), 0);

  const ok = recorder.start({
    width: cut.width, height: cut.height, seconds,
    audioStream: ctx.score.captureStream ? ctx.score.captureStream() : null,
  });
  if (!ok) {
    document.body.classList.remove('no-ui');
    exportPanel.hidden = false;
    return;
  }

  if (!cut.segments) dir.goTo(0);   // the full episode always starts at the top
  program = { cut, cutName, seconds, elapsed: 0, index: -1, segT: 0, wasMuted };
  document.addEventListener('visibilitychange', onHiddenWhileRecording);
  recBar.hidden = false;
  recLabel.textContent = `${cut.label} · ${formatLabel(recorder.mime)}`;
  running = true;
  startCard.classList.add('gone');
  advanceProgram(0);
}

// Drive the shot list. A trailer jumps between beats, which is exactly how the
// genre advertises itself; the full episode just plays.
function advanceProgram(dt) {
  const p = program;
  if (!p) return;
  p.elapsed += dt;
  recTime.textContent = `${Math.floor(p.elapsed / 60)}:${String(Math.floor(p.elapsed % 60)).padStart(2, '0')} / ${Math.floor(p.seconds / 60)}:${String(Math.round(p.seconds % 60)).padStart(2, '0')}`;

  if (!p.cut.segments) {
    if (p.elapsed >= p.seconds + 1) finishRecording();
    return;
  }
  p.segT += dt;
  const seg = p.cut.segments[p.index];
  if (p.index < 0 || (seg && p.segT >= seg[2])) {
    p.index++;
    p.segT = 0;
    const next = p.cut.segments[p.index];
    if (!next) { finishRecording(); return; }
    dir.goTo(next[0]);
    // Fast-forward inside the scene without rendering, so the segment starts
    // on its beat rather than at the top of the act.
    seekWithin(next[1]);
  }
}

// Recording only works while the page is on screen: a hidden tab stops
// requestAnimationFrame, so no frames are drawn or captured while the audio and
// the clock keep running. Stop rather than write a file that is minutes long
// and three frames deep.
function onHiddenWhileRecording() {
  if (program && document.visibilityState === 'hidden') finishRecording('interrumpido: la pestaña se ocultó');
}

async function finishRecording(note) {
  const p = program;
  if (!p) return;
  program = null;
  document.removeEventListener('visibilitychange', onHiddenWhileRecording);
  recLabel.textContent = note || 'codificando…';
  const stats = recorder.stats(null);
  const blob = await recorder.finish();
  const info = { ...stats, mb: blob ? +(blob.size / 1048576).toFixed(1) : 0, cut: p.cutName };
  window.__lastExport = info;
  recBar.hidden = true;
  document.body.classList.remove('no-ui');
  if (p.wasMuted) { sound = false; ctx.score.setEnabled(false); soundBtn.textContent = '✕'; soundBtn.classList.add('off'); }
  if (!blob || !blob.size) return;
  const name = `corazon-de-gallina-${p.cutName}.${recorder.extension}`;
  // Effective frame rate is the number that says whether the file is any good;
  // near zero means the capture starved and the clip will be a still.
  recLabel.textContent = `${info.frames} cuadros · ${info.fps}/s · ${info.wall}s`;
  recTime.textContent = `${info.mb} MB`;
  recBar.hidden = false;
  setTimeout(() => { if (!program) recBar.hidden = true; }, 9000);
  const res = await deliver(blob, name);
  const failure = {
    too_large: 'archivo demasiado grande',
    blocked: 'descarga bloqueada aquí — abre la página fuera del marco',
    declined: 'guardado cancelado',
    error: 'no se pudo guardar',
  }[res.how];
  if (!res.ok && failure) {
    recLabel.textContent = failure;
    recTime.textContent = `${(blob.size / 1048576).toFixed(1)} MB`;
    recBar.hidden = false;
    setTimeout(() => { recBar.hidden = true; }, 6000);
  }
}

window.addEventListener('keydown', (e) => {
  if (offline) return;   // the stepped exporter owns the world; see the transport guards
  if (e.key === 'h' || e.key === 'H') setUI(!showUI);
  else if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); }
  else if (e.key === 'ArrowRight') dir.next();
  else if (e.key === 'ArrowLeft') dir.prev();
  else if (e.key === 'm' || e.key === 'M') soundBtn.click();
  else if (e.key === 'r' || e.key === 'R') dir.restart();
  // Number keys cover however many scenes the episode has (nine at most —
  // there is only one row of digits).
  else if (e.key >= '1' && e.key <= String(Math.min(9, dir.scenes.length))) dir.goTo(+e.key - 1);
  else if (e.key === 'Enter' && !running) begin();
});

// --- loop -------------------------------------------------------------------

// The capture harness has to sample the canvas inside the same frame as the
// draw; a WebGL canvas reads back black once the compositor has swapped.
let grabWaiters = [];
function drainGrab() {
  if (!grabWaiters.length) return;
  const c = canvas;
  const s = document.createElement('canvas');
  s.width = 240;
  s.height = Math.max(1, Math.round((240 * c.height) / c.width));
  const g2 = s.getContext('2d');
  g2.drawImage(c, 0, 0, s.width, s.height);
  const d = g2.getImageData(0, 0, s.width, s.height).data;
  let sum = 0, min = 255, max = 0, sat = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; min = Math.min(min, l); max = Math.max(max, l);
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    sat += mx ? (mx - mn) / mx : 0;
    n++;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    varSum += (l - mean) ** 2;
  }
  const stats = {
    meanLuma: +mean.toFixed(2), stdLuma: +Math.sqrt(varSum / n).toFixed(2),
    minLuma: +min.toFixed(1), maxLuma: +max.toFixed(1), meanSat: +(sat / n).toFixed(3),
    shot: cam.label, scene: hud.scene.textContent,
  };
  for (const w of grabWaiters) w(stats);
  grabWaiters = [];
}

// Run the world forward without drawing, so a seek lands on its beat with the
// springs, gestures and grade already settled.
function seekWithin(sceneSeconds) {
  const step = 1 / 60;
  // Fast-forwarding passes every cue in between; let the music and the state
  // follow along, but do not fire the one-shots.
  const score = ctx.score;
  const wasScheduling = score.scheduling;
  score.scheduling = false;
  try {
    for (let guard = 0; dir.t < sceneSeconds && guard < 30000; guard++) {
      const sdt = dir.update(step);
      time += sdt;
      if (sdt > 0) {
        for (const k in actors) actors[k].update(sdt, time, step);
        updateSet(set, sdt, time);
        updateDressing(set, sdt);
        updateWeather(weather, sdt, time, set);
        cam.update(sdt, time);
      }
      titles.update(step);
      post.grade(step);
    }
  } finally {
    score.scheduling = wasScheduling;
    for (const k in actors) actors[k].hush();
  }
}

let running = false;
let offline = null;      // set while tools/render.mjs is driving
let last = performance.now() / 1000;
let time = 0;
let fpsAcc = 0, fpsN = 0, fpsShown = 0;
let slowFrames = 0;

function frame() {
  requestAnimationFrame(frame);
  if (offline) return;   // the offline renderer drives the world itself
  const now = performance.now() / 1000;
  // Normally a big step means the tab was hidden and the world should not leap.
  // While recording, though, the audio runs on the wall clock no matter what we
  // do, so the world has to as well or the two drift apart; a slow machine gets
  // a choppy video rather than a desynchronised one.
  let dt = clamp(now - last, 0, program ? 0.5 : 0.1);
  last = now;

  if (!running) {
    // Idle attract state: hold the establishing shot, keep the world alive.
    time += dt;
    updateSet(set, dt, time);
    updateDressing(set, dt);
    updateWeather(weather, dt, time, set);
    for (const k in actors) actors[k].update(dt, time, dt);
    cam.update(dt, time);
    post.grade(dt);
    post.render(scene, camera, time, cam);
    drawOverlay();
    drainGrab();
    return;
  }

  const sdt = dir.update(dt);      // scene time, scaled by slow motion / freeze
  time += sdt;

  if (sdt > 0) {
    for (const k in actors) actors[k].update(sdt, time, dt);
    updateSet(set, sdt, time);
    updateDressing(set, sdt);
    updateWeather(weather, sdt, time, set);
    ctx.score.setRain(weather.amount);
    cam.update(sdt, time);
  }
  titles.update(dt);
  post.grade(dt);
  post.render(scene, camera, time + (sdt > 0 ? 0 : performance.now() * 0.001), cam);
  drawOverlay();
  if (program) { recorder.capture(canvas, titles); advanceProgram(dt); }
  drainGrab();

  // HUD.
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    fpsShown = Math.round(fpsN / fpsAcc);
    fpsAcc = 0; fpsN = 0;
    hud.fps.textContent = `${fpsShown} fps`;
    // Drop resolution rather than drop the performance.
    if (fpsShown < 26 && quality > 0.62) { slowFrames++; if (slowFrames > 2) { quality = 0.7; resize(); slowFrames = 0; } }
  }
  hud.shot.textContent = cam.label;
  const p = dir.scene ? Math.min(1, dir.t / dir.scene.dur) : 0;
  hud.bar.style.transform = `scaleX(${p})`;
}

// --- deterministic offline render -------------------------------------------
// Real-time screen recording depends on the browser handing frames to an
// encoder while the page is visible and keeping up. This does not: the world
// is stepped by a fixed amount per frame and the soundtrack is rendered
// separately through an OfflineAudioContext against the same clock. Two
// consumers drive it — tools/render.mjs over the harness handle, and the
// stepped WebCodecs exporter through offlineWorld below — so it lives here as
// plain functions rather than inside the handle.

async function offlineBegin({ fps = 30, width: w = 1280, height: h = 720, seconds, quality: q = 0.92 }) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return { ok: false, error: 'no OfflineAudioContext' };
  await soundtrack.openOffline(OAC, seconds + 3);
  ctx.score = soundtrack;

  running = true;
  startCard.classList.add('gone');
  document.body.classList.add('no-ui');
  // frame() stops running while the offline renderer drives the world, so
  // wipe the caption overlay rather than leave the last live card frozen
  // over the page for the length of the render.
  cardCtx.clearRect(0, 0, cardCanvas.width, cardCanvas.height);
  cardsDrawn = false;

  canvas.width = w; canvas.height = h;
  renderer.setSize(w, h, false);
  cam.setAspect(w / h);
  post.setSize(w, h);

  const mix = document.createElement('canvas');
  mix.width = w; mix.height = h;
  offline = {
    fps, dt: 1 / fps, seconds, width: w, height: h, n: 0, quality: q,
    mix, mctx: mix.getContext('2d', { alpha: false }),
  };
  time = 0;
  dir.goTo(0);
  return { ok: true, total: Math.ceil(seconds * fps) };
}

// One step: advance the world one frame and composite it (with its cards)
// onto the mixing canvas. Returns the canvas, or null when the run is over.
// The stepped exporter hands this canvas straight to a VideoEncoder — the
// measured cost of the old path was 99% canvas.toDataURL, so the JPEG detour
// only exists for the ffmpeg pipe below.
function offlineStep() {
  const o = offline;
  if (!o) return null;
  if (o.n >= Math.ceil(o.seconds * o.fps)) return null;
  // The soundtrack schedules against this, not against a wall clock.
  soundtrack.virtualNow = o.n * o.dt;
  const sdt = dir.update(o.dt);
  time += sdt;
  if (sdt > 0) {
    for (const k in actors) actors[k].update(sdt, time, o.dt);
    updateSet(set, sdt, time);
    updateDressing(set, sdt);
    updateWeather(weather, sdt, time, set);
    ctx.score.setRain(weather.amount);
    cam.update(sdt, time);
  }
  titles.update(o.dt);
  post.grade(o.dt);
  post.render(scene, camera, time, cam);
  o.mctx.drawImage(canvas, 0, 0, o.width, o.height);
  drawCards(o.mctx, titles, o.width, o.height);
  o.n++;
  return o.mix;
}

// Put the page back after an offline run: the live canvas size, the interface,
// and the wall-clock audio. The offline context has rendered its length and is
// spent; if the live soundtrack had never been started (a fresh page driven by
// the CLI) it is reset instead, so a later start() builds one from scratch.
function offlineEnd() {
  if (!offline) return;
  offline = null;
  document.body.classList.remove('no-ui');
  soundtrack.closeOffline(audioStarted && !soundtrack.failed);
  ctx.score = audioStarted && soundtrack.failed ? synth : soundtrack;
  resize();
  last = performance.now() / 1000;
  // Re-enter the scene the export ended on: scene entry restates the music
  // bed and the ambience, which a fresh audio context knows nothing about.
  if (dir.scene) dir.goTo(dir.scene.id);
}

// The offline contract as the stepped exporter consumes it (engine/exporter.js
// documents the shape). The exporter and the harness cannot diverge because
// both drive these same functions.
const offlineWorld = {
  begin: (o) => offlineBegin(o),
  frame: () => offlineStep(),
  goTo: (ref, t) => { dir.goTo(ref); seekWithin(t); },
  audio: () => (soundtrack.ctx && soundtrack.virtualNow !== null ? soundtrack.ctx.startRendering() : null),
  fullSeconds: () => dir.scenes.reduce((a, s) => a + s.dur / (s.pace ?? dir.pace), 0),
  end: () => offlineEnd(),
};

// Show the world behind the start card straight away.
dir.goTo(0, { silent: true });
dir.onScene(dir.scenes[0], 0);
post.snapLook({ fade: 0.35 });
frame();

// Expose a handle for the capture harness.
window.__telenovela = {
  dir, cam, post, actors, scene, camera, renderer, THREE, soundtrack, synth, recorder, dressed,
  get lastExport() { return window.__lastExport || null; },
  get score() { return ctx.score; },
  begin() { begin(); },
  // `ref` is a scene id or an index — dir.goTo takes both.
  goTo(ref, t = 0) {
    running = true;
    startCard.classList.add('gone');
    dir.goTo(ref);
    seekWithin(t);
  },
  measure() { return new Promise((res) => grabWaiters.push(res)); },
  CUTS,
  // The episode's shape, for the tools: play order, per-scene beats worth
  // screenshotting, and the export cuts — so no tool hardcodes scene knowledge.
  episode: {
    order: episode.order.map((m) => m.id),
    beats: Object.fromEntries(episode.order.map((m) => [m.id, m.beats])),
    cuts: episode.cuts,
  },
  seekWithin(t) { seekWithin(t); },

  // --- deterministic offline render ---------------------------------------
  // The offline contract lives above as plain functions (offlineBegin /
  // offlineStep / offlineEnd); the handle re-exposes it for tools/render.mjs.
  offlineBegin(o) { return offlineBegin(o); },

  // One step, one frame, as base64 JPEG — the ffmpeg pipe's format. The
  // stepped exporter skips this and takes the canvas from offlineStep()
  // directly; toDataURL is why the JPEG pipe measured 99% encode.
  offlineFrame() {
    const c = offlineStep();
    if (!c) return null;
    // The frame is JPEG'd on its way to ffmpeg, so this is the real quality
    // ceiling — a crf of 16 cannot recover what 0.92 threw away.
    return c.toDataURL('image/jpeg', offline.quality).slice('data:image/jpeg;base64,'.length);
  },

  // Render the scheduled soundtrack and hand it back as a WAV.
  async offlineAudio() {
    if (!offline) return null;
    const buf = await soundtrack.ctx.startRendering();
    const u8 = wavBytes(buf, buf.length);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  },

  // --- stepped WebCodecs export --------------------------------------------
  // The CLI face of the same exporter the button uses. exportRun kicks the
  // export off and parks its result in window.__export; exportStatus is
  // cheap to poll; exportSlice hands the finished bytes out in pieces small
  // enough for a CDP evaluate to carry.
  exportProbe(o) { return probeSteppedExport(o); },
  async exportRun(o) {
    const cut = typeof o.cut === 'string' ? CUTS[o.cut] : o.cut;
    if (!cut) { window.__export = { state: 'failed', error: `unknown cut ${o.cut}` }; return false; }
    window.__export = { state: 'running', phase: 'video', done: 0, total: 0 };
    try {
      const res = await exportSteppedVideo({
        cut, width: o.width || cut.width, height: o.height || cut.height, fps: o.fps || 30,
        limitSeconds: o.seconds || 0, videoBitrate: o.videoBitrate || 0,
        maxBytes: o.maxBytes || 0, codec: o.codec || null, mux: o.mux !== false,
        world: offlineWorld,
        onProgress: (p) => Object.assign(window.__export, p),
      });
      window.__export = res.ok
        ? {
          state: 'done', bytes: res.bytes, wav: res.wav, silent: !!res.silent,
          codec: res.codec, frames: res.frames, chunks: res.chunks,
          size: res.bytes ? res.bytes.length : 0, wavSize: res.wav ? res.wav.length : 0,
        }
        : { state: 'failed', error: res.cancelled ? 'cancelled' : (res.reason || 'unknown') };
    } catch (e) {
      window.__export = { state: 'failed', error: (e && e.message) || String(e) };
    }
    return true;
  },
  exportStatus() {
    const s = window.__export;
    if (!s) return null;
    return {
      state: s.state, phase: s.phase || null, done: s.done | 0, total: s.total | 0,
      error: s.error || null, size: s.size | 0, wavSize: s.wavSize | 0,
      silent: !!s.silent, codec: s.codec || null, frames: s.frames | 0, chunks: s.chunks | 0,
    };
  },
  exportSlice(kind, offset, length) {
    const s = window.__export;
    const u8 = s && (kind === 'wav' ? s.wav : s.bytes);
    if (!u8) return null;
    const part = u8.subarray(offset, Math.min(offset + length, u8.length));
    let bin = '';
    for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
    return btoa(bin);
  },
  // Self-test for the video export: record a few seconds and report the file.
  async testRecord(seconds = 4) {
    await startAudio();
    running = true;
    startCard.classList.add('gone');
    const ok = recorder.start({
      width: 640, height: 360, seconds,
      audioStream: ctx.score.captureStream ? ctx.score.captureStream() : null,
    });
    if (!ok) return { ok: false, error: recorder.error };
    program = { cut: CUTS.episode, cutName: 'test', seconds, elapsed: 0, index: -1, segT: 0, wasMuted: false };
    await new Promise((r) => setTimeout(r, seconds * 1000));
    program = null;
    const blob = await recorder.finish();
    document.body.classList.remove('no-ui');
    recBar.hidden = true;
    if (blob && blob.size) {
      // Handed back through the page so the harness can probe the container.
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      window.__lastVideoB64 = btoa(bin);
    }
    return { ok: !!(blob && blob.size), bytes: blob ? blob.size : 0, mime: recorder.mime, frames: recorder.frames };
  },
  // Debug aid for the capture harness: what is actually in front of the lens.
  probe() {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(0, 0), camera);
    return rc.intersectObjects(scene.children, true).slice(0, 6).map((h) => {
      let n = h.object, path = [];
      while (n && path.length < 5) { path.push(n.name || n.type); n = n.parent; }
      return { d: +h.distance.toFixed(3), path: path.join('<') };
    });
  },
  get ready() { return true; },
};
