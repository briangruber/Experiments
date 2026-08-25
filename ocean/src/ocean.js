// The FFT ocean simulation on raw WebGL2.
//
// The pure, GPU-free half of this file now lives in ./ocean-shared.js so a
// three.js/TSL renderer can share it without dragging src/gl.js and the GLSL
// simulation shaders in with it. Every name is re-exported here, so callers that
// imported them from this module keep working.

import { program, setUniforms, texture2D, textureArray, framebuffer, Blitter, FS_VERT } from './gl.js';
import { INIT_SPECTRUM_FS, TIME_EVOLVE_FS, FFT_FS, ASSEMBLE_FS, FOAM_FS } from './shaders/oceanSim.js';
import { mulberry32, gauss2 } from './math.js';
import {
  ACTIVE_SHARE,
  DEFAULT_CASCADES,
  FOAM_WEIGHTS,
  GATE_PASS,
  bandLimitsOf,
  breakLodsOf,
  breakWeightsOf,
  butterflyData,
  cascadeNoise,
  choppinessOf,
  foamCutoffOf,
  kCharOf,
  probit,
  whitecapFraction,
} from './ocean-shared.js';

export {
  ACTIVE_SHARE,
  DEFAULT_CASCADES,
  FOAM_WEIGHTS,
  GATE_PASS,
  bandLimitsOf,
  breakLodsOf,
  breakWeightsOf,
  butterflyData,
  cascadeNoise,
  choppinessOf,
  foamCutoffOf,
  kCharOf,
  probit,
  whitecapFraction,
};

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
    const all = cascadeNoise(N, C, seed);
    this.noise?.forEach?.((t) => gl.deleteTexture(t.tex));
    this.noise = [];
    for (let c = 0; c < C; c++) {
      const data = all.subarray(c * N * N * 4, (c + 1) * N * N * 4);
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

  bandLimits(c) { return bandLimitsOf(this.L, this.C, c); }

  // Horizontal (Gerstner) displacement is what turns a sinusoid into a wave with
  // a peaked crest and a flat trough, and that asymmetry is the main cue for the
  // weight of the water. The steepness budget is set by the folding limit of the
  // *longest* waves, but the short cascades contribute almost nothing to the
  // shape of a swell while contributing most of the Jacobian, so spending the
  // budget on the long end buys crest sharpening for free.
  choppinessFor(c, p) { return choppinessOf(this.C, c, p); }

  // Energy centre of a cascade's band, used as the carrier wavenumber of the
  // bound second harmonic. Cascade 0 has no lower limit, so its centre is taken
  // from the top of the band, which is where the JONSWAP peak sits.
  kChar(c) { return kCharOf(this.L, this.C, this.N, c); }

  // See breakWeightsOf / breakLodsOf above; the bodies were hoisted so the TSL
  // simulation can share them. These stay as methods because that is the shape
  // every caller already holds.
  breakWeights(scale) { return breakWeightsOf(this.L, this.C, this.N, scale); }

  breakLods(scale) { return breakLodsOf(this.L, this.C, this.N, scale); }

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
        uSpreadTail: p.spreadTail,
        uSwellWidth: p.swellWidth, uGamma: p.peakEnhancement,
        uTailSat: p.tailSaturation,
        uAmplitude: p.amplitude, uShortWaveFade: p.shortWaveFade,
      });
      this.blit.draw();
    }
    this.dirty = false;
    this.spinUp = 30;   // ~9 s of foam life, run on the next update
  }

  update(dt, p) {
    const gl = this.gl, N = this.N;
    if (this.dirty) this.buildSpectrum(p);
    this.time += dt * p.timeScale;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, N, N);

    for (let c = 0; c < this.C; c++) {
      // 1. evolve h(k, t) into the ping buffers
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.ping[c]);
      gl.useProgram(this.pEvolve);
      setUniforms(gl, this.pEvolve, {
        uH0: this.h0, uN: N, uL: this.L[c], uTime: this.time,
        uDepth: p.depth, uChoppy: this.choppinessFor(c, p), uLoopPeriod: p.loopPeriod,
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
        uS0: srcA, uS1: srcB, uLayer: new Int32Array([c]),
        uChoppy: this.choppinessFor(c, p),
        uKChar: this.kChar(c), uStokes: p.crestSharpen,
      });
      this.blit.draw();
    }

    // 4. temporal foam. Separate loop because every cascade's breaking test
    // reads the displacement of *all* cascades, so they must all be current.
    // The raft left by a breaker lives several seconds, so after a change of sea
    // state the field needs that long to reach its equilibrium coverage. Rather
    // than show a foamless ocean for the first seconds (or, on a slow frame
    // budget, the first half minute) the spin-up runs the same integrator over
    // a frozen wave field until the raft has filled in.
    // Foam ages in wave time, not wall time: the decay rates are tied to the
    // life of a breaker, so a slowed or hurried sea has to carry its foam with
    // it or the whitecaps outlive the waves that made them.
    const foamDt = Math.min(dt * p.timeScale, 0.1);
    const steps = this.spinUp > 0 ? this.spinUp : 0;
    this.spinUp = 0;
    for (let s = 0; s <= steps; s++) {
      this._foamStep(s < steps ? 0.3 : foamDt, p);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const t of [this.disp, this.slope, this.foam[this.foamIdx]]) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t.tex);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    }
  }

  _foamStep(foamDt, p) {
    const gl = this.gl, N = this.N;
    const nextFoam = 1 - this.foamIdx;
    gl.useProgram(this.pFoam);
    const patch = this.patchSizes;
    const lods = this.breakLods(p.foamBreakScale);
    this.whitecap = whitecapFraction(p.windSpeed, p.foamCoverage, p.foamWindMin);
    const cutoff = foamCutoffOf(this.whitecap);
    for (let c = 0; c < this.C; c++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.foam[nextFoam][c]);
      setUniforms(gl, this.pFoam, {
        uPrevFoam: this.foam[this.foamIdx], uDisp: this.disp, uSlope: this.slope,
        uPatch: patch, uCompLod: lods, uCascadeCount: new Int32Array([this.C]),
        uLayer: new Int32Array([c]), uDt: foamDt,
        uCutoff: cutoff, uSoft: p.foamSoftness, uFaceBias: p.foamFace,
        uDecay: p.foamDecay, uFreshDecay: p.foamFreshDecay,
        uInject: p.foamInject, uSpreadRate: p.foamSpread, uThin: p.foamThin,
        uWeight: FOAM_WEIGHTS[c], uDrift: p.foamDrift, uBreakScale: p.foamBreakScale,
        uCrestAniso: p.foamCrestAniso, uRidge: p.foamRidge, uBreakup: p.foamBreakup,
        uWindDir: p.windDir, uN: N, uL: this.L[c],
      });
      this.blit.draw();
    }
    this.foamIdx = nextFoam;
    // The scale-free breaking test reads <x^2> off the top mip of the previous
    // step, so during spin-up the chain has to be rebuilt every step.
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.foam[this.foamIdx].tex);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  }

  get foamTex() { return this.foam[this.foamIdx]; }
  get patchSizes() { return new Float32Array(this.L); }

  // Debug/verification readback. Significant wave height comes from the variance
  // of the assembled height field, mean square slope and whitecap coverage come
  // straight off the 1x1 top mip that the assemble and foam passes feed. Slow
  // (it stalls the pipeline) - this is a console tool, not a per-frame path.
  measure() {
    const gl = this.gl, N = this.N;
    const lod = Math.round(Math.log2(N));
    const px = new Float32Array(4);
    const disp = new Float32Array(N * N * 4);
    const probe = gl.createFramebuffer();
    const topMip = (tex, layer, ch) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, probe);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex.tex, lod, layer);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return NaN;
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
      return px[ch];
    };

    let varH = 0, mss = 0, foam = 0, jMin = 1e9;
    const per = [];
    for (let c = 0; c < this.C; c++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.assemble[c]);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, disp);
      let s2 = 0, jm = 1e9, folded = 0;
      for (let i = 0; i < N * N; i++) {
        const h = disp[i * 4 + 1];
        s2 += h * h;
        const J = disp[i * 4 + 3];
        if (J < jm) jm = J;
        if (J < 0) folded++;
      }
      s2 /= N * N;
      const m = topMip(this.slope, c, 3);
      const f = topMip(this.foamTex, c, 0);
      varH += s2; mss += m; foam += f; jMin = Math.min(jMin, jm);
      const [kLow, kHigh] = this.bandLimits(c);
      per.push({
        c, L: this.L[c], kLow: +kLow.toFixed(4), kHigh: +Math.min(kHigh, Math.PI * N / this.L[c]).toFixed(3),
        nyquist: +(Math.PI * N / this.L[c]).toFixed(2),
        Hs: +(4 * Math.sqrt(s2)).toFixed(3), mss: +m.toFixed(5),
        foam: +f.toFixed(4), jMin: +jm.toFixed(3), foldedFrac: +(folded / (N * N)).toFixed(4),
      });
    }
    gl.deleteFramebuffer(probe);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {
      Hs: +(4 * Math.sqrt(varH)).toFixed(3), mss: +mss.toFixed(5),
      foam: +foam.toFixed(4), foamTarget: +(this.whitecap ?? 0).toFixed(4),
      jMin: +jMin.toFixed(3), per,
    };
  }
}
