// Choosing a backend, and saying which one you got.
//
// THREE.WebGPURenderer already picks WebGPU and falls back to WebGL2 on its own,
// so the selection is not the interesting part. What this adds is the parts that
// are not automatic:
//
//   - an explicit override, so a backend can be forced for comparison rather
//     than only accepted
//   - a truthful report of which one is live, because "it fell back" is
//     otherwise silent and looks identical to "it did not"
//   - the device, when there is one, since the wave simulation dispatches raw
//     WGSL compute on it and there is no such thing on the WebGL path
//
// The fallback being automatic is worth stating plainly: it covers the RENDERER.
// It does not port shaders. Three can only fall back on material code expressed
// in TSL, and nothing translates GLSL to WGSL - see docs/webgpu-port.md.

export const BACKENDS = ['auto', 'webgpu', 'webgl'];

// ?backend=webgl forces the fallback path; ?backend=webgpu refuses to fall back
// and fails loudly instead, which is what you want when testing that the WebGPU
// path actually works rather than quietly measuring WebGL twice.
export function requestedBackend(search = (typeof location !== 'undefined' ? location.search : '')) {
  const v = new URLSearchParams(search).get('backend');
  return BACKENDS.includes(v) ? v : 'auto';
}

export async function webgpuAvailable() {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

// three is a peer of this module, not a dependency of the library: pass the
// namespace in. `import * as THREE from 'three/webgpu'`.
export async function createRenderer(THREE, { canvas, backend = 'auto', ...opts } = {}) {
  if (!THREE?.WebGPURenderer) {
    throw new Error("createRenderer expects three/webgpu's namespace (import * as THREE from 'three/webgpu')");
  }
  const want = BACKENDS.includes(backend) ? backend : 'auto';

  if (want === 'webgpu' && !(await webgpuAvailable())) {
    throw new Error('backend=webgpu was requested but this browser has no usable WebGPU adapter');
  }

  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: want === 'webgl', ...opts });
  await renderer.init();

  const isWebGPU = !!renderer.backend?.isWebGPUBackend;
  const active = isWebGPU ? 'webgpu' : 'webgl';
  if (want === 'webgpu' && !isWebGPU) {
    throw new Error('backend=webgpu was requested but the renderer initialised on WebGL2');
  }

  return {
    renderer,
    backend: active,
    // Present only on WebGPU. The simulation needs it to dispatch compute; the
    // WebGL path runs the fragment simulation in src/ocean.js instead.
    device: isWebGPU ? renderer.backend.device : null,
    fellBack: want === 'auto' && !isWebGPU,
    describe() {
      return active === 'webgpu'
        ? `WebGPU (${renderer.backend.adapter?.info?.vendor || '?'} / ${renderer.backend.adapter?.info?.architecture || '?'})`
        : 'WebGL2' + (want === 'auto' ? ' — fell back, no WebGPU adapter' : ' — forced');
    },
  };
}
