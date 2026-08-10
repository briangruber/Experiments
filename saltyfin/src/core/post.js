// Post: threshold, a small mip pyramid of blurs, then a composite that does the
// tonemap, the grade and the vignette in one pass.
//
// Same algorithm and the same tuning as the WebGL build, rewritten as TSL node
// graphs. The bloom is the Unreal-style downsample/upsample chain rather than a
// single wide gaussian, because the thing it has to sell is a lantern and a row
// of village windows at night — small, very bright, and they need a long soft
// falloff without an obvious kernel edge.
//
// Each pass is one QuadMesh whose material is a NodeMaterial with a fragment
// node. The source texture of a pass changes between mip levels, so every pass
// keeps a TextureNode and swaps its `.value` — that is a uniform rebind, not a
// recompile.

import * as THREE from 'three';
import {
  Fn, texture, uniform, uv, vec2, vec3, vec4, float,
  max, min, clamp, mix, pow, dot, step, smoothstep, fract, screenCoordinate, textureSize,
} from 'three/tsl';
import { createUnderwaterFx } from '../water/underwaterFx.js';

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** Interleaved gradient noise — the good cheap dither. */
const ign = Fn(([p]) => fract(
  float(52.9829189).mul(fract(dot(p, vec2(0.06711056, 0.00583715)))),
));

/** ACES, softened at the shoulder so a saturated sunset does not go white. */
const tonemapFilmic = Fn(([x]) => {
  const c = max(x, vec3(0)).toVar();
  const a = c.mul(c.mul(2.51).add(0.03));
  const b = c.mul(c.mul(2.43).add(0.59)).add(0.14);
  const aces = clamp(a.div(b), 0, 1);
  const l = dot(c, LUMA);
  const reinhard = c.div(l.add(1));
  return mix(aces, reinhard, 0.25);
});

const linearToSrgb = Fn(([c]) => mix(
  c.mul(12.92),
  pow(max(c, vec3(1e-5)), vec3(1 / 2.4)).mul(1.055).sub(0.055),
  step(vec3(0.0031308), c),
));

export function createPost({ renderer, targets, makeTarget, quality }) {
  // The water column, its extinction, its caustics and its god rays, as a
  // screen-space term over the beauty buffer. It lives here rather than as a
  // pass of its own because it has to SAMPLE targets.scene.depthTexture, and
  // WebGPU will not let a texture be a render attachment and a sampled
  // resource at the same time — so it cannot be drawn back into the target it
  // reads. The two passes below already read that target while it is unbound.
  // See water/underwaterFx.js.
  const underwaterFx = createUnderwaterFx({ targets, quality });
  const quad = new THREE.QuadMesh();

  const mat = () => {
    const m = new THREE.NodeMaterial();
    m.depthTest = false;
    m.depthWrite = false;
    return m;
  };

  // --- threshold -----------------------------------------------------------
  const thrSrc = texture(targets.scene.texture);
  const uThreshold = uniform(1.0);
  const uSoftKnee = uniform(0.6);
  const uExposureThr = uniform(1.0);
  const thresholdMat = mat();
  thresholdMat.fragmentNode = Fn(() => {
    const tuv = uv().toVar();
    // The water goes on BEFORE the bright pass, so the shafts and the caustic
    // highlights are what bloom. Doing it only in the composite would give a
    // frame whose brightest feature is the one thing with no glow on it.
    // Half the marching steps: this buffer is a quarter of the pixels and
    // everything drawn from it is about to be blurred six times.
    const c = underwaterFx.apply(thrSrc.sample(tuv).rgb, tuv, Math.max(5, underwaterFx.steps >> 1))
      .mul(uExposureThr).toVar();
    const l = max(max(c.r, c.g), c.b).toVar();
    const knee = uThreshold.mul(uSoftKnee).add(1e-5).toVar();
    const soft = clamp(l.sub(uThreshold).add(knee), 0, knee.mul(2)).toVar();
    soft.assign(soft.mul(soft).div(knee.mul(4)));
    const w = max(soft, l.sub(uThreshold)).div(max(l, 1e-5));
    return vec4(c.mul(w), 1);
  })();

  // --- the mip chain --------------------------------------------------------
  //
  // Every level gets its OWN material, with its source texture and its texel
  // size baked into the graph. The obvious shape — one downsample material
  // whose texture node and texel uniform are re-pointed between levels — does
  // not work on the node renderer: state changed between draws inside a single
  // frame does not reach the passes, so every level ended up blurring with the
  // same texel and the pyramid kept its energy instead of spreading it, which
  // at night turned the moon path into a floodlight. A dozen small materials
  // cost nothing and remove the whole class of problem.

  const uUpRadius = uniform(1.0);
  let downMats = [];
  let upMats = [];

  // The texel size is a uniform, not a number folded into the graph. It was
  // `vec2(1 / w, 1 / h)` written straight into the shader, which meant a resize
  // could only be served by building new materials — and a new material is a
  // new node graph, a new WGSL module and a synchronous
  // device.createRenderPipeline apiece. Measured on this scene: 11 pipelines,
  // 11 node builds, 14 programs and 79 kB of regenerated shader source per
  // window resize, every time, forever. iOS Safari fires a resize every time
  // the URL bar collapses.
  const makeDownMat = (srcTex, w, h) => {
    const src = texture(srcTex);
    const m = mat();
    const t = uniform(new THREE.Vector2(1 / w, 1 / h));
    m.texel = t;
    m.fragmentNode = Fn(() => {
      const at = (x, y) => src.sample(uv().add(t.mul(vec2(x, y)))).rgb;
      // 13-tap Karis-weighted downsample: no fireflies, no aliasing crawl.
      const a = at(-2, 2), b = at(0, 2), c = at(2, 2);
      const d = at(-2, 0), e = at(0, 0), f = at(2, 0);
      const g = at(-2, -2), h2 = at(0, -2), i = at(2, -2);
      const j = at(-1, 1), k = at(1, 1), l = at(-1, -1), n = at(1, -1);
      return vec4(
        e.mul(0.125)
          .add(a.add(c).add(g).add(i).mul(0.03125))
          .add(b.add(d).add(f).add(h2).mul(0.0625))
          .add(j.add(k).add(l).add(n).mul(0.125)),
        1,
      );
    })();
    return m;
  };

  const makeUpMat = (srcTex, prevTex, w, h) => {
    const src = texture(srcTex);
    const prev = texture(prevTex);
    const m = mat();
    const t = uniform(new THREE.Vector2(1 / w, 1 / h));
    m.texel = t;
    m.fragmentNode = Fn(() => {
      const r = t.mul(uUpRadius).toVar();
      const at = (x, y) => src.sample(uv().add(vec2(r.x.mul(x), r.y.mul(y)))).rgb;
      // Tent filter, accumulating the level below as it walks back up.
      const s2 = at(-1, 1).add(at(0, 1).mul(2)).add(at(1, 1))
        .add(at(-1, 0).mul(2)).add(at(0, 0).mul(4)).add(at(1, 0).mul(2))
        .add(at(-1, -1)).add(at(0, -1).mul(2)).add(at(1, -1));
      return vec4(s2.div(16).add(prev.sample(uv()).rgb), 1);
    })();
    return m;
  };

  // --- composite: chroma, bloom, tonemap, grade, vignette, dither ----------
  const compScene = texture(targets.scene.texture);
  const compBloom = texture(targets.scene.texture);
  const uExposure = uniform(1.0);
  const uBloomStrength = uniform(0.4);
  const uSaturation = uniform(1.1);
  const uContrast = uniform(1.05);
  const uVignette = uniform(0.25);
  const uGrain = uniform(0.012);
  const uTime = uniform(0.0);
  const uLift = uniform(new THREE.Vector3(0, 0, 0));
  const uGain = uniform(new THREE.Vector3(1, 1, 1));
  const uUnderwater = uniform(0.0);
  const uUnderwaterTint = uniform(new THREE.Vector3(0.2, 0.6, 0.8));
  const uChroma = uniform(1.6);
  const uResolution = uniform(new THREE.Vector2(1280, 720));

  // `?post=bloom` shows the bloom buffer on its own. Cheaper than guessing why
  // a chain like this is hot.
  const DEBUG = new URLSearchParams(location.search).get('post');

  const compositeMat = mat();
  compositeMat.fragmentNode = Fn(() => {
    if (DEBUG === 'bloom') return vec4(compBloom.sample(uv()).rgb, 1);
    const suv = uv().toVar();
    const c2 = suv.sub(0.5).toVar();
    const r2 = dot(c2, c2).toVar();

    // A hair of lateral chromatic aberration at the frame edge. The uniform is
    // in pixels at the very corner, not in UV: c2*r2 peaks around 0.25, so a UV
    // offset that looks tiny is in fact twenty pixels wide.
    const off = c2.mul(r2).mul(uChroma.mul(4).div(uResolution)).toVar();
    const col = vec3(
      compScene.sample(suv.sub(off)).r,
      compScene.sample(suv).g,
      compScene.sample(suv.add(off)).b,
    ).toVar();

    // A `?uw=` debug view returns here, before the tonemap and the grade, so
    // what lands in the canvas is the number the pass computed rather than a
    // graded picture of it. Reading a value off a screenshot is the only way
    // to check a depth reconstruction, and it has to be the raw value.
    if (underwaterFx.debug) return vec4(underwaterFx.apply(col, suv), 1);
    col.assign(underwaterFx.apply(col, suv));
    col.mulAssign(uExposure);
    col.addAssign(compBloom.sample(suv).rgb.mul(uBloomStrength));

    // Under the surface: a HUE shift and a lifted floor, not an exposure cut.
    //
    // This used to multiply the frame by the water's body colour at 0.85, which
    // is a filter over a scene still lit as though it were in air. It was doing
    // the whole job on its own and doing it wrongly — a dark blue times an
    // unchanged image is a dark image, and everything below the boat came back
    // near-black with a blue cast. world/underwater.js now does the physical
    // part (fog, key falloff, ambient lift), so this only has to finish the
    // look. Normalising the tint by its own maximum channel is what makes it a
    // shift rather than a dimmer: the brightest channel passes at 1.0 and only
    // red is pulled down, which is exactly what water does to the spectrum.
    const wt = uUnderwaterTint.div(max(max(uUnderwaterTint.r, uUnderwaterTint.g),
      max(uUnderwaterTint.b, 1e-3))).toVar();
    col.assign(mix(col, col.mul(mix(vec3(1.0), wt, 0.80)), uUnderwater.mul(0.55)));
    // The floor lift is the water between the eye and the subject glowing. It
    // is what stops the shadows going to true black, which never happens in
    // daylight under two metres of anything.
    col.addAssign(uUnderwaterTint.mul(uUnderwater).mul(0.10));

    col.assign(tonemapFilmic(col));

    // Grade in display-referred space: lift/gain then contrast around 0.5.
    col.assign(col.mul(uGain).add(uLift.mul(col.oneMinus())));
    col.assign(col.sub(0.5).mul(uContrast).add(0.5));
    col.assign(mix(vec3(dot(col, LUMA)), col, uSaturation));
    col.assign(max(col, vec3(0)));

    col.mulAssign(uVignette.mul(smoothstep(0.15, 0.85, r2.mul(2))).oneMinus());
    col.assign(linearToSrgb(col));
    col.addAssign(
      ign(screenCoordinate.xy.add(fract(uTime).mul(137))).sub(0.5)
        .mul(uGrain.add(1 / 255)),
    );
    return vec4(col, 1);
  })();

  // --- debug: show one pass's render target --------------------------------
  //
  // `?show=reflection|refraction|scene` blits the named target over the finished
  // frame. Same precedent as `?post=bloom` above — a URL flag read once, and
  // when it is absent nothing here runs and nothing else changes.
  //
  // It exists because the reflection pass is otherwise unlookable-at: it renders
  // through a camera mirrored in y=0 and its only consumer is a projective
  // sample buried in the water shader, so anything wrong in it arrives as a
  // smear on the water with no way to tell what drew it. Showing the target
  // answers that directly.
  //
  // The U flip is not cosmetic. water/waterMaterial.js samples this target as
  // `tReflection.sample(vec2(rv.x.oneMinus(), rv.y))`, because mirroring the
  // camera flips the winding and main.js negates the projection's X row to flip
  // it back. `?show=reflection` applies the same flip, so what is on screen is
  // in the orientation the water reads it in.
  //
  // Uniform-driven, one draw, its own material: it cannot perturb the passes it
  // is meant to be reporting on.
  const SHOW = new URLSearchParams(location.search).get('show');
  const showSrc = texture(targets.scene.texture);
  const uShowFlipU = uniform(0);
  const uShowExposure = uniform(1);
  const showMat = mat();
  showMat.fragmentNode = Fn(() => {
    const suv = uv().toVar();
    suv.x.assign(mix(suv.x, suv.x.oneMinus(), uShowFlipU));
    // The targets are half-float and linear, so tonemap and encode exactly as
    // the composite does — otherwise a debug view of an HDR sky is solid white
    // and reads as a broken pass.
    const col = showSrc.sample(suv).rgb.mul(uShowExposure).toVar();
    col.assign(tonemapFilmic(col));
    return vec4(linearToSrgb(col), 1);
  })();

  const LEVELS = 6;
  let chain = [];

  /** The mip pyramid's dimensions for a given canvas size. Shape only. */
  function levelSizes(w, h) {
    const out = [];
    let lw = w, lh = h;
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(2, lw >> 1); lh = Math.max(2, lh >> 1);
      out.push({ w: lw, h: lh });
      if (lw <= 4 || lh <= 4) break;
    }
    return out;
  }

  function resize(w, h) {
    const sizes = levelSizes(w, h);
    uResolution.value.set(w, h);

    // The common case, and the only one iOS produces in normal use: the canvas
    // changed size but the pyramid still has the same number of levels. Resize
    // the targets in place and move the texel uniforms. Nothing is disposed, so
    // no material is rebuilt, so no WGSL is regenerated and no pipeline is
    // created. RenderTarget.setSize keeps the same Texture instances, so every
    // texture() node in the chain stays bound to the thing it was bound to.
    if (chain.length === sizes.length) {
      for (let i = 0; i < sizes.length; i++) {
        const l = chain[i];
        l.down.setSize(sizes[i].w, sizes[i].h);
        l.up.setSize(sizes[i].w, sizes[i].h);
        l.w = sizes[i].w; l.h = sizes[i].h;
      }
      for (let i = 1; i < chain.length; i++) {
        downMats[i].texel.value.set(1 / chain[i - 1].w, 1 / chain[i - 1].h);
      }
      const last = chain.length - 1;
      upMats[last].texel.value.set(1 / chain[last].w, 1 / chain[last].h);
      for (let i = last - 1; i >= 0; i--) {
        upMats[i].texel.value.set(1 / chain[i + 1].w, 1 / chain[i + 1].h);
      }
      thrSrc.value = targets.scene.texture;
      compScene.value = targets.scene.texture;
      compBloom.value = chain[0].up.texture;
      if (SHOW && targets[SHOW]) showSrc.value = targets[SHOW].texture;
      return;
    }

    // Level count changed (first call, or a viewport small enough to lose a
    // level). Only here do the materials have to be built again.
    for (const l of chain) { l.down.dispose(); l.up.dispose(); }
    for (const m of downMats) if (m) m.dispose();
    for (const m of upMats) if (m) m.dispose();
    chain = []; downMats = []; upMats = [];
    for (const s of sizes) {
      chain.push({
        down: makeTarget(s.w, s.h, { depth: false }),
        up: makeTarget(s.w, s.h, { depth: false }),
        w: s.w, h: s.h,
      });
    }

    // One material per level, every binding baked in.
    for (let i = 1; i < chain.length; i++) {
      downMats[i] = makeDownMat(chain[i - 1].down.texture, chain[i - 1].w, chain[i - 1].h);
    }
    const last = chain.length - 1;
    upMats[last] = makeUpMat(chain[last].down.texture, chain[last].down.texture, chain[last].w, chain[last].h);
    for (let i = last - 1; i >= 0; i--) {
      upMats[i] = makeUpMat(chain[i + 1].up.texture, chain[i].down.texture, chain[i + 1].w, chain[i + 1].h);
    }
    thrSrc.value = targets.scene.texture;
    compScene.value = targets.scene.texture;
    compBloom.value = chain[0].up.texture;
    underwaterFx.setTargets(targets);
    // Rebound here rather than per frame: a target's texture can be replaced by
    // setSize, and nothing that changes between draws inside one frame reaches
    // the passes anyway (see the mip chain above).
    if (SHOW && targets[SHOW]) showSrc.value = targets[SHOW].texture;
  }

  function draw(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target ?? null);
    // autoClear, never renderer.clear(): a manual clear on this renderer left
    // the pass writing somewhere other than the target it had just been given,
    // and on tile-based GPUs a folded clear is also cheaper than loading the
    // old contents only to overwrite every texel.
    renderer.autoClear = true;
    quad.render(renderer);
    renderer.autoClear = false;
  }

  function render(env, { time = 0, underwater = 0, underwaterTint = null } = {}) {
    uThreshold.value = env.bloomThreshold;
    uExposureThr.value = env.exposure;
    uUpRadius.value = env.bloomRadius * 2.0 + 0.5;
    draw(thresholdMat, chain[0].down);

    for (let i = 1; i < chain.length; i++) draw(downMats[i], chain[i].down);
    for (let i = chain.length - 1; i >= 0; i--) draw(upMats[i], chain[i].up);

    uExposure.value = env.exposure;
    uBloomStrength.value = env.bloomStrength;
    uSaturation.value = env.saturation;
    uContrast.value = env.contrast;
    uVignette.value = env.vignette;
    uGrain.value = env.grainStrength;
    uTime.value = time;
    uUnderwater.value = underwater;
    if (underwaterTint) uUnderwaterTint.value.set(underwaterTint.r, underwaterTint.g, underwaterTint.b);
    uLift.value.set(env.lift.r, env.lift.g, env.lift.b);
    uGain.value.set(env.gain.r, env.gain.g, env.gain.b);

    draw(compositeMat, null);
  }

  /**
   * `?show=…` debug blit. Call it after the frame is otherwise finished — and,
   * under `?capture=1`, before main.js mirrors the canvas. Returns true when it
   * drew, i.e. when the canvas no longer holds the composited image.
   */
  function showDebugTarget(env) {
    if (!SHOW || !targets[SHOW]) return false;
    uShowFlipU.value = SHOW === 'reflection' ? 1 : 0;
    uShowExposure.value = env?.exposure ?? 1;
    draw(showMat, null);
    return true;
  }

  function dispose() {
    for (const l of chain) { l.down.dispose(); l.up.dispose(); }
    for (const m of downMats) if (m) m.dispose();
    for (const m of upMats) m.dispose();
    thresholdMat.dispose(); compositeMat.dispose(); showMat.dispose();
  }

  return {
    resize, render, dispose, showDebugTarget, showing: SHOW,
    underwater: underwaterFx,
    materials: { compositeMat },
  };
}
