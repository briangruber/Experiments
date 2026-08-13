// The water surface.
//
// One transparent mesh, one node material, shaded in this order:
//
//   1. displace the grid by the wave train, attenuated by depth
//   2. build a normal from the wave train + drifting ripple noise + the wake
//   3. look up what is behind the surface, offset along that normal (refraction)
//   4. attenuate that colour by how far the light travelled through water, per
//      channel, so red dies first and the shallows go turquoise on their own
//   5. reflect the sky, weighted by Fresnel, and put the sun back on top
//   6. lay foam over the result: shore lace, crest, wake
//
// The shallow-water look lives almost entirely in step 4. Reference art of a
// tropical cove is not a blue surface - it is sand seen through a filter that
// eats red at half a metre and green by five, and the eye reads that gradient as
// depth without being told.

import { Mesh, MeshBasicNodeMaterial, DoubleSide } from 'three';
import {
  Fn, float, vec2, vec3, vec4, positionLocal, positionWorld, cameraPosition,
  cameraNear, cameraFar, screenUV, viewportSharedTexture, viewportDepthTexture,
  linearDepth, normalize, reflect, dot, max, clamp, mix, smoothstep,
  pow, exp, length, Discard, mx_noise_float, mx_worley_noise_float,
} from 'three/tsl';
import {
  U, depthField, waveDisplace, waveNormal, wakeField, skyColor, band, saturate3,
} from './fields.js';
import { buildWaterGeometry } from './terrain.js';

// Small drifting ripples. Too fine to displace geometry for, but they are what
// makes the surface read as water rather than as glass, so they go in the
// normal at full strength.
const rippleNormal = Fn(([p, depth, dist]) => {
  const t = U.time;
  const e = 0.14;
  const h = (qq) => mx_noise_float(vec3(qq, t.mul(0.05)), 1.0, 0.0);
  const grad = (qq, amp) => vec2(
    h(qq.add(vec2(e, 0))).sub(h(qq.sub(vec2(e, 0)))),
    h(qq.add(vec2(0, e))).sub(h(qq.sub(vec2(0, e)))),
  ).mul(amp);

  // Each octave is dropped once it is finer than a few pixels, which is the
  // difference between a surface that shimmers and one that boils.
  const fade = (k) => smoothstep(0.0, 1.0, float(1.0).div(float(1.0).add(dist.mul(k)))).max(0.0);
  const g = grad(p.mul(1.35).add(vec2(t.mul(0.21), t.mul(-0.14))), 0.55).mul(fade(0.012))
    .add(grad(p.mul(3.10).add(vec2(t.mul(-0.33), t.mul(0.27))), 0.30).mul(fade(0.05)))
    .add(grad(p.mul(7.40).add(vec2(t.mul(0.52), t.mul(0.41))), 0.14).mul(fade(0.16)));

  // Ripples flatten out in the last few centimetres, same as the swell does.
  return g.mul(U.ripple).mul(smoothstep(0.03, 0.55, depth));
});

// Sun glitter: a sparse cellular field, thresholded hard so it reads as
// individual points of light rather than a sheen, and only where the surface
// happens to be aimed at the sun.
const glitter = Fn(([p, align, dist]) => {
  const t = U.time.mul(0.6);
  const w = mx_worley_noise_float(vec3(p.mul(6.5), t), 1.0);
  const dots = pow(clamp(w.oneMinus(), 0, 1), 20.0);
  // Glitter that covers the whole surface evenly is noise; real glitter gathers
  // into drifting patches, so a slow low-frequency mask gates it.
  const patch = smoothstep(0.35, 0.85, mx_noise_float(vec3(p.mul(0.22), t.mul(0.12)), 1.0, 0.5));
  const near = smoothstep(15.0, 70.0, dist).oneMinus();
  return dots.mul(patch).mul(near).mul(pow(clamp(align, 0, 1), 8.0)).mul(U.sparkle);
});

export function createWater(segments = 448) {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = true;
  material.side = DoubleSide;

  // ------------------------------------------------------------------ vertex
  material.positionNode = Fn(() => {
    const p = positionLocal.xz;
    const depth = max(depthField(p), 0.0);
    // Beyond the cove the grid is metres wide per quad; displacing it there only
    // buys aliasing, so the swell is faded out with distance from the viewer.
    const near = smoothstep(60.0, 220.0, length(p.sub(cameraPosition.xz))).oneMinus();
    return positionLocal.add(waveDisplace(p, depth).mul(near));
  })();

  // ---------------------------------------------------------------- fragment
  material.colorNode = Fn(() => {
    const P = positionWorld;
    const p = P.xz;
    const depth = depthField(p).toVar();

    // Dry land is not water. Cutting the surface per pixel against the same
    // field the floor was built from gives a waterline as sharp as the depth
    // texture, whatever the grid under it is doing.
    Discard(depth.lessThan(0.0));

    const V = normalize(cameraPosition.sub(P));
    const dist = length(cameraPosition.sub(P));

    // ---- normal
    const wn = waveNormal(p, depth);
    const wake = wakeField(p).toVar();
    const rip = rippleNormal(p, depth, dist);
    const N = normalize(vec3(
      wn.x.sub(rip.x).sub(wake.y.mul(U.wakeFoam)),
      wn.y,
      wn.z.sub(rip.y).sub(wake.z.mul(U.wakeFoam)),
    )).toVar();
    // Flatten the normal with distance or the horizon turns into noise.
    const flat = smoothstep(40.0, 200.0, dist);
    N.assign(normalize(mix(N, vec3(0, 1, 0), flat)));

    // ---- what is behind the water
    // Screen-space offset, in UV. A few per cent of the screen is already a
    // strong wobble; more than that and the surface stops refracting what is
    // under it and starts smearing whatever happens to be nearby.
    const strength = U.refraction.mul(0.035).mul(clamp(depth.mul(0.6), 0.1, 1.0)).div(max(dist.mul(0.05), 1.0));
    const uvOff = screenUV.add(vec2(N.x, N.z.negate()).mul(strength)).toVar();
    const here = linearDepth().toVar();
    const behindOff = linearDepth(viewportDepthTexture(uvOff));
    // If the offset landed on something in front of the water - the hull, a
    // piling - fall back to the straight-through sample instead of smearing it.
    const uv = behindOff.sub(here).lessThan(0.0).select(screenUV, uvOff).toVar();
    const behind = linearDepth(viewportDepthTexture(uv));
    const span = cameraFar.sub(cameraNear);

    // Path length through water along the view ray. Where nothing was drawn
    // behind the surface (open sea floor beyond the terrain) it saturates.
    const path = max(behind.sub(here).mul(span), 0.0).toVar();
    const scene = viewportSharedTexture(uv).rgb.toVar();

    // ---- absorption: the whole trick
    // Extinction per channel, inverted from the shallow tint so the artist
    // controls the answer rather than the coefficients. Red goes first. The
    // floor has already lost light on the way down (see scene.js); this is the
    // second leg, surface to eye.
    const sigma = vec3(1.0).sub(clamp(U.shallow, vec3(0.001), vec3(0.999))).mul(float(0.62).div(U.clarity));
    const T = exp(sigma.mul(path).negate()).toVar();

    // Body colour: what the water itself glows with once the floor is gone.
    // Banding the depth mix is where the painted, stepped look comes from - open
    // water in reference art is not a smooth ramp, it is a few flat plates of
    // colour with soft joins.
    const dmix = band(smoothstep(0.4, 5.5, depth), 5.0, U.stylize);
    const body = mix(U.shallow.mul(mix(vec3(1.0), U.sunColor, 0.5)), U.deep, dmix)
      .mul(float(0.22).add(U.turbidity.mul(0.55)));

    const under = scene.mul(T).add(body.mul(T.oneMinus())).toVar();

    // ---- reflection
    const R0 = reflect(V.negate(), N);
    const R = normalize(vec3(R0.x, max(R0.y, 0.015), R0.z)).toVar();
    const sky = skyColor(R).toVar();

    // Stylised sun: a broad sheet plus a tight core, so the glare has a shape.
    const align = dot(R, U.sunDir);
    const shine = mix(float(900.0), float(40.0), U.gloss);
    const spec = pow(max(align, 0.0), shine).mul(2.6)
      .add(pow(max(align, 0.0), 12.0).mul(0.16))
      // A broad sheen. Without it the swell is invisible from above: at these
      // angles almost nothing is reflected, so the only thing that tells the eye
      // there are waves is how the sun's glare leans across them.
      .add(pow(max(align, 0.0), 2.2).mul(0.13));
    const glint = glitter(p, align, dist);

    const f0 = 0.02;
    const fres = clamp(
      float(f0).add(float(1.0 - f0).mul(pow(clamp(float(1.0).sub(max(dot(N, V), 0.0)), 0, 1), 5.0))).mul(U.reflectivity),
      0.0, 1.0,
    ).toVar();
    // Painterly step in the Fresnel: reference art shows a fairly abrupt line
    // where the surface stops being a window and starts being a mirror.
    fres.assign(band(fres, 5.0, U.stylize.mul(0.6)));

    const col = mix(under, sky, fres)
      .add(U.sunColor.mul(spec).mul(mix(0.35, 1.0, fres.mul(4.0).min(1.0))))
      .add(U.sunColor.mul(glint).mul(1.6))
      .toVar();

    // ---- foam
    // Thickness of water over the floor *right now*, including the swell: this
    // is what makes the lace run up the sand and drain back off it.
    const surfaceY = waveDisplace(p, depth).y;
    const thin = depth.add(surfaceY);
    const lace = smoothstep(0.0, U.shoreFoamDepth, thin).oneMinus().toVar();

    // Break the band up so it reads as foam and not as a contour line.
    const fn1 = mx_noise_float(vec3(p.mul(2.6).add(vec2(U.time.mul(0.09), U.time.mul(-0.06))), U.time.mul(0.12)), 1.0, 0.5);
    const fn2 = mx_noise_float(vec3(p.mul(7.5).sub(vec2(U.time.mul(0.14), 0)), U.time.mul(0.2)), 1.0, 0.5);
    const grain = clamp(fn1.mul(0.75).add(fn2.mul(0.35)).add(0.35), 0.0, 1.0);
    lace.assign(smoothstep(0.12, 0.62, lace.mul(0.55).add(lace.mul(grain).mul(1.1))).mul(U.shoreFoam));

    const crest = smoothstep(0.55, 1.05, wn.w.mul(grain.add(0.45))).mul(U.crestFoam)
      .mul(smoothstep(0.25, 1.2, depth));
    const wakeFoam = smoothstep(0.22, 0.95, wake.x.mul(grain.mul(0.85).add(0.55))).mul(U.wakeFoam).mul(0.88);

    // Contact foam. Anything standing in the water - a piling, a hull, a buoy -
    // has a collar of white where the surface meets it, because that is where
    // the water is being disturbed and where the path through it goes to zero.
    // The depth buffer already knows: a short path means the surface is nearly
    // touching whatever is behind it.
    const contact = smoothstep(0.06, 0.62, path).oneMinus()
      .mul(smoothstep(0.15, 0.7, depth))            // the beach has its own lace
      .mul(grain.mul(0.55).add(0.6))
      .mul(U.shoreFoam);

    const foam = clamp(lace.add(crest).add(wakeFoam).add(contact), 0.0, 1.0).toVar();
    const foamCol = mix(vec3(0.90, 0.96, 0.99), U.sunColor, 0.25)
      .mul(float(0.75).add(grain.mul(0.35)));
    col.assign(mix(col, foamCol, foam.mul(0.94)));

    // ---- distance
    // The far grid fades into the same haze the sky has at the horizon, which is
    // what hides the edge of the world.
    const haze = smoothstep(140.0, 420.0, dist);
    const far = mix(U.deep.mul(1.4), skyColor(vec3(V.x, 0.06, V.z).negate()).mul(0.95), haze.mul(0.75));
    col.assign(mix(col, far, smoothstep(45.0, 260.0, dist).mul(0.9)));

    return vec4(saturate3(col, U.saturation), 1.0);
  })();

  const mesh = new Mesh(buildWaterGeometry(segments), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.name = 'water';
  return mesh;
}
