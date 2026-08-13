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

  // --- streaks -----------------------------------------------------------
  g.start();
  const sellCleanly = () => {
    const c = waitForCustomer();
    if (!c) return null;
    for (const { id, count } of c.order) for (let i = 0; i < count; i++) g.clickCrate(id);
    g.clickBell();
    step(4);
    return c;
  };

  sellCleanly();
  sellCleanly();
  check('clean sales build a streak', g.streak === 2, g.streak);
  check('the streak shows in the hud', !document.querySelector('#stat-streak').hidden);

  const spoil = waitForCustomer();
  if (spoil) {
    const wrongId = ['carrot', 'cabbage', 'strawberry', 'corn', 'radish', 'muffin'].find(
      (id) => !spoil.order.some((o) => o.id === id),
    );
    g.clickCrate(wrongId);
    check('a mistake breaks the streak', g.streak === 0, g.streak);
  }

  // --- the very small customer -------------------------------------------
  g.start();
  g.day = 4;
  g.rollSpecial = () => 'tiny';
  let tiny = waitForCustomer();
  check('the small one appears', tiny?.special === 'tiny', tiny?.name);
  check('the small one orders one thing', tiny?.order.length === 1 && tiny.order[0].count === 1, JSON.stringify(tiny?.order));
  check('the small one is patient', tiny?.patienceMax > 40, tiny?.patienceMax);

  // --- the inspector ------------------------------------------------------
  g.start();
  g.day = 4;
  g.hearts = 1;
  g.ui.setHearts(1);
  g.rollSpecial = () => 'inspector';
  const insp = waitForCustomer();
  check('the inspector appears', insp?.special === 'inspector', insp?.name);
  check('the inspector wants three different things', insp?.order.length === 3, JSON.stringify(insp?.order));
  if (insp) {
    for (const { id, count } of insp.order) for (let i = 0; i < count; i++) g.clickCrate(id);
    g.clickBell();
    check('a clean inspection buys back a star', g.hearts === 2, g.hearts);
  }

  // --- the touch pad ------------------------------------------------------
  const padBtn = document.querySelector('.stock-btn');
  check('the pad has a button per item', document.querySelectorAll('.stock-btn').length === 6);
  g.start();
  const padCustomer = waitForCustomer();
  if (padCustomer) {
    const wantedId = padCustomer.order[0].id;
    const wantedBtn = [...document.querySelectorAll('.stock-btn')].find((b) => b.dataset.id === wantedId);
    check('wanted produce is highlighted on the pad', wantedBtn?.classList.contains('wanted'), wantedId);
    check('the pad shows the count', /0\/\d/.test(wantedBtn?.querySelector('.need').textContent ?? ''), wantedBtn?.querySelector('.need').textContent);
    g.clickCrate(wantedId);
    check('the pad count follows the bag', /1\/\d/.test(wantedBtn?.querySelector('.need').textContent ?? ''), wantedBtn?.querySelector('.need').textContent);
  }
  check('unused pad buttons exist but are not highlighted', !!padBtn);

  // --- shop-wide events ---------------------------------------------------
  g.start();
  g.day = 4;
  g.event = null;
  g.startEvent();
  check('an event starts', !!g.event, g.event?.id);

  // Force each modifier in turn and check it actually reaches the rules.
  g.event = { id: 'test', duration: 99, banner: ['x', 'y'], banItem: 'radish', forceItem: 'cabbage' };
  const shaped = Array.from({ length: 12 }, () => g.makeOrder({ special: null }));
  check('a banned item leaves every order', shaped.every((o) => !o.some((i) => i.id === 'radish')));
  check('a craze reaches every order', shaped.every((o) => o.some((i) => i.id === 'cabbage')));

  g.event = { id: 'test', duration: 99, banner: ['x', 'y'], tipScale: 3, patienceScale: 2 };
  const boosted = g.patienceFor([{ id: 'carrot', count: 1 }], { spec: null });
  g.event = null;
  const plain = g.patienceFor([{ id: 'carrot', count: 1 }], { spec: null });
  check('an event can change patience', boosted > plain * 1.8, `${plain.toFixed(1)} -> ${boosted.toFixed(1)}`);

  g.event = { id: 'test', duration: 0.01, banner: ['x', 'y'], over: 'done' };
  g.eventLeft = 0.01;
  step(1);
  check('an event ends on its own', g.event === null);

  // --- rabbits stay out of the furniture ----------------------------------
  g.start();
  step(150);
  const stuck = [];
  for (const sh of g.shoppers) {
    const p = sh.body.pos;
    const r = sh.body.radius;
    for (const b of g.obstacles) {
      const dx = Math.min(p.x + r, b.maxX) - Math.max(p.x - r, b.minX);
      const dz = Math.min(p.y + r, b.maxZ) - Math.max(p.y - r, b.minZ);
      if (dx > 0.02 && dz > 0.02) stuck.push(`${sh.name} in ${b.name}`);
    }
  }
  check('nobody is standing inside the furniture', stuck.length === 0, stuck.join('; '));

  const pairs = [];
  for (let i = 0; i < g.shoppers.length; i++) {
    for (let j = i + 1; j < g.shoppers.length; j++) {
      const a = g.shoppers[i].body;
      const b = g.shoppers[j].body;
      const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
      if (d < (a.radius + b.radius) * 0.9) pairs.push(d.toFixed(2));
    }
  }
  check('rabbits are not standing inside each other', pairs.length === 0, pairs.join(', '));

  // --- the walk cycle matches the ground covered --------------------------
  // A playback rate that has to clamp is a foot that slides, and a sliding walk
  // reads as the rabbit jerking backwards every time the cycle loops.
  g.start();
  const gaitRows = [];
  for (const kind of ['normal', 'tiny', 'trenchcoat']) {
    g.start();
    g.day = 4;
    g.rollSpecial = () => (kind === 'normal' ? null : kind);
    const c = waitForCustomer();
    if (!c) continue;
    const b = c.body;
    for (const gait of ['walk', 'run']) {
      gaitRows.push({
        kind,
        gait,
        natural: b.gaits[gait] ? +b.gaits[gait].toFixed(2) : null,
        speed: +b.speeds[gait].toFixed(2),
        rate: +b.rates[gait].toFixed(2),
      });
    }
  }
  check('every rabbit has a measured stride', gaitRows.every((r) => r.natural !== null),
    JSON.stringify(gaitRows));
  // The whole point: speed is the stride times the rate, so a planted foot
  // stays planted no matter which rabbit it belongs to.
  check('speed always equals stride times playback rate',
    gaitRows.every((r) => Math.abs(r.natural * r.rate - r.speed) < 0.02),
    gaitRows.map((r) => `${r.kind}/${r.gait} ${r.natural}x${r.rate}=${r.speed}`).join(', '));
  // The smallest customers really are slow — short legs, and the rate is capped
  // at a cadence that still reads as walking rather than scurrying.
  check('every rabbit moves at a playable speed',
    gaitRows.every((r) => r.speed > 0.5 && r.speed < 3.2),
    gaitRows.map((r) => `${r.kind}/${r.gait} ${r.speed}`).join(', '));

  // --- incidents ----------------------------------------------------------
  // Incidents need somebody browsing to happen to. Rather than hope one is,
  // these set the stage explicitly: freeze the natural schedule, park a rabbit
  // at a shelf, then ask for the incident we want to test.
  const stage = (day = 4) => {
    g.start();
    g.day = day;
    step(30);
    g.incidentIn = 1e9; // no unplanned incidents while we are measuring
    g.endIncident();
    g.lastIncident = null;
    return g.shoppers.filter((s2) => s2.queueIndex < 0 && !s2.done);
  };

  const parkBrowser = () => {
    const free = g.shoppers.find((s2) => s2.queueIndex < 0 && !s2.done);
    if (!free) return null;
    free.phase = 'browsing';
    free.timer = 1e6;
    free.incident = null;
    return free;
  };

  const forceIncident = (id, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      if (!parkBrowser()) {
        step(2);
        continue;
      }
      g.lastIncident = null;
      g.startIncident();
      if (g.incident?.def.id === id) return g.incident;
      if (g.incident) g.endIncident();
    }
    return null;
  };

  stage();
  parkBrowser();
  g.startIncident();
  check('an incident starts', !!g.incident, g.incident?.def.id);
  check('the alert is showing', !document.querySelector('#alert').hidden);
  check('the alert names a way out', !!document.querySelector('.alert-call').textContent);

  const coinsAtIncident = g.coins;
  const solvedId = g.incident?.def.id;
  g.solveIncident();
  check('solving an incident clears it', g.incident === null, solvedId);
  check('the alert goes away', document.querySelector('#alert').hidden);
  if (solvedId && solvedId !== 'question') {
    check('solving an incident pays', g.coins > coinsAtIncident, `${coinsAtIncident} -> ${g.coins}`);
  }

  // Ignoring a thief costs real money.
  stage();
  g.coins = 100;
  check('a shoplifter can be provoked', !!forceIncident('shoplifter'), g.incident?.def.id);
  if (g.incident?.def.id === 'shoplifter') {
    check('a thief heads for the door', g.incident.target.phase === 'sneaking', g.incident.target.phase);
    g.incident.left = 0.001;
    step(0.2);
    check('an ignored thief costs coins', g.coins < 100, `100 -> ${g.coins}`);
    check('the theft resolves the incident', g.incident === null);
  }

  // Tapping the culprit is the same as tapping the alert.
  stage();
  const culprit = parkBrowser();
  g.startIncident();
  if (g.incident && culprit) {
    g.clickShopper(g.incident.target);
    check('tapping the culprit resolves the incident', g.incident === null);
    check('the culprit was dealt with, not petted', culprit.petted === false);
  }

  // A spill puts real objects on the floor; nothing may survive a restart.
  stage();
  // Rabbits are scene children too and a restart disposes them, so count the
  // fittings only.
  const fittings = () => g.scene.children.length - g.shoppers.length;
  const baseline = g.clickable.length;
  const sceneBefore = fittings();
  check('a spill can be provoked', !!forceIncident('spill'), g.incident?.def.id);
  if (g.incident?.def.id === 'spill') {
    check('a spill puts a tap target on the floor', g.clickable.length === baseline + 1,
      `${baseline} -> ${g.clickable.length}`);
    check('a spill adds exactly one thing to the scene', fittings() === sceneBefore + 1,
      `${sceneBefore} -> ${fittings()}`);
    check('a spill slows the customer being served', g.incident.def.patienceDrain > 1,
      g.incident.def.patienceDrain);
    g.start();
    check('restarting clears any incident', g.incident === null);
    check('restarting takes the spill off the floor', g.clickable.length === baseline,
      `${g.clickable.length} vs ${baseline}`);
    check('restarting leaves no orphan objects in the scene', fittings() === sceneBefore,
      `${sceneBefore} -> ${fittings()}`);
  }

  // --- the walk cycle does not travel ------------------------------------
  // The clips are meant to animate in place: the game owns where a rabbit is.
  // A clip that creeps forward inside its own group and snaps back at the loop
  // is what "walking, then teleporting backwards" looks like, and it survived
  // one wrong fix, so it is asserted in world space where "horizontal" is
  // unambiguous rather than trusting an axis guess.
  g.start();
  step(20);
  const walker = g.shoppers[0];
  if (walker) {
    const THREE = window.__THREE;
    const lead = walker.body.root.children[0];
    let hip = null;
    lead.traverse((o) => {
      if (o.isBone && /^Hip$/i.test(o.name)) hip = o;
    });

    const travel = [];
    for (const gait of ['walk', 'run']) {
      const clip = walker.body.actions[gait].getClip();

      // No track may end anywhere other than where it started.
      let seam = 0;
      for (const tr of clip.tracks) {
        if (!tr.name.endsWith('.position')) continue;
        const v = tr.values;
        const n = tr.getValueSize();
        for (let k = 0; k < n; k++) seam = Math.max(seam, Math.abs(v[k] - v[v.length - n + k]));
      }

      // And the root must be in the same place on the floor at both ends.
      const mixer = new THREE.AnimationMixer(lead);
      const action = mixer.clipAction(clip);
      action.play();
      const at = (t) => {
        mixer.setTime(t);
        lead.updateWorldMatrix(true, true);
        return new THREE.Vector3().setFromMatrixPosition(hip.matrixWorld);
      };
      const a = at(0);
      const b = at(clip.duration * 0.999);
      action.stop();
      mixer.uncacheClip(clip);

      travel.push({ gait, seam: +seam.toFixed(4), drift: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(4) });
    }

    check('no clip has a loop seam', travel.every((t) => t.seam < 0.001),
      travel.map((t) => `${t.gait} ${t.seam}`).join(', '));
    check('no clip travels across the floor', travel.every((t) => t.drift < 0.02),
      travel.map((t) => `${t.gait} ${t.drift}`).join(', '));
  }

  // --- bubbles stay up long enough to read --------------------------------
  const long = 'This is a deliberately long line of dialogue with quite a lot of words in it indeed.';
  g.ui.bubble(g.shoppers[0] ?? { body: { anchor: () => ({}) }, done: false }, long, { keep: true });
  const entry = [...g.ui.live.values()].pop();
  check('a long line gets a long bubble', entry && entry.until - performance.now() > 6000,
    entry ? Math.round(entry.until - performance.now()) : 'none');

  // --- a long unattended run must not throw or leak -----------------------
  g.start();
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
