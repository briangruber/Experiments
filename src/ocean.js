// Multi-cascade FFT ocean.
//
// Four independent spectra with deliberately non-commensurate patch sizes are
// summed in the surface shader. Because the periods share no common multiple at
// any believable viewing distance, the surface never shows a repeating tile.

import { program, setUniforms, texture2D, textureArray, framebuffer, Blitter, FS_VERT } from './gl.js';
import { INIT_SPECTRUM_FS, TIME_EVOLVE_FS, FFT_FS, ASSEMBLE_FS, FOAM_FS } from './shaders/oceanSim.js';
import { mulberry32, gauss2 } from './math.js';

// Patch sizes chosen so no pair has a simple rational ratio.
export const DEFAULT_CASCADES = [793.0, 197.0, 43.0, 9.7];

function butterflyData(N) {
  const stages = Math.round(Math.log2(N));
  const bits = stages;
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const data = new Float32Array(stages * N * 4);
  for (let s = 0; s < stages; s++) {
    const span = 1 << s;
    for (let y = 0; y < N; y++) {
      // k carries the wing sign implicitly: the lower wing lands on k + N/2.
      const k = ((y * (N / (span * 2))) % N);
      const ang = 2 * Math.PI * k / N;             // e^{+i.} => inverse transform
      const topWing = (y % (span * 2)) < span;
      let top, bot;
      if (s === 0) {
        top = topWing ? rev[y] : rev[y - 1];
        bot = topWing ? rev[y + 1] : rev[y];
      } else {
        top = topWing ? y : y - span;
        bot = topWing ? y + span : y;
      }
      const o = (y * stages + s) * 4;              // texture is stages wide, N tall
      data[o + 0] = Math.cos(ang);
      data[o + 1] = Math.sin(ang);
      data[o + 2] = top;
      data[o + 3] = bot;
    }
  }
  return { data, stages };
}

export class Ocean {
  constructor(gl, { size = 256, cascades = DEFAULT_CASCADES } = {}) {
    this.gl = gl;
    this.N = size;
    this.L = cascades.slice();
    this.C = this.L.length;
    this.blit = new Blitter(gl);
    this.time = 0;
    this._buildTargets();
    this._buildPrograms();
    this.dirty = true;
    this.seed = 1337;
  }

  get cascadeCount() { return this.C; }

  _buildTargets() {
    const gl = this.gl, N = this.N, C = this.C;
    const F32 = { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST, wrap: gl.CLAMP_TO_EDGE };

    this.h0 = textureArray(gl, { width: N, height: N, layers: C, ...F32 });
    this.pingA = textureArray(gl, { width: N, height: N, layers: C, ...F32 });
    this.pingB = textureArray(gl, { width: N, height: N, layers: C, ...F32 });
    this.pongA = textureArray(gl, { width: N, height: N, layers: C, ...F32 });
    this.pongB = textureArray(gl, { width: N, height: N, layers: C, ...F32 });

    // Displacement is read in the vertex shader; keep it float + linear.
    this.disp = textureArray(gl, {
      width: N, height: N, layers: C,
      internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT,
      filter: gl.LINEAR, wrap: gl.REPEAT, mips: true,
    });
    this.slope = textureArray(gl, {
      width: N, height: N, layers: C,
      internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.REPEAT, mips: true, aniso: 8,
    });
    this.foam = [0, 1].map(() => textureArray(gl, {
      width: N, height: N, layers: C,
      internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.REPEAT, mips: true, aniso: 8,
    }));
    this.foamIdx = 0;

    const layered = (tex, layer) => ({ target: gl.TEXTURE_2D_ARRAY, tex: tex.tex, layer });
    this.fbo = {
      h0: [], evolve: [], ping: [], pong: [], assemble: [], foam: [[], []],
    };
    for (let c = 0; c < C; c++) {
      this.fbo.h0.push(framebuffer(gl, [layered(this.h0, c)]));
      this.fbo.ping.push(framebuffer(gl, [layered(this.pingA, c), layered(this.pingB, c)]));
      this.fbo.pong.push(framebuffer(gl, [layered(this.pongA, c), layered(this.pongB, c)]));
      this.fbo.assemble.push(framebuffer(gl, [layered(this.disp, c), layered(this.slope, c)]));
      this.fbo.foam[0].push(framebuffer(gl, [layered(this.foam[0], c)]));
      this.fbo.foam[1].push(framebuffer(gl, [layered(this.foam[1], c)]));
    }

    const bf = butterflyData(N);
    this.stages = bf.stages;
    this.butterfly = texture2D(gl, {
      width: bf.stages, height: N,
      internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT,
      filter: gl.NEAREST, data: bf.data,
    });

    this._makeNoise(this.seed ?? 1337);
  }

  _makeNoise(seed) {
    const gl = this.gl, N = this.N, C = this.C;
    const rand = mulberry32(seed);
    const data = new Float32Array(N * N * 4);
    this.noise?.forEach?.((t) => gl.deleteTexture(t.tex));
    this.noise = [];
    for (let c = 0; c < C; c++) {
      for (let i = 0; i < N * N; i++) {
        const [a, b] = gauss2(rand);
        const [d, e] = gauss2(rand);
        data[i * 4 + 0] = a; data[i * 4 + 1] = b; data[i * 4 + 2] = d; data[i * 4 + 3] = e;
      }
      this.noise.push(texture2D(gl, {
        width: N, height: N,
        internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT,
        filter: gl.NEAREST, data,
      }));
    }
  }

  _buildPrograms() {
    const gl = this.gl;
    this.pInit = program(gl, FS_VERT, INIT_SPECTRUM_FS, 'ocean.init');
    this.pEvolve = program(gl, FS_VERT, TIME_EVOLVE_FS, 'ocean.evolve');
    this.pFFT = program(gl, FS_VERT, FFT_FS, 'ocean.fft');
    this.pAsm = program(gl, FS_VERT, ASSEMBLE_FS, 'ocean.assemble');
    this.pFoam = program(gl, FS_VERT, FOAM_FS, 'ocean.foam');
  }

  setSeed(seed) {
    if (seed === this.seed) return;
    this.seed = seed;
    this._makeNoise(seed);
    this.dirty = true;
  }

  bandLimits(c) {
    // Each cascade owns the band up to a comfortable margin below the next
    // cascade's fundamental, so the four spectra tile k-space without overlap.
    const low = c === 0 ? 0.0 : (2 * Math.PI / this.L[c]) * 6.0;
    const high = c === this.C - 1 ? 1e9 : (2 * Math.PI / this.L[c + 1]) * 6.0;
    return [low, high];
  }

  buildSpectrum(p) {
    const gl = this.gl, N = this.N;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, N, N);
    gl.useProgram(this.pInit);
    for (let c = 0; c < this.C; c++) {
      const [kLow, kHigh] = this.bandLimits(c);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.h0[c]);
      setUniforms(gl, this.pInit, {
        uNoise: this.noise[c],
        uN: N, uL: this.L[c], uKLow: kLow, uKHigh: kHigh,
        uWindSpeed: p.windSpeed, uFetch: p.fetch, uWindDir: p.windDir,
        uDepth: p.depth, uSpread: p.spread, uAlignment: p.alignment,
        uSwellAmount: p.swellAmount, uSwellPeriod: p.swellPeriod,
        uSwellDir: p.swellDir, uSwellSpread: p.swellSpread,
        uAmplitude: p.amplitude, uShortWaveFade: p.shortWaveFade,
      });
      this.blit.draw();
    }
    this.dirty = false;
  }

  update(dt, p) {
    const gl = this.gl, N = this.N;
    if (this.dirty) this.buildSpectrum(p);
    this.time += dt * p.timeScale;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, N, N);

    const nextFoam = 1 - this.foamIdx;

    for (let c = 0; c < this.C; c++) {
      // 1. evolve h(k, t) into the ping buffers
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.ping[c]);
      gl.useProgram(this.pEvolve);
      setUniforms(gl, this.pEvolve, {
        uH0: this.h0, uN: N, uL: this.L[c], uTime: this.time,
        uDepth: p.depth, uChoppy: p.choppiness, uLoopPeriod: p.loopPeriod,
        uLayer: new Int32Array([c]),
      });
      this.blit.draw();

      // 2. 2 * log2(N) butterfly passes
      gl.useProgram(this.pFFT);
      let srcA = this.pingA, srcB = this.pingB, dstFbo = this.fbo.pong[c];
      let dstA = this.pongA, dstB = this.pongB, srcFbo = this.fbo.ping[c];
      for (let v = 0; v < 2; v++) {
        for (let s = 0; s < this.stages; s++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
          setUniforms(gl, this.pFFT, {
            uButterfly: this.butterfly, uSrc0: srcA, uSrc1: srcB,
            uStage: new Int32Array([s]), uVertical: new Int32Array([v]),
            uLayer: new Int32Array([c]),
          });
          this.blit.draw();
          [srcA, dstA] = [dstA, srcA];
          [srcB, dstB] = [dstB, srcB];
          [srcFbo, dstFbo] = [dstFbo, srcFbo];
        }
      }

      // 3. assemble displacement + slope + Jacobian
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.assemble[c]);
      gl.useProgram(this.pAsm);
      setUniforms(gl, this.pAsm, {
        uS0: srcA, uS1: srcB, uLayer: new Int32Array([c]), uChoppy: p.choppiness,
      });
      this.blit.draw();

      // 4. temporal foam
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.foam[nextFoam][c]);
      gl.useProgram(this.pFoam);
      setUniforms(gl, this.pFoam, {
        uSlope: this.slope, uPrevFoam: this.foam[this.foamIdx], uDisp: this.disp,
        uLayer: new Int32Array([c]), uDt: Math.min(dt, 0.05),
        uThreshold: p.foamThreshold, uDecay: p.foamDecay,
        uInject: p.foamInject, uSpreadRate: p.foamSpread, uN: N, uL: this.L[c],
      });
      this.blit.draw();
    }

    this.foamIdx = nextFoam;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const t of [this.disp, this.slope, this.foam[this.foamIdx]]) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t.tex);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    }
  }

  get foamTex() { return this.foam[this.foamIdx]; }
  get patchSizes() { return new Float32Array(this.L); }
}
