// Bootstrap: build the world, run the episode, wire the few controls.

import * as THREE from '../vendor/three/three.module.min.js';
import { buildSet, updateSet } from './sets.js';
import { buildCast } from './cast.js';
import { buildWeather, updateWeather } from './weather.js';
import { Cinematographer } from './camera.js';
import { Post } from './post.js';
import { Score } from './score.js';
import { Titles } from './titles.js';
import { Director, buildProps } from './director.js';
import { clamp } from './util.js';

const canvas = document.getElementById('gl');
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
const titles = new Titles(overlay);
const score = new Score();

let dpr = 1, width = 0, height = 0;
const post = new Post(renderer, 1280, 720);

const ctx = { scene, camera, renderer, set, actors, props, weather, cam, post, score, titles };
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
  b.addEventListener('click', () => { score.start(); dir.goTo(i); });
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

function begin() {
  startCard.classList.add('gone');
  score.start();
  score.setMood('theme', 3);
  dir.goTo(0);
  running = true;
}
playBtn.addEventListener('click', begin);

document.getElementById('btn-prev').addEventListener('click', () => dir.prev());
document.getElementById('btn-next').addEventListener('click', () => dir.next());
const pauseBtn = document.getElementById('btn-pause');
pauseBtn.addEventListener('click', () => {
  dir.paused = !dir.paused;
  pauseBtn.textContent = dir.paused ? '▶' : '❚❚';
  if (dir.paused) score.suspend(); else score.resume();
});
const soundBtn = document.getElementById('btn-sound');
let sound = true;
soundBtn.addEventListener('click', () => {
  sound = !sound;
  score.setEnabled(sound);
  soundBtn.textContent = sound ? '♪' : '✕';
  soundBtn.classList.toggle('off', !sound);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') setUI(!showUI);
  else if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); }
  else if (e.key === 'ArrowRight') dir.next();
  else if (e.key === 'ArrowLeft') dir.prev();
  else if (e.key === 'm' || e.key === 'M') soundBtn.click();
  else if (e.key === 'r' || e.key === 'R') dir.restart();
  else if (e.key >= '1' && e.key <= '6') dir.goTo(+e.key - 1);
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

let running = false;
let last = performance.now() / 1000;
let time = 0;
let fpsAcc = 0, fpsN = 0, fpsShown = 0;
let slowFrames = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  let dt = clamp(now - last, 0, 0.1);
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
    score.setRain(weather.amount);
    cam.update(sdt, time);
  }
  titles.update(dt);
  post.grade(dt);
  post.render(scene, camera, time + (sdt > 0 ? 0 : performance.now() * 0.001), cam);
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
  dir, cam, post, actors, score, scene, camera, renderer,
  begin() { begin(); },
  goTo(i, t = 0) {
    running = true;
    startCard.classList.add('gone');
    dir.goTo(i);
    // Fast-forward inside the scene without rendering, for deterministic stills.
    const step = 1 / 60;
    for (let acc = 0; acc < t; acc += step) {
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
  },
  measure() { return new Promise((res) => grabWaiters.push(res)); },
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
