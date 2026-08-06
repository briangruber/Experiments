// Multi-cascade FFT ocean.
//
// Four independent spectra with deliberately non-commensurate patch sizes are
// summed in the surface shader. Because the periods share no common multiple at
// any believable viewing distance, the surface never shows a repeating tile.

import { program, setUniforms, texture2D, textureArray, framebuffer, Blitter, FS_VERT } from './gl.js';
import { INIT_SPECTRUM_FS, TIME_EVOLVE_FS, FFT_FS, ASSEMBLE_FS, FOAM_FS } from './shaders/oceanSim.js';
import { mulberry32, gauss2 } from './math.js';

// Patch sizes chosen so no pair has a simple rational ratio. The largest patch
// has to resolve the peak of the spectrum with enough modes that the swell reads
// as travelling wave groups rather than one slow lump. Groups are a beat between
// neighbouring modes, so a peak carried by three or four of them cannot make
// any: at 3137 m a 14 s swell lands on mode 10 and the 17 s peak of a full gale
// on mode 7, both with enough neighbours to beat against. Cascade 0 never
// carries anything shorter than 66 m, so its 12 m texels are not the constraint
// - the mode count at the peak is.
export const DEFAULT_CASCADES = [3137.0, 397.0, 87.0, 17.3];

// How much of each cascade's whitecap contribution the surface shader should
// see. Every cascade now tests the same combined Jacobian, so without a
// partition the four foam layers would simply stack up in the near field. The
// weights sum to one when all four are visible.
//
// The split is a resolution argument, not a distance one. Cascade 0's texels are
// twelve metres across, so *any* structure it stores is at least a twenty metre
// blob - which is exactly what a third of the foam budget living there looked
// like. A breaker is metres wide, so the budget belongs in the cascades whose
// texels can hold that shape (1.6 m and 0.34 m). Cascade 0 keeps a token share
// for the far field, where a whitecap is sub-pixel anyway and only its area
// matters. Cascade 3 gets none at all: every cascade evaluates the same
// world-space fold field but can only store the part of it that falls inside its
// own tile, so a 17 m patch would stamp the same whitecap every 17 metres - and
// a 17 m window is too small a sample of a two-percent-coverage field to even
// contain one reliably. The bulk sits in the 397 m tile for the same reason in
// reverse: it is the longest period that still resolves a breaker.
// Each cascade's foam is periodic in that cascade's own tile - unavoidably, it
// lives in that tile's texture. So no single cascade may dominate, or its period
// prints a lattice of whitecaps across a sea whose waves do not repeat. Spread
// across incommensurate periods the sum has no period, exactly as the wave field
// does not. The bias toward the middle two is where breaking waves actually are.
const FOAM_WEIGHTS = [0.20, 0.34, 0.30, 0.16];

// Monahan & O'Muircheartaigh's whitecap law, W = 3.84e-6 U10^3.41. It is the one
// number in the foam model with a boat and a camera behind it, so the breaking
// threshold is derived from it rather than dialled in by eye: ~0.3% at force 4,
// ~3% at force 6, ~25% at force 10. Above force 11 the fit runs away and real
// seas saturate, hence the cap.
// `windMin` is a hard gate below it: the fit is a power law and never quite
// reaches zero, but a real sea below force 3 has no whitecaps at all, and a
// glassy preset showing its statistical quota of three rafts per square
// kilometre is worse than showing none.
export function whitecapFraction(U10, gain = 1, windMin = 4.0) {
  const U = Math.max(U10, 0.1);
  const gate = windMin > 0 ? Math.min(Math.max((U - windMin) / 2.5, 0), 1) ** 2 : 1;
  return Math.min(3.84e-6 * Math.pow(U, 3.41) * gain * gate, 0.42);
}

// Upper-tail quantile of a unit normal (Abramowitz & Stegun 26.2.23), good to
// 5e-4 over the range of coverages we ask for. The low-passed compression is a
// linear functional of a Gaussian wave field, so its own tail is Gaussian too
// and this converts "I want W of the surface breaking" into a cutoff in sigmas.
function probit(p) {
  const q = Math.min(Math.max(p, 1e-6), 0.5);
  const t = Math.sqrt(-2 * Math.log(q));
  return t - (2.30753 + 0.27061 * t) / (1 + 0.99229 * t + 0.04481 * t * t);
}

// Share of the total whitecap coverage that is *actively* folding at any
// instant; the rest of W is the dissipating raft the breaker leaves behind.
// Calibrated against the measured mean of the foam texture.
const ACTIVE_SHARE = 0.38;

// The breaking test is gated after the threshold - on the forward face and on
// the ridge of the fold field - and the injection gain then re-saturates
// whatever survives, so the area that ends up white is not the area of the
// Gaussian tail the probit sized. Measured against the mean of the foam texture
// across the preset range.
const GATE_PASS = 0.85;

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

  // Horizontal (Gerstner) displacement is what turns a sinusoid into a wave with
  // a peaked crest and a flat trough, and that asymmetry is the main cue for the
  // weight of the water. The steepness budget is set by the folding limit of the
  // *longest* waves, but the short cascades contribute almost nothing to the
  // shape of a swell while contributing most of the Jacobian, so spending the
  // budget on the long end buys crest sharpening for free.
  choppinessFor(c, p) {
    const t = this.C > 1 ? (this.C - 1 - c) / (this.C - 1) : 1;
    return p.choppiness * (1 + (p.choppyLong - 1) * t);
  }

  // Energy centre of a cascade's band, used as the carrier wavenumber of the
  // bound second harmonic. Cascade 0 has no lower limit, so its centre is taken
  // from the top of the band, which is where the JONSWAP peak sits.
  kChar(c) {
    const [lo, hi] = this.bandLimits(c);
    const top = Math.min(hi, Math.PI * this.N / this.L[c]);
    return lo > 0 ? Math.sqrt(lo * top) : 0.75 * top;
  }

  // Per-cascade weight of the folding test that drives spray. Droplets tear off
  // waves that can carry a plunging crest; anything shorter than `scale` metres
  // just wrinkles. Rolls off over two octaves above that.
  breakWeights(scale) {
    const kb = 2 * Math.PI / Math.max(scale, 0.2);
    const w = new Float32Array(4);
    for (let c = 0; c < this.C; c++) {
      const [lo, hi] = this.bandLimits(c);
      const nyq = Math.PI * this.N / this.L[c];
      const kMid = c === 0 ? Math.min(hi, nyq) * 0.3 : Math.sqrt(lo * Math.min(hi, nyq));
      const t = Math.log(kMid / kb) / Math.log(4.0);
      w[c] = 1 - Math.min(Math.max(t, 0), 1);
    }
    return w;
  }

  // Mip level per cascade whose footprint is `scale` metres across, i.e. the
  // level at which the breaking test sees a breaker-sized patch of surface
  // rather than one texel of ripple. Cascades whose texels are already coarser
  // than a breaker clamp to level 0.
  breakLods(scale) {
    const lods = new Float32Array(4);
    const maxLod = Math.log2(this.N) - 2;
    for (let c = 0; c < this.C; c++) {
      const texel = this.L[c] / this.N;
      lods[c] = Math.min(Math.max(Math.log2(Math.max(scale, 0.05) / texel), 0), maxLod);
    }
    return lods;
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
    const cutoff = probit(this.whitecap * ACTIVE_SHARE / GATE_PASS);
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
