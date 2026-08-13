// Boot, menus, and the frame loop.

import { AssetLibrary } from './assets.js';
import { Audio } from './audio.js';
import { Game } from './game.js';
import { Hud } from './hud.js';
import { Renderer, webgpuProblem } from './render.js';
import { randomSeed } from './rng.js';
import { detectQuality } from './quality.js';
import { TouchControls } from './touch.js';
import { RenderWatchdog } from './watchdog.js';

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

const quality = detectQuality();
let touch = null;

const hud = new Hud();
const audio = new Audio();

let renderer = null;
let assets = null;
let game = null;
let watchdog = null;
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
  el.start.textContent = 'UNSUPPORTED';
}

async function boot() {
  let requested = null;
  let safeMode = false;
  try {
    const params = new URLSearchParams(location.search);
    requested = params.get('backend');
    safeMode = params.get('safe') === '1';
  } catch { /* sandboxed */ }

  // WebGL is the default, on every device.
  //
  // This was built against WebGPU and still runs on it, but WebGPU turned out
  // to be the thing standing between real people and a playable game: on a
  // phone it initialised cleanly, reported no error, ran at twenty-six frames
  // per second and painted nothing at all. A backend that fails by succeeding
  // is not one to leave switched on by default, and the WebGL path draws the
  // identical scene through the identical node materials and TSL post chain —
  // it is the path this game has been verified against all along. The cost is
  // a slightly softer light. `?backend=webgpu` opts back in.
  const problem = webgpuProblem();
  let forceWebGL = requested !== 'webgpu' || Boolean(problem);

  el.loadNote.textContent = forceWebGL ? 'starting WebGL…' : 'starting WebGPU…';
  renderer = new Renderer(el.canvas, { forceWebGL, quality, safeMode });
  try {
    await renderer.init();
  } catch (err) {
    if (forceWebGL) {
      refuse(`No usable graphics backend: ${err.message}`);
      return;
    }
    // WebGPU said yes and then failed. Try the other one before giving up.
    console.warn('WebGPU failed, falling back to WebGL:', err.message);
    forceWebGL = true;
    renderer = new Renderer(el.canvas, { forceWebGL: true, quality, safeMode });
    try {
      await renderer.init();
    } catch (fallbackErr) {
      refuse(`No usable graphics backend: ${fallbackErr.message}`);
      return;
    }
  }

  hud.setBackend(safeMode ? `${renderer.label} SAFE` : renderer.label);
  if (requested === 'webgpu' && problem) {
    el.gpuNote.textContent = `${problem} Running on WebGL instead.`;
  } else if (safeMode) {
    el.gpuNote.textContent = 'Safe mode: no effects, no shadows.';
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
  if (quality.touch) el.start.textContent = 'TAP TO ENTER THE DARK';
  updateOrientation();
}

/**
 * Portrait plays. It used to put up a "rotate your phone" gate, which is a
 * demand rather than a design — most phone use is one-handed and vertical, and
 * a game that refuses to run in the orientation the device is already in is
 * just a game that does not run.
 *
 * So the orientation only sets a class. The controls sit in the bottom third
 * either way; portrait gives them a full-width band instead of two corners,
 * and the view gets the taller frame above it.
 */
function updateOrientation() {
  const portrait = window.innerHeight > window.innerWidth;
  document.documentElement.classList.toggle('portrait', portrait);
}

window.addEventListener('resize', updateOrientation);
window.addEventListener('orientationchange', () => setTimeout(updateOrientation, 250));

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
  game = new Game({ renderer, assets, audio, hud, quality });
  await game.start(seed);

  game.onEnd = (result) => {
    lastResult = result;
    hud.hide();
    touch?.disable();
    document.exitPointerLock?.();
    hud.showReport(result);
  };

  pushSeedToUrl(seed);
  el.loadFill.style.width = '100%';
  el.boot.hidden = true;

  if (quality.touch) {
    // Fullscreen reclaims the browser chrome, which on a phone in landscape is
    // a third of the screen. It can only be asked for from a gesture, and the
    // tap that started the run is one.
    await requestFullscreen();
    touch ??= new TouchControls({
      player: game.player,
      hud,
      onInteract: () => game?.interact(),
    });
    touch.player = game.player;
    touch.enable();
    hud.setLookMode(true);
    // The USE button appears only when there is something to use, so it
    // tracks the same prompt the desktop build shows.
    hud.onPrompt = (visible) => touch.setUseVisible(visible);
  } else {
    await acquireLook();
  }

  // Fresh per run: a run that renders is proof for that run only, and the
  // watchdog stands itself down permanently once it has seen a lit frame.
  watchdog = new RenderWatchdog({ canvas: el.canvas, renderer, hud });

  lastTime = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);

  // The opening shot runs on the live frame loop, so it needs the loop going
  // first — otherwise its first frame is also the frame that compiles every
  // shader in the level, and the camera move starts with a two-second stutter.
  game.playIntro();
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  // Clamp: a background tab or a long GC pause must not teleport the creature
  // across the level on the frame it resumes.
  const dt = Math.min(0.05, (now - lastTime) / 1000) || 0;
  lastTime = now;

  game?.update(dt);
  renderer.render(dt);

  // After the render, inside the same frame. The backbuffer is only readable
  // until the compositor takes it — sampling from a timer instead would read a
  // cleared buffer and report the exact bug it is looking for.
  if (watchdog && game?.running) {
    watchdog.update({ torchOn: Boolean(game.player?.torchOn) });
  }
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
      `${r.tags}/${r.tagsNeeded} tags · power ${r.power ? 'on' : 'off'} · ${r.scares} scares · ${Math.round(r.peakBpm)} peak BPM`,
      r.topScare ? `worst moment: ${r.topScare}` : '',
      shareLink(r.seed),
    ].filter(Boolean).join('\n'),
    el.reportCopy,
  );
});

async function requestFullscreen() {
  try {
    const root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) {
      await root.requestFullscreen({ navigationUI: 'hide' });
    }
    // No orientation lock. It used to force landscape here, which is the same
    // "turn your phone sideways" demand made silently — the phone rotates
    // under the player's hands instead of asking. Both orientations play.
  } catch {
    // Refused — an embedded frame without `allow="fullscreen"`, or iOS Safari,
    // which has no Fullscreen API on the document at all.
  }
}

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

// Skipping a cutscene had exactly one input — the space bar — which on a phone
// makes a twenty-second scripted shot something that happens *to* the player
// with no way out of it.
$('cine-skip')?.addEventListener('click', () => game?.cutscene?.skip());

/**
 * Open or close the renderer diagnostic.
 *
 * Nothing else on a phone can answer "what is it actually doing" — there is no
 * console, no flags, no way to attach anything. One tap on the frame-rate
 * readout, a corner nobody presses by accident, turns "it's all black" into a
 * screenful of facts.
 *
 * Opening it releases pointer lock, and that is not a courtesy. While the lock
 * is held every mouse event in the window is delivered to the canvas, so on a
 * desktop the panel would appear with its escape buttons visibly present and
 * completely unclickable — a diagnostic you cannot act on, which is the exact
 * failure it exists to prevent.
 */
function toggleDiagnostic() {
  if (!watchdog) return;
  const el = $('diagnostic');
  if (el && !el.hidden) {
    hud.hideDiagnostic();
    return;
  }
  document.exitPointerLock?.();
  hud.setLookMode(false);
  watchdog.showManual({ torchOn: Boolean(game?.player?.torchOn) });
}

$('fps')?.addEventListener('click', toggleDiagnostic);

// Re-acquire pointer lock on click, and treat losing it as a pause.
el.canvas.addEventListener('click', () => {
  if (game?.running && !document.pointerLockElement) acquireLook();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && game?.cutscene?.active) {
    e.preventDefault();
    game.cutscene.skip();
    return;
  }
  if (e.code === 'KeyE') game?.interact();
  if (e.code === 'KeyM') audio.setMuted(!audio.muted);
  // Backquote reaches the diagnostic without a mouse, which under pointer lock
  // is the only thing that can reach it at all.
  if (e.code === 'Backquote') toggleDiagnostic();

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
  get watchdog() { return watchdog; },
  audio,
};

boot();
