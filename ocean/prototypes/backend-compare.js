// Both simulations, on the reader's own hardware.
//
// The equivalence check in tools/ runs on a software rasteriser, which proves
// the maths and nothing about a real GPU. This is the same comparison on
// whatever machine has the page open: same seed, same parameters, same step
// count, same dt, and a per-texel diff of the resulting wave fields.
//
// It also shows the fields, because a table of matching statistics is a weak
// thing to look at and two identical-looking heightmaps with a black difference
// image between them is not.

import { getContext } from '../src/gl.js';
import { Ocean, DEFAULT_CASCADES } from '../src/ocean.js';
import { OceanCompute } from '../src/gpu/ocean-compute.js';
import { newParams } from '../src/presets.js';
import { createDerived, derive } from '../src/derive.js';

const N = 128;          // big enough to be the real algorithm, small enough to be instant
const STEPS = 8;
const DT = 1 / 60;
const SEED = 1337;
const PRESET = 'Golden Hour Swell';

const el = (id) => document.getElementById(id);
const out = () => el('out');
// insertAdjacentHTML, not innerHTML +=. The latter re-serialises and reparses
// everything already in the container, and a canvas does not survive that round
// trip - its bitmap is not part of its markup. Appending the field images and
// then calling say() again blanked all three of them.
const say = (html) => out().insertAdjacentHTML('beforeend', html);

function params() {
  const p = newParams(PRESET);
  p.seed = SEED; p.fftSize = N;
  derive(p, createDerived());
  return p;
}

// ------------------------------------------------------------------ WebGL2 --
function runGL() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const gl = getContext(canvas, {});
  const p = params();
  const ocean = new Ocean(gl, { size: N, cascades: DEFAULT_CASCADES });
  ocean.setSeed(SEED);
  ocean.buildSpectrum(p);
  const t0 = performance.now();
  for (let i = 0; i < STEPS; i++) ocean.update(DT, p);
  // readPixels forces the queue to drain, so the timing covers the work rather
  // than the submission of it.
  const buf = new Float32Array(N * N * 4);
  const fields = [];
  for (let c = 0; c < ocean.cascadeCount; c++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, ocean.fbo.assemble[c]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, buf);
    fields.push(buf.slice());
  }
  return { ms: performance.now() - t0, fields, renderer: rendererName(gl) };
}

function rendererName(gl) {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}

// ------------------------------------------------------------------ WebGPU --
async function runGPU() {
  if (!('gpu' in navigator)) throw new Error('this browser has no WebGPU (navigator.gpu is undefined)');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('requestAdapter() returned null');
  const device = await adapter.requestDevice();

  const p = params();
  device.pushErrorScope('validation');
  const sim = new OceanCompute(device, { size: N, cascades: DEFAULT_CASCADES });
  sim.setSeed(SEED);
  sim.buildSpectrum(p);
  await device.queue.onSubmittedWorkDone();

  const t0 = performance.now();
  for (let i = 0; i < STEPS; i++) sim.update(DT, p);
  await device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;

  const err = await device.popErrorScope();
  if (err) throw new Error(err.message);

  const fields = [];
  for (let c = 0; c < sim.cascadeCount; c++) fields.push(await sim.readDisplacement(c));
  const info = adapter.info || {};
  return { ms, fields, renderer: `${info.vendor || '?'} / ${info.architecture || '?'}` };
}

// -------------------------------------------------------------------- diff --
function stats(f) {
  let sum = 0, sum2 = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < f.length; i += 4) {
    const v = f[i + 1];                       // height, the channel with meaning
    sum += v; sum2 += v * v;
    if (v < min) min = v; if (v > max) max = v;
  }
  const n = f.length / 4;
  return { mean: sum / n, rms: Math.sqrt(sum2 / n), min, max };
}

function diff(a, b) {
  let worst = 0, beyond = 0;
  const scale = Math.max(stats(a).rms, 1e-6);
  for (let i = 0; i < a.length; i++) {
    const e = Math.abs(a[i] - b[i]) / scale;
    if (e > worst) worst = e;
    if (e > 1e-3) beyond++;
  }
  return { worst, beyond, total: a.length };
}

// Height as false colour, and the difference amplified hard enough that anything
// non-zero is unmissable.
// scaleField matters more than it looks. Normalising a difference by its OWN rms
// rescales whatever is there to full range, so a difference of one part in a
// million paints solid red and contradicts the verdict two inches below it. The
// delta has to be measured against the wave field it came from.
function draw(canvas, field, mode, gain = 1, scaleField = null) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(N, N);
  const s = Math.max(stats(scaleField || field).rms, 1e-6) * 2.5;
  for (let i = 0; i < N * N; i++) {
    const v = field[i * 4 + 1] / s;
    let r, g, b;
    if (mode === 'diff') {
      const m = Math.min(1, Math.abs(v) * gain);
      r = 255 * m; g = 40 * m; b = 30 * m;
    } else {
      const t = Math.max(-1, Math.min(1, v)) * 0.5 + 0.5;
      r = 20 + 60 * t; g = 60 + 120 * t; b = 110 + 130 * t;
    }
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function fieldCard(label, field, mode, gain, scaleField) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const c = document.createElement('canvas');
  c.width = c.height = N;
  wrap.appendChild(c);
  const s = document.createElement('span');
  s.textContent = label;
  wrap.appendChild(s);
  draw(c, field, mode, gain, scaleField);
  return wrap;
}

// -------------------------------------------------------------------- main --
el('run').onclick = async () => {
  el('run').disabled = true;
  out().innerHTML = '';
  el('status').textContent = ' running…';

  let gl = null, gpu = null, gpuError = '';
  try { gl = runGL(); } catch (e) { say(`<p class="bad">WebGL2 simulation failed: ${e.message}</p>`); }
  try { gpu = await runGPU(); } catch (e) { gpuError = String(e.message || e); }

  say(`<h2>Hardware</h2><table>
    <tr><th>WebGL2</th><td>${gl ? gl.renderer : '—'}</td></tr>
    <tr><th>WebGPU</th><td>${gpu ? gpu.renderer : `<span class="bad">unavailable — ${gpuError}</span>`}</td></tr>
    <tr><th>Run</th><td>${N}² × 4 cascades, ${STEPS} steps, seed ${SEED}, preset “${PRESET}”</td></tr></table>`);

  if (!gl || !gpu) {
    say(`<div id="verdict">Both backends are needed for a comparison.</div>`);
    el('run').disabled = false; el('status').textContent = '';
    return;
  }

  const rows = [];
  let worstAll = 0, beyondAll = 0;
  for (let c = 0; c < gl.fields.length; c++) {
    const d = diff(gl.fields[c], gpu.fields[c]);
    const a = stats(gl.fields[c]), b = stats(gpu.fields[c]);
    worstAll = Math.max(worstAll, d.worst);
    beyondAll += d.beyond;
    rows.push(`<tr><td>cascade ${c}</td>
      <td class="num">${a.rms.toFixed(6)}</td>
      <td class="num">${b.rms.toFixed(6)}</td>
      <td class="num ${d.worst < 1e-3 ? 'ok' : 'bad'}">${d.worst.toExponential(2)}</td>
      <td class="num ${d.beyond === 0 ? 'ok' : 'bad'}">${d.beyond} / ${d.total}</td></tr>`);
  }

  say(`<h2>Displacement, per cascade</h2><table>
    <tr><th>band</th><th class="num">WebGL2 rms</th><th class="num">WebGPU rms</th>
        <th class="num">worst rel</th><th class="num">texels beyond 1e-3</th></tr>
    ${rows.join('')}</table>
    <p class="note">Relative to each cascade's own rms. A bitwise match is not the
    bar and would fail a correct port: the two are different compilers, one will
    contract a multiply-add where the other does not, and a 256-point FFT need not
    sum its terms in the same order.</p>`);

  say(`<h2>The field itself — cascade 1</h2>`);
  const gallery = document.createElement('div');
  gallery.className = 'fields';
  gallery.appendChild(fieldCard('WebGL2 fragment passes', gl.fields[1], 'height'));
  gallery.appendChild(fieldCard('WebGPU compute', gpu.fields[1], 'height'));
  const delta = gl.fields[1].map((v, i) => v - gpu.fields[1][i]);
  gallery.appendChild(fieldCard('difference, ×2000', delta, 'diff', 2000, gl.fields[1]));
  out().appendChild(gallery);

  say(`<h2>Time for ${STEPS} steps</h2><table>
    <tr><th>WebGL2 fragment passes</th><td class="num">${gl.ms.toFixed(2)} ms</td></tr>
    <tr><th>WebGPU compute</th><td class="num">${gpu.ms.toFixed(2)} ms</td></tr>
    <tr><th>ratio</th><td class="num">${(gl.ms / Math.max(gpu.ms, 1e-6)).toFixed(2)}×</td></tr></table>
    <p class="note">Wall clock including submission and the sync that drains each
    queue, at ${N}² rather than the 256² that ships — so read it as a direction,
    not as a frame-time saving. What a saving here is worth to a whole frame is in
    docs/backend-decision.md: the simulation measured 3.0% of one.</p>`);

  const pass = beyondAll === 0;
  say(`<h2>Verdict</h2><div id="verdict">${pass
    ? `<span class="ok">The two backends agree.</span> Worst relative deviation
       ${worstAll.toExponential(2)} across all four cascades, and no texel anywhere
       beyond 1e-3. The WGSL translation of the spectrum, the time evolution, the
       FFT butterflies and the assembly reproduces the renderer that ships.`
    : `<span class="bad">They disagree.</span> ${beyondAll} texels beyond 1e-3,
       worst ${worstAll.toExponential(2)}. That is a defect, not rounding — the
       difference image above shows where.`}</div>`);

  el('status').textContent = ' done.';
  el('run').disabled = false;
};

window.abyssalCompare = { N, STEPS, SEED, PRESET };
