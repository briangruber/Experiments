#!/usr/bin/env node
// Drives the shop through its rules and asserts on the outcomes.
//
//   node tools/playtest.mjs
//
// The simulation is stepped directly rather than waited on, so a full day of
// trading takes a second and the results are deterministic. Exits non-zero on
// the first failed assertion or page error.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) return res.writeHead(403).end();
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const { chromium } = await import('playwright');
const browser = await chromium.launch({
  ...(existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !document.querySelector('#start')?.disabled, { timeout: 180000 });
await page.click('#start');

// Everything below runs in the page, where the game object lives.
const results = await page.evaluate(() => {
  const g = window.__game;
  const out = [];
  const check = (name, pass, detail = '') => out.push({ name, pass: !!pass, detail: String(detail) });

  const step = (seconds) => {
    for (let i = 0; i < seconds * 60; i++) g.update(1 / 60);
  };

  // Advance until somebody is standing at the counter with an order.
  const waitForCustomer = (limit = 90) => {
    for (let i = 0; i < limit * 60; i++) {
      g.update(1 / 60);
      if (g.current) return g.current;
    }
    return null;
  };

  // --- a clean sale -------------------------------------------------------
  let s = waitForCustomer();
  check('a rabbit reaches the counter', s, s ? s.name : 'nobody arrived');
  if (!s) return out;

  check('the customer has an order', s.order?.length > 0, JSON.stringify(s.order));
  check('the ticket is showing', !document.querySelector('#ticket').hidden);

  const wanted = s.order.map((o) => ({ ...o }));
  const coinsBefore = g.coins;
  for (const { id, count } of wanted) for (let i = 0; i < count; i++) g.clickCrate(id);

  check('bagging the order completes it', s.complete(), JSON.stringify([...s.bagged]));
  check('the bell lights up when complete', g.bellReady);
  check('no mistakes on a clean order', s.mistakes === 0, s.mistakes);

  g.clickBell();
  check('ringing up pays out', g.coins > coinsBefore, `${coinsBefore} -> ${g.coins}`);
  check('the sale is counted', g.served === 1, g.served);
  check('the ticket is cleared', document.querySelector('#ticket').hidden);
  check('the bag is emptied', g.bagItems.length === 0, g.bagItems.length);

  step(4);
  check('the paid customer leaves the counter', s.phase === 'leaving' || s.phase === 'gone', s.phase);

  // --- a wrong item -------------------------------------------------------
  s = waitForCustomer();
  if (s) {
    const notWanted = ['carrot', 'cabbage', 'strawberry', 'corn', 'radish', 'muffin'].find(
      (id) => !s.order.some((o) => o.id === id),
    );
    const patienceBefore = s.patience;
    g.clickCrate(notWanted);
    check('a wrong item is refused', (s.bagged.get(notWanted) ?? 0) === 0, notWanted);
    check('a wrong item counts as a mistake', s.mistakes === 1, s.mistakes);
    check('a wrong item costs patience', s.patience < patienceBefore, `${patienceBefore} -> ${s.patience}`);

    // --- petting ----------------------------------------------------------
    const before = s.patience;
    g.clickShopper(s);
    check('petting restores patience', s.patience > before, `${before} -> ${s.patience}`);
    g.clickShopper(s);
    check('a rabbit can only be petted once', s.petted === true);

    // --- running out of patience -----------------------------------------
    const heartsBefore = g.hearts;
    s.patience = 0.01;
    step(1);
    check('an abandoned customer costs a heart', g.hearts === heartsBefore - 1, `${heartsBefore} -> ${g.hearts}`);
  }

  // --- the day rolls over -------------------------------------------------
  const dayBefore = g.day;
  g.dayClock = 0.5;
  step(1);
  check('the day advances', g.day === dayBefore + 1, `${dayBefore} -> ${g.day}`);

  // --- losing ------------------------------------------------------------
  g.hearts = 1;
  const victim = waitForCustomer();
  if (victim) {
    victim.patience = 0.01;
    step(1);
    check('the game ends when the last heart goes', g.over === true && !g.running, `hearts=${g.hearts}`);
    check('the summary is shown', !document.querySelector('#gameover').hidden);
  }

  // --- restarting --------------------------------------------------------
  g.start();
  check('restarting clears the shop', g.coins === 0 && g.day === 1 && g.shoppers.length === 0, JSON.stringify({
    coins: g.coins,
    day: g.day,
    shoppers: g.shoppers.length,
  }));

  // --- a long unattended run must not throw or leak -----------------------
  step(240);
  check('four minutes unattended stays bounded', g.shoppers.length <= 9, `${g.shoppers.length} rabbits`);

  return out;
});

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
for (const e of pageErrors) {
  failed++;
  console.log(` FAIL  page error: ${e}`);
}

console.log(`\n${results.length - (failed - pageErrors.length)}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
