// Three.js adapter.
//
// Abyssal is not built on Three.js - it is hand-written WebGL2 - so this is a real
// adapter rather than a re-export. It borrows the renderer's context, draws with
// its own programs, and hands the context back in the state Three expects.
//
// Deliberately no `import ... from 'three'`. Everything below needs from a camera
// is three matrices, read straight off the object, so this file works with any
// Three.js version and does not care whether your Three came from a bundler, an
// import map or a CDN. There is no version of Three this can be out of step with.
//
// See docs/threejs.md for what does and does not integrate.

import { Blitter } from '../gl.js';
import { Ocean, DEFAULT_CASCADES } from '../ocean.js';
import { Sky } from '../sky.js';
import { WaterSurface } from '../water.js';
import { newParams } from '../presets.js';
import { createDerived, derive } from '../derive.js';
import { mat4, mul, invert, v3 } from '../math.js';
import { adoptContext, restoreThreeState, resetDrawState } from './context.js';

// Shared per-frame view state, filled from a THREE.Camera (or anything exposing
// the same three matrices).
class ViewState {
  constructor() {
    this.viewProj = mat4();
    this.invViewProj = mat4();
    this.camPos = v3();
  }

  read(camera) {
    if (!camera || !camera.projectionMatrix || !camera.matrixWorldInverse) {
      throw new Error('Abyssal: expected a THREE.Camera (or an object with projectionMatrix / matrixWorld / matrixWorldInverse).');
    }
    // A camera moved this frame but not yet rendered has a stale matrixWorld;
    // Three refreshes it inside render(), which for the sea is one frame too late.
    if (camera.updateMatrixWorld) camera.updateMatrixWorld();
    if (camera.matrixWorldInverse.copy && camera.matrixWorld) {
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    }
    mul(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements, this.viewProj);
    invert(this.viewProj, this.invViewProj);
    const e = camera.matrixWorld.elements;
    this.camPos[0] = e[12]; this.camPos[1] = e[13]; this.camPos[2] = e[14];
    return this;
  }
}

// Common machinery for the two components: a shared context, a shared parameter
// set, and a clock.
class Component {
  constructor(renderer, opts = {}) {
    if (!renderer || typeof renderer.getContext !== 'function') {
      throw new Error('Abyssal: first argument must be a THREE.WebGLRenderer.');
    }
    this.renderer = renderer;
    this.gl = adoptContext(renderer);
    this.params = opts.params || newParams(opts.preset);
    this.derived = createDerived();
    this.view = new ViewState();
    this.time = 0;
    // A Three canvas is display-referred. Our shaders are scene-referred, so
    // without a transform a sunlit sea clamps to white. 'ldr' puts exposure and
    // an ACES fit in the shader; pass output: 'hdr' when you render into a
    // half-float target and tonemap the composed frame yourself.
    this.output = opts.output || 'ldr';
    this.exposure = opts.exposure !== undefined ? opts.exposure : 1.0;
    this._ctx = {
      camPos: this.view.camPos,
      viewProj: this.view.viewProj,
      invViewProj: this.view.invViewProj,
      sunDir: this.derived.sunDir,
      moonDir: this.derived.moonDir,
      windVec3: this.derived.windVec3,
      time: 0,
    };
    // Before anything else touches the parameters. `defaults` carries wind and
    // swell as degrees; the radians the spectrum is built from, and the
    // premultiplied sun irradiance, only exist once derive() has run. Building a
    // spectrum first fails on an undefined uniform rather than on anything that
    // names the actual problem.
    derive(this.params, this.derived);
  }

  _frame(dt, camera) {
    this.time += dt;
    derive(this.params, this.derived);
    this.view.read(camera);
    this._ctx.time = this.time;
    return this._ctx;
  }

  // The sun as a world-space unit vector pointing *towards* the sun, so it drops
  // straight into a directional light's position. Read after update().
  get sunDirection() { return this.derived.sunDir; }

  // Sun tint normalised to a peak of 1. The absolute irradiance the water shader
  // uses (params.sunIntensity) is on a physical scale that has no meaning to a
  // Three light, so how bright to make your own objects stays your call.
  get sunColor() {
    const t = this.params.sunTint;
    const m = Math.max(t[0], t[1], t[2], 1e-6);
    return [t[0] / m, t[1] / m, t[2] / m];
  }
}

// The sky: analytic atmosphere plus a volumetric cloud raymarch.
//
// Drawn as a single far-plane triangle AFTER your scene, under a LEQUAL depth
// test that writes no depth. That ordering is not cosmetic - it means the cloud
// march, by far the most expensive shading in the frame, only runs on pixels
// nothing else covered.
export class AbyssalSky extends Component {
  constructor(renderer, opts = {}) {
    super(renderer, opts);
    this.blit = new Blitter(this.gl);
    this.sky = new Sky(this.gl, this.blit, { output: this.output });
    this._ownsSky = true;
  }

  // Advance the clouds and rebuild the atmosphere lookup table if the sun,
  // the air or the eye height has moved. Call once per frame before render().
  update(dt, camera) {
    const ctx = this._frame(dt, camera);
    this.sky.updateLUT(this.params, this.derived.sunDir, Math.max(this.view.camPos[1], 1));
    restoreThreeState(this.renderer);
    return ctx;
  }

  // Call AFTER renderer.render(scene, camera).
  render(camera) {
    if (camera) this.view.read(camera);
    resetDrawState(this.gl);
    this.sky.outExposure = this.exposure;
    this.sky.drawBackground(this.params, this._ctx);
    restoreThreeState(this.renderer);
  }

  dispose() {
    // Programs and textures belong to the shared context; dropping the references
    // is enough for the page, and the context outlives us either way.
    this.sky = null;
  }
}

// The sea: a multi-cascade FFT simulation displacing a camera-centred radial grid.
//
// Drawn BEFORE your scene, writing colour and depth, so anything you render
// afterwards depth-tests against the real wave surface.
export class AbyssalWater extends Component {
  constructor(renderer, opts = {}) {
    super(renderer, opts);
    this.blit = new Blitter(this.gl);
    this.ocean = new Ocean(this.gl, {
      size: opts.fftSize || this.params.fftSize,
      cascades: opts.cascades || DEFAULT_CASCADES,
    });
    if (opts.seed !== undefined) this.ocean.setSeed(opts.seed);
    // The water reflects the sky, so it needs the atmosphere lookup table whether
    // or not anyone is drawing a sky. Sharing an AbyssalSky avoids building the
    // table twice; on its own it keeps a private one that is never drawn.
    this.sky = opts.sky ? opts.sky.sky : new Sky(this.gl, this.blit, { output: this.output });
    this._ownsSky = !opts.sky;
    this.surface = new WaterSurface(this.gl, this.params, { output: this.output });
    this.ocean.buildSpectrum(this.params);
  }

  // Rebuild the wave spectrum. Needed after changing any parameter that describes
  // the sea state itself - wind, fetch, depth, swell, amplitude - rather than how
  // it is shaded.
  rebuild() { this.ocean.dirty = true; }

  // Rebuild the surface grid, after changing gridRadial / gridAngular / gridScale.
  rebuildGrid() { this.surface.buildGrid(this.params); }

  // Step the simulation. Call once per frame, before render().
  update(dt, camera) {
    const gl = this.gl;
    const ctx = this._frame(dt, camera);
    // The simulation runs into its own framebuffers at its own resolution. Put
    // back whatever Three had bound, or the next thing it draws lands in an FFT
    // cascade instead of on the screen.
    const vp = gl.getParameter(gl.VIEWPORT);
    this.ocean.update(dt, this.params);
    this.sky.updateLUT(this.params, this.derived.sunDir, Math.max(this.view.camPos[1], 1));
    restoreThreeState(this.renderer);
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    return ctx;
  }

  // Call BEFORE renderer.render(scene, camera), with renderer.autoClear = false.
  render(camera) {
    if (camera) this.view.read(camera);
    resetDrawState(this.gl);
    this.surface.outExposure = this.exposure;
    this.surface.render(this.params, this._ctx, this.ocean, this.sky);
    restoreThreeState(this.renderer);
  }

  dispose() {
    this.surface.dispose();
    this.ocean = null;
    this.surface = null;
  }
}
