// Bootstrap: build the world, run the episode, wire the few controls.

import * as THREE from '../vendor/three/three.module.min.js';
import { buildSet, updateSet } from './sets.js';
import { buildCast } from './cast.js';
import { buildWeather, updateWeather } from './weather.js';
import { Cinematographer } from './camera.js';
import { Post } from './post.js';
import { Score } from './score.js';
import { Soundtrack } from './audio.js';
import { Titles } from './titles.js';
import { Director, buildProps } from './director.js';
import { Recorder, CUTS, deliver, canDeliver, formatLabel, drawCards } from './record.js';
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
const titles = new Titles(overlay);
// The generated soundtrack, with the procedural synth standing by in case the
// audio can't be fetched or decoded (opening index.html off the filesystem,
// say). Both present the same surface, so the director never has to know.
const soundtrack = new Soundtrack();
const synth = new Score();

let dpr = 1, width = 0, height = 0;
const post = new Post(renderer, 1280, 720);

const ctx = { scene, camera, renderer, set, actors, props, weather, cam, post, score: soundtrack, titles };
const dir = new Director(ctx);
ctx.dir = dir;

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
  b.addEventListener('click', () => { startAudio(); dir.goTo(i); });
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
  ctx.score.setMood('theme', 3);
}

function begin() {
  startCard.classList.add('gone');
  running = true;
  dir.goTo(0);
  startAudio();
}
playBtn.addEventListener('click', begin);

document.getElementById('btn-prev').addEventListener('click', () => dir.prev());
document.getElementById('btn-next').addEventListener('click', () => dir.next());
const pauseBtn = document.getElementById('btn-pause');
pauseBtn.addEventListener('click', () => {
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

exportBtn.hidden = true;
if (Recorder.supported) {
  canDeliver().then((ok) => { exportBtn.hidden = !ok; });
}
exportBtn.addEventListener('click', () => { exportPanel.hidden = false; });
document.getElementById('export-close').addEventListener('click', () => { exportPanel.hidden = true; });
document.getElementById('rec-stop').addEventListener('click', () => finishRecording('cancelado'));
for (const b of exportPanel.querySelectorAll('[data-cut]')) {
  b.addEventListener('click', () => startRecording(b.dataset.cut));
}

async function startRecording(cutName) {
  const cut = CUTS[cutName];
  if (!cut || program) return;
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
  if (e.key === 'h' || e.key === 'H') setUI(!showUI);
  else if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); }
  else if (e.key === 'ArrowRight') dir.next();
  else if (e.key === 'ArrowLeft') dir.prev();
  else if (e.key === 'm' || e.key === 'M') soundBtn.click();
  else if (e.key === 'r' || e.key === 'R') dir.restart();
  else if (e.key >= "1" && e.key <= "7") dir.goTo(+e.key - 1);
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
  for (let guard = 0; dir.t < sceneSeconds && guard < 30000; guard++) {
    const sdt = dir.update(step);
    time += sdt;
    if (sdt > 0) {
      for (const k in actors) actors[k].update(sdt, time);
      updateSet(set, sdt, time);
      updateWeather(weather, sdt, time, set);
      cam.update(sdt, time);
    }
    titles.update(step);
    post.grade(step);
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
    updateWeather(weather, dt, time, set);
    for (const k in actors) actors[k].update(dt, time);
    cam.update(dt, time);
    post.grade(dt);
    post.render(scene, camera, time, cam);
    drainGrab();
    return;
  }

  const sdt = dir.update(dt);      // scene time, scaled by slow motion / freeze
  time += sdt;

  if (sdt > 0) {
    for (const k in actors) actors[k].update(sdt, time);
    updateSet(set, sdt, time);
    updateWeather(weather, sdt, time, set);
    ctx.score.setRain(weather.amount);
    cam.update(sdt, time);
  }
  titles.update(dt);
  post.grade(dt);
  post.render(scene, camera, time + (sdt > 0 ? 0 : performance.now() * 0.001), cam);
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

// Show the world behind the start card straight away.
dir.goTo(0, { silent: true });
dir.onScene(dir.scenes[0], 0);
post.snapLook({ fade: 0.35 });
frame();

// Expose a handle for the capture harness.
window.__telenovela = {
  dir, cam, post, actors, scene, camera, renderer, THREE, soundtrack, synth, recorder,
  get lastExport() { return window.__lastExport || null; },
  get score() { return ctx.score; },
  begin() { begin(); },
  goTo(i, t = 0) {
    running = true;
    startCard.classList.add('gone');
    dir.goTo(i);
    seekWithin(t);
  },
  measure() { return new Promise((res) => grabWaiters.push(res)); },
  CUTS,
  seekWithin(t) { seekWithin(t); },

  // --- deterministic offline render ---------------------------------------
  // Real-time screen recording depends on the browser handing frames to an
  // encoder while the page is visible and keeping up. This does not: the world
  // is stepped by a fixed amount, each frame is handed back as a JPEG, and the
  // soundtrack is rendered separately through an OfflineAudioContext against
  // the same clock. tools/render.mjs drives it and lets ffmpeg encode.
  async offlineBegin({ fps = 30, width = 1280, height = 720, seconds }) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return { ok: false, error: 'no OfflineAudioContext' };
    await soundtrack.openOffline(OAC, seconds + 3);
    ctx.score = soundtrack;

    running = true;
    startCard.classList.add('gone');
    document.body.classList.add('no-ui');

    canvas.width = width; canvas.height = height;
    renderer.setSize(width, height, false);
    cam.setAspect(width / height);
    post.setSize(width, height);

    const mix = document.createElement('canvas');
    mix.width = width; mix.height = height;
    offline = {
      fps, dt: 1 / fps, seconds, width, height, n: 0,
      mix, mctx: mix.getContext('2d', { alpha: false }),
    };
    time = 0;
    dir.goTo(0);
    return { ok: true, total: Math.ceil(seconds * fps) };
  },

  // One step, one frame. Returns base64 JPEG, or null when the run is over.
  offlineFrame() {
    const o = offline;
    if (!o) return null;
    if (o.n >= Math.ceil(o.seconds * o.fps)) return null;
    // The soundtrack schedules against this, not against a wall clock.
    soundtrack.virtualNow = o.n * o.dt;
    const sdt = dir.update(o.dt);
    time += sdt;
    if (sdt > 0) {
      for (const k in actors) actors[k].update(sdt, time);
      updateSet(set, sdt, time);
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
    return o.mix.toDataURL('image/jpeg', 0.92).slice('data:image/jpeg;base64,'.length);
  },

  // Render the scheduled soundtrack and hand it back as a WAV.
  async offlineAudio() {
    if (!offline) return null;
    const buf = await soundtrack.ctx.startRendering();
    const chans = Math.min(2, buf.numberOfChannels);
    const n = buf.length;
    const bytes = new DataView(new ArrayBuffer(44 + n * chans * 2));
    const put = (o, s) => { for (let i = 0; i < s.length; i++) bytes.setUint8(o + i, s.charCodeAt(i)); };
    put(0, 'RIFF'); bytes.setUint32(4, 36 + n * chans * 2, true); put(8, 'WAVEfmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, chans, true);
    bytes.setUint32(24, buf.sampleRate, true); bytes.setUint32(28, buf.sampleRate * chans * 2, true);
    bytes.setUint16(32, chans * 2, true); bytes.setUint16(34, 16, true);
    put(36, 'data'); bytes.setUint32(40, n * chans * 2, true);
    const data = [];
    for (let c = 0; c < chans; c++) data.push(buf.getChannelData(c));
    let p = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < chans; c++) {
        const v = Math.max(-1, Math.min(1, data[c][i]));
        bytes.setInt16(p, v < 0 ? v * 32768 : v * 32767, true);
        p += 2;
      }
    }
    const u8 = new Uint8Array(bytes.buffer);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
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
