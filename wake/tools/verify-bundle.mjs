#!/usr/bin/env node
// Load the bundled single file exactly as the artifact host will: as body
// content inside a bare document, from a directory containing nothing else.
// If the module graph is broken, this catches it here instead of after publish.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SRC = resolve(ROOT, opt('in', 'dist/wake-lab.html'));
const OUT = resolve(ROOT, opt('out', 'shots/artifact.png'));

const body = await readFile(SRC, 'utf8');
const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});
await new Promise((r) => server.listen(0, r));

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await p.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
const ready = await p.waitForFunction('window.__ready === true', { timeout: 60000 })
  .then(() => true).catch(() => false);
await p.waitForTimeout(2500);

const diag = await p.evaluate(() => ({
  ready: !!window.__ready,
  travelled: Math.round(Math.hypot(window.__wake?.state.x ?? 0, window.__wake?.state.z ?? 0)),
  maxArc: Math.round(window.__wake?.wake.maxArc ?? 0),
  fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  rail: !!document.querySelector('#ui details'),
}));

await mkdir(dirname(OUT), { recursive: true });
await p.screenshot({ path: OUT });
await browser.close();
server.close();

console.log(JSON.stringify({ ready, diag, errors }, null, 2));
if (!ready || errors.length) process.exit(1);
