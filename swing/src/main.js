// Skyline — boot, frame loop and the wiring between systems.

import * as THREE from 'three';
import { buildCity } from './city.js';
import { buildSky, buildProps } from './world.js';
import { Player } from './player.js';
import { ChaseCamera } from './camera.js';
import { Avatar } from './avatar.js';
import { WebLine } from './web.js';
import { Rings } from './rings.js';
import { Fx } from './fx.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { clamp, smoothstep } from './util.js';

const canvas = document.getElementById('gl');
const titleEl = document.getElementById('title');
const playBtn = document.getElementById('play');
const noteEl = document.getElementById('renderer-note');
const coarse = matchMedia('(pointer: coarse)').matches;

const _probe = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, index: -1 };

function fail(message) {
  document.getElementById('fail').hidden = false;
  document.getElementById('fail-msg').textContent = message;
  titleEl.hidden = true;
  console.error(message);
}

/**
 * Decide whether WebGPU can actually draw here, on a throwaway canvas.
 *
 * `navigator.gpu` existing is not enough: a browser can expose WebGPU and still
 * reject descriptors this version of three.js emits, and because a canvas keeps
 * the first context type it is given, discovering that on the real canvas would
 * leave nowhere to fall back to. So we spend a few milliseconds rendering a
 * textured quad off to the side and watch for anything thrown, including the
 * asynchronous device errors that never reach a try/catch.
 */
async function webgpuUsable() {
  if (!navigator.gpu) return false;
  const probe = document.createElement('canvas');
  probe.width = probe.height = 8;
  let broke = null;
  const onError = (e) => { broke = e.message || e.reason?.message || 'device error'; };
  addEventListener('error', onError);
  addEventListener('unhandledrejection', onError);
  let renderer = null;
  try {
    renderer = new THREE.WebGPURenderer({ canvas: probe, antialias: false });
    await renderer.init();
    renderer.backend?.device?.lost?.then((info) => { broke = info?.message || 'device lost'; });

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    cam.position.z = 2;
    const tex = new THREE.DataTexture(new Uint8Array([255, 128, 64, 255]), 1, 1);
    tex.needsUpdate = true;
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex })));
    await renderer.renderAsync(scene, cam);
    await new Promise((r) => setTimeout(r, 0));      // let async device errors land
    tex.dispose();
  } catch (err) {
    broke = err?.message || String(err);
  } finally {
    removeEventListener('error', onError);
    removeEventListener('unhandledrejection', onError);
    try { renderer?.dispose(); } catch { /* already gone */ }
  }
  if (broke) console.warn('WebGPU present but not usable here, falling back to WebGL2 —', broke);
  return !broke;
}

async function makeRenderer() {
  const params = new URLSearchParams(location.search);
  const opts = { canvas, antialias: !coarse, alpha: false, powerPreference: 'high-performance' };
  const forceWebGL = params.has('webgl') || (!params.has('webgpu') && !(await webgpuUsable()));
  const r = new THREE.WebGPURenderer({ ...opts, forceWebGL });
  await r.init();
  return r;
}

async function boot() {
  let renderer;
  try {
    renderer = await makeRenderer();
  } catch (err) {
    fail(`This browser could not start WebGPU or WebGL2. ${err?.message || err}`);
    return;
  }

  const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.setClearColor(0x0a0d1a, 1);

  let quality = coarse ? 1.3 : 1.75;
  const resize = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, quality));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 9000);

  buildSky(scene);
  const city = buildCity(1337);
  scene.add(city.group);

  const rings = new Rings(city, 4);
  scene.add(rings.group);

  const player = new Player(city);
  const cam = new ChaseCamera(camera, city);
  const avatar = new Avatar();
  const web = new WebLine();
  const fx = new Fx(city);
  const hud = new Hud();
  const input = new Input(canvas);
  const audio = new Audio();

  scene.add(avatar.root, web.mesh, fx.group);

  // Start high over downtown, already moving.
  player.reset(-40, 260);
  cam.snap(player);
  rings.layChain(player);
  resize();
  addEventListener('resize', resize);

  // Bloom is what turns the emissive window maps into a skyline; if the node
  // pipeline refuses on this device we simply render the scene straight.
  let post = null;
  try {
    const { pass } = await import('three/tsl');
    const { bloom } = await import('three/addons/tsl/display/BloomNode.js');
    post = new THREE.PostProcessing(renderer);
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode();
    post.outputNode = color.add(bloom(color, 0.42, 0.6, 0.85));
  } catch (err) {
    console.warn('bloom unavailable —', err?.message || err);
    post = null;
  }

  // Assets are optional dressing — the game is playable before they land.
  const assets = Promise.all([
    avatar.load().catch((err) => console.warn('avatar unavailable —', err.message)),
    buildProps(city).then((g) => { scene.add(g); return g; }).catch((err) => {
      console.warn('props unavailable —', err.message);
      return null;
    }),
  ]);

  input.attach();
  input.bindPad(document.getElementById('btn-web-l'), 'webLeft');
  input.bindPad(document.getElementById('btn-web-r'), 'webRight');
  input.bindPad(document.getElementById('btn-dive'), 'dive');
  input.bindPad(document.getElementById('btn-boost'), 'boost', true);

  let props = null;
  let state = 'title';
  let time = 0;
  let nearMissCd = 0;
  let reticleCd = 0;
  let fpsAvg = 60;

  const start = () => {
    state = 'playing';
    input.enabled = true;
    titleEl.classList.add('out');
    setTimeout(() => { titleEl.hidden = true; }, 450);
    hud.show(true);
    audio.start();
    if (!coarse) canvas.requestPointerLock?.();
  };

  const pause = () => {
    if (state !== 'playing') return;
    state = 'paused';
    input.enabled = false;
    input.held.clear();
    input.webLeft = input.webRight = false;
    document.exitPointerLock?.();
    titleEl.hidden = false;
    titleEl.classList.remove('out');
    playBtn.textContent = 'Resume';
    audio.setWind(0, false);
  };

  playBtn.addEventListener('click', start);
  input.onPause = pause;
  input.onKey = (code) => {
    if (state !== 'playing') return;
    if (code === 'KeyH') hud.toggle();
    if (code === 'KeyR') { player.reset(player.pos.x, player.pos.z); rings.layChain(player); fx.reset(); }
    if (code === 'KeyM') audio.muted = !audio.muted;
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  const handlePlayerEvents = () => {
    for (const e of player.events) {
      switch (e) {
        case 'attach':
          audio.thwip();
          fx.burst(player.web.anchor, 7, { life: 0.4, size: 0.6, spread: 4, color: 0xdfefff, drag: 4 });
          break;
        case 'miss': audio.miss(); break;
        case 'boost':
          audio.boost();
          cam.kick(0.35);
          _dir.copy(player.vel).normalize().multiplyScalar(-1);
          fx.burst(player.pos, 14, { life: 0.5, size: 0.9, spread: 9, dir: _dir, color: 0x9fd8ff, drag: 3 });
          break;
        case 'land':
          audio.land();
          cam.kick(0.3);
          fx.burst(player.pos, 10, { life: 0.6, size: 1.1, spread: 5, color: 0x8a8378, drag: 3.5, grow: 3 });
          break;
        case 'smack':
          audio.smack();
          cam.kick(0.9);
          fx.burst(player.pos, 16, { life: 0.5, size: 0.8, spread: 8, color: 0xffb070, drag: 3 });
          break;
        case 'scrape':
          audio.scrape();
          cam.kick(0.12);
          fx.burst(player.pos, 4, { life: 0.35, size: 0.4, spread: 5, color: 0xffcf90, drag: 4 });
          break;
        case 'jump': audio.burst({ freq: 400, sweep: 2, dur: 0.14, gain: 0.14 }); break;
        default: break;
      }
    }
  };

  const handleRingEvents = () => {
    for (const e of rings.events) {
      if (e.type === 'ring') {
        audio.ring(e.combo);
        cam.kick(0.14);
        fx.burst(e.pos, 22, { life: 0.7, size: 0.8, spread: 12, color: 0x7fe6ff, drag: 2 });
        hud.say(e.combo > 1 ? `+${e.points}  x${e.combo}` : `+${e.points}`, e.combo > 2);
      } else if (e.type === 'bonus') {
        hud.say(`${e.label}  +${e.points}`);
      }
    }
  };

  /** Risk pays: brushing a wall at speed without hitting it scores. */
  const checkNearMiss = (dt) => {
    nearMissCd -= dt;
    if (nearMissCd > 0 || player.grounded || player.speed < 30) return;
    _probe.copy(player.pos);
    if (city.resolve(_probe, 5.2, _normal)) {
      nearMissCd = 0.75;
      rings.award(40, 'close call');
      audio.burst({ freq: 1400, sweep: 0.4, dur: 0.12, gain: 0.1, q: 2 });
      cam.kick(0.18);
    }
  };

  /** Cheap reticle feedback: one ray up-forward, a few times a second. */
  const checkReticle = (dt) => {
    if (player.web.active) { hud.setReticle('held'); return; }
    reticleCd -= dt;
    if (reticleCd > 0) return;
    reticleCd = 0.08;
    _dir.copy(cam.basis.forward);
    _dir.y += 0.42;
    _dir.normalize();
    const hit = city.raycast(player.pos, _dir, 105, _hit);
    hud.setReticle(hit && hit.point.y > player.pos.y + 3 ? 'live' : '');
  };

  /**
   * One step of the game, with no drawing. Split out from the frame loop so the
   * capture harness can run minutes of play in a tight loop and report on how it
   * went, without waiting on a software rasteriser.
   */
  const simulate = (dt) => {
    time += dt;
    input.sample();

    cam.aim(dt, player, input);
    player.update(dt, input, cam.basis);
    handlePlayerEvents();

    rings.update(dt, player, time);
    handleRingEvents();
    checkNearMiss(dt);

    avatar.update(dt, player);
    web.update(dt, player, avatar);
    fx.update(dt, player, camera);
    cam.update(dt, player);
    props?.update(time);
    checkReticle(dt);

    audio.setWind(player.speed, player.web.active);
    hud.update(dt, player, rings);
    input.endFrame();
  };

  let last = performance.now();
  const frame = async () => {
    const now = performance.now();
    let dt = (now - last) / 1000;
    last = now;
    dt = clamp(dt, 0, 1 / 20);            // never let a stall teleport the player

    if (state === 'playing') {
      simulate(dt);

      // Back off resolution rather than dropping frames on weaker phones.
      fpsAvg = fpsAvg * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
      if (fpsAvg < 42 && quality > 0.85) { quality -= 0.08; resize(); }
    }

    if (post) await post.renderAsync();
    else await renderer.renderAsync(scene, camera);
  };

  renderer.setAnimationLoop(frame);

  noteEl.textContent = `renderer · ${backend}`;
  playBtn.disabled = false;
  playBtn.textContent = 'Play';

  props = await assets.then(([, p]) => p);
  // Handle for the capture harness in tools/ (and for poking at it in a console).
  window.__skyline = { renderer, scene, camera, city, player, rings, cam, hud, input, avatar, backend, start,
    draw: () => (post ? post.renderAsync() : renderer.renderAsync(scene, camera)),
    stop: () => renderer.setAnimationLoop(null),
    step: simulate };
}

boot().catch((err) => fail(err?.message || String(err)));
