// An on-device bisect of the frame.
//
// Why this exists: there is no WebGPU in the headless browser this project is
// developed against, so every local run is the WebGL backend and every claim
// about WebGPU performance so far has been inference. The only machine that can
// answer the question is the phone, so the measurement has to travel there.
//
// It works by rendering a ladder of progressively more complete frames and
// timing each one for a couple of seconds. The gaps between the rungs localise
// the cost far better than any single number can:
//
//   clear          nothing but a clear and a present. If this alone is slow,
//                  the problem is surface presentation, not our shaders.
//   quad x1        one trivial fullscreen triangle. Isolates pipeline and
//                  present overhead from any real shading.
//   quad x16/x64   the SAME trivial shader, in 16 and 64 separate render passes
//                  into a 64px target. Nothing here costs fill rate, so the
//                  slope is the per-pass price on its own — three's backend
//                  submits one command buffer per pass, and a tile-based GPU
//                  flushes tile memory at every boundary.
//   quad full x4   that trivial shader over the full half-float canvas target,
//                  which separates raw bandwidth from per-pass overhead.
//   post           the real 13-pass bloom chain over the last beauty frame.
//   beauty         the scene by itself, straight to the canvas.
//   +refraction    …plus the underwater pass.
//   +reflection    …plus the mirrored pass.
//   full           the shipping frame.
//
// Alongside the timings it reports what the WebGPU API actually saw (see
// gpuProbe.js). Pipelines or shader modules being created in steady state is
// the single most damning thing this can find, and no frame-time number would
// ever have shown it.
//
// The panel ends with a Copy button because the person holding the phone is not
// the person reading the numbers.

import * as THREE from 'three';
import { Fn, vec4, uv } from 'three/tsl';
import { installGpuProbe, gpuProbeActive, markGpuProbe, readGpuProbe } from './gpuProbe.js';

export { installGpuProbe };

const KEY = 'saltyfin-profile';

/** Ask for a profile on the next load (the renderer needs to boot differently). */
export function requestProfileRun() {
  try { localStorage.setItem(KEY, '1'); } catch { /* sandboxed */ }
}

/** Is this boot a profiling boot? Consumes the request. */
export function profileRequested() {
  let want = false;
  try {
    want = localStorage.getItem(KEY) === '1';
    if (want) localStorage.removeItem(KEY);
  } catch { /* sandboxed */ }
  try {
    if (new URLSearchParams(location.search).get('profile') === '1') want = true;
  } catch { /* no window */ }
  return want;
}

const WARM_FRAMES = 10;      // let pipelines compile and the clock settle
const MIN_FRAMES = 8;
const MAX_FRAMES = 30;
const MAX_MS = 2200;         // a rung never takes longer than this

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Build the ladder. `passes` are the real frame's pass functions from main.js;
 * everything else is synthetic and built here.
 */
export function createProfiler({ renderer, quality, targets, passes, makeTarget }) {
  // --- synthetic rungs ------------------------------------------------------
  const emptyScene = new THREE.Scene();
  const flatCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);

  const quad = new THREE.QuadMesh();
  const quadMat = new THREE.NodeMaterial();
  quadMat.depthTest = false;
  quadMat.depthWrite = false;
  // Deliberately the cheapest legal fragment shader: a gradient, so the driver
  // cannot fold the whole pass away as a constant clear.
  quadMat.fragmentNode = Fn(() => vec4(uv().x.mul(0.15), uv().y.mul(0.15), 0.2, 1))();
  quad.material = quadMat;

  const scratch = makeTarget(64, 64, { depth: false });

  const drawQuad = (target) => {
    renderer.setRenderTarget(target ?? null);
    renderer.autoClear = true;
    quad.render(renderer);
    renderer.autoClear = false;
  };

  // n passes into a 64px target, then one to the canvas. Nothing here costs
  // fill rate, so the slope across x1 / x16 / x64 is the price of a render pass
  // and its command-buffer submit on its own. It has to reach 64 to be
  // readable: rAF cannot resolve anything under one vsync, so a per-pass cost
  // of half a millisecond is invisible at x16 and obvious at x64.
  const quadTimes = (n) => () => {
    for (let i = 0; i < n - 1; i++) drawQuad(scratch);
    drawQuad(null);
  };

  // The same trivial shader over the full half-float canvas target instead.
  // Against the tiny-target rungs this separates bandwidth from pass overhead.
  const quadFull = (n) => () => {
    for (let i = 0; i < n - 1; i++) drawQuad(targets.scene);
    drawQuad(null);
  };

  const fullFrame = () => {
    if (quality.reflections) passes.reflection();
    passes.refraction();
    passes.beauty(false);
    passes.post();
    renderer.setRenderTarget(null);
  };

  const rungs = [
    // Discarded. Every pipeline in the shipping frame compiles on the frame its
    // material is first drawn, and the first rung measured otherwise absorbs
    // all of it — the run before this existed put 64 ms on "clear only", which
    // is not a thing a clear can cost.
    { name: '(warm-up)', drop: true, run: fullFrame },
    { name: 'clear only', run: () => {
      renderer.setRenderTarget(null);
      renderer.autoClear = true;
      renderer.render(emptyScene, flatCamera);
      renderer.autoClear = false;
    } },
    { name: 'quad x1', run: quadTimes(1) },
    { name: 'quad x16', run: quadTimes(16) },
    { name: 'quad x64', run: quadTimes(64) },
    { name: 'quad full x4', run: quadFull(4) },
    { name: 'post only', run: () => passes.post() },
    { name: 'beauty', run: () => passes.beauty(true) },
    { name: 'beauty+refr', run: () => { passes.refraction(); passes.beauty(true); } },
    { name: 'beauty+refr+refl', run: () => {
      passes.reflection(); passes.refraction(); passes.beauty(true);
    } },
    { name: 'FULL FRAME', run: fullFrame },
  ];

  // --- state ----------------------------------------------------------------
  let active = false;
  let index = 0;
  let n = 0;
  let started = 0;
  let last = 0;
  const samples = [];
  const results = [];
  let gpuMs = null;
  let banner = null;

  const hasTimestamp = !!renderer.backend?.trackTimestamp;
  // The probe patches globals that exist on any browser with WebGPU, but it
  // only sees traffic when the WebGPU backend is the one running.
  const probing = gpuProbeActive() && quality.backend === 'webgpu';

  function showBanner(text) {
    if (!banner) {
      banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:90;'
        + 'font:600 11px/1.6 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;'
        + 'color:#ff9a3c;background:rgba(6,14,28,.82);border:1px solid rgba(255,154,60,.35);'
        + 'border-radius:999px;padding:6px 14px;pointer-events:none;white-space:nowrap';
      document.body.appendChild(banner);
    }
    banner.textContent = text;
  }

  function start() {
    if (active) return;
    active = true;
    index = 0; n = 0;
    samples.length = 0; results.length = 0;
    started = performance.now();
    last = 0;
    // The scene is still simulating underneath — freeze what we can so the
    // rungs are comparable to each other rather than to the weather.
    document.getElementById('hud')?.classList.add('hidden');
    document.getElementById('touch')?.classList.add('hidden');
    if (probing) markGpuProbe();
  }

  /**
   * Called from the frame loop. Returns the render function to use this frame,
   * or null to render normally.
   */
  function step(nowMs) {
    if (!active) return null;
    const rung = rungs[index];

    if (last > 0) {
      const dt = nowMs - last;
      if (n >= WARM_FRAMES) samples.push(dt);
    }
    last = nowMs;
    n++;

    const enough = samples.length >= MIN_FRAMES
      && (samples.length >= MAX_FRAMES || performance.now() - started > MAX_MS);

    if (enough) {
      const counts = probing ? readGpuProbe(samples.length) : null;
      const row = { name: rung.name, ms: median(samples), counts, gpuMs: null };
      if (!rung.drop) results.push(row);
      // Resolving drains every timestamp taken since the last resolve, so the
      // number that comes back belongs to the rung that just ended — but it
      // comes back a few frames later, so it is written into the row rather
      // than returned. finish() waits a beat for the last one.
      if (hasTimestamp) {
        renderer.resolveTimestampsAsync('render')
          .then((v) => { if (typeof v === 'number') row.gpuMs = v; })
          .catch(() => { /* the pool can refuse while a map is in flight */ });
      }
      index++; n = 0; last = 0;
      samples.length = 0;
      started = performance.now();
      if (probing) markGpuProbe();
      if (index >= rungs.length) {
        active = false;
        setTimeout(finish, 250);
        return null;
      }
    }

    showBanner(`profiling ${index + 1}/${rungs.length} — ${rungs[index].name}`);
    return rungs[index].run;
  }

  // --- report ---------------------------------------------------------------
  function report() {
    const L = [];
    const dpr = window.devicePixelRatio || 1;
    L.push(`SALTY FIN GPU PROFILE`);
    L.push(`backend ${quality.backend} · tier ${quality.tier} · pr ${quality.pixelRatio} · scale ${quality.renderScale}`);
    L.push(`canvas ${targets.scene.width}x${targets.scene.height} backing · dpr ${dpr}`);
    L.push(`refr ${targets.refraction.width}x${targets.refraction.height} · refl ${targets.reflection.width}x${targets.reflection.height}`);
    L.push(`shadows ${quality.shadows ? quality.shadowSize : 'off'} · reflections ${quality.reflections}`);
    L.push(`timestamps ${hasTimestamp ? 'on' : 'unavailable'} · api counters ${probing ? 'live' : 'n/a on webgl'}`);
    L.push(`ua ${navigator.userAgent.slice(0, 96)}`);
    L.push('');
    // Without this line the table reads wrong: rAF cannot report anything
    // faster than the display, so a rung sitting exactly on 16.7 (or 8.3 on a
    // 120 Hz panel) is not "16.7 ms of work", it is "finished early".
    L.push('ms is rAF-to-rAF, so a rung at the vsync floor has headroom to spare.');
    L.push('');

    // Two narrow tables rather than one wide one — a phone screen is about 55
    // monospace characters across at this size, and a table that needs
    // sideways scrolling is a table nobody reads.
    const pad = (s, w) => String(s).padStart(w);
    L.push('rung                ms   fps    +ms   gpu');
    let prev = 0;
    for (const r of results) {
      L.push(
        r.name.padEnd(16)
        + pad(r.ms.toFixed(1), 6)
        + pad((1000 / r.ms).toFixed(0), 6)
        + pad((r.ms - prev).toFixed(1), 7)
        + pad(r.gpuMs == null ? '-' : r.gpuMs.toFixed(1), 6),
      );
      prev = r.ms;
    }

    L.push('');
    if (probing) {
      L.push('per frame, as the WebGPU API saw it:');
      L.push('rung             subm pass draw pipe shdr bgrp wbuf');
      for (const r of results) {
        const c = r.counts || {};
        L.push(
          r.name.padEnd(16)
          + pad(Math.round(c.submit ?? 0), 5)
          + pad(Math.round(c.renderPasses ?? 0), 5)
          + pad(Math.round(c.draws ?? 0), 5)
          + pad(Math.round(c.pipelines ?? 0), 5)
          + pad(Math.round(c.shaders ?? 0), 5)
          + pad(Math.round(c.bindGroups ?? 0), 5)
          + pad(Math.round(c.writeBuffer ?? 0), 5),
        );
      }
      L.push('');
      L.push('pipe/shdr must be 0 here. Anything else is WGSL being recompiled');
      L.push('mid-flight, which is tens of ms a go on a phone.');
      const kb = results.map((r) => Math.round((r.counts?.writeBytes ?? 0) / 1024));
      L.push('uniform upload kB/frame: ' + kb.join(' '));
      const mapped = results.reduce((a, r) => a + (r.counts?.mapAsync ?? 0), 0);
      if (mapped > 0) L.push(`buffer maps/frame: ${(mapped / results.length).toFixed(2)} — a readback stalls the pipe`);
    } else {
      L.push('(API counters need the WebGPU backend; this run was WebGL.)');
    }
    return L.join('\n');
  }

  function finish() {
    if (banner) { banner.remove(); banner = null; }
    document.getElementById('hud')?.classList.remove('hidden');
    document.getElementById('touch')?.classList.remove('hidden');

    const text = report();
    console.log(text);
    window.saltyfinProfile = { text, results };

    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;inset:0;z-index:95;background:rgba(4,9,19,.94);'
      + 'display:flex;flex-direction:column;padding:max(14px,env(safe-area-inset-top)) 12px 14px;'
      + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#cfe6fb';
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText = 'flex:1;overflow:auto;margin:0;font-size:9.5px;line-height:1.55;'
      + '-webkit-overflow-scrolling:touch;white-space:pre';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;padding-top:10px';
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'flex:1;appearance:none;border:1px solid rgba(206,232,255,.28);'
        + 'background:rgba(10,24,44,.7);color:#dceaf7;border-radius:10px;padding:11px 8px;'
        + 'font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase';
      b.addEventListener('click', fn);
      return b;
    };
    row.appendChild(btn('Copy', async (e) => {
      try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; }
      catch { e.target.textContent = 'Select the text'; }
    }));
    row.appendChild(btn('Close', () => panel.remove()));
    panel.appendChild(pre);
    panel.appendChild(row);
    document.body.appendChild(panel);
  }

  return {
    start,
    step,
    report,
    get active() { return active; },
    dispose() {
      scratch.dispose();
      quadMat.dispose();
      banner?.remove();
    },
  };
}
