#!/usr/bin/env node
// Two facts that decide whether a WebGPU port is worth doing.
//
//   node tools/probe-backend.mjs
//
// 1. Is WebGPU actually available to us - in a browser, and in THIS headless
//    environment? If it is not available headlessly, a port loses the only
//    verification loop this project has.
//
// 2. What share of a frame does the ocean simulation take? WebGPU's decisive
//    advantage for this workload is compute shaders, and the only thing that
//    would use them is the simulation - the FFT cascades, the spray integration,
//    the wake stamp. Fragment shading costs the same in either API. So if the
//    simulation is a small slice, the compute win lands on a small slice.
//
// Measured by ablation: run normally, then no-op the simulation and run again.
// The frame-rate difference is what the simulation costs.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, GL_ARGS } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await launchChromium({
  args: [...GL_ARGS, '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 300 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror:', e.message));

// ---------------------------------------------------------------- 1. WebGPU
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
const gpu = await page.evaluate(async () => {
  if (!('gpu' in navigator)) return { available: false, why: 'navigator.gpu is undefined' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false, why: 'requestAdapter() returned null' };
    const info = adapter.info || {};
    return {
      available: true,
      vendor: info.vendor ?? '?', architecture: info.architecture ?? '?',
      description: info.description ?? '?',
      maxComputeInvocations: adapter.limits?.maxComputeInvocationsPerWorkgroup ?? null,
      maxStorageBufferSize: adapter.limits?.maxStorageBufferBindingSize ?? null,
    };
  } catch (e) { return { available: false, why: String(e.message || e) }; }
});

// ------------------------------------------------- 2. cost of the simulation
await page.waitForFunction(() => !!window.abyssal, null, { timeout: 30000 });
// Uncapped and non-adaptive, or the controller and the frame cap both fight the
// measurement: a capped frame rate cannot show a saving, and an adaptive one
// spends the saving on quality instead of showing it.
await page.evaluate(() => {
  const A = window.abyssal;
  A.params.fpsCap = 0;
  A.params.adaptiveQuality = false;
  A.params.fpsCapIdle = 0;
});

async function measure(seconds) {
  return page.evaluate((s) => new Promise((done) => {
    const t0 = performance.now(), f0 = window.abyssal.frames;
    setTimeout(() => {
      const dt = (performance.now() - t0) / 1000;
      done(+((window.abyssal.frames - f0) / dt).toFixed(3));
    }, s * 1000);
  }), seconds);
}

await page.waitForTimeout(6000);              // settle
const fpsFull = await measure(20);

// No-op the simulation. Everything else - the water draw, the sky, the post
// chain - still runs against the last fields it wrote.
await page.evaluate(() => {
  const A = window.abyssal;
  A._realUpdate = A.ocean.update.bind(A.ocean);
  A.ocean.update = () => {};
});
await page.waitForTimeout(3000);
const fpsNoSim = await measure(20);

await browser.close();
server.close();

const msFull = 1000 / fpsFull, msNoSim = 1000 / fpsNoSim;
const simMs = msFull - msNoSim;
const share = simMs / msFull;

console.log(JSON.stringify({
  webgpu: gpu,
  frameMsFull: +msFull.toFixed(1),
  frameMsWithoutSim: +msNoSim.toFixed(1),
  simMs: +simMs.toFixed(1),
  simShareOfFrame: +(share * 100).toFixed(1) + '%',
  fpsFull, fpsNoSim,
}, null, 2));
