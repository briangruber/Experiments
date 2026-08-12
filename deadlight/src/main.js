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
  let fromUrl = null;
  try {
    fromUrl = new URLSearchParams(location.search).get('seed');
  } catch {
    // Sandboxed frame; fall through to a random seed.
  }
  return (fromUrl || randomSeed()).toUpperCase().slice(0, 12);
}

function currentSeed() {
  const typed = el.seedInput.value.trim().toUpperCase();
  return typed || randomSeed();
}

/**
 * Keep the address bar in sync so the tab itself is the shareable link.
 *
 * Guarded because this also runs embedded, where a sandboxed frame can refuse
 * both `history.replaceState` and even reading `location.href`. Losing the
 * shareable URL there is a shame; throwing on the way into a run is not
 * acceptable, and this is called on every start.
 */
function pushSeedToUrl(seed) {
  try {
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    history.replaceState(null, '', url);
  } catch {
    // Embedded and sandboxed. The seed is still shown on the HUD.
  }
}

/** The current run's link, or just the seed where there is no usable URL. */
function shareLink(seed) {
  try {
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    return url.toString();
  } catch {
    return `seed ${seed}`;
  }
}

async function copyText(text, button, done = 'COPIED') {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = done;
  } catch {
    // Clipboard access is refused in plenty of legitimate setups, and an
    // embedded frame may refuse `prompt` as well — hence the second guard.
    button.textContent = 'CTRL+C';
    try {
      window.prompt('Copy this:', text);
    } catch {
      console.info(text);
    }
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

  await acquireLook();

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
  copyText(shareLink(currentSeed()), el.seedCopy, 'COPIED');
});

el.reportCopy.addEventListener('click', () => {
  if (!lastResult) return;
  const r = lastResult;
  const mins = Math.floor(r.seconds / 60);
  const secs = String(Math.floor(r.seconds % 60)).padStart(2, '0');
  copyText(
    [
      `DEADLIGHT · seed ${r.seed}`,
      r.won ? `escaped in ${mins}:${secs}` : `died after ${mins}:${secs}`,
      `${r.fuses}/${r.fusesNeeded} fuses · ${r.scares} scares · ${Math.round(r.peakBpm)} peak BPM`,
      r.topScare ? `worst moment: ${r.topScare}` : '',
      shareLink(r.seed),
    ].filter(Boolean).join('\n'),
    el.reportCopy,
  );
});

/**
 * Ask for pointer lock, and find out whether we got it.
 *
 * An embedded page is only granted pointer lock if the host `<iframe>` carries
 * `allow="pointer-lock"`, which this page has no way to request. Rather than
 * leave the mouse silently dead, the player falls back to hold-to-look and the
 * HUD says so — see Player#attach.
 */
async function acquireLook() {
  try {
    const request = el.canvas.requestPointerLock?.();
    if (request && typeof request.then === 'function') await request;
  } catch {
    // Refused. The fallback below covers it.
  }
  // The lock lands asynchronously even without a promise-returning API.
  await new Promise((resolve) => setTimeout(resolve, 150));
  hud.setLookMode(document.pointerLockElement === el.canvas);
}

// Re-acquire pointer lock on click, and treat losing it as a pause.
el.canvas.addEventListener('click', () => {
  if (game?.running && !document.pointerLockElement) acquireLook();
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
