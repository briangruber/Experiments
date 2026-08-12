#!/usr/bin/env node
// Runs a prototype page headlessly and prints whatever it left on
// window.probeResult.
//
//   node tools/run-probe.mjs prototypes/three-native-probe.html
//
// Same CDN-to-node_modules interception as tools/check-examples.mjs, so the page
// can import 'three' the way a reader would while the test stays hermetic.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.argv[2] || 'prototypes/three-native-probe.html';

function resolveThree() {
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const c = join(dir, 'node_modules', 'three');
    if (existsSync(join(c, 'build', 'three.module.js'))) return c;
    const up = dirname(dir); if (up === dir) break; dir = up;
  }
  throw new Error('three is not installed. Run `npm install` first.');
}
const THREE_DIR = resolveThree();

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

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 500, height: 400 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.stack || e.message));

await page.route('https://unpkg.com/**', async (route) => {
  const rel = new URL(route.request().url()).pathname.replace(/^\/three@[^/]+\//, '');
  try {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(THREE_DIR, rel)) });
  } catch { route.fulfill({ status: 404, body: 'not vendored: ' + rel }); }
});

await page.goto(`http://127.0.0.1:${port}/${PAGE}`, { waitUntil: 'load' });
let result = null;
try {
  await page.waitForFunction(() => !!window.probeResult, null, { timeout: 60000 });
  result = await page.evaluate(() => window.probeResult);
} catch {
  result = { error: 'window.probeResult never appeared', pageErrors };
}

await browser.close();
server.close();

if (result.results) {
  for (const r of result.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
  console.log(`\n${result.allOk ? 'ALL PASS' : 'SOME FAILED'}`);
} else {
  console.log(JSON.stringify(result, null, 2));
}
if (pageErrors.length) console.error('\npage errors:\n' + pageErrors.join('\n'));
process.exit(result.allOk ? 0 : 1);
