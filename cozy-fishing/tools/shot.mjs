#!/usr/bin/env node
// Headless capture + smoke test for the prototype.
//
//   node tools/shot.mjs --out shots \
//     --script "wait:2500,shot:arrival,click:0.52x0.45,wait:1500,shot:cast"
//
// Script steps (comma separated):
//   wait:<ms>          sleep
//   shot:<name>        save <out>/<name>.png
//   click:<fx>x<fy>    click at viewport fractions (0..1)
//   eval:<js>          run js in the page (use for __dockside debug hooks)
//
// Prints a JSON report (errors, state, frames) and exits non-zero on any
// page error, so it doubles as a smoke test.

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
    try { return await import(c); } catch { /* try next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};

const OUT = opt('out', 'shots');
const SCRIPT = opt('script', 'wait:3000,shot:frame');
const W = +opt('w', 1280);
const H = +opt('h', 720);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });

const report = { errors: [], console: [], shots: [] };
page.on('pageerror', (e) => report.errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') report.console.push(`${m.type()}: ${m.text()}`);
});

await mkdir(OUT, { recursive: true });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => (window.__frames ?? 0) > 5, null, { timeout: 15000 })
  .catch(() => report.errors.push('never reached 5 rendered frames'));

for (const step of SCRIPT.split(',')) {
  const i = step.indexOf(':');
  const cmd = step.slice(0, i), arg = step.slice(i + 1);
  if (cmd === 'wait') await page.waitForTimeout(+arg);
  else if (cmd === 'shot') {
    const file = join(OUT, `${arg}.png`);
    await page.screenshot({ path: file });
    report.shots.push(file);
  } else if (cmd === 'click') {
    const [fx, fy] = arg.split('x').map(Number);
    await page.mouse.click(fx * W, fy * H);
  } else if (cmd === 'eval') {
    await page.evaluate(arg).catch((e) => report.errors.push(`eval(${arg}): ${e}`));
  }
}

report.frames = await page.evaluate(() => window.__frames ?? 0);
report.state = await page.evaluate(() => window.__dockside?.state ?? null);
report.caught = await page.evaluate(() => window.__dockside?.caught ?? 0);

await browser.close();
server.close();
console.log(JSON.stringify(report, null, 2));
process.exit(report.errors.length ? 1 : 0);
