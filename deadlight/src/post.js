// Post-processing, written in TSL and executed on WebGPU.
//
// The chain has two jobs. Most of the time it is doing camcorder work — a
// little bloom, a little aberration, grain, a heavy vignette — which is what
// makes torchlight in a concrete corridor look like footage rather than like a
// render. The rest of the time it is being violently abused by the scare
// director, and every knob it exposes is there to be turned to eleven for
// about four hundred milliseconds.
//
// All of the scare parameters rest at zero, so the quiet state costs the same
// as the loud one and there is no hitch when a scare fires.

import { RenderPipeline } from 'three/webgpu';
import {
  Fn, clamp, float, fract, luminance, max, mix, pass, rand, time, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

export class Post {
  constructor(renderer, scene, camera, quality = { bloom: true }) {
    // Every scare parameter, in one place. `.value` is written directly by
    // the director each frame.
    this.params = {
      /** Barrel distortion. Negative pinches, positive bulges. */
      distort: uniform(0),
      /** RGB split, in screen widths. */
      aberration: uniform(0.0016),
      /** Full-frame grain. */
      grain: uniform(0.05),
      /** Blocky video static. */
      staticNoise: uniform(0),
      /** Pull toward greyscale. 1 = fully desaturated. */
      desaturate: uniform(0.15),
      /** Vignette weight. */
      vignette: uniform(0.55),
      /** Overall exposure, dropped as the torch dies. */
      exposure: uniform(1),
      /** Red wash on damage. */
      blood: uniform(0),
      /** Vertical roll offset, for the CRT-tearing scare. */
      tear: uniform(0),
    };

    const scenePass = pass(scene, camera);
    const colour = scenePass.getTextureNode();

    // Bloom on the torch hotspot and the practical lights only — a low
    // threshold here would fog the whole frame and destroy the blacks, which
    // are the only reason the dark reads as dark.
    //
    // It is also a mip pyramid and several extra full-screen passes, which is
    // the single most expensive thing in this chain. The phone tier drops it
    // and loses the halo around the torch: a real loss, and a better trade
    // than halving the frame rate.
    const glow = quality.bloom ? bloom(colour, 0.62, 0.72, 0.86) : null;

    const composite = Fn(() => {
      const centred = uv().sub(0.5);
      const r2 = centred.dot(centred);

      // Lens warp. Also used inverted, as a lurch, when something grabs you.
      const warped = centred.mul(float(1).add(r2.mul(this.params.distort))).add(0.5);

      // Roll the image vertically. Only ever non-zero during a glitch.
      const rolled = vec2(warped.x, fract(warped.y.add(this.params.tear)));

      // Aberration scaled by radius: none at the centre, worst at the corners,
      // which is how a real lens fails and keeps the crosshair readable.
      const split = centred.mul(this.params.aberration.mul(r2.mul(8).add(0.4)));

      const r = colour.sample(rolled.add(split)).r;
      const g = colour.sample(rolled).g;
      const b = colour.sample(rolled.sub(split)).b;
      let colour3 = vec3(r, g, b);
      if (glow) colour3 = colour3.add(glow.rgb);

      // Desaturate toward luminance.
      colour3 = mix(colour3, vec3(luminance(colour3)), this.params.desaturate);

      // Blood wash — multiplies rather than adds, so it darkens as it reddens
      // instead of blowing the frame out to pink.
      colour3 = mix(colour3, colour3.mul(vec3(1.25, 0.16, 0.16)), this.params.blood);

      // Grain, and blocky static for signal-loss moments. Both are driven off
      // `time` so they animate without a per-frame upload.
      //
      // Weighted by local brightness rather than applied flat. The tone curve
      // below has a steep toe, so flat grain in the shadows gets amplified
      // into visible static across the ninety per cent of this game that is
      // shadow — the floor of 0.18 keeps some texture in the blacks without
      // turning them into a snowstorm.
      const grain = rand(uv().add(vec2(time.mul(1.37), time.mul(0.71)))).sub(0.5);
      const grainWeight = luminance(colour3).mul(2.2).add(0.18).clamp(0, 1.2);
      colour3 = colour3.add(grain.mul(this.params.grain).mul(grainWeight));

      const block = uv().mul(vec2(64, 42)).floor().div(vec2(64, 42));
      const blocky = rand(block.add(time.mul(11).floor().mul(0.017)));
      colour3 = mix(colour3, vec3(blocky), this.params.staticNoise);

      // Vignette. Deliberately strong — it is the frame of the whole game.
      const dark = clamp(float(1).sub(r2.mul(2.6).mul(this.params.vignette)), 0, 1);
      colour3 = colour3.mul(dark);

      colour3 = colour3.mul(this.params.exposure);

      // Filmic-ish shoulder. Keeps the torch hotspot from clipping to a white
      // disc while leaving the shadows alone.
      const toned = colour3.div(colour3.add(vec3(0.86))).mul(1.35);

      return vec4(max(toned, vec3(0)), 1);
    });

    this.pipeline = new RenderPipeline(renderer);
    this.pipeline.outputNode = composite();
    this.scenePass = scenePass;
  }

  render() {
    // Synchronous: the device was brought up by Renderer#init before any
    // frame runs, so the async variant would only add a promise per frame.
    this.pipeline.render();
  }

  /** Reset every scare parameter to its resting value. */
  calm() {
    const p = this.params;
    p.distort.value = 0;
    p.aberration.value = 0.0016;
    p.grain.value = 0.05;
    p.staticNoise.value = 0;
    p.desaturate.value = 0.15;
    p.vignette.value = 0.55;
    p.exposure.value = 1;
    p.blood.value = 0;
    p.tear.value = 0;
  }

  /**
   * Ease every parameter back toward rest.
   *
   * Called each frame; the director stamps values on top and this pulls them
   * down, so a scare is a spike with a tail rather than a state that has to be
   * explicitly cleared. Anything the director forgets to reset recovers on its
   * own within a second.
   */
  decay(dt, tension = 0) {
    const p = this.params;
    const k = Math.min(1, dt * 3.4);
    const toward = (u, rest) => { u.value += (rest - u.value) * k; };

    toward(p.distort, 0);
    toward(p.staticNoise, 0);
    toward(p.blood, 0);
    toward(p.tear, 0);
    // The resting values themselves lean harder as the run gets worse: the
    // frame tightens and the colour drains long before anything jumps out.
    toward(p.aberration, 0.0016 + tension * 0.004);
    toward(p.grain, 0.05 + tension * 0.055);
    toward(p.desaturate, 0.15 + tension * 0.3);
    toward(p.vignette, 0.55 + tension * 0.35);
  }

  setSize(width, height) {
    this.scenePass.setSize?.(width, height);
  }
}
