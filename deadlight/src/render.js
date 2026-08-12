// Renderer setup.
//
// WebGPU only. There is a WebGL fallback path in three, but the whole look
// here — the post chain, the shadowed torch, the volumetrics — was built
// against the WebGPU backend, and a silent fallback would deliver a worse
// game while pretending nothing had happened. So the requirement is checked
// up front and reported honestly.

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
  constructor(canvas, { forceWebGL = false } = {}) {
    this.canvas = canvas;
    this.forceWebGL = forceWebGL;
    this.renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      forceWebGL,
    });

    this.renderer.setClearColor(0x000000, 1);
    this.renderer.shadowMap.enabled = true;
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

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    return this;
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
    this.post = new Post(this.renderer, scene, this.camera);
    this.resize();
    return this.post;
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    // Cap the device pixel ratio: this is a fragment-heavy scene and a 3x
    // phone screen would spend its whole budget on pixels nobody can see.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);

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
