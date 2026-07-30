// The game: click open water to cast, wait through the nibbles, click when
// the bobber plunges. One small state machine owns the bobber, the line,
// and the leap of whatever took the bait.
//
// States: IDLE → CASTING → FLY → WAIT → BITE → (CATCH | ESCAPE) → REEL → IDLE

import * as THREE from 'three';
import { FISHING } from '../config.js';
import { rand, pick, clamp, easeOutCubic } from '../core/utils.js';
import { matte } from '../props/parts.js';
import { SPECIES, pickSpecies, buildFish } from '../props/fish.js';

const ESCAPE_LINES = [
  'It slipped away…',
  'Gone. The water smooths over.',
  'Too slow — just a swirl of teal left behind.',
];
const EARLY_LINES = [
  'Nothing yet. The water ripples patiently.',
  'Just seaweed. It happens to everyone.',
  'The bobber comes back empty.',
];

function buildBobber() {
  const g = new THREE.Group();
  const bottom = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 10, 7), matte(0xf2e8d8, { flatShading: false })
  );
  const top = new THREE.Mesh(
    new THREE.SphereGeometry(0.101, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2),
    matte(0xd8583e, { flatShading: false })
  );
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.1, 6), matte(0xd8583e));
  stem.position.y = 0.13;
  g.add(bottom, top, stem);
  return g;
}

export function createFishing({ scene, camera, fisher, water, fx, ui, audio }) {
  const bobber = buildBobber();
  bobber.visible = false;
  scene.add(bobber);

  const LINE_PTS = 24;
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(LINE_PTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
    color: 0x241c16, transparent: true, opacity: 0.7,
  }));
  line.frustumCulled = false;
  line.visible = false;
  scene.add(line);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tipPos = new THREE.Vector3();
  const from = new THREE.Vector3();
  const target = new THREE.Vector3();

  let st = 'IDLE';
  let tState = 0;
  let tNow = 0;
  let waitDur = 0;
  let nibbleTimes = [];
  let nibbleAnim = 0;      // >0 while the bobber dips for a fake-out
  let flyDur = 0.5;
  let arcH = 1.5;
  let caught = 0;
  let firstCast = true;
  let fishAnim = null;     // { mesh, species, t, from }

  function screenToWater(e) {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const t = -ray.ray.origin.y / ray.ray.direction.y;
    if (!(t > 0)) return null;
    return ray.ray.at(t, new THREE.Vector3());
  }

  function validTarget(p) {
    fisher.rodTip.getWorldPosition(tipPos);
    const d = Math.hypot(p.x - tipPos.x, p.z - tipPos.z);
    if (d < FISHING.castMin || d > FISHING.castMax) return false;
    if (Math.abs(p.x) < 2.1 && p.z > -12.9 && p.z < 7) return false;         // dock
    if (p.x > -8.9 && p.x < -3.3 && p.z > -9.6 && p.z < -5.0) return false;  // hut
    if (Math.hypot(p.x - 4.5, p.z + 9.9) < 3.4) return false;                // boat
    return true;
  }

  function setState(next) { st = next; tState = 0; }

  function beginCast(p) {
    target.copy(p);
    setState('CASTING');
    fisher.playCast(() => {
      fisher.rodTip.getWorldPosition(from);
      const d = from.distanceTo(target);
      flyDur = 0.42 + d * 0.012;
      arcH = 1.1 + d * 0.07;
      bobber.position.copy(from);
      bobber.visible = true;
      line.visible = true;
      setState('FLY');
      audio.whoosh();
    });
  }

  function land() {
    setState('WAIT');
    waitDur = rand(FISHING.waitMin, FISHING.waitMax);
    const n = Math.random() < 0.45 ? (Math.random() < 0.3 ? 2 : 1) : 0;
    nibbleTimes = Array.from({ length: n }, () => waitDur * rand(0.3, 0.8)).sort();
    fx.ripple(target.x, target.z, 0.9);
    fx.splash(target.x, target.z, 0.8);
    audio.plip(0.8);
    if (firstCast) { firstCast = false; ui.hint(false); }
  }

  function bite() {
    setState('BITE');
    fisher.setBite(true);
    ui.bang(true);
    fx.ripple(target.x, target.z, 1.3);
    audio.bite();
  }

  function escape() {
    setState('REEL');
    fisher.setBite(false);
    ui.bang(false);
    fx.ripple(target.x, target.z, 0.8);
    ui.toast(pick(ESCAPE_LINES));
  }

  function hook() {
    const species = pickSpecies();
    fisher.setBite(false);
    ui.bang(false);
    fx.splash(target.x, target.z, 1.6);
    fx.ripple(target.x, target.z, 1.6);
    audio.plip(1.3);
    const mesh = buildFish(species);
    mesh.position.copy(bobber.position);
    scene.add(mesh);
    fishAnim = { mesh, species, t: 0, from: bobber.position.clone() };
    setState('CATCH');
  }

  function resolveCatch(species) {
    caught++;
    ui.tally(caught);
    const stars = species.stars > 0 ? '★'.repeat(species.stars) : '';
    ui.toast(`You caught ${species.name}!`, species.flavor, stars);
    audio.chime(species.stars);
  }

  addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('button')) return;
    audio.ensure();
    if (st === 'IDLE') {
      const p = screenToWater(e);
      if (p && validTarget(p)) beginCast(p);
      else if (p) ui.toast('Cast toward open water.');
    } else if (st === 'WAIT') {
      setState('REEL');
      ui.toast(pick(EARLY_LINES));
    } else if (st === 'BITE') {
      hook();
    }
  });

  // Hover cursor: pointer over castable water.
  addEventListener('pointermove', (e) => {
    if (st !== 'IDLE') { document.body.style.cursor = ''; return; }
    const p = screenToWater(e);
    document.body.style.cursor = p && validTarget(p) ? 'pointer' : '';
  });

  function updateLine() {
    fisher.rodTip.getWorldPosition(tipPos);
    const sag = st === 'BITE' ? 0.05 : st === 'FLY' ? 0.15 : 0.5;
    const pos = lineGeo.attributes.position.array;
    for (let i = 0; i < LINE_PTS; i++) {
      const u = i / (LINE_PTS - 1);
      const x = tipPos.x + (bobber.position.x - tipPos.x) * u;
      const y = tipPos.y + (bobber.position.y - tipPos.y) * u - Math.sin(u * Math.PI) * sag;
      const z = tipPos.z + (bobber.position.z - tipPos.z) * u;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.computeBoundingSphere?.();
  }

  function waterY() {
    return water.heightAt(target.x, target.z, tNow);
  }

  function update(dt, t) {
    tNow = t;
    tState += dt;

    if (st === 'FLY') {
      const u = clamp(tState / flyDur, 0, 1);
      const k = easeOutCubic(u);
      bobber.position.lerpVectors(from, target, k);
      bobber.position.y = from.y + (waterY() - from.y) * k + arcH * 4 * k * (1 - k);
      if (u >= 1) land();
    } else if (st === 'WAIT') {
      if (nibbleTimes.length && tState >= nibbleTimes[0]) {
        nibbleTimes.shift();
        nibbleAnim = 0.35;
        fx.ripple(target.x, target.z, 0.5);
        audio.plip(0.35);
      }
      nibbleAnim = Math.max(0, nibbleAnim - dt);
      const dip = nibbleAnim > 0 ? Math.sin((0.35 - nibbleAnim) / 0.35 * Math.PI) * 0.12 : 0;
      bobber.position.y = waterY() + 0.04 + Math.sin(t * 2.1) * 0.03 - dip;
      if (tState >= waitDur) bite();
    } else if (st === 'BITE') {
      bobber.position.y = waterY() - 0.22 + Math.sin(t * 22) * 0.035;
      if (tState > FISHING.biteWindow) escape();
    } else if (st === 'CATCH') {
      // Bobber reels home while the fish leaps.
      fisher.rodTip.getWorldPosition(tipPos);
      bobber.position.lerp(tipPos, clamp(dt * 3.2, 0, 1));
      if (fishAnim) {
        fishAnim.t += dt;
        const u = clamp(fishAnim.t / 1.15, 0, 1);
        const m = fishAnim.mesh;
        m.position.lerpVectors(fishAnim.from, tipPos, u * 0.75);
        m.position.y = fishAnim.from.y + Math.sin(u * Math.PI) * 2.1 + u * 0.5;
        m.rotation.z = -u * Math.PI * 1.6;
        m.rotation.y = u * 2.2;
        if (fishAnim.species.sparkle && Math.random() < 0.35) fx.sparkle(m.position, 3);
        if (u >= 1) {
          scene.remove(m);
          fx.sparkle(m.position, fishAnim.species.sparkle ? 14 : 6);
          resolveCatch(fishAnim.species);
          fishAnim = null;
          setState('REEL');
        }
      }
    } else if (st === 'REEL') {
      fisher.rodTip.getWorldPosition(tipPos);
      bobber.position.lerp(tipPos, clamp(dt * 4.5, 0, 1));
      if (bobber.position.distanceTo(tipPos) < 0.25 || tState > 1.2) {
        bobber.visible = false;
        line.visible = false;
        setState('IDLE');
      }
    }

    if (bobber.visible) updateLine();
    if (st === 'BITE') ui.bangAt(bobber.position, camera);
  }

  // Debug hooks for the headless capture harness.
  window.__dockside = {
    get state() { return st; },
    get caught() { return caught; },
    forceBite() { if (st === 'WAIT') bite(); },
    castAt(x, z) {
      if (st === 'IDLE') beginCast(new THREE.Vector3(x, 0, z));
    },
    SPECIES,
  };

  return { update };
}
