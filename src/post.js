import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { PREFILTER_FS, DOWN_FS, UP_FS, LUM_FS, ADAPT_FS, ACCUM_FS, COMPOSITE_FS, FXAA_FS } from './shaders/post.js';

const MIPS = 6;

// Approximate Planckian-locus RGB gains. Positive temperature = warmer image
// (as on a camera's Kelvin dial), positive tint = greener.
function whiteBalanceGains(temperature, tint) {
  const t = Math.max(-1, Math.min(1, temperature || 0));
  const g = Math.max(-1, Math.min(1, tint || 0));
  const r = 1 + 0.22 * t + 0.02 * g;
  const gr = 1 - 0.02 * Math.abs(t) + 0.14 * g;
  const b = 1 - 0.22 * t + 0.02 * g;
  // Renormalise on luminance so white balance never doubles as an exposure knob.
  const y = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
  return new Float32Array([r / y, gr / y, b / y]);
}

export class Post {
  constructor(gl, blit) {
    this.gl = gl;
    this.blit = blit;
    this.pPre = program(gl, FS_VERT, PREFILTER_FS, 'post.prefilter');
    this.pDown = program(gl, FS_VERT, DOWN_FS, 'post.down');
    this.pUp = program(gl, FS_VERT, UP_FS, 'post.up');
    this.pLum = program(gl, FS_VERT, LUM_FS, 'post.lum');
    this.pAdapt = program(gl, FS_VERT, ADAPT_FS, 'post.adapt');
    this.pAccum = program(gl, FS_VERT, ACCUM_FS, 'post.accum');
    this.pComp = program(gl, FS_VERT, COMPOSITE_FS, 'post.composite');
    this.pFxaa = program(gl, FS_VERT, FXAA_FS, 'post.fxaa');

    // r = linear effective key (what resolveExposure divides by), g = its log2,
    // b = the robust key the metering pass needs fed back to it.
    this.adapt = [0, 1].map(() => texture2D(gl, {
      width: 1, height: 1, internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT,
      filter: gl.NEAREST, data: new Float32Array([0.18, Math.log2(0.18), Math.log2(0.18), 1]),
    }));
    this.adaptFbo = this.adapt.map((t) => framebuffer(gl, [t]));
    this.adaptIdx = 0;
    this.size = [0, 0];
    this._wb = whiteBalanceGains(0, 0);
    this._wbKey = '0,0';
  }

  resize(w, h) {
    const gl = this.gl;
    if (this.size[0] === w && this.size[1] === h) return;
    this.size = [w, h];
    const kill = (t) => t && gl.deleteTexture(t.tex);
    this.chain?.forEach((l) => kill(l.tex));
    this.up?.forEach((l) => l && kill(l.tex));
    kill(this.lum); kill(this.ldr); kill(this.history?.[0]); kill(this.history?.[1]);

    const half = (x) => Math.max(1, x >> 1);
    const mk = (cw, ch) => {
      const tex = texture2D(gl, {
        width: cw, height: ch,
        internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
        filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
      });
      return { tex, fbo: framebuffer(gl, [tex]), w: cw, h: ch };
    };
    this.chain = [];
    this.up = [];
    let cw = half(w), ch = half(h);
    for (let i = 0; i < MIPS; i++) {
      this.chain.push(mk(cw, ch));
      // Separate upsample targets: reading and writing one texture in the same
      // pass is a feedback loop, so the additive chain needs its own buffers.
      this.up.push(i < MIPS - 1 ? mk(cw, ch) : null);
      cw = half(cw); ch = half(ch);
    }
    // Two (weighted log-luminance, weight) pairs -- the robust key and the
    // bright population -- so the mip pyramid reduces each to a weighted mean.
    this.lum = texture2D(gl, {
      width: 256, height: 256, internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE, mips: true,
    });
    this.lumFbo = framebuffer(gl, [this.lum]);
    this.ldr = texture2D(gl, {
      width: w, height: h, internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
      filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
    });
    this.ldrFbo = framebuffer(gl, [this.ldr]);
    this.history = [0, 1].map(() => texture2D(gl, {
      width: w, height: h, internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
      filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
    }));
    this.historyFbo = this.history.map((t) => framebuffer(gl, [t]));
    this.histIdx = 0;
  }

  // Temporal accumulation used by photo mode: n frames of jitter, no motion.
  accumulate(src, sampleIndex) {
    const gl = this.gl;
    const next = 1 - this.histIdx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.historyFbo[next]);
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(this.pAccum);
    setUniforms(gl, this.pAccum, {
      uSrc: src, uHistory: this.history[this.histIdx],
      uBlend: 1.0 / Math.max(sampleIndex, 1),
    });
    this.blit.draw();
    this.histIdx = next;
    return this.history[this.histIdx];
  }

  // The stop the prefilter and the composite must agree on. Auto exposure lives
  // on the GPU, so both shaders recompute it from uAdapt; these are its inputs.
  exposureUniforms(p) {
    return {
      uExposure: p.exposure, uAutoExposure: p.autoExposure,
      uExposureBias: p.exposureBias, uExposureTarget: p.exposureTarget,
      uAdapt: this.adapt[this.adaptIdx],
    };
  }

  // Direction the airflow drags water across the glass, normalised.
  _lensFlow(p) {
    if (!this._flow) this._flow = new Float32Array(2);
    const a = p.lensFlowAngle * Math.PI / 180;
    this._flow[0] = Math.sin(a); this._flow[1] = Math.cos(a);
    return this._flow;
  }

  render(src, p, dt, time, opts = {}) {
    const gl = this.gl;
    const [w, h] = this.size;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // --- auto exposure ---
    if (p.autoExposure > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.lumFbo);
      gl.viewport(0, 0, 256, 256);
      gl.useProgram(this.pLum);
      setUniforms(gl, this.pLum, {
        uSrc: src, uPrev: this.adapt[this.adaptIdx],
        uMeterCenter: p.meterCenter, uMeterHi: p.meterHighlight, uMeterLo: p.meterShadow,
      });
      this.blit.draw();
      gl.bindTexture(gl.TEXTURE_2D, this.lum.tex);
      gl.generateMipmap(gl.TEXTURE_2D);

      const nx = 1 - this.adaptIdx;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.adaptFbo[nx]);
      gl.viewport(0, 0, 1, 1);
      gl.useProgram(this.pAdapt);
      setUniforms(gl, this.pAdapt, {
        uLum: this.lum, uPrev: this.adapt[this.adaptIdx],
        // Clamped so a dropped frame cannot jump the iris, but not so hard that
        // a genuinely slow machine takes a hundred frames to settle.
        uDt: Math.min(dt, 0.3), uSpeed: p.exposureSpeed,
        uSpeedUp: Math.max(p.exposureSpeedUp, 0.05),
        uMinLog: Math.log2(p.exposureMin), uMaxLog: Math.log2(p.exposureMax),
        uSigma: p.meterSigma,
        // The metering pass weights by area with a Gaussian centre bias; its
        // frame mean is a pure function of that bias, so normalise the moments
        // with it here instead of burning a fourth channel on the weight sum.
        uCwMean: 1 - 0.4423 * p.meterCenter,
        // Stops of separation allowed between the midtone key and the bright
        // percentile before the meter starts protecting the highlights instead.
        uHiHeadroom: Math.log2(Math.max(p.meterHiTarget, 1e-3) / Math.max(p.exposureTarget, 1e-4)),
      });
      this.blit.draw();
      this.adaptIdx = nx;
    }

    const exposure = this.exposureUniforms(p);

    // --- bloom ---
    let level = this.chain[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, level.fbo);
    gl.viewport(0, 0, level.w, level.h);
    gl.useProgram(this.pPre);
    setUniforms(gl, this.pPre, {
      ...exposure,
      uSrc: src, uTexel: new Float32Array([1 / w, 1 / h]),
      uThreshold: p.bloomThreshold, uKnee: Math.max(p.bloomKnee, 1e-3), uClamp: p.bloomClamp,
      uVeil: p.bloomVeil,
    });
    this.blit.draw();

    gl.useProgram(this.pDown);
    for (let i = 1; i < MIPS; i++) {
      const src2 = this.chain[i - 1], dst = this.chain[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      setUniforms(gl, this.pDown, { uSrc: src2.tex, uTexel: new Float32Array([1 / src2.w, 1 / src2.h]) });
      this.blit.draw();
    }
    gl.useProgram(this.pUp);
    for (let i = MIPS - 1; i > 0; i--) {
      const small = i === MIPS - 1 ? this.chain[i] : this.up[i];
      const dst = this.up[i - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      setUniforms(gl, this.pUp, {
        uSrc: small.tex, uPrev: this.chain[i - 1].tex,
        uTexel: new Float32Array([1 / small.w, 1 / small.h]),
        uRadius: p.bloomRadius, uAnamorphic: p.bloomAnamorphic,
        uWeight: p.bloomFalloff,
      });
      this.blit.draw();
    }

    // --- composite ---
    // Which upsample level feeds the wide veiling-glare / halation tap. It
    // carries the sum of every octave from here down, i.e. the broad tail of
    // the point spread function only -- no ring hugging the highlight.
    const glareLevel = Math.max(1, Math.min(MIPS - 2, Math.round(p.glareSpread)));

    const wbKey = `${p.temperature},${p.tintCC}`;
    if (wbKey !== this._wbKey) { this._wb = whiteBalanceGains(p.temperature, p.tintCC); this._wbKey = wbKey; }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ldrFbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.pComp);
    setUniforms(gl, this.pComp, {
      ...exposure,
      uSrc: src, uBloom: this.up[0].tex, uGlare: this.up[glareLevel].tex,
      uRes: new Float32Array([w, h]),
      uBloomIntensity: p.bloomIntensity, uBloomTint: p.bloomTint, uBloomTintAmount: p.bloomTintAmount,
      uGlareIntensity: p.glareIntensity,
      uVignette: p.vignette, uVignetteRound: p.vignetteRound,
      uTime: time, uChromatic: p.chromatic, uDistortion: p.distortion,
      uContrast: p.contrast, uSaturation: p.saturation, uPostSaturation: p.postSaturation,
      uBlackPoint: p.blackPoint, uToe: p.toeStrength, uToeRange: p.toeRange,
      uChromaRestore: p.chromaRestore,
      uSplit: p.splitTone, uSplitShadow: p.splitShadow, uSplitHigh: p.splitHighlight,
      uLift: p.lift, uGammaCC: p.gammaCC, uGain: p.gain, uWhiteBalance: this._wb,
      uTonemap: new Int32Array([p.tonemap]),
      uHighlightRoll: p.highlightRoll,
      uHalation: p.halation, uHalationTint: p.halationTint,
      uLensWet: (opts.lensWet ?? 0) * p.lensWater,
      uLensDrops: p.lensDrops, uLensSize: p.lensSize,
      uLensRefract: p.lensRefract, uLensStreak: p.lensStreak,
      uLensRim: p.lensRim, uLensFilm: p.lensFilm,
      uLensFlow: this._lensFlow(p),
    });
    this.blit.draw();

    // --- FXAA to the screen ---
    // A converged photo-mode frame is already supersampled; running full FXAA
    // over it would only throw away the detail the accumulation just bought.
    // Early samples have not bought any yet, so hand over gradually.
    const fxaa = opts.photo
      ? p.fxaa * Math.max(0.12, 1 - (opts.sample || 0) / 12)
      : p.fxaa;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.pFxaa);
    setUniforms(gl, this.pFxaa, {
      uSrc: this.ldr, uTexel: new Float32Array([1 / w, 1 / h]), uAmount: fxaa,
      uGrain: p.grain, uGrainSize: p.grainSize, uGrainChroma: p.grainChroma,
      uGrainShadow: p.grainShadow, uTime: time,
    });
    this.blit.draw();
  }
}
