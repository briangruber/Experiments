#!/usr/bin/env node
// Loads the built standalone page the way a browser will and checks it actually
// runs. A bundler that emits a syntactically valid file which throws at load is
// the exact failure this project has already shipped once: the earlier bundle
// broke on `export { a, b };` and the smoke test never caught it because the
// test loaded the SOURCES, not the built file.
//
//   node tools/check-bundle-three.mjs [--file dist/abyssal-three.html] [--backend webgl]
//
// Served over http rather than file:// because WebGPU needs a secure context and
// file:// is not one - the page would silently fall back and the check would pass
// for the wrong reason.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchChromium } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const FILE = resolve(opt('file', 'dist/abyssal-three.html'));
const BACKEND = opt('backend', 'webgl');
const SETTLE = +(opt('settle', '3500'));
// Small by default. Now that the sky renders, the cloud raymarch covers half the
// frame, and on the software rasteriser in CI a 900x560 frame can take several
// seconds - long enough that the capture below times out and the page looks dead
// when it is merely slow.
const VW = +(opt('width', '480'));
const VH = +(opt('height', '300'));
const CAP_MS = +(opt('capms', '60000'));

const html = await readFile(FILE, 'utf8');

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.setDefaultTimeout(CAP_MS + 20000);

const consoleErrors = [];
const pageErrors = [];
const external = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
// Anything leaving the origin would be blocked by the artifact CSP.
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith(`http://127.0.0.1:${port}`) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
});

const q = BACKEND === 'auto' ? '' : `?backend=${BACKEND}`;
await page.goto(`http://127.0.0.1:${port}/${q}`, { waitUntil: 'load' });
await page.waitForTimeout(SETTLE);

// Capture INSIDE the app's frame callback, not afterwards.
//
// A WebGL/WebGPU drawing buffer is cleared once the browser composites it unless
// preserveDrawingBuffer is set, so a drawImage() from a later task reads black -
// a live, correct page then looks like a dead one. This project has already lost
// time to exactly that. app.onFrame fires at the end of the app's own frame,
// before compositing, which is the one moment the pixels are readable.
await page.evaluate((ms) => { window.__capMs = ms; }, CAP_MS);
await page.evaluate(function () {
  return new Promise(function (resolve) {
    if (!window.abyssal) return resolve();
    var prev = window.abyssal.onFrame;
    window.abyssal.onFrame = function () {
      var canvas = document.getElementById('view');
      var c2 = document.createElement('canvas');
      c2.width = canvas.width; c2.height = canvas.height;
      var g = c2.getContext('2d', { willReadFrequently: true });
      g.drawImage(canvas, 0, 0);
      window.__cap = g.getImageData(0, 0, c2.width, c2.height).data;
      window.abyssal.onFrame = prev;
      resolve();
    };
    setTimeout(resolve, window.__capMs);
  });
});

const result = await page.evaluate(() => {
  const canvas = document.getElementById('view');
  const status = document.getElementById('status');
  const out = {
    build: window.abyssalBuild ?? null,
    error: window.abyssalError ? String(window.abyssalError.message || window.abyssalError) : null,
    booted: !!window.abyssal,
    backend: window.abyssal?.backend ?? null,
    fellBack: window.abyssal?.fellBack ?? null,
    status: status ? status.textContent.trim() : null,
    statusClass: status ? status.className : null,
    presetCount: document.getElementById('preset')?.options.length ?? 0,
    size: canvas ? [canvas.width, canvas.height] : null,
  };
  const d = window.__cap;
  if (!canvas || !d) return out;
  let sum = 0, sum2 = 0, n = 0;
  const hist = new Array(16).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    sum += l; sum2 += l * l; n++;
    hist[Math.min(15, Math.floor(l * 16))]++;
  }
  out.mean = sum / n;
  out.std = Math.sqrt(Math.max(sum2 / n - (sum / n) ** 2, 0));
  out.buckets = hist.filter((c) => c > n * 0.001).length;
  return out;
});

await browser.close();
server.close();

const DEVICE_LOSS = /Device Lost|Instance dropped|valid external Instance/i;
const unexpected = (list) => list.filter((m) => !(result.fellBack && DEVICE_LOSS.test(m)));

const checks = [
  ['bundle executed', !!result.build, `build ${result.build}`],
  ['no load-time error', !result.error, result.error ?? 'none'],
  ['app booted', result.booted, result.status ?? ''],
  ['reports a backend', !!result.backend, `${result.backend}${result.fellBack ? ' (fell back)' : ''}`],
  ['presets populated', result.presetCount > 3, `${result.presetCount} presets`],
  ['canvas is not black', (result.mean ?? 0) > 0.02, `mean ${(result.mean ?? 0).toFixed(4)}`],
  ['canvas is not flat', (result.std ?? 0) > 0.02 && (result.buckets ?? 0) >= 4,
    `std ${(result.std ?? 0).toFixed(4)}, ${result.buckets}/16 buckets`],
  // When the app FELL BACK, the WebGPU renderer it abandoned reports its device
  // loss asynchronously. Those messages are the expected consequence of the
  // fallback firing, not a defect, so they are named and excused - and ONLY
  // those. Anything else still fails, and if no fallback happened they all do.
  ['no page errors', unexpected(pageErrors).length === 0,
    unexpected(pageErrors)[0] ?? (pageErrors.length ? `${pageErrors.length} expected device-loss message(s)` : 'none')],
  ['no console errors', unexpected(consoleErrors).length === 0,
    unexpected(consoleErrors)[0] ?? (consoleErrors.length ? `${consoleErrors.length} expected device-loss message(s)` : 'none')],
  ['no external requests', external.length === 0, external[0] ?? 'none'],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}
console.log(`\nrendered at ${result.size?.join('x')} on ${result.backend}`);
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
