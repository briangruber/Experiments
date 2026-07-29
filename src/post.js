import { program, setUniforms, texture2D, framebuffer, FS_VERT } from './gl.js';
import { PREFILTER_FS, DOWN_FS, UP_FS, LUM_FS, ADAPT_FS, ACCUM_FS, COMPOSITE_FS, FXAA_FS } from './shaders/post.js';

const MIPS = 6;

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

    this.adapt = [0, 1].map(() => texture2D(gl, {
      width: 1, height: 1, internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT,
      filter: gl.NEAREST, data: new Float32Array([0.18]),
    }));
    this.adaptFbo = this.adapt.map((t) => framebuffer(gl, [t]));
    this.adaptIdx = 0;
    this.size = [0, 0];
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
    this.lum = texture2D(gl, {
      width: 256, height: 256, internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT,
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

  render(src, p, dt, time) {
    const gl = this.gl;
    const [w, h] = this.size;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // --- auto exposure ---
    if (p.autoExposure > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.lumFbo);
      gl.viewport(0, 0, 256, 256);
      gl.useProgram(this.pLum);
      setUniforms(gl, this.pLum, { uSrc: src });
      this.blit.draw();
      gl.bindTexture(gl.TEXTURE_2D, this.lum.tex);
      gl.generateMipmap(gl.TEXTURE_2D);

      const nx = 1 - this.adaptIdx;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.adaptFbo[nx]);
      gl.viewport(0, 0, 1, 1);
      gl.useProgram(this.pAdapt);
      setUniforms(gl, this.pAdapt, {
        uLum: this.lum, uPrev: this.adapt[this.adaptIdx],
        uDt: Math.min(dt, 0.1), uSpeed: p.exposureSpeed,
        uMinLog: Math.log(p.exposureMin), uMaxLog: Math.log(p.exposureMax),
      });
      this.blit.draw();
      this.adaptIdx = nx;
    }

    // --- bloom ---
    let level = this.chain[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, level.fbo);
    gl.viewport(0, 0, level.w, level.h);
    gl.useProgram(this.pPre);
    setUniforms(gl, this.pPre, {
      uSrc: src, uTexel: new Float32Array([1 / w, 1 / h]),
      uThreshold: p.bloomThreshold, uKnee: Math.max(p.bloomKnee, 1e-3), uClamp: p.bloomClamp,
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
      });
      this.blit.draw();
    }

    // --- composite ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ldrFbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.pComp);
    setUniforms(gl, this.pComp, {
      uSrc: src, uBloom: this.up[0].tex, uAdapt: this.adapt[this.adaptIdx],
      uRes: new Float32Array([w, h]),
      uExposure: p.exposure, uAutoExposure: p.autoExposure, uExposureBias: p.exposureBias,
      uExposureTarget: p.exposureTarget,
      uBloomIntensity: p.bloomIntensity, uBloomTint: p.bloomTint, uBloomTintAmount: p.bloomTintAmount,
      uVignette: p.vignette, uVignetteRound: p.vignetteRound,
      uGrain: p.grain, uTime: time, uChromatic: p.chromatic,
      uContrast: p.contrast, uSaturation: p.saturation,
      uLift: p.lift, uGammaCC: p.gammaCC, uGain: p.gain,
      uTonemap: new Int32Array([p.tonemap]),
      uHighlightRoll: p.highlightRoll, uHalation: p.halation,
    });
    this.blit.draw();

    // --- FXAA to the screen ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.pFxaa);
    setUniforms(gl, this.pFxaa, {
      uSrc: this.ldr, uTexel: new Float32Array([1 / w, 1 / h]), uAmount: p.fxaa,
    });
    this.blit.draw();
  }
}
