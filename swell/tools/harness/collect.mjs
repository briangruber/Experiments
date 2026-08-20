// Collection. Drives the page once per fixture and brings back everything the
// metrics need, in one round trip.
//
// The pixel arithmetic happens inside the page, where the frame already lives.
// Shipping 1280x720x4 bytes across the CDP boundary three times per fixture is
// what makes naive harnesses take an hour; a digest is a few kilobytes.

import { frame } from '../browser.mjs';

// Runs in the browser. Keep it self-contained - it is serialised, not imported.
/* c8 ignore start */
function pageCollect(o) {
  const app = window.__swell;
  const gl = app.renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const px = new Uint8Array(W * H * 4);

  const readLum = () => {
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lum = new Float32Array(W * H);
    let hash = 2166136261 >>> 0;
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      lum[i] = (px[p] * 0.2126 + px[p + 1] * 0.7152 + px[p + 2] * 0.0722) / 255;
      // FNV-1a over the raw bytes: cheap, and only ever compared for equality.
      hash = (hash ^ px[p]) >>> 0; hash = Math.imul(hash, 16777619) >>> 0;
      hash = (hash ^ px[p + 1]) >>> 0; hash = Math.imul(hash, 16777619) >>> 0;
      hash = (hash ^ px[p + 2]) >>> 0; hash = Math.imul(hash, 16777619) >>> 0;
    }
    return { lum, hash };
  };

  // Timing has to force the pipeline. gl.finish() does not: ANGLE happily
  // returns from it while the software rasteriser has done nothing, and reports
  // sub-millisecond frames that are really seconds of work. A one-pixel
  // readback is the cheapest thing that actually blocks until the frame exists.
  const one = new Uint8Array(4);
  const times = [];
  const render = (t) => {
    const t0 = performance.now();
    app.setTime(t);
    app.renderFrame();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
    times.push(performance.now() - t0);
  };

  render(o.time);
  const a = readLum();
  render(o.time);                       // same input, second time
  const aRepeat = readLum();
  render(o.time + o.dt);
  const b = readLum();

  // Shimmer detector. A wave moving across the screen makes a *smooth*
  // frame-to-frame difference; aliasing makes a speckled one. So difference the
  // frames and measure how much high spatial frequency is in the difference.
  //
  // Then divide by the high spatial frequency already in the frame. Without that
  // normalisation the measure is really "how detailed is this scene", and a
  // storm fails a gate a millpond passes for no reason other than having more
  // to look at. What we actually want to know is how much of the fine detail is
  // *unstable*, which is a ratio.
  let dEnergy = 0, sEnergy = 0, mean = 0;
  const D = new Float32Array(W * H);
  for (let i = 0; i < D.length; i++) { D[i] = Math.abs(b.lum[i] - a.lum[i]); mean += a.lum[i]; }
  mean /= D.length;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      dEnergy += Math.abs(4 * D[i] - D[i - 1] - D[i + 1] - D[i - W] - D[i + W]);
      sEnergy += Math.abs(4 * a.lum[i] - a.lum[i - 1] - a.lum[i + 1] - a.lum[i - W] - a.lum[i + W]);
      n++;
    }
  }
  const flicker = n ? dEnergy / Math.max(sEnergy, 1e-6) : 0;

  // Downsampled luminance, for anything that wants to look at the image itself.
  const GW = 128, GH = 72;
  const grid = new Float32Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      let s = 0, c = 0;
      const x0 = Math.floor((gx * W) / GW), x1 = Math.floor(((gx + 1) * W) / GW);
      const y0 = Math.floor((gy * H) / GH), y1 = Math.floor(((gy + 1) * H) / GH);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += a.lum[y * W + x]; c++; }
      grid[gy * GW + gx] = c ? s / c : 0;
    }
  }

  // Cost. The three renders above are already representative and already paid
  // for; extra burst frames are opt-in because on a software rasteriser each
  // one costs seconds.
  for (let i = 0; i < o.benchFrames; i++) render(o.time + (i + 1) * 0.0166);
  const sorted = times.slice().sort((x, y) => x - y);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

  // Two probes, because the measurements want incompatible things from one.
  // Wave height and spectral slope need a patch several peak wavelengths across;
  // whitecap coverage needs samples fine enough to see an individual breaker.
  // Each probe band-limits the field to its own sampling, so its resolution is
  // part of the definition of what it measured.
  const field = app.probe({ resolution: o.fieldRes, extent: o.fieldExtent, time: o.time });
  const detail = app.probe({ resolution: o.detailRes, extent: o.detailExtent, time: o.time });
  const b64 = (arr) => {
    const bytes = new Uint8Array(arr.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(s);
  };

  // Leave the canvas showing the fixture frame, not the last frame of the
  // timing burst, so the screenshot Node takes next is the one being measured.
  render(o.time);

  return {
    width: W, height: H,
    hash: a.hash, hashRepeat: aRepeat.hash,
    meanLuminance: mean,
    flicker,
    grid: b64(grid), gridW: GW, gridH: GH,
    timing: { samples: sorted.length, medianMs: pick(0.5), p95Ms: pick(0.95) },
    field: {
      resolution: field.resolution, extent: field.extent, metresPerSample: field.metresPerSample,
      height: b64(field.height), coverage: b64(field.coverage),
      fold: b64(field.fold), subRough: b64(field.subRough),
    },
    detail: {
      resolution: detail.resolution, extent: detail.extent, metresPerSample: detail.metresPerSample,
      height: b64(detail.height), coverage: b64(detail.coverage),
      fold: b64(detail.fold), subRough: b64(detail.subRough),
    },
    knobs: app.knobs,
    selection: app.selection,
    errors: app.errors.slice(),
  };
}
/* c8 ignore stop */

const unpackProbe = (p) => ({
  resolution: p.resolution,
  extent: p.extent,
  metresPerSample: p.metresPerSample,
  height: decode(p.height),
  coverage: decode(p.coverage),
  fold: decode(p.fold),
  subRough: decode(p.subRough),
});

const decode = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

// One fixture, one selection, everything the metrics will ask for.
export async function collect(page, { scene, time, variants, knobs, width, height, options }) {
  const o = {
    fieldRes: options.fieldResolution ?? 256,
    fieldExtent: options.fieldExtent ?? 1024,
    detailRes: options.detailResolution ?? 512,
    detailExtent: options.detailExtent ?? 512,
    benchFrames: options.benchFrames ?? 0,
    dt: 1 / 60,
  };

  await frame(page, { scene, time, variants, knobs, width, height });
  const r = await page.evaluate(pageCollect, Object.assign({ time }, o));
  const png = await page.screenshot({ type: 'png' });

  return {
    png,
    fixture: { scene, time },
    width: r.width, height: r.height,
    hash: r.hash, hashRepeat: r.hashRepeat,
    meanLuminance: r.meanLuminance,
    flicker: r.flicker,
    grid: decode(r.grid), gridW: r.gridW, gridH: r.gridH,
    timing: r.timing,
    field: unpackProbe(r.field),
    detail: unpackProbe(r.detail),
    knobs: r.knobs,
    selection: r.selection,
    errors: r.errors,
  };
}
