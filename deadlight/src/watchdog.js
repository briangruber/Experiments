// Black-frame watchdog.
//
// This exists because "it renders a black screen" is the single hardest bug to
// act on remotely. A black frame and a dark corridor are the same picture, and
// the causes are wildly different — an unlit level, a torch the player switched
// off, a post-processing chain the driver would not compile, a lost device, a
// backend that reported success and then drew nothing. Every one of them looks
// identical from the outside, and none of them throws.
//
// So the game checks its own output. A few seconds into a run it samples the
// canvas; if there is genuinely nothing on it, it works down the list of causes
// in order of how cheap they are to rule out, fixes what it can, and puts the
// rest on screen in a form somebody can read out.
//
// The point is not that the fallbacks are clever. It is that the game stops
// being able to fail silently.

/** Wall-clock milliseconds to let the scene settle before judging it. */
const GRACE_MS = 2500;
/**
 * And a minimum number of frames, because time alone is not enough: the first
 * few frames of a run are the ones compiling every shader in the level, and a
 * device slow enough to still be doing that at 2.5 seconds is a device this
 * has no business calling broken.
 */
const GRACE_FRAMES = 12;
/** Mean 0–255 luminance below which a frame counts as empty. */
const BLACK_THRESHOLD = 2.0;

export class RenderWatchdog {
  constructor({ canvas, renderer, hud }) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.hud = hud;

    this.stage = 0;
    this.report = null;
    /** Last reading, kept so the smoke test can assert the frame was lit. */
    this.lastBrightness = null;
    this._since = 0;
    this._frames = 0;
    this._sampler = document.createElement('canvas');
    this._sampler.width = 32;
    this._sampler.height = 18;
    this._ctx = this._sampler.getContext('2d', { willReadFrequently: true });
  }

  /**
   * Average brightness of the current frame, or null if it cannot be read.
   *
   * Must be called inside the animation frame that drew it: without
   * `preserveDrawingBuffer` the backbuffer is valid only until the compositor
   * takes it, and reading later returns a cleared — that is, black — buffer,
   * which would make the watchdog report the very bug it is looking for.
   */
  sample() {
    try {
      this._ctx.drawImage(this.canvas, 0, 0, this._sampler.width, this._sampler.height);
      const { data } = this._ctx.getImageData(0, 0, this._sampler.width, this._sampler.height);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      }
      return sum / (data.length / 4);
    } catch {
      return null;
    }
  }

  /**
   * Called every frame from inside the render loop. `context` describes what
   * the game believes it is drawing, which is what makes the diagnosis
   * possible: a dark frame with the torch off is a game working correctly.
   *
   * The clock is wall time, deliberately not the frame loop's delta. That
   * delta is clamped so a stalled tab cannot teleport the creature across the
   * level, which means on a struggling device it runs slower than real time —
   * and a watchdog that waits longer the worse things get is a watchdog that
   * never fires on precisely the hardware it was written for.
   */
  update(context) {
    if (this.stage > 2) return;
    this._frames++;
    const now = performance.now();
    if (!this._since) this._since = now;
    if (now - this._since < GRACE_MS || this._frames < GRACE_FRAMES) return;
    this._since = now;

    const brightness = this.sample();
    this.lastBrightness = brightness;
    if (brightness === null) {
      // Cannot read the canvas — say nothing rather than guess.
      this.stage = 3;
      return;
    }
    if (brightness > BLACK_THRESHOLD) {
      this.stage = 3; // Drawing something. Stand down for good.
      return;
    }

    this.stage++;
    this.#act(context);
  }

  /**
   * Everything known about what the renderer is doing, in fields a player can
   * read down a phone screen and out loud. This is the payload of the whole
   * exercise: not the fallbacks, but the fact that somebody two thousand miles
   * away can now answer "which backend, how many draw calls, what size".
   */
  describe(context = {}) {
    const info = this.renderer.renderer?.info?.render;
    return {
      build: this.renderer.build ?? '?',
      backend: this.renderer.forceWebGL ? 'WebGL' : 'WebGPU',
      gpu: this.renderer.gpuName ?? '?',
      safeMode: this.renderer.safeMode ? 'on' : 'off',
      post: this.renderer.post?.bypassed ? 'bypassed' : 'on',
      brightness: this.lastBrightness === null
        ? 'unreadable' : this.lastBrightness.toFixed(2),
      drawCalls: info?.drawCalls ?? '?',
      triangles: info?.triangles ?? '?',
      canvas: `${this.canvas.width}×${this.canvas.height}`,
      torch: context.torchOn === undefined ? '?' : (context.torchOn ? 'on' : 'OFF'),
      lost: this.renderer.deviceLost ?? null,
    };
  }

  /** Open the panel because the player asked, not because anything is wrong. */
  showManual(context) {
    this.hud?.showDiagnostic('Renderer', this.describe(context), [
      ...this.#escapes(),
      { label: 'CLOSE', quiet: true, run: () => this.hud.hideDiagnostic() },
    ]);
  }

  #act(context) {
    const detail = this.describe(context);

    // 1. The cheapest explanation, and by far the most common: the light is
    //    off. That is the game working, not failing.
    if (this.stage === 1 && !context.torchOn) {
      this.hud?.objective('Your torch is off. Press F — or the TORCH button.', 6);
      return;
    }

    // 2. Nothing was submitted. That is a scene problem, not a driver one, and
    //    no amount of changing the pipeline will help.
    if (this.stage === 1 && detail.drawCalls === 0) {
      this.#surface('Nothing is being drawn.', detail);
      this.stage = 3;
      return;
    }

    // 3. Geometry went in and black came out. The post chain is the part most
    //    likely to have failed to compile on an unusual driver, and it is the
    //    only part the game can drop and keep running.
    if (this.stage === 1 && this.renderer.post && !this.renderer.post.bypassed) {
      this.renderer.post.bypass(true);
      this.hud?.objective('Graphics trouble — dropping effects.', 5);
      console.warn('watchdog: black frame, bypassing post-processing', detail);
      return;
    }

    // 4. Still black with the post chain out of the way. Out of moves inside
    //    this process — but not out of options, because safe mode and the
    //    other backend are both still on the table. Either needs a reload, so
    //    it is the player's call rather than something that yanks the run out
    //    from under them.
    this.#surface('The scene is not rendering.', detail);
    this.stage = 3;
  }

  /** Reload with a query parameter set. Both escapes below are the same move. */
  static #reloadWith(key, value) {
    try {
      const url = new URL(location.href);
      url.searchParams.set(key, value);
      location.replace(url);
    } catch {
      // Sandboxed frame that will not hand over its own URL.
      location.reload();
    }
  }

  /**
   * The things left to try, cheapest first.
   *
   * Safe mode comes first because it is the smaller loss: it drops the post
   * chain and the shadows — a dozen TSL nodes compiled into one shader, and a
   * depth pass with a float target, which between them are most of what a
   * driver can refuse — and keeps the game. Swapping backends is the bigger
   * hammer and only worth offering when there is another backend to swap to.
   */
  #escapes() {
    const out = [];
    if (!this.renderer.safeMode) {
      out.push({
        label: 'SAFE MODE — NO EFFECTS OR SHADOWS',
        run: () => RenderWatchdog.#reloadWith('safe', '1'),
      });
    }
    if (this.renderer.forceWebGL) {
      if (navigator.gpu) {
        out.push({
          label: 'TRY THE WEBGPU RENDERER',
          run: () => RenderWatchdog.#reloadWith('backend', 'webgpu'),
        });
      }
    } else {
      out.push({
        label: 'TRY THE WEBGL RENDERER',
        run: () => RenderWatchdog.#reloadWith('backend', 'webgl'),
      });
    }
    return out;
  }

  #surface(headline, detail) {
    this.report = { headline, detail };
    console.error('watchdog:', headline, detail);
    this.hud?.showDiagnostic(headline, detail, this.#escapes());
  }
}
