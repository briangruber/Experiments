// What the water does to the image, once the eye is inside it.
//
// This is a screen-space pass over the finished beauty buffer, and it exists
// because three separate things that make an underwater shot READ as underwater
// cannot be done by any of the machinery already here:
//
//   1. THE COLUMN. Look sideways into open water and there is no geometry — so
//      the beauty pass draws the SKY, and the frame comes back a flat bright
//      cyan with a hard band across it where the far water surface catches the
//      horizon. What should be there is water: bright near the ceiling, dark
//      going down, and dense enough at thirty metres to be a wall. Nothing that
//      shades a surface can paint that, because there is no surface.
//   2. EXTINCTION, per channel. THREE.Fog is a linear ramp to one colour, which
//      is exactly the wrong shape — water eats red at about 0.46 per metre and
//      blue at 0.07, so the SEPARATION between the channels with distance is
//      the whole cue. exp(-sigma*d) per channel gives it for free.
//   3. GOD RAYS, properly. A shaft of light underwater is not a generic sun
//      beam: it is the CAUSTIC PATTERN of the surface projected into a
//      scattering medium. The same tiling caustic texture the seabed already
//      gets is what the rays are made of, so they writhe with the same
//      wavelets, and marching the view ray against it puts them behind
//      geometry, through gaps in the reef, and nowhere the surface is calm.
//      The previous attempt was seven additive quads hung in front of the
//      camera; they depth-tested against the reef and were never once visible.
//
// It also does surface caustics, which fall out of the same projection for one
// extra sample: the dapple on the sand, the boat's hull and every fish.
//
// WHERE IT RUNS. Inside post.js, on the two passes that read the beauty target:
// the bloom threshold (so the rays bloom) and the composite (the final image).
// It cannot be its own pass drawn back into the beauty target, because that
// target's depth texture is attached while it is bound and WebGPU will not let
// a texture be a render attachment and a sampled resource at once.
//
// THE RAY. No inverse projection matrix and no NDC-convention guesswork: the
// four frustum corner directions are computed on the CPU each frame, scaled so
// that world = cameraPosition + ray * (metres along the camera's forward axis),
// and the fragment bilerps them. `?uw=depth`, `?uw=rays`, `?uw=caustic` and
// `?uw=off` exist to check each piece on its own.

import * as THREE from 'three';
import {
  Fn, texture, textureLevel, uniform, uv, vec2, vec3, vec4, float,
  max, min, mix, pow, dot, exp, smoothstep, fract, sin, floor, clamp, log2, step,
  normalize, length, cross, dFdx, dFdy, If, select, saturate, sign, screenCoordinate,
} from 'three/tsl';

const DEBUG = new URLSearchParams(location.search).get('uw');

// How far along the view ray shafts are gathered. Past this the medium has
// eaten them anyway (exp(-0.108 * 40) = 1.3%), and every extra metre costs
// resolution in the steps that matter, which are the near ones.
const SHAFT_RANGE = 42;

// Henyey-Greenstein anisotropy. Sea water's real phase function is far spikier
// than any single HG lobe — Petzold's measurements have an asymmetry parameter
// around 0.92 — but a lobe that tight puts all the light within a few degrees
// of the sun and the shafts vanish the moment you look off it. 0.66 keeps a
// strong forward bias while leaving the beams visible across a wide framing,
// which is the useful lie.
const HG_G = 0.66;

/**
 * One instance, shared by every pass that wants it.
 *
 * `apply(colorNode, uvNode, steps)` returns a node: the colour with the water
 * put back in front of it. Call it from a fragment node that has just sampled
 * the beauty buffer.
 */
export function createUnderwaterFx({ targets, quality } = {}) {
  // Each step is one texture fetch and a little ALU. The count buys the
  // smoothness of a beam's edge, not its existence — the dithered start offset
  // does most of that work — and it is affordable at all only because the march
  // is drawn once into a small buffer rather than twice at full resolution.
  const STEPS = Math.max(6, Math.round(quality?.shaftSteps ?? 20));

  // --- inputs --------------------------------------------------------------
  const blankDepth = new THREE.DepthTexture(1, 1, THREE.FloatType);
  blankDepth.needsUpdate = true;
  const tDepth = texture(targets?.scene?.depthTexture ?? blankDepth);

  const blankCaustic = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  blankCaustic.colorSpace = THREE.NoColorSpace;
  blankCaustic.needsUpdate = true;
  const tCaustic = texture(blankCaustic);

  const uAmount = uniform(0);
  const uNear = uniform(0.35);
  const uFar = uniform(6000);
  // The eye, as a uniform rather than TSL's `cameraPosition`.
  //
  // This pass runs on a QuadMesh, and a QuadMesh renders through its OWN
  // internal orthographic camera — so inside it `cameraPosition`, `cameraNear`
  // and `cameraFar` are the QUAD's, not the scene's. Every world position this
  // pass reconstructed was therefore relative to the origin, and every attempt
  // to linearise depth with three's `perspectiveDepthToViewZ(d, cameraNear,
  // cameraFar)` came back as zero. Nothing about that is visible in a
  // composited frame: the extinction still looked like extinction, because
  // distance is carried almost entirely by the depth sample and barely by the
  // rest. It cost three rounds of chasing normals and caustics before a probe
  // that read the reconstruction as NUMBERS against a CPU raycast found it.
  const uCamPos = uniform(new THREE.Vector3());
  const uRay00 = uniform(new THREE.Vector3(-1, -1, -1));
  const uRay10 = uniform(new THREE.Vector3(1, -1, -1));
  const uRay01 = uniform(new THREE.Vector3(-1, 1, -1));
  const uRay11 = uniform(new THREE.Vector3(1, 1, -1));

  const uSurfaceY = uniform(0);
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0));      // toward the sun
  const uSunColor = uniform(new THREE.Color(0xfff6e2));
  const uSunPower = uniform(1);

  // Per-metre extinction. Fed from the environment's own waterAbsorption, which
  // is already the right shape — 0.46 / 0.108 / 0.068 at noon is close to
  // Jerlov type I coastal water — plus a scattering term that does not vary
  // much with wavelength.
  const uSigma = uniform(new THREE.Vector3(0.46, 0.11, 0.07));

  // The colour of the column itself, near the ceiling and looking down into it.
  const uBodyNear = uniform(new THREE.Color(0x2fbfd0));
  const uBodyDeep = uniform(new THREE.Color(0x03304f));

  // --- the five artistic knobs ---------------------------------------------
  // Kept strictly separate from the env-derived uniforms above, which update()
  // rewrites every frame. Anything a capture wants to sweep has to live here or
  // the next frame stamps over it, which cost an afternoon the first time.
  // In-scattered radiance, not an albedo — but a bright one. The long path is
  // at the HORIZONTAL, so that is where the column colour is purest and where
  // any mismatch between it and the lit scene shows as a band along the eye
  // line. Too dark and that band is a dark stripe; at 0.42 the veil sits at
  // about the brightness of the water either side of it and stops reading as a
  // feature. The band is physically real — it is the longest sightline in the
  // frame — it just must not be the darkest thing in the shot.
  const uBodyGain = uniform(0.42);
  const uSigmaGain = uniform(0.38);  // how thick the water is, against physical
  const uShaft = uniform(4.0);
  const uShaftSharp = uniform(2.4);  // how narrow a beam is; the pow exponent
  const uCausticGain = uniform(1);
  const uCausticSharp = uniform(1.6);
  const uSunGlow = uniform(0.10);

  const uCausticScale = uniform(1 / 8.5);
  const uTime = uniform(0);
  const uMurk = uniform(1);          // scales the whole in-scatter, for night

  // --- helpers -------------------------------------------------------------

  // Window depth -> positive metres along the camera's forward axis.
  //
  // three's own node, not a hand-rolled one. waterMaterial.js has a local
  // version that does `ndc = d*2-1` and then the GL formula, which is correct
  // only for a [-1,1] clip range — WebGPU's is [0,1], and the two backends
  // therefore need different arithmetic. Rolling it by hand here produced a
  // `dist` that was tens of metres too large in the near field, which put the
  // shaft march's samples past everything and returned nothing. Letting three
  // supply the conversion means the backend difference is its problem.
  // Window depth [0,1] -> positive metres along the camera's forward axis.
  // The [0,1] form, not the [-1,1] one waterMaterial.js uses: a depth TEXTURE
  // stores the window value on both backends whatever the clip convention is,
  // and the near/far come in as uniforms written from the real camera.
  const linearZ = Fn(([d]) => uNear.mul(uFar).div(
    max(uFar.sub(uFar.sub(uNear).mul(d)), 1e-4),
  ));

  // Interleaved gradient noise — the same dither post.js uses for grain, and
  // the right one here: it decorrelates the march's start offset per pixel so
  // the steps show up as film grain rather than as concentric bands.
  const ign = Fn(([p]) => fract(
    float(52.9829189).mul(fract(dot(p, vec2(0.06711056, 0.00583715)))),
  ));

  /**
   * The caustic pattern arriving at a point in the water: trace from the point
   * up along the sun direction to the surface plane and read the tile there.
   *
   * Returns the light AND how far it travelled through water to get there, so
   * the caller can attenuate it — a shaft eight metres down is dimmer than the
   * same shaft at one metre, and that vertical falloff is most of what makes a
   * beam read as a beam instead of a stripe.
   */
  const causticAt = Fn(([P, lod]) => {
    const h = max(uSurfaceY.sub(P.y), 0.0).toVar();
    const up = max(uSunDir.y, 0.12).toVar();
    const travel = h.div(up).toVar();
    const S = P.add(uSunDir.mul(travel)).toVar();
    // Two octaves at an irrational ratio: one tile is 8.5 m and its repeat is
    // findable across a beam that is thirty metres long. Multiplying by a
    // second, longer tile breaks the lattice without a second animation.
    // x2.5 because caustics.js stores the field at 0.4 scale to keep headroom
    // in a byte target (caustics.js:96) — sampling it raw gives a signal whose
    // peak is 0.4, and any shaping curve applied to THAT crushes it to nothing.
    // The first version cubed the raw value and the whole shaft term came back
    // black; this is that bug's fix and the reason the scale is spelled out.
    // EXPLICIT mip level, and this is the difference between beams and a glow.
    //
    // The march jitters each pixel's start offset to hide banding, so adjacent
    // pixels in a quad sample this texture at world points metres apart. The
    // implicit UV derivative is then enormous and the sampler picks the
    // coarsest mip — the field collapses to its own mean and the shafts come
    // back as a smooth dome with the right brightness and no structure at all.
    // Choosing the level from the sample's distance fixes that AND is the
    // physically right shape: caustics do get softer and slower with depth.
    const c0 = textureLevel(tCaustic, S.xz.mul(uCausticScale), lod).r.mul(2.5).toVar();
    const c1 = textureLevel(tCaustic, S.xz.mul(uCausticScale.mul(0.37)).add(vec2(0.37, 0.11)), lod)
      .r.mul(2.5).toVar();
    return vec2(saturate(c0.mul(float(0.72).add(c1.mul(0.55)))), travel);
  });

  // --- the pass ------------------------------------------------------------

  /**
   * The reconstruction every part of this pass starts from: a world position
   * from the depth buffer, the view ray that reached it, and a surface normal
   * with a confidence.
   */
  function reconstruct(suv) {
    const ray = mix(mix(uRay00, uRay10, suv.x), mix(uRay01, uRay11, suv.x), suv.y).toVar();
    const rd = normalize(ray).toVar();
    const zLin = linearZ(tDepth.sample(suv)).toVar();
    const P = uCamPos.add(ray.mul(zLin)).toVar();
    const dist = min(length(ray).mul(zLin), 260.0).toVar();

    // The water surface is a lie in the depth buffer, and this is the one
    // place it matters. Its disc runs out to forty kilometres and its vertex
    // shader CLAMPS gl_Position.z to keep the far rings inside the far plane —
    // so every fragment of the distant ceiling reports a depth far nearer than
    // it is. Extinction then barely touched it and the frame grew a hard band
    // of raw surface colour along the horizon, immune to every tuning attempt
    // because the tuning was not where the bug was.
    //
    // Where the reconstruction lands at or above the waterline we are looking
    // at the ceiling, and its distance is exactly a ray-plane intersection —
    // no buffer needed, and it goes correctly to infinity as the ray levels
    // out, which is what makes the band dissolve instead of moving.
    const isCeil = step(uSurfaceY.sub(0.05), P.y).toVar();
    const tCeil = min(uSurfaceY.sub(uCamPos.y).div(max(rd.y, 1e-3)), 260.0).toVar();
    dist.assign(mix(dist, max(tCeil, 0.0), isCeil));
    return { ray, rd, zLin, P, dist };
  }

  /**
   * The shaft march ALONE, as a scalar. Drawn once a frame into a small buffer
   * — see post.js — rather than evaluated in both of the passes that read the
   * beauty target. It is the only expensive thing here (one texture fetch a
   * step) and the only one whose result survives being computed at a third of
   * the resolution: it is a soft, jittered, additive term with no edges of its
   * own, so bilinear upsampling costs nothing visible and buys back enough
   * budget to nearly double the step count.
   */
  function shaft(suv, steps = STEPS) {
    const outv = float(0).toVar();
    If(uAmount.greaterThan(0.002), () => {
      const { rd, dist } = reconstruct(suv);
      const g = HG_G;
      const cosT = dot(rd, uSunDir).toVar();
      const denom = float(1.0 + g * g).sub(cosT.mul(2.0 * g)).toVar();
      // Normalised against isotropic (1/4pi) so the number is a MULTIPLIER on
      // an even scatter rather than a per-steradian radiance, then soft-clamped
      // to an asymptote near 2.9. Left raw, the lobe swings 14x across the
      // framings the game actually uses.
      const phase = float(1 - g * g).div(max(pow(denom, 1.5), 1e-4)).toVar();
      const phaseC = phase.div(phase.mul(0.35).add(1.0)).toVar();

      const marchLen = min(dist, SHAFT_RANGE).toVar();
      const dt = marchLen.div(steps).toVar();
      // Screen PIXELS, not uv: interleaved gradient noise is built around a
      // pixel lattice, and a 0..1 coordinate scaled by a guessed constant gave
      // a coarse diagonal hatch instead of a dither.
      const jitter = ign(screenCoordinate.xy.add(fract(uTime).mul(71.0))).toVar();
      const acc = float(0).toVar();
      // Unrolled in JS rather than looped: the graph is built in JS so a fixed
      // count costs nothing to spell out, and a texture fetch inside a dynamic
      // loop is the one thing WGSL's uniformity rules make awkward.
      for (let i = 0; i < steps; i++) {
        const t = dt.mul(float(i).add(jitter)).toVar();
        const Q = uCamPos.add(rd.mul(t)).toVar();
        // A floor of 0.75 rather than 0: at mip 0 the per-pixel jitter makes
        // neighbouring samples land on different filaments and the beams come
        // back cross-hatched. One level up is still filaments, with enough
        // less variance between neighbours that the dither reads as grain.
        const lod = clamp(log2(t.mul(0.30).add(1.0)).add(0.75), 0.75, 4.5).toVar();
        const c = causticAt(Q, lod).toVar();
        const att = exp(uSigma.mul(uSigmaGain).y.mul(c.y.add(t)).negate()).toVar();
        // Kill anything above the surface: a ray that leaves the water inside
        // the march must not keep gathering.
        const inWater = saturate(uSurfaceY.sub(Q.y).mul(3.0)).toVar();
        acc.addAssign(pow(c.x, uShaftSharp).mul(att).mul(inWater));
      }
      // MEAN, not integral. acc*dt is an optical path length in metres, so it
      // scaled with the sightline — 5 m at the fishing camera against 42 m
      // offshore. Bring the path back as a term that saturates instead.
      outv.assign(acc.div(steps).mul(saturate(marchLen.div(16.0))).mul(phaseC));
    });
    return outv;
  }

  /**
   * @param col       vec3 node: the scene colour at this pixel
   * @param suv       vec2 node: the screen uv it was sampled at
   * @param shaftNode float node: the marched shaft term, from the small buffer
   */
  function apply(col, suv, shaftNode) {
    const out = vec3(col).toVar();
    if (DEBUG === 'off') return out;

    // Derivatives must sit in uniform control flow, so the position and the
    // normal are reconstructed unconditionally and only the rest is branched.
    // The branch is on a uniform, which WGSL is happy with.
    const { ray, rd, zLin, P, dist } = reconstruct(suv);

    // The surface normal, from the screen-space gradient of the reconstructed
    // world position. Two things this needs that a naive cross product does
    // not give:
    //
    //   The SIGN. Which way the cross product points depends on the handedness
    //   of the screen derivatives, and it is not the same for every surface —
    //   the first version lit the coral STEMS and left the sand dark, which is
    //   the caustic gate exactly inverted. A visible surface always faces the
    //   eye, so flipping against the view ray settles it for every pixel.
    //
    //   A CONFIDENCE. Across a silhouette the two neighbouring pixels are
    //   metres apart in world space and the gradient is meaningless, which
    //   draws a bright rim around every object. Comparing the gradient's size
    //   against the distance catches that.
    const dPx = dFdx(P).toVar();
    const dPy = dFdy(P).toVar();
    const rawN = cross(dPx, dPy).toVar();
    const nLen = length(rawN).toVar();
    const N = select(nLen.greaterThan(1e-8), rawN.div(max(nLen, 1e-8)), vec3(0.0, 1.0, 0.0)).toVar();
    N.assign(N.mul(sign(dot(N, rd)).negate()));
    const nOk = smoothstep(0.13, 0.03, length(dPx).add(length(dPy)).div(max(dist, 1.0))).toVar();

    If(uAmount.greaterThan(DEBUG ? -1.0 : 0.002), () => {
      const sigma = uSigma.mul(uSigmaGain).toVar();

      // ---- the column ----------------------------------------------------
      // How much ceiling this ray is pointed at, and it is deliberately biased
      // upward. A level gaze underwater does not look into the dark — the dark
      // is what you get looking DOWN — so upness is 0.70 at the horizontal and
      // only reaches zero forty degrees below it. Centred on the horizontal, as
      // it was, the frame grew a dark band exactly along the eye line.
      // One smooth ramp across the WHOLE vertical, not a curve centred on the
      // eye line. Anything that changes quickly near rd.y = 0 draws a band
      // along the horizon, and the horizon is already where the extinction
      // steps — the reef at forty metres still shows through, the ceiling two
      // hundred metres out does not — so a second feature in the same place
      // reads as an error even when both halves are individually right.
      const upness = smoothstep(-1.05, 0.65, rd.y).toVar();
      // And how deep the water it is looking THROUGH is. Sampled at a bounded
      // distance: with no geometry the reconstruction lands 260 m out, so a
      // ray a few degrees below level reported 30 m of depth and darkened as
      // though it were pointing at the abyss.
      const sampleY = uCamPos.y.add(rd.y.mul(min(dist, 45.0))).toVar();
      const depthOf = saturate(uSurfaceY.sub(sampleY).div(34.0)).toVar();
      const body = mix(uBodyDeep, uBodyNear, upness)
        .mul(mix(float(1.0), float(0.52), depthOf)).toVar();

      // A soft bloom of light around the sun's bearing, which is most of what
      // gives an underwater frame its direction.
      const toSun = saturate(dot(rd, uSunDir)).toVar();
      body.addAssign(uSunColor.mul(
        pow(toSun, 7.0).mul(uSunGlow).mul(uSunPower).mul(saturate(uSunDir.y.mul(3.0))),
      ));
      body.mulAssign(uMurk.mul(uBodyGain));

      // ---- extinction ------------------------------------------------------
      const T = exp(sigma.mul(dist).negate()).toVar();
      out.assign(mix(body, out, T));

      // ---- surface caustics ------------------------------------------------
      // Only where the surface faces the light, and only on things near enough
      // for the dapple to still have contrast — at range the pattern is below a
      // pixel and adding it is noise for the bloom to eat.
      const lit = saturate(dot(N, uSunDir)).mul(nOk).toVar();
      const cs = causticAt(P, clamp(log2(dist.mul(0.22).add(1.0)), 0.0, 4.0)).toVar();
      const causticFade = smoothstep(26.0, 4.0, dist).mul(saturate(uSunDir.y.mul(2.4))).toVar();
      const causticAtt = exp(sigma.mul(cs.y).negate()).toVar();
      out.addAssign(
        uSunColor.mul(causticAtt)
          .mul(pow(cs.x, uCausticSharp).mul(3.4))
          .mul(lit).mul(causticFade).mul(T).mul(uCausticGain).mul(uSunPower),
      );

      // ---- the shafts ------------------------------------------------------
      const shafts = shaftNode.mul(uShaft).mul(uSunPower)
        .mul(saturate(uSunDir.y.mul(2.2))).toVar();
      out.addAssign(uSunColor.mul(shafts));

      if (DEBUG === 'rays') out.assign(uSunColor.mul(shafts));
      if (DEBUG === 'caustic') out.assign(vec3(pow(cs.x, 2.2).mul(lit)));
      if (DEBUG === 'depth') out.assign(vec3(fract(dist.mul(0.1)), fract(dist.mul(0.01)), 0.0));
      if (DEBUG === 'normal') out.assign(N.mul(0.5).add(0.5).mul(nOk));
      // Greyscale, so it can be read off a screenshot without guessing what a
      // graded and tonemapped hue means. Black is down, white is up.
      if (DEBUG === 'ny') out.assign(vec3(N.y.mul(0.5).add(0.5)));
      if (DEBUG === 'facing') out.assign(vec3(saturate(dot(N, rd).negate())));
      if (DEBUG === 'nok') out.assign(vec3(nOk));
      if (DEBUG === 'lit') out.assign(vec3(lit));
      if (DEBUG === 'py') out.assign(vec3(saturate(P.y.negate().mul(0.15))));
      if (DEBUG === 'dist') out.assign(vec3(saturate(dist.mul(0.02))));
      if (DEBUG === 'rawshaft') out.assign(vec3(shaftNode.mul(3.0)));
      if (DEBUG === 'z') out.assign(vec3(saturate(zLin.mul(0.02))));
    });

    return DEBUG ? out : mix(vec3(col), out, uAmount);
  }

  // --- per-frame -----------------------------------------------------------
  const _corner = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _sun = new THREE.Vector3();
  const _bodyNear = new THREE.Color();
  const _bodyDeep = new THREE.Color();
  let causticBound = false;

  // NDC y is UP; the quad's v runs the other way in this renderer, so v=0 is
  // NDC +1. Measured, not assumed: with the naive mapping the reconstructed
  // world position came out ABOVE the waterline over four-fifths of the frame
  // (`?uw=py` was black where it should have been mid-grey), which put every
  // caustic, every normal and every shaft sample somewhere the ray never went.
  // Extinction still looked right throughout, because distance is carried by
  // the depth and barely by the ray — which is exactly why this survived two
  // rounds of eyeballing the composite.
  const CORNERS = [
    [-1, 1, 'uRay00'], [1, 1, 'uRay10'], [-1, -1, 'uRay01'], [1, -1, 'uRay11'],
  ];
  const RAYS = { uRay00, uRay10, uRay01, uRay11 };

  /**
   * Call once a frame, before post.render(). `water` is the surface module —
   * its caustic texture is bound on the first call and never again, because a
   * texture node rebound between draws inside a frame does not reach the pass
   * (see post.js's mip chain).
   */
  function update({ camera, env, amount, time, water, surfaceY = 0 }) {
    uAmount.value = amount;
    uTime.value = time;
    if (amount <= 0.002) return;

    if (!causticBound && water?.uniforms?.tCaustic?.value) {
      tCaustic.value = water.uniforms.tCaustic.value;
      if (water.uniforms.uCausticScale) uCausticScale.value = water.uniforms.uCausticScale.value;
      causticBound = true;
    }

    uNear.value = camera.near;
    uFar.value = camera.far;
    uCamPos.value.copy(camera.position);
    uSurfaceY.value = surfaceY;

    camera.getWorldDirection(_fwd);
    for (const [x, y, key] of CORNERS) {
      _corner.set(x, y, 0.5).unproject(camera).sub(camera.position);
      // Scaled so world = camera + ray * (metres along forward), which is
      // exactly what the linearised depth gives.
      const f = _corner.dot(_fwd);
      _corner.multiplyScalar(1 / (Math.abs(f) < 1e-6 ? 1e-6 : f));
      RAYS[key].value.copy(_corner);
    }

    if (env) {
      _sun.copy(env.keyDir).normalize();
      uSunDir.value.copy(_sun);
      uSunColor.value.copy(env.keyColor);
      // The key's own intensity is a lighting number in the tens; what matters
      // here is only how much of it survives to the water, so it is normalised
      // and then shaped by how high the sun is.
      uSunPower.value = Math.min(1.6, env.keyIntensity / 3.2) * (0.25 + 0.75 * env.dayFactor);

      // Extinction from the environment's own absorption, with a floor so the
      // night presets do not turn the water into vacuum.
      uSigma.value.set(
        Math.max(0.12, env.waterAbsorption.x),
        Math.max(0.045, env.waterAbsorption.y),
        Math.max(0.030, env.waterAbsorption.z),
      );

      // The column: the shallow tone lifted toward the scattering colour for
      // the ceiling end, and the deep tone crushed for the other.
      _bodyNear.copy(env.waterShallow).lerp(env.waterScatter, 0.55);
      _bodyDeep.copy(env.waterDeep).lerp(env.waterMid, 0.80);
      uBodyNear.value.copy(_bodyNear);
      uBodyDeep.value.copy(_bodyDeep);
      uMurk.value = 0.30 + 0.70 * env.dayFactor;
    }
  }

  function setTargets(t) {
    if (t?.scene?.depthTexture) tDepth.value = t.scene.depthTexture;
  }

  return {
    apply,
    shaft,
    steps: STEPS,
    debug: DEBUG || null,
    update,
    setTargets,
    uniforms: {
      uBodyGain, uSigmaGain, uShaft, uShaftSharp, uCausticGain, uCausticSharp, uSunGlow,
      uAmount, uSigma, uBodyNear, uBodyDeep, uMurk, uSurfaceY, uSunDir, uSunPower,
    },
    dispose() {
      blankDepth.dispose();
      blankCaustic.dispose();
    },
  };
}
