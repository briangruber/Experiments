// Renderer setup.
//
// Built against WebGPU, but not welded to it. Three's WebGL backend runs the
// same scene, the same node materials and the same TSL post chain, so the two
// differ in fidelity rather than in content — which is what makes falling back
// honest rather than a bait and switch. Whichever one is running, the menu
// says so; see `boot()` in main.js for who picks.

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Post } from './post.js';

/**
 * Why WebGPU might not be available here, in words a player can act on.
 * Returns null when everything is fine.
 *
 * Deliberately does *not* request an adapter. An adapter obtained here and
 * then dropped takes the underlying Dawn instance with it on some builds, and
 * the device three opens moments later dies with "a valid external Instance
 * reference no longer exists" — a black screen a few frames into the run.
 * Only one thing in this program is allowed to touch `navigator.gpu`, and it
 * is the renderer; anything the check cannot answer without an adapter is
 * reported from `Renderer#init` instead.
 */
/**
 * Build stamp. Bumped by hand when something ships that changes what a bug
 * report means — it appears in the diagnostic panel so "it's still black" can
 * be told apart from "it's still black on the build from before the fix".
 */
export const BUILD = 'r5';

export function webgpuProblem() {
  if (!window.isSecureContext) {
    return 'WebGPU needs a secure context — serve this over http://localhost rather than opening the file directly.';
  }
  if (!navigator.gpu) {
    return 'This browser has no WebGPU. Chrome or Edge 113+, or Safari 18+, will run it.';
  }
  return null;
}

export class Renderer {
  /**
   * `forceWebGL` runs the identical scene, materials and TSL post chain
   * through three's WebGL backend instead. It exists for headless
   * verification — see tools/shot.mjs — because plenty of CI machines have no
   * working WebGPU driver, and "the level renders" is otherwise not a thing
   * that can be checked anywhere. It is not a player-facing fallback: the
   * game asks for WebGPU and says so when it is missing.
   */
  constructor(canvas, { forceWebGL = false, quality, safeMode = false } = {}) {
    this.canvas = canvas;
    this.forceWebGL = forceWebGL;
    this.quality = quality;
    /**
     * Safe mode drops the two most driver-sensitive things in the game: the
     * post chain, which is a dozen TSL nodes compiled into one shader, and the
     * shadow pass, which wants a depth target the driver has to agree to. It
     * is the last rung of the ladder in src/watchdog.js — ugly, and still the
     * game.
     */
    this.safeMode = safeMode;
    this.label = forceWebGL ? 'WEBGL' : 'WEBGPU';
    /** Stamped into the diagnostic so a bug report names the build it saw. */
    this.build = BUILD;
    this.renderer = new WebGPURenderer({
      canvas,
      // MSAA is a per-sample cost on a device that is already fill-bound, and
      // the post chain's grain hides the aliasing it would have removed.
      antialias: quality.tier === 'desktop' && !safeMode,
      powerPreference: 'high-performance',
      forceWebGL,
    });

    this.renderer.setClearColor(0x000000, 1);
    this.renderer.shadowMap.enabled = !safeMode;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // the post chain tones.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 90);
    this.camera.rotation.order = 'YXZ';

    this._fpsClock = 0;
    this._frames = 0;
    /** Smoothed, so the readout does not flicker between windows. */
    this.fps = 0;
  }

  /** Bring up the WebGPU device. Call once. Throws with a readable message. */
  async init() {
    try {
      await this.renderer.init();
    } catch (err) {
      throw new Error(
        `WebGPU would not start: ${err.message}. Check that hardware acceleration is enabled.`,
      );
    }

    // A lost device stops rendering silently, which looks exactly like a
    // level that is simply very dark. Say so instead.
    this.renderer.backend?.device?.lost?.then((info) => {
      this.deviceLost = `${info.reason ?? 'unknown'}: ${info.message}`;
      console.error('WebGPU device lost:', this.deviceLost);
      this.onDeviceLost?.(this.deviceLost);
    });

    this.gpuName = this.#identifyGpu();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  /**
   * What is actually drawing this, as a string.
   *
   * Both backends hide it somewhere different and neither promises to expose
   * it at all — WebGL puts it behind a debug extension browsers may withhold,
   * and WebGPU offers an adapter description that is often empty. Best effort
   * on purpose: this is for a bug report, so an unhelpful answer is fine and
   * an exception on the way into a run is not.
   */
  #identifyGpu() {
    try {
      const backend = this.renderer.backend;
      const gl = backend?.gl;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const name = ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        return name || gl.getParameter(gl.RENDERER) || 'WebGL';
      }
      const adapter = backend?.adapter;
      return adapter?.info?.description || adapter?.info?.vendor || 'WebGPU';
    } catch {
      return '?';
    }
  }

  /**
   * Point the renderer at a scene, rebuilding the post chain for it.
   *
   * The chain is rebuilt rather than retargeted because its first node is a
   * `pass(scene, camera)` bound at construction. Runs are minutes long and
   * this happens once per run, so the rebuild is not worth avoiding.
   */
  setScene(scene) {
    this.scene = scene;
    this.post = new Post(this.renderer, scene, this.camera, this.quality);
    // Built either way, then switched out: the director writes to its uniforms
    // every frame and should not have to know whether anyone is reading them.
    if (this.safeMode) this.post.bypass(true);
    this.resize();
    return this.post;
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    // Cap the device pixel ratio: this is a fragment-heavy scene and a 3x
    // phone screen would spend its whole budget on pixels nobody can see.
    // Two separate knobs: the pixel-ratio cap is what the device claims it
    // wants, and `renderScale` is how much of that this scene can afford.
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio)
      * this.quality.renderScale;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(width * dpr, height * dpr);
  }

  /** Field of view is pushed out while sprinting and pulled in during a
   *  scare; both are animated rather than snapped. */
  setFov(target, dt) {
    const next = this.camera.fov + (target - this.camera.fov) * Math.min(1, dt * 6);
    if (Math.abs(next - this.camera.fov) > 0.01) {
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  render(dt) {
    this._frames++;
    this._fpsClock += dt;
    if (this._fpsClock >= 0.5 && this._frames > 0) {
      const sample = this._frames / this._fpsClock;
      // Exponential average: a single long frame should not read as a crash.
      this.fps = this.fps ? Math.round(this.fps * 0.5 + sample * 0.5) : Math.round(sample);
      this._frames = 0;
      this._fpsClock = 0;
    }
    this.post.render();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
