// A counter clipped onto the WebGPU API itself.
//
// The fps badge could only ever say "the encode is cheap" — on WebGPU
// renderer.render() returns the moment the commands are written, so a low cpu
// number says nothing about where the frame actually goes. This wraps the
// handful of WebGPU entry points that cost real money and counts them per
// frame, which turns "the GPU is slow" into a specific accusation:
//
//   submits            one per render pass in three's backend, and every one
//                      is a command-buffer boundary a tile-based GPU has to
//                      flush its tile memory across
//   renderPasses       same thing from the other side
//   pipelines/shaders  MUST be zero once the scene is warm. Anything else is
//                      three recompiling WGSL mid-flight, which on a phone is
//                      tens of milliseconds a pop
//   bindGroups         likewise: churn here means the bind-group cache is
//                      missing every frame
//   writeBuffer        uniform traffic; bytes matter more than the count
//   draws              the actual geometry
//
// Everything is patched on the prototypes before the renderer asks for a
// device, so it sees three's real traffic and nothing else. Install() is a
// no-op on a browser with no WebGPU, and on the WebGL backend the counters
// simply stay at zero — which is itself the honest answer for that path.

const KEYS = [
  'submit', 'writeBuffer', 'writeBytes', 'encoders', 'renderPasses',
  'computePasses', 'pipelines', 'shaders', 'bindGroups', 'buffers',
  'textures', 'draws', 'mapAsync',
];

const zero = () => KEYS.reduce((o, k) => (o[k] = 0, o), {});

let live = zero();     // accumulating since the last mark
let installed = false;

function wrap(proto, name, key, size = null) {
  if (!proto || typeof proto[name] !== 'function') return;
  const orig = proto[name];
  proto[name] = function (...args) {
    live[key]++;
    if (size) live[size] += size === 'writeBytes' ? byteLen(args) : 0;
    return orig.apply(this, args);
  };
}

function byteLen(args) {
  // queue.writeBuffer(buffer, offset, data, dataOffset?, size?)
  const d = args[2];
  if (!d) return 0;
  if (typeof args[4] === 'number') return args[4] * (d.BYTES_PER_ELEMENT || 1);
  return d.byteLength || 0;
}

/**
 * Patch the WebGPU prototypes. Must run before the renderer requests a device.
 * Safe to call more than once, and safe where WebGPU does not exist.
 */
export function installGpuProbe() {
  if (installed || typeof GPUQueue === 'undefined') return false;
  installed = true;

  wrap(GPUQueue.prototype, 'submit', 'submit');
  wrap(GPUQueue.prototype, 'writeBuffer', 'writeBuffer', 'writeBytes');
  wrap(GPUDevice.prototype, 'createCommandEncoder', 'encoders');
  wrap(GPUDevice.prototype, 'createRenderPipeline', 'pipelines');
  wrap(GPUDevice.prototype, 'createRenderPipelineAsync', 'pipelines');
  wrap(GPUDevice.prototype, 'createComputePipeline', 'pipelines');
  wrap(GPUDevice.prototype, 'createShaderModule', 'shaders');
  wrap(GPUDevice.prototype, 'createBindGroup', 'bindGroups');
  wrap(GPUDevice.prototype, 'createBuffer', 'buffers');
  wrap(GPUDevice.prototype, 'createTexture', 'textures');
  wrap(GPUCommandEncoder.prototype, 'beginRenderPass', 'renderPasses');
  wrap(GPUCommandEncoder.prototype, 'beginComputePass', 'computePasses');
  wrap(GPURenderPassEncoder.prototype, 'draw', 'draws');
  wrap(GPURenderPassEncoder.prototype, 'drawIndexed', 'draws');
  wrap(GPUBuffer.prototype, 'mapAsync', 'mapAsync');
  return true;
}

export function gpuProbeActive() { return installed; }

/** Zero the counters and start a new window. */
export function markGpuProbe() { live = zero(); }

/** Totals since the last mark, optionally divided by a frame count. */
export function readGpuProbe(frames = 1) {
  const n = Math.max(1, frames);
  const out = {};
  for (const k of KEYS) out[k] = live[k] / n;
  return out;
}
