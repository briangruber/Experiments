#!/usr/bin/env node
// Interactive visit harness.
//
// Where shot.mjs captures one frame, this drives a whole session: a visitor
// arrives, waits, drags, scrolls the panel, changes a preset, hits a key,
// resizes to a phone. It records screenshots, console output, unhandled errors
// and coarse timings so an agent can report on the *experience* rather than on
// a single still.
//
//   node tools/visit.mjs --session visits/first-time.mjs --outdir shots/visit-x
//   node tools/visit.mjs --session visits/first-time.mjs --device mobile
//
// A session file default-exports an async function receiving a context object:
//
//   export default async function (v) {
//     await v.wait(4000);
//     await v.shot('arrival');
//     await v.drag(600, 300, 400, 320);
//     await v.preset('North Atlantic Storm');
//     v.note('the panel scrolled under my thumb');
//   }
//
// Everything it records is written to <outdir>/report.json and echoed to stdout.

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, extname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs',
    process.env.PLAYWRIGHT_PATH,
  ].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_PATH');
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const SESSION = opt('session', null);
const OUTDIR = opt('outdir', 'shots/visit');
const DEVICE = opt('device', 'desktop');
const PRESET = opt('preset', '');
const HEADFUL = args.includes('--headful');
const SETS = args.reduce((a, v, i) => (v === '--set' ? [...a, args[i + 1]] : a), []);
// This box has no GPU: WebGL runs on SwiftShader at 1-3 fps, and a screenshot
// cannot complete while the main thread is saturated. Dial the render down
// unless the session explicitly asks for full quality. Judge look and feel
// here, never framerate.
const FULL = args.includes('--full-quality');

if (!SESSION) {
  console.error('usage: node tools/visit.mjs --session visits/<file>.mjs [--outdir DIR] [--device desktop|laptop|tablet|mobile]');
  process.exit(2);
}

const DEVICES = {
  desktop: { width: 1440, height: 810, dpr: 1, touch: false, ua: null },
  laptop: { width: 1280, height: 720, dpr: 1, touch: false, ua: null },
  tablet: { width: 900, height: 1200, dpr: 1, touch: true, ua: null },
  mobile: {
    width: 390, height: 844, dpr: 1, touch: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};
const dev = DEVICES[DEVICE] || DEVICES.desktop;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  headless: !HEADFUL,
  args: [
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const context = await browser.newContext({
  viewport: { width: dev.width, height: dev.height },
  deviceScaleFactor: dev.dpr,
  hasTouch: dev.touch,
  isMobile: dev.touch,
  userAgent: dev.ua || undefined,
});
const page = await context.newPage();

const consoleLog = [];
const errors = [];
const shots = [];
const notes = [];
const timeline = [];
const t0 = Date.now();
const stamp = () => Date.now() - t0;

page.on('console', (m) => {
  consoleLog.push({ t: stamp(), type: m.type(), text: m.text().slice(0, 400) });
  if (m.type() === 'error') errors.push(m.text().slice(0, 400));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message).slice(0, 600)));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

const outAbs = isAbsolute(OUTDIR) ? OUTDIR : join(ROOT, OUTDIR);
await mkdir(outAbs, { recursive: true });

let shotN = 0;
const v = {
  page,
  device: DEVICE,
  viewport: { w: dev.width, h: dev.height },

  // --- observation -----------------------------------------------------------
  async shot(name, opts = {}) {
    shotN++;
    const file = `${String(shotN).padStart(2, '0')}-${name.replace(/[^a-z0-9-_]/gi, '_')}.png`;
    const path = join(outAbs, file);
    try {
      await page.screenshot({ path, timeout: 120000, animations: 'disabled', ...opts });
    } catch {
      // A busy main thread can starve the compositor. Drop the render cost, let
      // it breathe, and try once more before giving up on the frame.
      await page.evaluate(() => { if (window.abyssal) window.abyssal.params.renderScale = 0.35; }).catch(() => {});
      await page.waitForTimeout(3000);
      await page.screenshot({ path, timeout: 180000, animations: 'disabled', ...opts });
    }
    shots.push({ t: stamp(), name, file });
    timeline.push({ t: stamp(), do: 'shot', name });
    return file;
  },
  note(text) {
    notes.push({ t: stamp(), text });
    timeline.push({ t: stamp(), do: 'note', text });
  },

  // --- pacing ---------------------------------------------------------------
  async wait(ms) { timeline.push({ t: stamp(), do: 'wait', ms }); await page.waitForTimeout(ms); },

  // --- interaction ----------------------------------------------------------
  async drag(x1, y1, x2, y2, steps = 18) {
    timeline.push({ t: stamp(), do: 'drag', from: [x1, y1], to: [x2, y2] });
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  },
  async wheel(dy, x = null, y = null) {
    timeline.push({ t: stamp(), do: 'wheel', dy });
    await page.mouse.move(x ?? dev.width / 2, y ?? dev.height / 2);
    await page.mouse.wheel(0, dy);
  },
  async key(code, ms = 400) {
    timeline.push({ t: stamp(), do: 'key', code });
    await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
    await page.waitForTimeout(ms);
  },
  async hold(code, ms) {
    timeline.push({ t: stamp(), do: 'hold', code, ms });
    await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
    await page.waitForTimeout(ms);
    await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true })), code);
  },
  async click(selector) {
    timeline.push({ t: stamp(), do: 'click', selector });
    await page.click(selector, { timeout: 8000 });
  },
  // Click a control-panel button by its visible label.
  async button(label) {
    timeline.push({ t: stamp(), do: 'button', label });
    const ok = await page.evaluate((l) => {
      const b = [...document.querySelectorAll('#ui button')].find((x) => x.textContent.trim().toLowerCase() === l.toLowerCase());
      if (!b) return false;
      b.click(); return true;
    }, label);
    if (!ok) notes.push({ t: stamp(), text: `COULD NOT FIND BUTTON "${label}"` });
    return ok;
  },
  async preset(name) {
    timeline.push({ t: stamp(), do: 'preset', name });
    const ok = await page.evaluate((n) => {
      const s = document.querySelector('#ui select');
      if (!s) return false;
      const o = [...s.options].find((x) => x.textContent === n);
      if (!o) return false;
      s.value = o.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, name);
    if (!ok) notes.push({ t: stamp(), text: `COULD NOT SELECT PRESET "${name}"` });
    return ok;
  },
  // Open a <details> group by its summary text.
  async openGroup(label) {
    timeline.push({ t: stamp(), do: 'openGroup', label });
    return page.evaluate((l) => {
      const d = [...document.querySelectorAll('#ui details')]
        .find((x) => x.querySelector('summary')?.textContent.trim().toLowerCase() === l.toLowerCase());
      if (!d) return false;
      d.open = true;
      d.scrollIntoView({ block: 'center' });
      return true;
    }, label);
  },
  // Drive a labelled slider to a 0..1 fraction of its range.
  async slider(label, fraction) {
    timeline.push({ t: stamp(), do: 'slider', label, fraction });
    const ok = await page.evaluate(([l, f]) => {
      const ctrl = [...document.querySelectorAll('#ui .ctrl')]
        .find((c) => c.querySelector('.name')?.textContent.trim().toLowerCase() === l.toLowerCase());
      const inp = ctrl?.querySelector('input[type=range]');
      if (!inp) return false;
      const min = +inp.min, max = +inp.max;
      inp.value = String(min + (max - min) * f);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, [label, fraction]);
    if (!ok) notes.push({ t: stamp(), text: `COULD NOT FIND SLIDER "${label}"` });
    return ok;
  },
  async scrollPanel(dy) {
    timeline.push({ t: stamp(), do: 'scrollPanel', dy });
    await page.evaluate((d) => { const u = document.getElementById('ui'); if (u) u.scrollTop += d; }, dy);
  },
  async resize(w, h) {
    timeline.push({ t: stamp(), do: 'resize', w, h });
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
  },

  // --- inspection -----------------------------------------------------------
  async read(selector) {
    return page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, selector);
  },
  async visibleText() {
    return page.evaluate(() => {
      const grab = (el) => (el ? el.innerText.replace(/\s+\n/g, '\n').trim() : '');
      return { hud: grab(document.getElementById('hud')), panel: grab(document.getElementById('ui')).slice(0, 3000) };
    });
  },
  async fps() {
    return page.evaluate(() => new Promise((res) => {
      let n = 0; const s = performance.now();
      const tick = () => { n++; if (performance.now() - s > 2000) res(+(n / ((performance.now() - s) / 1000)).toFixed(1)); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }));
  },
  async eval(fn, arg) { return page.evaluate(fn, arg); },
  // Direct parameter poke. Only works for params the frame loop reads every
  // frame; anything needing a rebuild must go through the real UI control.
  async setParam(key, value) {
    timeline.push({ t: stamp(), do: 'setParam', key, value });
    return page.evaluate(([k, x]) => {
      if (!window.abyssal) return false;
      window.abyssal.params[k] = x;
      window.abyssal.ui?.syncAll?.();
      return true;
    }, [key, value]);
  },
};

// ---------------------------------------------------------------- run session
const url = `http://127.0.0.1:${port}/${PRESET ? '?preset=' + encodeURIComponent(PRESET) : ''}`;
const navStart = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
const domReady = Date.now() - navStart;

// When does the visitor actually see the sea, rather than the boot card?
let firstFrame = null;
try {
  await page.waitForFunction(() => window.abyssal && window.abyssal.frames > 0, null, { timeout: 60000 });
  firstFrame = Date.now() - navStart;
} catch {
  errors.push('never produced a rendered frame within 60s');
}

// Software-rendering budget. renderScale and cloudSteps are both read fresh
// every frame, so poking them takes effect immediately without a rebuild.
if (!FULL && firstFrame !== null) {
  await page.evaluate(() => {
    const p = window.abyssal.params;
    p.renderScale = 0.55;
    p.cloudSteps = 20;
  }).catch(() => {});
  await page.waitForTimeout(1500);
}
if (SETS.length && firstFrame !== null) {
  await page.evaluate((kvs) => {
    for (const kv of kvs) {
      const [k, val] = kv.split('=');
      window.abyssal.params[k] = val.startsWith('[') ? JSON.parse(val) : (isNaN(+val) ? val : +val);
    }
    window.abyssal.ocean.dirty = true;
    window.abyssal.ui?.syncAll?.();
  }, SETS).catch(() => {});
  await page.waitForTimeout(1500);
}

let sessionError = null;
try {
  const mod = await import(pathToFileURL(isAbsolute(SESSION) ? SESSION : join(ROOT, SESSION)).href);
  await mod.default(v);
} catch (e) {
  sessionError = (e.stack || e.message).slice(0, 1200);
}

const perf = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0];
  return {
    transferredBytes: performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0),
    resources: performance.getEntriesByType('resource').length,
    domContentLoaded: n ? Math.round(n.domContentLoadedEventEnd) : null,
  };
}).catch(() => ({}));

await browser.close();
server.close();

const report = {
  session: SESSION,
  device: DEVICE,
  viewport: { w: dev.width, h: dev.height, dpr: dev.dpr, touch: dev.touch },
  outdir: OUTDIR,
  timing: { domReadyMs: domReady, firstRenderedFrameMs: firstFrame, ...perf },
  shots,
  notes,
  timeline,
  consoleErrors: errors.slice(0, 25),
  consoleWarnings: consoleLog.filter((c) => c.type === 'warning').slice(0, 15),
  sessionError,
  ok: !sessionError && errors.length === 0 && firstFrame !== null,
};
await writeFile(join(outAbs, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
