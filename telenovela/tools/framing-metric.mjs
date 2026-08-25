#!/usr/bin/env node
// Where does the subject actually sit in frame, shot by shot.
//
//   node tools/framing-metric.mjs                      # the whole episode
//   node tools/framing-metric.mjs --scenes encuentro,gemelo
//   node tools/framing-metric.mjs --json
//
// camera-metric.mjs answers "does the camera move like an operator". This
// answers the other half: "would a DP sign off on this frame". It drives the
// real page, steps every scene at 60 Hz, and projects the live subject through
// the live camera every frame, so what it reports is what the audience sees —
// after handheld sway, after the springs, after the avoidance search moved the
// camera somewhere the script did not ask for.
//
// Per shot it reports the median over the shot's life (median, not mean: one
// frame of a whip pan should not condemn a held frame), of:
//
//   eyeY    the eyes' vertical position, -1 bottom to +1 top of frame.
//           Film convention puts them on the upper third, near +0.33. Dead
//           centre is the look of security-camera footage.
//   eyeX    horizontal position, same units.
//   nose    how much room the subject has in the direction they face, minus
//           the room behind their head, in frame widths. Positive is correct:
//           a face looking out of frame with its back to open space is the
//           single most common amateur framing error.
//   fill    the subject's height as a fraction of frame height — what tells
//           you a "close-up" is really a medium, or that a wide has lost its
//           subject entirely.
//
// FLAGS are the shot-size-aware verdicts: eyes too low or too high, no nose
// room, subject too small or too large for its declared framing, or a subject
// that is off frame altogether.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const sceneRef = (s) => (/^\d+$/.test(s) ? +s : s);
const SCENES = args.indexOf('--scenes') >= 0
  ? args[args.indexOf('--scenes') + 1].split(',').map(sceneRef)
  : null;                                   // null = every scene in the episode

const SETTLE = 8;                            // frames of the cut itself, dropped
const FPS = 60;
const MIN_FRAMES = SETTLE + 12;

// What each shot size is supposed to deliver. `fill` is the subject's height as
// a share of the frame; `eye` is where the eyes belong vertically. Tighter
// shots carry the eyes higher — a close-up with the eyes at the centre leaves
// half a frame of forehead and no room to breathe.
// `fill` is the subject's whole standing height measured in NDC, where the
// frame itself is 2.0 tall. So 2.0 means head-to-toe exactly fills the frame,
// and 6.0 means only about a third of the bird is on screen.
// eye targets mirror engine/camera.js COMPOSE_Y — the tool and the solver have
// to agree on what "right" is, or one of them is grading the other's homework.
const RULES = {
  ecu: { fill: [6.0, 40], eye: 0.10 },
  bcu: { fill: [4.2, 11], eye: 0.18 },
  cu: { fill: [2.6, 7.0], eye: 0.23 },
  mcu: { fill: [1.9, 4.8], eye: 0.25 },
  ms: { fill: [1.3, 3.4], eye: 0.22 },
  mls: { fill: [0.85, 2.3], eye: 0.18 },
  ws: { fill: [0.45, 1.6], eye: 0.12 },
  ews: { fill: [0.04, 0.8], eye: 0.06 },
};
const EYE_TOL = 0.16;        // how far off the mark still reads as intentional
const NOSE_MIN = -0.02;      // below this the subject is looking out of frame

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    let u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    const p = join(ROOT, u);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.error('page error:', (e.stack || e.message).slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__telenovela, null, { timeout: 30000 });
await page.evaluate(async () => {
  await window.__telenovela.dressed;
  if (window.__telenovela.castReady) await window.__telenovela.castReady;
});

const traces = await page.evaluate(({ refs, step }) => {
  const T = window.__telenovela;
  const cam = T.dir.ctx.cam;
  const list = refs === null
    ? T.dir.scenes.map((_, i) => i)
    : refs.map((r) => (typeof r === 'string' ? T.dir.indexOf(r) : r));
  const out = [];

  for (const i of list) {
    if (i < 0) continue;
    const scene = T.dir.scenes[i];
    const samples = [], shots = [];
    const take = cam.take.bind(cam);
    cam.take = (spec) => {
      const r = take(spec);
      const s = cam.shot;
      shots.push({
        frame: samples.length, label: s.label || '', frame_size: s.frame,
        lens: s.lens, subject: s.subject && s.subject.key ? s.subject.key : null,
        over: !!s.over, move: s.move ? s.move.type : '',
      });
      return r;
    };

    T.dir.goTo(i);
    let time = 0;
    for (let g = 0; g < 60000; g++) {
      const sdt = T.dir.update(step);
      if (T.dir.index !== i) break;
      if (sdt <= 0) continue;
      time += sdt;
      for (const k in T.actors) T.actors[k].update(sdt, time, step);
      // The camera only moves when it is driven; without this the whole trace
      // is measured against wherever the lens was parked.
      cam.update(sdt, time);

      // Project the live subject through the live camera, exactly as rendered.
      const s = cam.shot;
      const sub = s && s.subject;
      let row = null;
      if (sub && sub.headWorld) {
        const c = T.dir.ctx.camera;
        c.updateMatrixWorld(true);
        const eye = sub.eyeWorld(new c.position.constructor(), c.position);
        const head = sub.headWorld(new c.position.constructor());
        const foot = new c.position.constructor(sub.pos.x, 0, sub.pos.z);
        const pe = eye.clone().project(c);
        const ph = head.clone().project(c);
        const pf = foot.clone().project(c);
        // Facing direction in screen space: where the beak points.
        const fwd = new c.position.constructor(Math.sin(sub.yaw), 0, Math.cos(sub.yaw));
        const ahead = head.clone().add(fwd.multiplyScalar(0.25)).project(c);
        row = {
          eyeX: pe.x, eyeY: pe.y, behind: pe.z > 1,
          top: ph.y, footY: pf.y, faceX: ahead.x - ph.x,
          vis: !!(sub.rig && sub.rig.root && sub.rig.root.visible),
        };
      }
      samples.push(row);
    }
    cam.take = take;
    out.push({ index: i, id: scene.id, name: scene.name, samples, shots });
  }
  return out;
}, { refs: SCENES, step: 1 / FPS });

await browser.close();
server.close();

const median = (a) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  return b[b.length >> 1];
};

const scenes = [];
for (const tr of traces) {
  const rows = [];
  for (let k = 0; k < tr.shots.length; k++) {
    const s = tr.shots[k];
    const end = k + 1 < tr.shots.length ? tr.shots[k + 1].frame : tr.samples.length;
    const span = tr.samples.slice(s.frame + SETTLE, end).filter(Boolean);
    if (end - s.frame < MIN_FRAMES || !span.length) continue;
    const live = span.filter((r) => r.vis && !r.behind);
    if (!live.length) {
      rows.push({ ...s, dur: (end - s.frame) / FPS, offstage: true, flags: ['subject not on stage'] });
      continue;
    }
    const eyeY = median(live.map((r) => r.eyeY));
    const eyeX = median(live.map((r) => r.eyeX));
    // Subject height in frame: eyes to feet, doubled — a bird's eyes sit about
    // halfway up its standing silhouette, and the feet are often out of frame.
    const fill = median(live.map((r) => Math.abs(r.top - r.footY)));
    // Room in the direction faced, minus the room behind. NDC x is 2 wide.
    const nose = median(live.map((r) => {
      const dir = Math.sign(r.faceX) || 1;
      const roomAhead = (dir > 0 ? 1 - r.eyeX : r.eyeX + 1) / 2;
      const roomBehind = (dir > 0 ? r.eyeX + 1 : 1 - r.eyeX) / 2;
      // Only counts when the subject is actually turned; a head-on subject
      // has no side to lead into.
      return (roomAhead - roomBehind) * Math.min(1, Math.abs(r.faceX) * 6);
    }));
    const onScreen = live.filter((r) => Math.abs(r.eyeX) < 1 && Math.abs(r.eyeY) < 1).length / live.length;

    const rule = RULES[s.frame_size];
    const flags = [];
    if (onScreen < 0.6) flags.push('subject off frame');
    if (rule) {
      if (eyeY < rule.eye - EYE_TOL) flags.push(`eyes low (${eyeY.toFixed(2)} vs ${rule.eye})`);
      if (eyeY > rule.eye + EYE_TOL + 0.12) flags.push(`eyes high (${eyeY.toFixed(2)})`);
      if (fill < rule.fill[0]) flags.push(`too small for ${s.frame_size} (${fill.toFixed(2)})`);
      if (fill > rule.fill[1]) flags.push(`too large for ${s.frame_size} (${fill.toFixed(2)})`);
    }
    if (nose < NOSE_MIN && !s.over) flags.push(`no nose room (${nose.toFixed(2)})`);
    rows.push({
      ...s, dur: +((end - s.frame) / FPS).toFixed(2),
      eyeX: +eyeX.toFixed(3), eyeY: +eyeY.toFixed(3), nose: +nose.toFixed(3),
      fill: +fill.toFixed(3), onScreen: +onScreen.toFixed(2), flags,
    });
  }
  scenes.push({ id: tr.id, name: tr.name, shots: rows });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ scenes }, null, 2));
} else {
  let flagged = 0, total = 0;
  for (const sc of scenes) {
    console.log(`\n${sc.name}`);
    console.log('  shot                                     size  lens   eyeY   eyeX   nose   fill');
    for (const r of sc.shots) {
      total++;
      if (r.flags.length) flagged++;
      if (r.offstage) { console.log(`  ${(r.label || '?').padEnd(38)} ${String(r.frame_size).padEnd(5)} ${String(r.lens).padEnd(5)}  -- subject not on stage`); continue; }
      console.log(`  ${(r.label || '?').padEnd(38)} ${String(r.frame_size).padEnd(5)} ${String(r.lens).padEnd(5)} ${r.eyeY.toFixed(2).padStart(6)} ${r.eyeX.toFixed(2).padStart(6)} ${r.nose.toFixed(2).padStart(6)} ${r.fill.toFixed(2).padStart(6)}${r.flags.length ? '   <-- ' + r.flags.join('; ') : ''}`);
    }
  }
  console.log(`\n${flagged} of ${total} shots flagged`);
}
