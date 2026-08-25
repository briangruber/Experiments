#!/usr/bin/env node
// How smooth is the camera, in numbers.
//
//   node tools/camera-metric.mjs                          # entrada encuentro gemelo
//   node tools/camera-metric.mjs --scenes bofetada,gemelo # ids or indices
//   node tools/camera-metric.mjs --json                   # machine-readable summary
//
// Watching a render tells you a shot feels nervous; it does not tell you which
// shot, or whether yesterday's change made it worse. This drives the real page
// the way audio-timeline.mjs does — step each scene at a fixed 60Hz, exactly
// the loop main.js runs — and samples the rendered camera's position and
// orientation every frame. From those it reports, per shot:
//
//   RMS jerk        third derivative of position (m/s^3), the number that
//                   tracks "reads as vibration" — smooth drift is low, noise
//                   and stepped moves are high
//   max ang accel   worst orientation kick (rad/s^2) — whip pans and aim
//                   jitter live here
//
// The first few frames of every shot are excluded: a hard cut IS a position
// discontinuity, and measuring it would drown the number the tool exists to
// report (how the shot behaves once it is on screen). Shots are grouped by
// their handheld level, because an operator's sway is deliberate motion and a
// locked-off crane move should be held to a stricter standard.

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
  : ['entrada', 'encuentro', 'gemelo'];

// Frames dropped from the head of every shot before measuring: the cut itself,
// plus the whip smear's intended swing.
const SETTLE = 8;
const FPS = 60;
const DT = 1 / FPS;
// A shot has to be on screen this long before its statistics mean anything.
const MIN_FRAMES = SETTLE + 12;

async function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH].filter(Boolean)) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary' };
const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
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
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => { console.error('pageerror:', e.message); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__telenovela, null, { timeout: 30000 });
await page.evaluate(() => window.__telenovela.dressed);

const traces = await page.evaluate(({ refs, step }) => {
  const T = window.__telenovela;
  const cam = T.dir.ctx.cam;
  const out = [];

  // Silence the score: cues fire it, and headless there is no audio context
  // running to receive them. Same trick audio-timeline.mjs uses.
  const real = T.dir.ctx.score;
  const mute = Object.create(real);
  for (const m of ['play', 'say', 'sting', 'thunder', 'slap', 'heartbeat', 'crow', 'squawk',
    'cluck', 'flap', 'eggCrack', 'peep', 'setMood', 'setRain', 'setAmbience', 'harpRun']) {
    mute[m] = () => ({ duration: 0 });
  }
  mute.scheduling = true;
  T.dir.ctx.score = mute;

  const origTake = cam.take.bind(cam);
  try {
    for (const ref of refs) {
      const i = typeof ref === 'string' ? T.dir.indexOf(ref) : ref;
      if (i < 0) throw new Error(`unknown scene '${ref}'`);
      const scene = T.dir.scenes[i];

      const pos = [], quat = [], shots = [];
      // Every take() marks a shot boundary at the current sample index, with
      // the resolved spec — the schema fields the report groups by.
      cam.take = (spec) => {
        const r = origTake(spec);
        const s = cam.shot;
        shots.push({
          frame: pos.length / 3, label: cam.label, cut: !!s.cut, whip: !!s.whip,
          handheld: s.handheld, smooth: s.smooth, move: s.move ? s.move.type : null,
        });
        return r;
      };

      T.dir.goTo(i);
      let time = 0;
      for (let guard = 0; guard < 60000; guard++) {
        const sdt = T.dir.update(step);
        if (T.dir.index !== i) break;
        if (sdt > 0) {
          time += sdt;
          for (const k in T.actors) T.actors[k].update(sdt, time, step);
          cam.update(sdt, time);
          const c = cam.camera;
          pos.push(c.position.x, c.position.y, c.position.z);
          quat.push(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w);
        }
      }
      out.push({ index: i, id: scene.id, name: scene.name, pos, quat, shots });
    }
  } finally {
    cam.take = origTake;
    T.dir.ctx.score = real;
  }
  return out;
}, { refs: SCENES, step: DT });

await browser.close();
server.close();

// --- metrics -----------------------------------------------------------------

const v3 = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const q4 = (a, i) => [a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]];

// Angular velocity vector taking q0 to q1 over dt, from the relative rotation
// conj(q0) * q1 read as axis-angle.
function angVel(q0, q1, dt) {
  const [x0, y0, z0, w0] = q0, [x1, y1, z1, w1] = q1;
  // conj(q0) * q1
  const w = w0 * w1 + x0 * x1 + y0 * y1 + z0 * z1;
  const x = w0 * x1 - x0 * w1 - y0 * z1 + z0 * y1;
  const y = w0 * y1 + x0 * z1 - y0 * w1 - z0 * x1;
  const z = w0 * z1 - x0 * y1 + y0 * x1 - z0 * w1;
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-12) return [0, 0, 0];
  const ang = 2 * Math.atan2(s, Math.abs(w));
  const k = (w < 0 ? -ang : ang) / (s * dt);
  return [x * k, y * k, z * k];
}

function shotMetrics(pos, quat, a, b) {
  // Third central-ish difference: j_i = (p3 - 3 p2 + 3 p1 - p0) / dt^3.
  let sum = 0, n = 0, maxAng = 0;
  for (let i = a; i + 3 < b; i++) {
    const p0 = v3(pos, i), p1 = v3(pos, i + 1), p2 = v3(pos, i + 2), p3 = v3(pos, i + 3);
    const jx = p3[0] - 3 * p2[0] + 3 * p1[0] - p0[0];
    const jy = p3[1] - 3 * p2[1] + 3 * p1[1] - p0[1];
    const jz = p3[2] - 3 * p2[2] + 3 * p1[2] - p0[2];
    const j = Math.sqrt(jx * jx + jy * jy + jz * jz) / (DT * DT * DT);
    sum += j * j; n++;
  }
  for (let i = a; i + 2 < b; i++) {
    const w0 = angVel(q4(quat, i), q4(quat, i + 1), DT);
    const w1 = angVel(q4(quat, i + 1), q4(quat, i + 2), DT);
    const acc = Math.sqrt((w1[0] - w0[0]) ** 2 + (w1[1] - w0[1]) ** 2 + (w1[2] - w0[2]) ** 2) / DT;
    if (acc > maxAng) maxAng = acc;
  }
  return { rmsJerk: n ? Math.sqrt(sum / n) : 0, maxAngAcc: maxAng, frames: b - a };
}

const LOW_HH = 0.45; // at or under this, the operator is meant to be steady
const summary = { scenes: [], settleFrames: SETTLE };

for (const tr of traces) {
  const N = tr.pos.length / 3;
  const rows = [];
  for (let k = 0; k < tr.shots.length; k++) {
    const s = tr.shots[k];
    const end = k + 1 < tr.shots.length ? tr.shots[k + 1].frame : N;
    if (end - s.frame < MIN_FRAMES) continue;
    const m = shotMetrics(tr.pos, tr.quat, s.frame + SETTLE, end);
    rows.push({ ...s, ...m, seconds: (end - s.frame) * DT });
  }
  const grp = (f) => {
    const g = rows.filter(f);
    if (!g.length) return null;
    return {
      shots: g.length,
      rmsJerk: Math.sqrt(g.reduce((t, r) => t + r.rmsJerk * r.rmsJerk, 0) / g.length),
      maxAngAcc: Math.max(...g.map((r) => r.maxAngAcc)),
    };
  };
  summary.scenes.push({
    id: tr.id, name: tr.name, shots: rows,
    low: grp((r) => r.handheld <= LOW_HH),
    high: grp((r) => r.handheld > LOW_HH),
    all: grp(() => true),
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const sc of summary.scenes) {
    console.log(`\n${sc.id} — ${sc.name}`);
    console.log('  shot                                    hh    move       dur   RMS jerk  maxAngAcc');
    for (const r of sc.shots) {
      console.log(`  ${(r.label || '?').padEnd(38)} ${r.handheld.toFixed(2)}  ${String(r.move || (r.cut ? (r.whip ? 'whip-cut' : 'cut') : 'move')).padEnd(9)} ${r.seconds.toFixed(1).padStart(5)}s ${r.rmsJerk.toFixed(2).padStart(9)} ${r.maxAngAcc.toFixed(2).padStart(10)}`);
    }
    const f = (g, tag) => g && console.log(`  ${tag}: ${g.shots} shot(s)  RMS jerk ${g.rmsJerk.toFixed(2)} m/s^3  max ang acc ${g.maxAngAcc.toFixed(2)} rad/s^2`);
    f(sc.low, `steady (handheld <= ${LOW_HH})`);
    f(sc.high, `handheld (> ${LOW_HH})       `);
    f(sc.all, 'all shots                 ');
  }
  console.log();
}
