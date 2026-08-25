// The wave simulation, on WebGPU compute.
//
// Same physics as src/ocean.js, same fields, different machine. This drives the
// WGSL kernels in ./kernels/ directly on a GPUDevice - not through TSL, because
// wgslFn cannot take ptr<storage> parameters (see docs/webgpu-port.md). The
// device comes from THREE.WebGPURenderer's backend when there is one, or from
// navigator.gpu when this is being tested on its own.
//
// It is deliberately NOT a drop-in replacement for Ocean yet: it produces the
// displacement and slope fields and stops there. Foam needs a mip pyramid and a
// reduction kernel that does not exist. What it does produce is exactly what the
// golden fingerprint measures, which is what makes it checkable.

import { INIT_SPECTRUM_WGSL } from './kernels/spectrum.js';
import { TIME_EVOLVE_WGSL } from './kernels/evolve.js';
import { FFT_STAGE_WGSL, fftSharedWgsl } from './kernels/fft.js';
import { ASSEMBLE_WGSL } from './kernels/assemble.js';
// Shared with the WebGL2 simulation rather than reproduced. Reproducing them is
// how this driver was first written and every one of the five was subtly wrong -
// the butterfly table transposed and its twiddle sign flipped, the noise
// reseeded per cascade instead of drawn as one stream, all three band formulas
// different. Those would have failed the equivalence check while pointing the
// blame at the WGSL, which is correct.
import {
  DEFAULT_CASCADES, butterflyData, cascadeNoise,
  bandLimitsOf, kCharOf, choppinessOf,
} from '../ocean.js';

// The spectrum kernel is a wgslFn snippet: a bare function taking pointers, with
// no bindings and no entry point. Rather than hand-transcribe its 24 parameters
// into a uniform struct - and get one of them subtly out of order - read the
// signature and generate the wrapper from it. If a parameter is added upstream,
// this follows automatically instead of silently binding garbage.
export function wrapSpectrumKernel(src) {
  const sig = src.match(/fn\s+initSpectrum\s*\(([\s\S]*?)\)\s*->\s*void/);
  if (!sig) throw new Error('spectrum kernel: could not find fn initSpectrum(...) -> void');
  // Split on commas at angle-bracket depth zero. A naive split breaks
  // `ptr<storage, array<vec4<f32>>, read_write>` into three fragments, two of
  // which have no type at all.
  const body = sig[1].replace(/\/\/[^\n]*/g, '');
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const params = parts
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      if (i < 0) throw new Error(`spectrum kernel: parameter without a type: "${s}"`);
      return { name: s.slice(0, i).trim(), type: s.slice(i + 1).trim() };
    });

  // Two pointers and an index are supplied by the wrapper; everything else is a
  // scalar that has to travel in the uniform block, in declaration order.
  const scalars = params.filter((p) => !p.type.startsWith('ptr<') && p.name !== 'index');
  const fields = scalars.map((p) => `  ${p.name} : ${p.type},`).join('\n');
  // std140-ish: WGSL uniform structs need a size that is a multiple of 16, and
  // every field here is 4 bytes, so pad the count up to a multiple of four.
  const pad = (4 - (scalars.length % 4)) % 4;
  const padding = Array.from({ length: pad }, (_, i) => `  _pad${i} : u32,`).join('\n');
  const args = params.map((p) => {
    if (p.name === 'h0') return '&h0Buf';
    if (p.name === 'uNoise') return '&noiseBuf';
    if (p.name === 'index') return 'index';
    return `params.${p.name}`;
  }).join(', ');

  // `-> void` is how Three's wgslFn parser spells "returns nothing"; real WGSL
  // has no void type and rejects it. Three strips it when it emits; emitting the
  // module ourselves means stripping it ourselves.
  const bodySrc = src.replace(/\)\s*->\s*void\s*\{/, ') {');

  return {
    scalars: scalars.map((s) => s.name),
    code: `${bodySrc}

struct SpectrumParams {
${fields}${padding ? '\n' + padding : ''}
};

@group(0) @binding(0) var<uniform>             params   : SpectrumParams;
@group(0) @binding(1) var<storage, read>       noiseBuf : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> h0Buf    : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let Nu : u32 = u32(params.uN);
  if (gid.x >= Nu || gid.y >= Nu) { return; }
  let index : u32 = gid.y * Nu + gid.x;
  initSpectrum(${args});
}
`,
  };
}

const VEC4 = 16;

export class OceanCompute {
  constructor(device, { size = 256, cascades = DEFAULT_CASCADES } = {}) {
    this.device = device;
    this.N = size;
    this.L = cascades.slice();
    this.C = this.L.length;
    this.time = 0;
    const { stages } = butterflyData(size);
    this.stages = stages;
    this._build();
  }

  get cascadeCount() { return this.C; }

  _buf(elements, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST) {
    return this.device.createBuffer({ size: elements * VEC4, usage });
  }

  _build() {
    const d = this.device, N = this.N, C = this.C;
    const per = N * N * C;

    this.h0 = this._buf(per);
    // Two ping-pong pairs: a butterfly's read set is not its write set, so a
    // stage cannot run in place.
    this.pingA = this._buf(per); this.pingB = this._buf(per);
    this.pongA = this._buf(per); this.pongB = this._buf(per);
    this.disp = this._buf(per);
    this.slope = this._buf(per);

    const bf = butterflyData(N);
    this.butterfly = d.createBuffer({ size: bf.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.butterfly, 0, bf.data);

    this.noise = this._buf(per);
    this.seed = 1337;
    this.setSeed(this.seed);

    const spec = wrapSpectrumKernel(INIT_SPECTRUM_WGSL);
    this.spectrumScalars = spec.scalars;
    // Workgroup FFT when the line fits in the 16 KiB shared-memory guarantee
    // (N <= 512). Stage-wise ping-pong is the portable fallback.
    const storeCap = d.limits?.maxComputeWorkgroupStorageSize ?? 16384;
    this.fftShared = N <= 512 && storeCap >= N * 32;
    this.pipelines = {
      spectrum: this._pipeline(spec.code),
      evolve: this._pipeline(TIME_EVOLVE_WGSL),
      fft: this._pipeline(this.fftShared ? fftSharedWgsl(N) : FFT_STAGE_WGSL),
      assemble: this._pipeline(ASSEMBLE_WGSL),
    };
    // One uniform buffer per pass per cascade per stage would be hundreds of
    // tiny buffers; a single one written between dispatches would race. These
    // are sized to the largest block each pass needs and rotated.
    this.ubo = {};
  }

  setSeed(seed) {
    this.seed = seed;
    this.device.queue.writeBuffer(this.noise, 0, cascadeNoise(this.N, this.C, seed));
  }

  _pipeline(code) {
    const mod = this.device.createShaderModule({ code });
    return this.device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
  }

  _uniform(key, floats) {
    // 16-byte aligned, and one buffer per (pass, dispatch) so a queue can hold
    // several in flight without one overwriting another's parameters.
    const bytes = Math.ceil(floats.byteLength / 16) * 16;
    const pool = (this.ubo[key] ||= []);
    const buf = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    pool.push(buf);
    this.device.queue.writeBuffer(buf, 0, floats);
    return buf;
  }

  _bind(pipeline, entries) {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: entries.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  _dispatch(pass, pipeline, entries, ubo, groups = null) {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this._bind(pipeline, [ubo, ...entries]));
    const g = groups || [Math.ceil(this.N / 8), Math.ceil(this.N / 8), 1];
    pass.dispatchWorkgroups(g[0], g[1], g[2]);
  }

  bandLimits(c) { return bandLimitsOf(this.L, this.C, c); }
  kChar(c) { return kCharOf(this.L, this.C, this.N, c); }
  choppinessFor(c, p) { return choppinessOf(this.C, c, p); }

  buildSpectrum(p) {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (let c = 0; c < this.C; c++) {
      const [kLow, kHigh] = this.bandLimits(c);
      const named = {
        uLayer: c, uN: this.N, uL: this.L[c], uKLow: kLow, uKHigh: kHigh,
        uWindSpeed: p.windSpeed, uFetch: p.fetch, uWindDir: p.windDir, uDepth: p.depth,
        uSpread: p.spread, uSpreadTail: p.spreadTail, uAlignment: p.alignment,
        uGamma: p.peakEnhancement, uTailSat: p.tailSaturation,
        uSwellAmount: p.swellAmount, uSwellPeriod: p.swellPeriod, uSwellDir: p.swellDir,
        uSwellSpread: p.swellSpread, uSwellWidth: p.swellWidth,
        uAmplitude: p.amplitude, uShortWaveFade: p.shortWaveFade,
      };
      // Packed in the order the generated struct declares, which is the order
      // the kernel's signature declares. uLayer is u32; the rest are f32, and a
      // Float32Array view over the same bytes is how a u32 rides along.
      const n = this.spectrumScalars.length;
      const f32 = new Float32Array(Math.ceil(n / 4) * 4);
      const u32 = new Uint32Array(f32.buffer);
      this.spectrumScalars.forEach((name, i) => {
        const v = named[name];
        if (v === undefined) throw new Error(`spectrum: no value for ${name}`);
        if (name === 'uLayer') u32[i] = v >>> 0; else f32[i] = v;
      });
      this._dispatch(pass, this.pipelines.spectrum, [this.noise, this.h0], this._uniform('spectrum', f32));
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.dirty = false;
  }

  update(dt, p) {
    if (this.dirty !== false) this.buildSpectrum(p);
    this.time += dt * p.timeScale;
    const N = this.N;
    const enc = this.device.createCommandEncoder();

    for (let c = 0; c < this.C; c++) {
      // 1. h0 -> h(k, t), into the ping pair.
      {
        const f = new Float32Array(8);
        const u = new Uint32Array(f.buffer);
        f[0] = N; f[1] = this.L[c]; f[2] = this.time; f[3] = p.depth;
        f[4] = this.choppinessFor(c, p); f[5] = p.loopPeriod; u[6] = c;
        const pass = enc.beginComputePass();
        this._dispatch(pass, this.pipelines.evolve, [this.h0, this.pingA, this.pingB], this._uniform('evolve', f));
        pass.end();
      }

      // 2. FFT. Shared-memory: two dispatches (horiz, then vert) and the
      //    result lands in ping. Stage-wise: 2 * log2(N) ping-pongs, also
      //    even, also ping. Assemble binds ping either way.
      let srcA = this.pingA, srcB = this.pingB, dstA = this.pongA, dstB = this.pongB;
      if (this.fftShared) {
        const pass = enc.beginComputePass();
        for (let axis = 0; axis < 2; axis++) {
          const f = new Float32Array(8);
          const u = new Uint32Array(f.buffer);
          f[0] = N; u[1] = this.stages; u[2] = 0; u[3] = axis; u[4] = c;
          this._dispatch(pass, this.pipelines.fft,
            [this.butterfly, srcA, srcB, dstA, dstB], this._uniform('fft', f),
            [N, 1, 1]);
          [srcA, dstA] = [dstA, srcA];
          [srcB, dstB] = [dstB, srcB];
        }
        pass.end();
      } else {
        for (let axis = 0; axis < 2; axis++) {
          for (let s = 0; s < this.stages; s++) {
            const f = new Float32Array(8);
            const u = new Uint32Array(f.buffer);
            f[0] = N; u[1] = this.stages; u[2] = s; u[3] = axis; u[4] = c;
            const pass = enc.beginComputePass();
            this._dispatch(pass, this.pipelines.fft,
              [this.butterfly, srcA, srcB, dstA, dstB], this._uniform('fft', f));
            pass.end();
            [srcA, dstA] = [dstA, srcA];
            [srcB, dstB] = [dstB, srcB];
          }
        }
      }

      // 3. unpack into displacement and slope
      {
        const f = new Float32Array(8);
        const u = new Uint32Array(f.buffer);
        f[0] = N; f[1] = this.choppinessFor(c, p); f[2] = this.kChar(c); f[3] = p.crestSharpen; u[4] = c;
        const pass = enc.beginComputePass();
        this._dispatch(pass, this.pipelines.assemble,
          [srcA, srcB, this.disp, this.slope], this._uniform('assemble', f));
        pass.end();
      }
    }

    this.device.queue.submit([enc.finish()]);
    // The uniform pool is only alive for the frame it was written for.
    for (const k of Object.keys(this.ubo)) { for (const b of this.ubo[k]) b.destroy?.(); this.ubo[k] = []; }
  }

  // Read one cascade's displacement back, for the equivalence check.
  async readDisplacement(cascade) {
    const N = this.N;
    const bytes = N * N * VEC4;
    const rb = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.disp, cascade * bytes, rb, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    return out;
  }
}
