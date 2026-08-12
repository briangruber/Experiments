// Headless smoke test and screenshot harness.
//
//   node tools/shot.mjs --out shots/frame.png [--seed ABCDE] [--play 12]
//                       [--pose creature|watcher|crawler|mannequin]
//                       [--webgpu] [--scare-shot] [--intro] [--report]
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

/**
 * `--device phone|tablet` emulates a touch device: viewport, touch support and
 * a mobile user agent, plus `?quality=` so the game picks that tier.
 *
 * It is emulation, not a phone — it cannot tell you whether an iPhone's Safari
 * has WebGPU or how hot the device gets. What it does answer is everything
 * that has actually been broken here: does the layout fit, do the touch
 * controls exist and respond, does the stick move the player, does the game
 * run at all when the desktop assumptions are removed.
 */
const DEVICES = {
  phone: { width: 844, height: 390, dpr: 3, quality: 'phone' },
  tablet: { width: 1180, height: 820, dpr: 2, quality: 'tablet' },
  portrait: { width: 390, height: 844, dpr: 3, quality: 'phone' },
};
const DEVICE = DEVICES[flag('device')] ?? null;

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
  const page = await browser.newPage({
    viewport: DEVICE
      ? { width: DEVICE.width, height: DEVICE.height }
      : { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: DEVICE?.dpr ?? 1,
    hasTouch: Boolean(DEVICE),
    isMobile: Boolean(DEVICE),
    userAgent: DEVICE
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
        + ' (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });

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
    if (DEVICE) query.set('quality', DEVICE.quality);
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

    // In portrait the game deliberately refuses to start and asks for a
    // rotate. Verifying that is the whole point of the portrait device, so
    // check the gate is up and stop rather than trying to click through it.
    const gated = await page.$eval('#rotate', (r) => !r.hidden).catch(() => false);
    if (gated) {
      await page.screenshot({ path: OUT });
      console.log(`· portrait: rotate gate up, wrote ${path.relative(ROOT, OUT)}`);
      return;
    }

    await page.click('#start');

    // The HUD appearing means the run is live.
    await page.waitForFunction(
      () => !document.getElementById('hud').hidden,
      { timeout: 120_000 },
    );
    console.log('· run started');

    // Skip the opening shot unless we are capturing it: the drive loop below
    // would otherwise spend its whole budget with the player frozen.
    if (has('intro')) {
      await page.waitForTimeout(1800);
      await page.screenshot({ path: OUT.replace(/(\.png)$/, '-intro$1') });
      console.log(`· wrote ${path.relative(ROOT, OUT.replace(/(\.png)$/, '-intro.png'))}`);
    }
    // Wait for the opening shot to *finish*, not merely to be absent. The
    // cutscene only starts after `Game.start` resolves, so both "no game yet"
    // and "game built, intro not started" answer "no cutscene playing" — and
    // every capture landed in the middle of the intro.
    await page.waitForFunction(() => window.deadlight?.game?.introPlayed === true,
      { timeout: 30_000 })
      .catch(async () => {
        await page.keyboard.press('Space');
        await page.waitForTimeout(800);
      });

    // Drive it. On a touch device that means the touch controls, because a
    // keyboard the device does not have proves nothing about whether the game
    // is playable on it.
    const deadline = Date.now() + PLAY_SECONDS * 1000;

    if (DEVICE) {
      const before = await page.evaluate(() => {
        const p = window.deadlight.game.player;
        return { x: p.position.x, z: p.position.z, yaw: p.yaw };
      });

      // Synthetic PointerEvents rather than Playwright's mouse: the game reads
      // pointer events, and this exercises exactly the path a finger takes,
      // including two fingers at once.
      const drive = (seconds) => page.evaluate(async ({ w, h, seconds: secs }) => {
        const fire = (type, id, x, y) => window.dispatchEvent(new PointerEvent(type, {
          pointerId: id, pointerType: 'touch', isPrimary: id === 1,
          clientX: x, clientY: y, bubbles: true, cancelable: true,
        }));

        // Left thumb: push the stick forward. Right thumb: drag to look.
        fire('pointerdown', 1, w * 0.2, h * 0.7);
        fire('pointerdown', 2, w * 0.75, h * 0.5);
        fire('pointermove', 1, w * 0.2, h * 0.7 - 70);

        const until = performance.now() + secs * 1000;
        let angle = 0;
        while (performance.now() < until) {
          angle += 0.4;
          fire('pointermove', 2, w * 0.75 + Math.sin(angle) * 40, h * 0.5);
          await new Promise((r) => setTimeout(r, 90));
        }
        fire('pointerup', 1, w * 0.2, h * 0.7 - 70);
        fire('pointerup', 2, w * 0.75, h * 0.5);
      }, { w: DEVICE.width, h: DEVICE.height, seconds });

      await drive(PLAY_SECONDS);

      const after = await page.evaluate(() => {
        const p = window.deadlight.game.player;
        return { x: p.position.x, z: p.position.z, yaw: p.yaw, axis: p.peakAxis ?? 0 };
      });
      const moved = Math.hypot(after.x - before.x, after.z - before.z);
      const turned = Math.abs(after.yaw - before.yaw);
      console.log(`· touch: stick axis ${after.axis.toFixed(2)},` +
        ` player moved ${moved.toFixed(2)}m, look turned ${turned.toFixed(2)}rad`);
      // Assert on the axis, not the distance: the stick's job is to ask for
      // forward, and a wall two steps away is a legitimate reason for the
      // player not to have gone anywhere.
      if (after.axis < 0.4) problems.push('touch stick did not drive the move axis');
      if (turned < 0.05) problems.push('touch look did not turn the view');

      // And a button: the torch, which is the one pressed most.
      const lit = await page.evaluate(() => window.deadlight.game.player.torchOn);
      await page.touchscreen.tap(DEVICE.width - 60, DEVICE.height - 60);
      await page.waitForTimeout(250);
      const afterTap = await page.evaluate(() => window.deadlight.game.player.torchOn);
      console.log(`· touch: torch button ${lit} → ${afterTap}`);
      if (lit === afterTap) problems.push('torch button did nothing');
      // Leave the light on so the capture shows the level rather than the dark.
      await page.evaluate(() => { window.deadlight.game.player.torchOn = true; });
    } else {
      await page.keyboard.down('KeyW');
      while (Date.now() < deadline) {
        await page.mouse.move(WIDTH / 2 + (Math.random() - 0.5) * 260, HEIGHT / 2);
        await page.keyboard.press('KeyE');
        await page.waitForTimeout(320);
      }
      await page.keyboard.up('KeyW');
    }

    // Drive the puzzles directly. The random walk above will not find a tag
    // in eight seconds, and "the puzzles work" is exactly the thing a smoke
    // test has to answer now.
    if (has('solve')) {
      const solved = await page.evaluate(async () => {
        const g = window.deadlight.game;
        const out = { tags: 0, breakers: 0, powered: false, escaped: false };

        // Read every ward tag, closing each panel as it opens.
        for (const item of g.code.interactables) {
          const opened = item.use();
          await new Promise((r) => setTimeout(r, 60));
          g.ui.close();
          await opened?.catch(() => {});
        }
        out.tags = g.code.foundCount;

        // Throw the breakers in the order the diagram gives.
        for (const label of g.breakers.order) g.breakers.throw(label);
        out.breakers = g.breakers.progress;
        await new Promise((r) => setTimeout(r, 5200));
        out.powered = g.powered;

        // And the lift, with the code the tags spelled out.
        if (g.powered) {
          const entry = g.code.enter();
          await new Promise((r) => setTimeout(r, 80));
          for (const digit of g.code.code) {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: digit, code: `Digit${digit}` }));
          }
          await entry;
          await new Promise((r) => setTimeout(r, 4200));
          out.escaped = g.escaped;
        }
        return out;
      });
      console.log(`· puzzles: ${solved.tags} tags read, ${solved.breakers} breakers,` +
        ` power ${solved.powered ? 'on' : 'off'}, escaped ${solved.escaped}`);
      if (!solved.powered) problems.push('breaker sequence did not restore power');
      if (!solved.escaped) problems.push('lift code did not open the lift');
    }

    // The watcher is the game's new headline mechanic and it is entirely
    // invisible to a smoke test that only walks around: a watcher nobody
    // shines a torch at is indistinguishable from a broken one.
    if (has('watcher')) {
      const woke = await page.evaluate(async () => {
        const g = window.deadlight.game;
        const watcher = g.monsters.find((m) => m.behaviour === 'watcher');
        if (!watcher) return { found: false };

        const p = g.player;
        const ahead = p.forward().multiplyScalar(4).add(p.position);
        g.level.collide(ahead, 0.5);
        watcher.spawn(ahead);

        p.torchOn = false;
        await new Promise((r) => setTimeout(r, 700));
        const darkState = watcher.state;

        p.torchOn = true;
        await new Promise((r) => setTimeout(r, 1600));
        return { found: true, darkState, litState: watcher.state, hunting: watcher.hunting };
      });
      if (!woke.found) problems.push('no watcher in the level');
      else {
        console.log(`· watcher: dark → ${woke.darkState}, lit → ${woke.litState}`);
        if (woke.darkState !== 'still') problems.push(`watcher moved in the dark (${woke.darkState})`);
        if (!woke.hunting && woke.litState === 'still') problems.push('watcher ignored the torch');
      }
    }

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
        const face = Math.atan2(p.position.x - ahead.x, p.position.z - ahead.z);
        if (which === 'mannequin') {
          const m = g.mannequins.items[0];
          if (m) {
            m.object.position.copy(ahead);
            m.object.rotation.y = face;
          }
          return;
        }
        const monster = g.monsters.find((m) => m.key === which) ?? g.monsters[0];
        if (!monster) return;
        monster.spawn(ahead);
        monster.root.position.copy(ahead);
        monster.root.rotation.y = face;
        // A portrait wants the monster standing, not mid-lunge: `--watcher`
        // may have just woken this one, and `spawn` leaves a hunter walking.
        monster.state = 'still';
        monster.velocity.set(0, 0, 0);
        // Point the player at it, torch on. A portrait of a dark wall with
        // something in it is not evidence that the something loaded.
        p.yaw = Math.atan2(-(ahead.x - p.position.x), -(ahead.z - p.position.z));
        p.pitch = -0.02;
        p.torchOn = true;
        p.battery = 1;
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
      const text = (id) => document.getElementById(id)?.textContent ?? '?';
      const g = window.deadlight?.game;
      return {
        bpm: text('bpm-value'),
        fps: text('fps'),
        scares: text('scare-count'),
        tags: text('tag-have'),
        breakers: text('power-have'),
        monsters: g ? g.monsters.filter((m) => m.active).length : 0,
        awake: g ? g.monsters.filter((m) => m.hunting).length : 0,
      };
    });
    console.log(`· ${state.fps} · ${state.bpm} bpm · ${state.scares} scares` +
      ` · ${state.tags} tags · ${state.breakers} breakers` +
      ` · ${state.monsters} monsters (${state.awake} hunting)`);
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
