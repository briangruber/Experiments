// Backend selection: prefer WebGPU when a real adapter is available (the
// simulation runs on true 3D textures there), fall back to the WebGL2 app
// otherwise or if the WebGPU app fails to boot. `?gpu=0` forces WebGL2,
// `?gpu=1` expresses intent but still falls back rather than showing nothing.

const want = new URLSearchParams(location.search).get('gpu');

async function boot() {
  // No adapter pre-probe: a second requestAdapter can invalidate the first
  // instance on some Chromium builds. The gpu app throws if WebGPURenderer
  // ends up on its WebGL fallback, and we land on the native WebGL2 app.
  if (want !== '0' && navigator.gpu) {
    try {
      const { start } = await import('./gpu/main.js');
      await start();
      return;
    } catch (e) {
      console.warn('WebGPU backend failed to start; falling back to WebGL2.', e);
    }
  }
  await import('./main.js');
}

boot();
