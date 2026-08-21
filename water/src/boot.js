// Backend selection: prefer WebGPU when a real adapter is available (the
// simulation runs on true 3D textures there), fall back to the WebGL2 app
// otherwise or if the WebGPU app fails to boot. `?gpu=0` forces WebGL2,
// `?gpu=1` expresses intent but still falls back rather than showing nothing.
//
// Falling back is fiddlier than it looks. `navigator.gpu` existing does NOT
// mean WebGPU works: plenty of browsers expose it with no usable adapter, and
// three.js then dies *asynchronously* inside init rather than rejecting the
// promise we awaited — so a plain try/catch waits forever on a page that says
// "filling the tank…". Hence two guards: probe for an adapter before importing
// anything, and race the start against a timeout in case it wedges anyway.

const want = new URLSearchParams(location.search).get('gpu');
const START_TIMEOUT = 8000;

async function hasAdapter() {
  if (!navigator.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function boot() {
  if (want !== '0' && await hasAdapter()) {
    try {
      const { start } = await import('./gpu/main.js');
      let timer;
      await Promise.race([
        start(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('WebGPU start timed out')), START_TIMEOUT);
        }),
      ]);
      clearTimeout(timer);
      return;
    } catch (e) {
      console.warn('WebGPU backend unavailable; using WebGL2.', e);
      // A wedged start may still be holding a device and a render loop, so
      // reload rather than run a second app on top of it.
      if (String(e && e.message).includes('timed out')) {
        const q = new URLSearchParams(location.search);
        q.set('gpu', '0');
        location.search = `?${q}`;
        return;
      }
    }
  }
  await import('./main.js');
}

boot();
