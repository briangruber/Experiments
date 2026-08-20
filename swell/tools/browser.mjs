// Playwright bootstrap plus the page-side contract every tool relies on:
// a GPU-backed Chromium, all console and page errors collected, and a page
// that has finished building its shaders before anything is captured.
import { serve, ROOT } from './serve.mjs';

async function loadPlaywright() {
  const candidates = [
    'playwright',
    process.env.PLAYWRIGHT_PATH,
    '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; npm i -D playwright, or set PLAYWRIGHT_PATH');
}

export async function open({ width = 1280, height = 720, scene = 'golden-hour', root = ROOT } = {}) {
  const { chromium } = await loadPlaywright();
  const { server, port } = await serve(root);

  // Hardware where there is any, software where there is not. Cross-machine
  // pixel identity is deliberately *not* required: the determinism gate
  // compares two renders inside one process, and cost is only ever reported as
  // a ratio measured on the same machine in the same run. Forcing everyone onto
  // a software rasteriser to buy identity nobody uses just makes the harness
  // too slow to run, which is the failure mode that actually matters.
  const software = (process.env.SWELL_GL || 'auto') === 'software';
  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      ...(software ? ['--use-angle=swiftshader'] : []),
      '--enable-unsafe-swiftshader',   // the fallback when there is no GPU
      '--disable-lcd-text',
      '--force-device-scale-factor=1',
    ],
  });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));

  await page.goto(`http://127.0.0.1:${port}/index.html?headless=1&scene=${encodeURIComponent(scene)}`, {
    waitUntil: 'load',
  });
  await page.waitForFunction('window.__swellReady === true', null, { timeout: 60000 });

  // Anything the shader compiler complained about has been recorded by now.
  errors.push(...await page.evaluate('window.__swell.errors'));

  return {
    page, browser, errors,
    async close() { await browser.close(); server.close(); },
  };
}

// Render one frame at an exact simulation time. No wall clock is involved, so
// two runs of the same fixture are the same pixels.
export async function frame(page, { scene, time, variants, knobs, width, height, camera }) {
  return page.evaluate(async (o) => {
    const app = window.__swell;
    if (o.scene && o.scene !== app.sceneId) app.setScene(o.scene);
    if (o.variants) app.setVariants(o.variants);
    if (o.width) app.setSize(o.width, o.height);
    if (o.camera) {
      app.camera.position.set(...o.camera.position);
      app.camera.lookAt(...o.camera.target);
    } else {
      app.applyCamera();
    }
    if (o.knobs) app.setKnobs(o.knobs);
    app.setTime(o.time);
    app.renderFrame();
    await new Promise((r) => requestAnimationFrame(() => r()));
    app.renderFrame();
    return { errors: app.errors.slice(), knobs: app.knobs, selection: app.selection };
  }, { scene, time, variants, knobs, width, height, camera });
}
