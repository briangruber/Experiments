// Headless smoke test and screenshot harness.
//
//   node tools/shot.mjs --out shots/frame.png [--seed ABCDE] [--play 12]
//                       [--pose creature|mannequin] [--webgpu] [--scare-shot]
//
// Boots the real game in headless Chromium on SwiftShader, drives it, and
// exits non-zero on any WebGPU error, page exception, failed request or
// console error. That makes it a usable CI check as well as a way to look at
// the game — there is no GPU on the machines this tends to run on, and
// "it renders" is otherwise unverifiable.
//
// SwiftShader is a software rasteriser: expect single-digit frame rates here.
// That is a property of the harness, not of the game.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const OUT = path.resolve(ROOT, flag('out', 'shots/frame.png'));
const SEED = flag('seed', 'SHOT1');
const PLAY_SECONDS = Number(flag('play', 6));
const WIDTH = Number(flag('w', 1280));
const HEIGHT = Number(flag('h', 720));
const PORT = Number(flag('port', 8123));

/** Playwright's default headless *shell* exposes no WebGPU at all, so the full
 *  Chromium binary and `--headless=new` are both required. */
const CHROME = process.env.CHROME_PATH
  ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const COMMON = ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--mute-audio'];

/**
 * Which backend to capture through.
 *
 * The game is a WebGPU game and `--webgpu` drives it as one. That path needs a
 * machine whose Dawn/SwiftShader stack actually survives a frame, and plenty
 * do not — the software adapter on a bare CI container typically creates a
 * device and then drops it, which renders as a perfectly black canvas with no
 * error anywhere.
 *
 * So the default is three's WebGL backend, running the identical scene,
 * materials and TSL post chain. It answers the question a screenshot is
 * actually being asked — does the level build, is it lit, did the assets land
 * where they should — on hardware where WebGPU cannot answer anything.
 */
const USE_WEBGPU = has('webgpu');
const BACKEND_ARGS = USE_WEBGPU
  ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan']
  : ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];
const GPU_ARGS = [...COMMON, ...BACKEND_ARGS];

function startServer() {
  const serverArgs = [path.join(ROOT, 'tools/serve.mjs'), '--port', String(PORT)];
  // `--csp` proves the single-file build survives an Artifact's policy.
  if (has('csp')) serverArgs.push('--csp');
  if (has('csp-noblob')) serverArgs.push('--csp-noblob');
  const proc = spawn(process.execPath, serverArgs, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('http://')) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.on('error', reject);
  });
}

async function main() {
  await mkdir(path.dirname(OUT), { recursive: true });
  const server = await startServer();

  const browser = await chromium.launch({
    headless: false, // `--headless=new` is passed explicitly instead.
    executablePath: CHROME,
    args: GPU_ARGS,
  });

  const problems = [];
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

  // Compatibility shim for the Chromium that ships with Playwright, which
  // implements an early draft of WebGPU's component swizzle where the value is
  // a dictionary. three r185 sends the newer string form ('rgba'), and this
  // build rejects it outright, killing the device on the first frame.
  //
  // This belongs to the harness, not to the game: current browsers accept what
  // three sends, and shipping the workaround would mean mutating a descriptor
  // in everyone's hot path to satisfy a browser nobody is running.
  await page.addInitScript(() => {
    if (typeof GPUTexture === 'undefined') return;
    const original = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function createView(descriptor) {
      if (descriptor && typeof descriptor.swizzle === 'string') {
        const { swizzle, ...rest } = descriptor;
        return original.call(this, rest);
      }
      return original.call(this, descriptor);
    };
  });

  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') problems.push(`console: ${text}`);
    if (has('verbose')) console.log(`  [${msg.type()}] ${text}`);
  });
  page.on('pageerror', (err) => problems.push(`exception: ${err.message}`));
  page.on('requestfailed', (req) => {
    problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`);
  });

  try {
    const query = new URLSearchParams({ seed: SEED });
    if (!USE_WEBGPU) query.set('backend', 'webgl');
    // `--page` points at an alternative entry — the single-file build lives at
    // dist/deadlight.html and has to be verified the same way as the served one.
    const entry = flag('page', '/');
    console.log(`· backend: ${USE_WEBGPU ? 'webgpu' : 'webgl (verification)'}${has('csp') ? ' · strict CSP' : ''}${has('csp-noblob') ? ' · strict CSP, no blob:' : ''}`);
    await page.goto(`http://localhost:${PORT}${entry}?${query}`, { waitUntil: 'domcontentloaded' });

    // Wait for assets: the menu is revealed only once everything has loaded.
    await page.waitForFunction(
      () => !document.getElementById('menu').hidden,
      { timeout: 180_000 },
    );
    const blocked = await page.$eval('#start', (b) => (b.disabled ? b.textContent : null));
    if (blocked) throw new Error(`start button disabled: ${blocked}`);
    console.log('· assets loaded, menu up');

    await page.click('#start');

    // The HUD appearing means the run is live.
    await page.waitForFunction(
      () => !document.getElementById('hud').hidden,
      { timeout: 120_000 },
    );
    console.log('· run started');

    // Drive it: walk forward, look around, and take a fuse if one is offered.
    const deadline = Date.now() + PLAY_SECONDS * 1000;
    await page.keyboard.down('KeyW');
    while (Date.now() < deadline) {
      await page.mouse.move(WIDTH / 2 + (Math.random() - 0.5) * 260, HEIGHT / 2);
      await page.keyboard.press('KeyE');
      await page.waitForTimeout(320);
    }
    await page.keyboard.up('KeyW');

    // Level the view. The drive loop above leaves the camera wherever the
    // last mouse jitter put it, and a capture of the ceiling is not evidence
    // that the level renders.
    await page.evaluate(() => { window.deadlight.game.player.pitch = -0.06; });

    // Optionally stage an asset in front of the camera. `--pose creature`
    // is how the rig and its merged clips get verified — the creature is the
    // one asset a run may legitimately never show you.
    const pose = flag('pose');
    if (pose) {
      await page.evaluate((which) => {
        const g = window.deadlight.game;
        const p = g.player;
        const ahead = p.forward().multiplyScalar(3.4).add(p.position);
        g.level.collide(ahead, 0.5);
        p.frozen = true;
        if (which === 'creature') {
          g.creature.spawn(ahead);
          g.creature.root.position.copy(ahead);
          g.creature.root.rotation.y = Math.atan2(p.position.x - ahead.x, p.position.z - ahead.z);
        } else {
          const m = g.mannequins.items[0];
          if (m) {
            m.object.position.copy(ahead);
            m.object.rotation.y = Math.atan2(p.position.x - ahead.x, p.position.z - ahead.z);
          }
        }
      }, pose);
      await page.waitForTimeout(900);
    }

    // Let the post chain settle before the frame that gets kept: a capture
    // taken mid-scare is a picture of the scare, not of the game.
    await page.evaluate(() => window.deadlight.renderer.post.calm());
    await page.waitForTimeout(700);
    await page.screenshot({ path: OUT });
    console.log(`· wrote ${path.relative(ROOT, OUT)}`);

    // Then run the director's whole catalogue, which is the cheapest way to
    // execute every scare path and the jumpscare sequence in one pass.
    for (const key of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(420);
    }
    if (has('scare-shot')) {
      const scareOut = OUT.replace(/(\.png)$/, '-scare$1');
      await page.screenshot({ path: scareOut });
      console.log(`· wrote ${path.relative(ROOT, scareOut)}`);
    }

    // End the run and capture the report card — it is a deliverable in its
    // own right (it is what gets screenshotted and posted), so it is worth
    // proving it renders with real numbers in it.
    if (has('report')) {
      await page.evaluate(() => {
        const g = window.deadlight.game;
        g.director.jumpscare(g.creature, {
          lethal: true,
          onDone: () => g.constructor.prototype, // no-op; end below
        });
      });
      await page.waitForTimeout(2600);
      await page.evaluate(() => {
        const g = window.deadlight.game;
        // Reach the same exit path the creature's kill uses.
        g.director.cinematic = null;
        g.player.frozen = false;
        g.onEnd?.({
          won: false,
          cause: 'It found you in the dark.',
          seed: g.seed,
          seconds: (performance.now() - g.stats.started) / 1000,
          fuses: g.fusesTaken,
          fusesNeeded: 6,
          scares: g.director.scareCount,
          peakBpm: g.stats.peakBpm,
          closest: Number.isFinite(g.stats.closest) ? g.stats.closest : 0,
          topScare: 'it stood in the corridor',
        });
      });
      await page.waitForFunction(() => !document.getElementById('report').hidden, { timeout: 15_000 });
      const reportOut = OUT.replace(/(\.png)$/, '-report$1');
      await page.screenshot({ path: reportOut });
      console.log(`· wrote ${path.relative(ROOT, reportOut)}`);
    }

    const lost = await page.evaluate(() => window.deadlight?.renderer?.deviceLost ?? null);
    if (lost) problems.push(`graphics device lost: ${lost}`);

    const state = await page.evaluate(() => {
      const bpm = document.getElementById('bpm-value').textContent;
      const fps = document.getElementById('fps').textContent;
      const scares = document.getElementById('scare-count').textContent;
      const fuses = document.getElementById('fuse-have').textContent;
      return { bpm, fps, scares, fuses };
    });
    console.log(`· ${state.fps} · ${state.bpm} bpm · ${state.scares} scares · ${state.fuses} fuses`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of [...new Set(problems)].slice(0, 20)) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('\nno errors');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
