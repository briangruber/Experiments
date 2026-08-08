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

export function createPost({ renderer, targets, makeTarget }) {
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
    const c = thrSrc.sample(uv()).rgb.mul(uExposureThr).toVar();
    const l = max(max(c.r, c.g), c.b).toVar();
    const knee = uThreshold.mul(uSoftKnee).add(1e-5).toVar();
    const soft = clamp(l.sub(uThreshold).add(knee), 0, knee.mul(2)).toVar();
    soft.assign(soft.mul(soft).div(knee.mul(4)));
    const w = max(soft, l.sub(uThreshold)).div(max(l, 1e-5));
    return vec4(c.mul(w), 1);
  })();

  // --- downsample: 13-tap Karis, no fireflies, no aliasing crawl -----------
  const downSrc = texture(targets.scene.texture);
  const downMat = mat();
  downMat.fragmentNode = Fn(() => {
    const t = vec2(1, 1).div(vec2(textureSize(downSrc, 0))).toVar();
    const at = (x, y) => downSrc.sample(uv().add(t.mul(vec2(x, y)))).rgb;
    const a = at(-2, 2), b = at(0, 2), c = at(2, 2);
    const d = at(-2, 0), e = at(0, 0), f = at(2, 0);
    const g = at(-2, -2), h = at(0, -2), i = at(2, -2);
    const j = at(-1, 1), k = at(1, 1), l = at(-1, -1), m = at(1, -1);
    const o = e.mul(0.125)
      .add(a.add(c).add(g).add(i).mul(0.03125))
      .add(b.add(d).add(f).add(h).mul(0.0625))
      .add(j.add(k).add(l).add(m).mul(0.125));
    return vec4(o, 1);
  })();

  // --- upsample: tent filter, accumulating down the pyramid ----------------
  const upSrc = texture(targets.scene.texture);
  const upPrev = texture(targets.scene.texture);
  const uUpRadius = uniform(1.0);
  const upMat = mat();
  upMat.fragmentNode = Fn(() => {
    const r = vec2(1, 1).div(vec2(textureSize(upSrc, 0))).mul(uUpRadius).toVar();
    const at = (x, y) => upSrc.sample(uv().add(vec2(r.x.mul(x), r.y.mul(y)))).rgb;
    const s = at(-1, 1).add(at(0, 1).mul(2)).add(at(1, 1))
      .add(at(-1, 0).mul(2)).add(at(0, 0).mul(4)).add(at(1, 0).mul(2))
      .add(at(-1, -1)).add(at(0, -1).mul(2)).add(at(1, -1));
    return vec4(s.div(16).add(upPrev.sample(uv()).rgb), 1);
  })();

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

  // `?post=bloom` shows the bloom buffer on its own, `?post=threshold` the
  // thresholded frame. Cheaper than guessing why a chain like this is hot.
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

    col.mulAssign(uExposure);
    col.addAssign(compBloom.sample(suv).rgb.mul(uBloomStrength));

    // Under the surface, tint toward the water body colour and lift the floor.
    col.assign(mix(col, col.mul(uUnderwaterTint), uUnderwater.mul(0.85)));
    col.addAssign(uUnderwaterTint.mul(uUnderwater).mul(0.05));

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

  const LEVELS = 6;
  let chain = [];

  function resize(w, h) {
    for (const l of chain) { l.down.dispose(); l.up.dispose(); }
    chain = [];
    let lw = w, lh = h;
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(2, lw >> 1); lh = Math.max(2, lh >> 1);
      chain.push({
        down: makeTarget(lw, lh, { depth: false }),
        up: makeTarget(lw, lh, { depth: false }),
        w: lw, h: lh,
      });
      if (lw <= 4 || lh <= 4) break;
    }
    uResolution.value.set(w, h);
  }

  function draw(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target ?? null);
    // No explicit clear: the quad covers the whole target and writes every
    // texel, and on the node renderer a clear between setRenderTarget and the
    // draw was leaving the pass writing somewhere other than the target it had
    // just been given.
    quad.render(renderer);
  }

  function render(env, { time = 0, underwater = 0, underwaterTint = null } = {}) {
    thrSrc.value = targets.scene.texture;
    uThreshold.value = env.bloomThreshold;
    uExposureThr.value = env.exposure;
    draw(thresholdMat, chain[0].down);

    for (let i = 1; i < chain.length; i++) {
      downSrc.value = chain[i - 1].down.texture;
      draw(downMat, chain[i].down);
    }

    const last = chain.length - 1;
    uUpRadius.value = env.bloomRadius * 2.0 + 0.5;
    // Seed the top of the pyramid with itself, then walk down accumulating.
    upSrc.value = chain[last].down.texture;
    upPrev.value = chain[last].down.texture;
    draw(upMat, chain[last].up);

    for (let i = last - 1; i >= 0; i--) {
      upSrc.value = chain[i + 1].up.texture;
      upPrev.value = chain[i].down.texture;
      draw(upMat, chain[i].up);
    }

    compScene.value = targets.scene.texture;
    compBloom.value = chain[0].up.texture;
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

  function dispose() {
    for (const l of chain) { l.down.dispose(); l.up.dispose(); }
    thresholdMat.dispose(); downMat.dispose(); upMat.dispose(); compositeMat.dispose();
  }

  return { resize, render, dispose, materials: { compositeMat } };
}
