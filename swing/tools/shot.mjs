#!/usr/bin/env node
// Headless capture and smoke test.
//
//   node tools/shot.mjs --out shots/frame.png --wait 6000 --w 1280 --h 720
//   node tools/shot.mjs --out shots/phone.png --w 390 --h 844 --touch
//
// Boots the game in Chromium, plays it for a few seconds by driving the same
// input object the player uses, and writes a PNG. Exits non-zero on any page
// error or console error, so it doubles as the regression test.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs',
    process.env.PLAYWRIGHT_PATH,
  ].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

const OUT = opt('out', 'shots/frame.png');
const WAIT = +opt('wait', 6000);
const W = +opt('w', 1280);
const H = +opt('h', 720);
const TOUCH = has('touch');
const KEEP = has('title');            // capture the menu instead of playing
const FREEZE = opt('freeze', '');     // "x,y,z,tx,ty,tz" — scenic still instead of chase cam
const SIM = +opt('sim', 0);           // seconds of bot-driven play, no rendering
const TRACE = has('trace');           // sample the sim twice a second
const FOLLOW = has('follow');         // frame the capture from a clean chase position

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  hasTouch: TOUCH,
  isMobile: TOUCH,
});

const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  logs.push(`${m.type()}: ${t}`);
  if (m.type() === 'error') errors.push(`console: ${t}`);
});
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });

// Wait for boot, then play.
await page.waitForFunction(() => window.__skyline || !document.getElementById('fail').hidden, null, { timeout: 60000 });

const report = await page.evaluate(async ({ wait, keep, freeze, sim, trace, follow }) => {
  const s = window.__skyline;
  if (!s) return { fatal: document.getElementById('fail-msg').textContent };
  if (keep) return { backend: s.backend, skipped: true };

  s.start();
  const input = s.input;
  input.enabled = true;

  const t0 = performance.now();
  let frames = 0;
  const count = () => { frames++; requestAnimationFrame(count); };
  requestAnimationFrame(count);

  // Scenic still: stop the loop and let any in-flight frame land before taking
  // the camera over, or that frame renders the chase view on top of ours.
  if (freeze) {
    s.stop();
    await new Promise((r) => setTimeout(r, 6000));
    const [x, y, z, tx, ty, tz] = freeze.split(',').map(Number);
    s.camera.position.set(x, y, z);
    s.camera.up.set(0, 1, 0);
    s.camera.lookAt(tx, ty, tz);
    s.camera.updateMatrixWorld(true);
    await s.draw();
    return { backend: s.backend, frozen: true, buildings: s.city.count, avatar: !!s.avatar?.ready };
  }

  // Simulation-only run: no drawing at all, fixed timestep, driven by a bot that
  // chases the ring course the way a player would. This is how the game gets
  // play-tested here — the software rasteriser is far too slow to judge feel.
  if (sim > 0) {
    s.stop();
    const DT = 1 / 60;
    const steps = Math.round(sim / DT);
    const p = s.player, cam = s.cam, rings = s.rings;

    const stat = {
      distance: 0, speedSum: 0, speedMax: 0, fastFrames: 0, stuckWorst: 0,
      minY: Infinity, maxY: -Infinity,
      events: {}, attachedFrames: 0,
    };
    let stuck = 0, side = -1, hold = false, cooldown = 0;
    const prev = { x: p.pos.x, y: p.pos.y, z: p.pos.z };

    // Count events by patching the array the player refills each step.
    const tally = () => { for (const e of p.events) stat.events[e] = (stat.events[e] || 0) + 1; };

    for (let i = 0; i < steps; i++) {
      // Aim at the next ring in the chain.
      const t = rings.target;
      if (t) {
        const want = Math.atan2(-(t.pos.x - p.pos.x), -(t.pos.z - p.pos.z));
        let d = want - cam.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        input.lookX = Math.max(-0.06, Math.min(0.06, d * 0.09));
        const rise = t.pos.y - p.pos.y;
        input.lookY = Math.max(-0.03, Math.min(0.03, (rise / 120 - cam.pitch) * 0.05));
      }

      // Swing cycle: attach, ride to the bottom of the arc, release, dive, repeat.
      cooldown -= DT;
      if (!p.web.active && !hold && cooldown <= 0) {
        side = -side;
        hold = true;
      } else if (p.web.active && p.vel.y > 2) {
        hold = false;
        cooldown = 0.42;
      }
      input.webLeft = hold && side < 0;
      input.webRight = hold && side > 0;
      input.dive = !p.web.active && p.vel.y < -6 && cooldown > 0.15;
      input.reel = p.web.active && p.vel.y < 0;

      // Steer and boost toward the ring the way a player would. Lateral steering
      // has to go through the held-key set, because sample() rebuilds the
      // analogue fields from it every step and would overwrite a direct write.
      input.held.delete('left');
      input.held.delete('right');
      if (t) {
        const want = Math.atan2(-(t.pos.x - p.pos.x), -(t.pos.z - p.pos.z));
        let err = want - cam.yaw;
        while (err > Math.PI) err -= Math.PI * 2;
        while (err < -Math.PI) err += Math.PI * 2;
        if (err > 0.12) input.held.add('left');
        else if (err < -0.12) input.held.add('right');

        const range = p.pos.distanceTo(t.pos);
        const rising = t.pos.y - p.pos.y;
        if (!p.web.active && range < 110 && Math.abs(err) < 0.5 && rising > -6) input.boost = true;
      }

      s.step(DT);
      tally();

      const dx = p.pos.x - prev.x, dy = p.pos.y - prev.y, dz = p.pos.z - prev.z;
      stat.distance += Math.hypot(dx, dy, dz);
      prev.x = p.pos.x; prev.y = p.pos.y; prev.z = p.pos.z;
      stat.speedSum += p.speed;
      stat.speedMax = Math.max(stat.speedMax, p.speed);
      if (p.speed * 3.6 > 100) stat.fastFrames++;
      if (p.web.active) stat.attachedFrames++;
      stat.minY = Math.min(stat.minY, p.pos.y);
      stat.maxY = Math.max(stat.maxY, p.pos.y);
      const tgt = rings.target;
      if (tgt) stat.nearestRing = Math.min(stat.nearestRing ?? Infinity, p.pos.distanceTo(tgt.pos));
      stuck = p.speed < 3 ? stuck + 1 : 0;
      stat.stuckWorst = Math.max(stat.stuckWorst, stuck);

      if (trace && i % 30 === 0) {
        stat.trace = stat.trace || [];
        stat.trace.push([
          +(i * DT).toFixed(1), Math.round(p.pos.x), Math.round(p.pos.y), Math.round(p.pos.z),
          Math.round(p.speed * 3.6), p.web.active ? 'A' : '-', p.grounded ? 'G' : '-',
          p.events.join('|'),
        ].join(' '));
      }
      if (i % 900 === 0) await new Promise((r) => setTimeout(r, 0));   // keep the page alive
    }

    // What does the world actually look like from where the run ended? Casts the
    // same kind of fan the anchor search uses, so a run that ends stuck reports
    // whether there was anything to grab at all.
    const probe = { point: p.pos.clone(), normal: p.pos.clone(), distance: 0, index: -1 };
    const dir = p.pos.clone();
    const around = [];
    for (const pitchDeg of [6, 28, 54, 68]) {
      for (const yawDeg of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const yr = yawDeg * Math.PI / 180, pr = pitchDeg * Math.PI / 180;
        dir.set(Math.sin(yr) * Math.cos(pr), Math.sin(pr), Math.cos(yr) * Math.cos(pr));
        const h = s.city.raycast(p.pos, dir, 105, probe);
        if (h) around.push(`y${yawDeg} p${pitchDeg}: d=${h.distance.toFixed(0)} dy=${(h.point.y - p.pos.y).toFixed(0)}`);
      }
    }

    // Drive the player straight through the next ring to prove the pickup gate
    // itself works — otherwise a run that scores nothing is ambiguous between a
    // bot that cannot aim and a ring that cannot be collected.
    let ringGateWorks = null;
    const gateTarget = rings.target;
    if (gateTarget) {
      const before = rings.collected;
      p.prev.copy(gateTarget.pos).addScaledVector(gateTarget.normal, -6);
      p.pos.copy(gateTarget.pos).addScaledVector(gateTarget.normal, 6);
      rings.update(1 / 60, p, 0);
      ringGateWorks = rings.collected === before + 1;
    }

    // Ask the anchor search itself, from wherever the run ended.
    const heading = [cam.basis.flat.x, cam.basis.flat.y, cam.basis.flat.z].map((v) => +v.toFixed(2));
    const attachWorks = p.tryAttach(-1, cam.basis);
    const anchor = attachWorks ? [p.web.anchor.x, p.web.anchor.y, p.web.anchor.z].map((v) => Math.round(v)) : null;

    return {
      backend: s.backend,
      simSeconds: sim,
      endedAt: [p.pos.x, p.pos.y, p.pos.z].map((v) => Math.round(v)),
      endedGrounded: p.grounded,
      endedHeading: heading,
      attachFromHere: attachWorks,
      anchorFound: anchor,
      around: around.length ? around : 'nothing within 105 m',
      avatar: !!s.avatar?.ready,
      buildings: s.city.count,
      km: +(stat.distance / 1000).toFixed(2),
      avgKmh: +(stat.speedSum / steps * 3.6).toFixed(1),
      maxKmh: +(stat.speedMax * 3.6).toFixed(1),
      pctOver100kmh: +(stat.fastFrames / steps * 100).toFixed(1),
      pctAttached: +(stat.attachedFrames / steps * 100).toFixed(1),
      ringsPerMin: +(rings.collected / (sim / 60)).toFixed(1),
      closestApproachToRing: +(stat.nearestRing ?? -1).toFixed(1),
      ringGateWorks,
      rings: rings.collected,
      score: rings.score,
      bestCombo: rings.combo,
      altitude: { min: +stat.minY.toFixed(1), max: +stat.maxY.toFixed(1) },
      longestStallSeconds: +(stat.stuckWorst * DT).toFixed(2),
      events: stat.events,
      trace: stat.trace,
    };
  }

  // Swing: hold a web, alternate hands, dive between arcs.
  const step = async (ms, fn) => {
    fn();
    await new Promise((r) => setTimeout(r, ms));
  };
  const cycles = Math.max(1, Math.floor(wait / 1600));
  for (let i = 0; i < cycles; i++) {
    const side = i % 2 ? 'webRight' : 'webLeft';
    await step(950, () => { input[side] = true; input.reel = i % 3 === 0; });
    await step(420, () => { input[side] = false; input.reel = false; input.dive = true; });
    await step(230, () => { input.dive = false; });
  }
  await step(500, () => { input.webLeft = true; });

  // Settle before capturing. Left running, the loop saturates the software
  // rasteriser and the screenshot never gets a stable frame — so stop it, let
  // any in-flight frame land, and draw exactly one.
  s.stop();
  await new Promise((r) => setTimeout(r, 6000));

  // Optional hero framing: the in-game camera pulls right in when the player
  // swings close to a facade, which is correct to play and unreadable as a
  // still. This puts the shot back where a chase camera in open air would be.
  if (follow) {
    const p0 = s.player;
    const back = p0.vel.clone();
    back.y = 0;
    if (back.lengthSq() < 1) back.set(0, 0, 1);
    back.normalize();
    s.camera.position.copy(p0.pos).addScaledVector(back, -16).setY(p0.pos.y + 7);
    s.camera.up.set(0, 1, 0);
    s.camera.lookAt(p0.pos.x, p0.pos.y, p0.pos.z);
    s.camera.updateMatrixWorld(true);
  }
  await s.draw();

  const p = s.player;
  return {
    backend: s.backend,
    fps: Math.round(frames / ((performance.now() - t0) / 1000)),
    speed: +(p.speed * 3.6).toFixed(1),
    altitude: +p.pos.y.toFixed(1),
    attached: p.web.active,
    score: s.rings.score,
    collected: s.rings.collected,
    avatar: !!s.avatar?.ready,
    buildings: s.city.count,
    drawCalls: s.renderer.info?.render?.drawCalls ?? null,
  };
}, { wait: WAIT, keep: KEEP, freeze: FREEZE, sim: SIM, trace: TRACE, follow: FOLLOW });

if (!SIM) await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
// Software rasterisation can take seconds per frame; the default 30 s cap is
// not enough to catch a settled one.
if (!SIM) await page.screenshot({ path: join(ROOT, OUT), type: 'png', timeout: 180000, animations: 'disabled' });

await browser.close();
server.close();

console.log(JSON.stringify(SIM ? { ...report, errors } : { out: OUT, ...report, errors }, null, 2));
if (report.fatal || errors.length) process.exit(1);
