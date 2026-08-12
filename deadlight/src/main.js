// Boot, menus, and the frame loop.

import { AssetLibrary } from './assets.js';
import { Audio } from './audio.js';
import { Game } from './game.js';
import { Hud } from './hud.js';
import { Renderer, webgpuProblem } from './render.js';
import { randomSeed } from './rng.js';

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('gl'),
  boot: $('boot'),
  loadFill: $('load-fill'),
  loadNote: $('load-note'),
  menu: $('menu'),
  gpuNote: $('gpu-note'),
  start: $('start'),
  again: $('again'),
  newSeed: $('new-seed'),
  seedInput: $('seed-input'),
  seedRoll: $('seed-roll'),
  seedCopy: $('seed-copy'),
  reportCopy: $('report-copy'),
  report: $('report'),
};

const hud = new Hud();
const audio = new Audio();

let renderer = null;
let assets = null;
let game = null;
let lastResult = null;
let raf = 0;
let lastTime = 0;

// ---------------------------------------------------------------- seeds

/** Seed precedence: ?seed= in the URL, then whatever is typed, then random. */
function initialSeed() {
  const fromUrl = new URLSearchParams(location.search).get('seed');
  return (fromUrl || randomSeed()).toUpperCase().slice(0, 12);
}

function currentSeed() {
  const typed = el.seedInput.value.trim().toUpperCase();
  return typed || randomSeed();
}

/** Keep the address bar in sync so the tab itself is the shareable link. */
function pushSeedToUrl(seed) {
  const url = new URL(location.href);
  url.searchParams.set('seed', seed);
  history.replaceState(null, '', url);
}

async function copyText(text, button, done = 'COPIED') {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = done;
  } catch {
    // Clipboard access is refused in plenty of legitimate setups; showing the
    // text is more useful than showing an error.
    button.textContent = 'CTRL+C';
    window.prompt('Copy this:', text);
  }
  setTimeout(() => { button.textContent = original; }, 1400);
}

// ----------------------------------------------------------------- boot

function refuse(message) {
  el.boot.hidden = true;
  el.menu.hidden = false;
  el.gpuNote.textContent = message;
  el.gpuNote.classList.add('bad');
  el.start.disabled = true;
  el.start.textContent = 'WEBGPU REQUIRED';
}

async function boot() {
  // `?backend=webgl` is a verification escape hatch for headless capture, not
  // a fallback — see Renderer's constructor.
  const forceWebGL = new URLSearchParams(location.search).get('backend') === 'webgl';

  const problem = forceWebGL ? null : webgpuProblem();
  if (problem) {
    refuse(problem);
    return;
  }

  el.loadNote.textContent = forceWebGL ? 'starting WebGL…' : 'starting WebGPU…';
  renderer = new Renderer(el.canvas, { forceWebGL });
  try {
    await renderer.init();
  } catch (err) {
    refuse(err.message);
    return;
  }

  assets = new AssetLibrary('./assets/');
  try {
    await assets.loadAll((done, total, key) => {
      el.loadFill.style.width = `${Math.round((done / total) * 100)}%`;
      el.loadNote.textContent = `${key} · ${done}/${total}`;
    });
  } catch (err) {
    el.loadNote.textContent = err.message;
    el.loadNote.classList.add('bad');
    return;
  }

  el.loadFill.style.width = '100%';
  el.loadNote.textContent = 'ready';

  el.seedInput.value = initialSeed();
  pushSeedToUrl(el.seedInput.value);

  el.boot.hidden = true;
  el.menu.hidden = false;
}

// ------------------------------------------------------------- run control

async function startRun(seed) {
  el.menu.hidden = true;
  hud.hideReport();
  lastResult = null;

  // Audio has to be unlocked from the click that got us here.
  await audio.unlock();

  if (game) {
    game.dispose();
    game = null;
  }

  el.boot.hidden = false;
  el.loadNote.textContent = 'building the dark…';
  el.loadFill.style.width = '35%';

  // Game.start builds the scene and hands it to the renderer itself, because
  // the post chain has to exist before the director that writes to it.
  game = new Game({ renderer, assets, audio, hud });
  await game.start(seed);

  game.onEnd = (result) => {
    lastResult = result;
    hud.hide();
    document.exitPointerLock?.();
    hud.showReport(result);
  };

  pushSeedToUrl(seed);
  el.loadFill.style.width = '100%';
  el.boot.hidden = true;

  el.canvas.requestPointerLock?.();

  lastTime = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  // Clamp: a background tab or a long GC pause must not teleport the creature
  // across the level on the frame it resumes.
  const dt = Math.min(0.05, (now - lastTime) / 1000) || 0;
  lastTime = now;

  game?.update(dt);
  renderer.render(dt);
}

// -------------------------------------------------------------------- input

el.start.addEventListener('click', () => {
  const seed = currentSeed();
  el.seedInput.value = seed;
  startRun(seed);
});

el.again.addEventListener('click', () => startRun(lastResult?.seed ?? currentSeed()));

el.newSeed.addEventListener('click', () => {
  const seed = randomSeed();
  el.seedInput.value = seed;
  startRun(seed);
});

el.seedRoll.addEventListener('click', () => {
  el.seedInput.value = randomSeed();
  pushSeedToUrl(el.seedInput.value);
});

el.seedCopy.addEventListener('click', () => {
  const url = new URL(location.href);
  url.searchParams.set('seed', currentSeed());
  copyText(url.toString(), el.seedCopy, 'COPIED');
});

el.reportCopy.addEventListener('click', () => {
  if (!lastResult) return;
  const r = lastResult;
  const mins = Math.floor(r.seconds / 60);
  const secs = String(Math.floor(r.seconds % 60)).padStart(2, '0');
  const url = new URL(location.href);
  url.searchParams.set('seed', r.seed);
  copyText(
    [
      `DEADLIGHT · seed ${r.seed}`,
      r.won ? `escaped in ${mins}:${secs}` : `died after ${mins}:${secs}`,
      `${r.fuses}/${r.fusesNeeded} fuses · ${r.scares} scares · ${Math.round(r.peakBpm)} peak BPM`,
      r.topScare ? `worst moment: ${r.topScare}` : '',
      url.toString(),
    ].filter(Boolean).join('\n'),
    el.reportCopy,
  );
});

// Re-acquire pointer lock on click, and treat losing it as a pause.
el.canvas.addEventListener('click', () => {
  if (game?.running && !document.pointerLockElement) el.canvas.requestPointerLock?.();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyE') game?.interact();
  if (e.code === 'KeyM') audio.setMuted(!audio.muted);

  // Chaos keys — the streamer hook. 1–6 fire a specific scare on demand, so
  // a moderator can trigger one from chat without touching the game state.
  if (game?.running && !game.over && e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= 6) game.director.chaos(n);
  }

  if (e.code === 'Escape' && game?.running) document.exitPointerLock?.();
});

/**
 * A handle on the live objects.
 *
 * Used by tools/shot.mjs to drive a run deterministically, and useful for
 * anyone who wants to poke at a seed from the console — `deadlight.director
 * .fire('apparition')` is a far better way to look at a scare than waiting
 * for one.
 */
window.deadlight = {
  get game() { return game; },
  get director() { return game?.director; },
  get renderer() { return renderer; },
  get result() { return lastResult; },
  audio,
};

boot();
