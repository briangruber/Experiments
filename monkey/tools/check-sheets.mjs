#!/usr/bin/env node
// Load every built sheet and fail on anything that would reach a reader broken.
//
//   node tools/check-sheets.mjs
//
// This exists because of a specific bug that shipped: a helper was moved below
// its first use, which in a const arrow function is a temporal-dead-zone
// ReferenceError, and the published page rendered its header over a completely
// empty body. The page looked fine to build and fine to publish. Nothing but
// loading it would have caught it, so loading it is now a step rather than a
// thing to remember. It asserts the tiles actually built, exercises both
// grouping paths and every toggle, and treats any console error as a failure.
//
// It is not a preview and takes no screenshots: the user is the eyes for how
// the page looks, this only proves it is not broken.

import { launch, ROOT } from './harness.mjs';

const b = await launch();
const SHEETS = process.argv.slice(2).filter(a => !a.startsWith('--'));
for (const f of (SHEETS.length ? SHEETS : ['loopoff-seedream', 'loopoff-nano'])) {
  const p = await b.newPage();
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await p.goto(`file://${ROOT}/dist/${f}.html`, { waitUntil: 'load' });
  const r = await p.evaluate(() => ({
    tiles: document.querySelectorAll('.tile').length,
    videos: document.querySelectorAll('.tile video').length,
    heavy: document.querySelectorAll('.tile img.heavy').length,
    stats: document.querySelectorAll('.stat').length,
    spendAll: document.getElementById('spendAll')?.textContent,
    title: document.title,
    srcSet: [...document.querySelectorAll('.tile video')].every(v => v.src.startsWith('data:video/mp4')),
  }));
  // exercise both grouping paths and every toggle
  await p.click('#group button[data-v="model"]');
  await p.click('#xfBtn'); await p.click('#srcBtn'); await p.click('#playBtn');
  const after = await p.evaluate(() => document.querySelectorAll('.tile').length);
  // filter the font fetch this sandbox blocks; it is allowed by the artifact CSP
  const real = errs.filter(e => !/ERR_CONNECTION_RESET|fonts\.googleapis/.test(e));
  console.log(f, JSON.stringify({ ...r, tilesAfterRegroup: after, errors: real }));
  if (real.length || r.tiles !== 4) process.exitCode = 1;
}
await b.close();
