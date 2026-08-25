#!/usr/bin/env node
// Does the hull ride the sea it is floating on?
//
//   node tools/probe-bob.mjs --preset "Tropical Lagoon" --preset "North Atlantic Storm"
//
// Drives the wake-physics bench headlessly with the throttle shut and samples,
// every frame, the wave heights the GPU probe hands the body next to what the
// body then does with them. Two numbers carry the answer:
//
//   probeH span  - how much sea the four hull corners actually see. Flat here
//                  and there is nothing to bob on, however lively the surface
//                  looks: the visible ruffle is a normal map with no height.
//   y - surf     - how far the hull sits off the water it is riding. A boat
//                  holds this near zero; a metre of it is the hull leaving.
//
// Reported, never asserted - it is a probe, not a check. The sea state comes
// from the preset, and every threshold worth having depends on which one.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const multi = (n) => args.reduce((a, v, i) => (v === '--' + n ? [...a, args[i + 1]] : a), []);
const PRESETS = multi('preset');
const OVERRIDES = multi('set');
const SECS = +opt('secs', 10);
const BACKEND = opt('backend', 'webgl');
// Overrides the hull-length footprint the bench passes, i.e. the mip the probe
// reads each cascade at. 0 reads the exact texel.
const FOOTPRINT = opt('footprint', null);
// Stops the clock and compares the probe's answer against the displacement
// layers sampled on the CPU, cascade by cascade.
const VERIFY = args.includes('--verify');
const SPEED = +opt('speed', 0);   // knots; 0 parks the hull

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 360, height: 240 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(
  `http://127.0.0.1:${port}/examples/webgpu-wake-physics.html?backend=${BACKEND}`,
  { waitUntil: 'domcontentloaded' },
);
await page.waitForFunction(() => !!window.abyssalExample, null, { timeout: 120000 });
// A probe measures a fixed configuration; the frame-rate governor would move
// renderScale under it mid-run.
await page.evaluate(() => {
  const A = window.abyssalExample.abyssal;
  A.params.adaptiveQuality = 0; A.params.fpsCap = 0;
  A.params.renderScale = 0.25; A.params.cloudSteps = 6;
});

if (FOOTPRINT !== null) {
  await page.evaluate((fp) => {
    const probe = window.abyssalExample.abyssal.probe;
    const orig = probe.update.bind(probe);
    probe.update = (pts, o = {}) => orig(pts, { ...o, footprint: fp });
  }, +FOOTPRINT);
}

const stat = (v) => {
  const f = v.filter(Number.isFinite);
  if (!f.length) return { n: 0 };
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  const sd = Math.sqrt(f.reduce((a, b) => a + (b - mean) ** 2, 0) / f.length);
  return { n: f.length, min: Math.min(...f), max: Math.max(...f), mean, sd };
};
const show = (s, u = 'm') => s.n
  ? `${s.min.toFixed(3)} .. ${s.max.toFixed(3)} ${u}  (sd ${s.sd.toFixed(3)})`
  : 'no samples';

for (const preset of (PRESETS.length ? PRESETS : ['Tropical Lagoon'])) {

  await page.evaluate((name) => {
    const sel = document.getElementById('p-preset');
    sel.value = name;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, preset);
  // Applied after the preset, so --set wins over whatever it brought along.
  await page.evaluate((ov) => {
    const A = window.abyssalExample.abyssal;
    for (const kv of ov) {
      const [k, v] = kv.split('=');
      A.params[k] = isNaN(+v) ? v : +v;
    }
    if (ov.length && A.sim) A.sim.dirty = true;
  }, OVERRIDES);
  // The spectrum rebuilds on the next sim update, then the sea has to develop.
  await page.waitForTimeout(4000);

  const rows = await page.evaluate(async (ms) => {
    const b = window.abyssalExample.boat;
    const out = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        const ph = b._probeH ? b._probeH.slice(0, 4) : null;
        out.push({
          lo: ph ? Math.min(...ph) : null,
          hi: ph ? Math.max(...ph) : null,
          y: b.pos[1], surf: b.surf, vy: b.vel[1],
          pitch: b.pitch, roll: b.roll, air: b.airborne ? 1 : 0,
        });
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else res();
      };
      tick();
    });
    return out;
  }, SECS * 1000);

  const p = await page.evaluate(async () => {
    const A = window.abyssalExample.abyssal;
    const q = A.params;
    const m = await import('/src/gpu/tsl/water-common.js');
    const pr = await import('/src/gpu/tsl/craft-probe.js');
    return {
      wind: q.windSpeed, amp: q.amplitude, swell: q.swellAmount, depth: q.depth,
      cascades: m.uCascadeCount.value, hScale: m.uHeightScale.value, xzScale: m.uHorizScale.value,
      mips: !!m.dispTexture.value?.generateMipmaps,
      minFilter: m.dispTexture.value?.minFilter,
      patch: Array.from(m.uPatch.array || []),
      lod: Array.from(pr.uProbeLod.array || []),
      lodLight: Array.from(pr.uProbeLodLight.array || []),
      N: m.dispTexture.value?.image?.width || 0,
    };
  });

  // The probe reads the assembled displacement. Reading the field itself says
  // whether a flat hull ride is a sim that made no waves or a probe that missed
  // them - the two look identical from the body's side.
  const disp = await page.evaluate(async () => {
    const sim = window.abyssalExample.abyssal.sim;
    if (!sim?.readLayer) return null;
    const out = [];
    for (let c = 0; c < sim.C; c++) {
      const px = await sim.readLayer('disp', c);
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < px.length; i += 4) {
        sx += px[i] * px[i]; sy += px[i + 1] * px[i + 1]; sz += px[i + 2] * px[i + 2];
      }
      const n = px.length / 4;
      out.push([c, Math.sqrt(sx / n), Math.sqrt(sy / n), Math.sqrt(sz / n)]);
    }
    return out;
  });

  const seen = rows.flatMap((r) => (r.lo == null ? [] : [r.lo, r.hi]));
  const gap = rows.map((r) => r.y - r.surf);
  console.log(
    `\n${preset}   wind ${p.wind}  amplitude ${p.amp}  swell ${p.swell}  depth ${p.depth}` +
    `\n  disp N      ${p.N}  (mip chain tops out at ${Math.log2(p.N || 1).toFixed(0)})` +
    `\n  cascades    ${p.cascades}   heightScale ${p.hScale}  horizScale ${p.xzScale}` +
    `\n  disp mips   ${p.mips}  minFilter ${p.minFilter}` +
    `\n  patch m     ${p.patch.map((v) => v.toFixed(1)).join('  ')}` +
    `\n  probe LOD   ${p.lod.map((v) => v.toFixed(2)).join('  ')}` +
    `\n  light LOD   ${p.lodLight.map((v) => v.toFixed(2)).join('  ')}` +
    `\n  frames      ${rows.length} over ${SECS}s` +
    `\n  probeH      ${show(stat(seen))}` +
    `\n  hull y      ${show(stat(rows.map((r) => r.y)))}` +
    `\n  ride surf   ${show(stat(rows.map((r) => r.surf)))}` +
    `\n  y - surf    ${show(stat(gap))}` +
    `\n  vel.y       ${show(stat(rows.map((r) => r.vy)), 'm/s')}` +
    `\n  pitch       ${show(stat(rows.map((r) => r.pitch)), 'rad')}` +
    `\n  roll        ${show(stat(rows.map((r) => r.roll)), 'rad')}` +
    `\n  airborne    ${rows.filter((r) => r.air).length} / ${rows.length} frames` +
    (disp
      ? '\n  disp RMS    ' + disp
        .map(([c, x, y, z]) => `c${c} x${x.toExponential(2)} y${y.toExponential(2)} z${z.toExponential(2)}`)
        .join('\n              ')
      : ''),
  );

}

if (VERIFY) {

  const v = await page.evaluate(async () => {
    const A = window.abyssalExample.abyssal;
    // A still sea makes the async readback and the probe comparable: otherwise
    // they are answers about two different moments.
    A.params.timeScale = 0;
    await new Promise((r) => setTimeout(r, 2000));

    const sim = A.sim, N = sim.N, C = sim.C;
    const m = await import('/src/gpu/tsl/water-common.js');
    const patch = Array.from(m.uPatch.array);
    const layers = [];
    for (let c = 0; c < C; c++) layers.push(await sim.readLayer('disp', c));

    // Bilinear, repeat-wrapped, channel y - what the shader's sample does.
    const at = (px, X, Y) => {
      const xi = ((X % N) + N) % N, yi = ((Y % N) + N) % N;
      return px[(yi * N + xi) * 4 + 1];
    };
    const sample = (px, u, v) => {
      const fx = (((u % 1) + 1) % 1) * N - 0.5, fy = (((v % 1) + 1) % 1) * N - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      return at(px, x0, y0) * (1 - tx) * (1 - ty) + at(px, x0 + 1, y0) * tx * (1 - ty)
        + at(px, x0, y0 + 1) * (1 - tx) * ty + at(px, x0 + 1, y0 + 1) * tx * ty;
    };

    const pack = A.bodies.packProbes(A.params);
    const p = [pack.points[0], pack.points[1]];
    const per = patch.slice(0, C).map((L, c) => sample(layers[c], p[0] / L, p[1] / L));
    const b = window.abyssalExample.boat;
    return {
      point: p, perCascade: per, cpuSum: per.reduce((a, x) => a + x, 0),
      gpuProbeH: b._probeH ? Array.from(b._probeH.slice(0, 4)) : null,
    };
  });

  console.log(
    '\nfrozen-sea check at probe point ' + v.point.map((n) => n.toFixed(2)).join(', ') +
    '\n  per cascade (CPU)  ' + v.perCascade.map((n) => n.toFixed(5)).join('  ') +
    '\n  sum         (CPU)  ' + v.cpuSum.toFixed(5) + ' m' +
    '\n  probe said  (GPU)  ' + (v.gpuProbeH ? v.gpuProbeH.map((n) => n.toFixed(5)).join('  ') : 'none'),
  );

}

if (errors.length) console.log('\npage errors: ' + errors.slice(0, 4).join(' | '));
await browser.close();
server.close();
