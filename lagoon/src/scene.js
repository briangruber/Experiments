// The sea floor and the sky - everything the water is looking at.
//
// The floor is where half of the water's credibility is earned: the caustics
// live here, and so does the vertical light loss that makes six metres of water
// look like six metres from directly above, when the view ray through the
// surface is barely a metre long.

import { Mesh, MeshBasicNodeMaterial, SphereGeometry, BackSide } from 'three';
import {
  Fn, vec2, vec3, vec4, float, attribute, positionWorld, normalWorld, cameraPosition,
  normalize, dot, max, clamp, mix, smoothstep, pow, exp, length,
  mx_noise_float, mx_fractal_noise_float,
} from 'three/tsl';
import { U, caustics, skyColor, saturate3 } from './fields.js';
import { buildFloorGeometry } from './terrain.js';

// How much of the downward light survives to a given depth. The water shader
// handles the horizontal path from surface to eye; this is the other leg of the
// journey, and without it a deep floor lit from above stays suspiciously bright.
export const lightThroughWater = (depth) => exp(
  vec3(1.0).sub(clamp(U.shallow, vec3(0.001), vec3(0.999)))
    .mul(float(0.34).div(U.clarity))
    .mul(max(depth, 0.0)).negate(),
);

export function createFloor(floorDepth, segments = 512) {
  const material = new MeshBasicNodeMaterial();

  material.colorNode = Fn(() => {
    const P = positionWorld;
    const p = P.xz;
    const depth = P.y.negate().toVar();
    const vcol = attribute('color', 'vec3');   // r: reef cover, g: rock, b: variation

    // ---- sand, with ripples that run along the shore
    const rip = mx_noise_float(vec3(p.mul(vec2(1.9, 0.75)).add(vec2(0, p.x.mul(0.12))), 0.0), 1.0, 0.0);
    const grain = mx_fractal_noise_float(vec3(p.mul(0.9), 0.0), 3, 2.0, 0.55, 1.0);
    const sand = U.sandColor.mul(
      float(0.86).add(rip.mul(0.10)).add(grain.mul(0.13)).add(vcol.b.mul(0.12)),
    ).toVar();

    // Wet sand right at the waterline reads darker and more saturated.
    const wet = smoothstep(-0.55, 0.35, depth);
    sand.assign(mix(sand.mul(vec3(1.02, 0.98, 0.90)).mul(0.82), sand.mul(0.78), wet));

    // ---- reef and rock
    // Two scales of patchiness: broad beds, then mottling inside them. Reef that
    // is one flat colour reads as a stain on the sand rather than as growth.
    const patch = mx_fractal_noise_float(vec3(p.mul(0.42), 0.0), 3, 2.1, 0.5, 1.0);
    const mottle = mx_fractal_noise_float(vec3(p.mul(1.6), 0.0), 3, 2.0, 0.55, 1.0);
    const reefMask = clamp(vcol.r.mul(1.7).mul(smoothstep(0.12, 0.55, patch.add(0.5))), 0.0, 1.0);
    const reef = mix(
      U.reefColor.mul(0.7),
      mix(U.reefColor.mul(vec3(1.6, 1.45, 0.85)), U.reefColor.mul(vec3(0.8, 1.25, 1.1)), clamp(mottle.add(0.5), 0, 1)),
      clamp(patch.add(0.5), 0, 1),
    );
    const rockMask = clamp(vcol.g, 0.0, 1.0);
    const rock = mix(vec3(0.36, 0.33, 0.29), vec3(0.20, 0.30, 0.16), smoothstep(0.4, 0.9, patch.add(0.5)));

    const albedo = mix(mix(sand, reef, reefMask), rock, rockMask).toVar();

    // ---- normal, bumped by the same ripples
    const e = 0.35;
    const hh = (q) => mx_noise_float(vec3(q.mul(vec2(1.9, 0.75)), 0.0), 1.0, 0.0);
    const g = vec2(
      hh(p.add(vec2(e, 0))).sub(hh(p.sub(vec2(e, 0)))),
      hh(p.add(vec2(0, e))).sub(hh(p.sub(vec2(0, e)))),
    ).mul(0.35);
    const N = normalize(vec3(normalWorld.x.sub(g.x), normalWorld.y, normalWorld.z.sub(g.y))).toVar();

    // ---- light
    const ndl = max(dot(N, U.sunDir), 0.0);
    const sun = U.sunColor.mul(float(0.35).add(ndl.mul(0.75)));
    const amb = skyColor(vec3(N.x.mul(0.4), 1.0, N.z.mul(0.4))).mul(0.34);
    const att = lightThroughWater(depth);

    const lit = albedo.mul(sun.add(amb)).mul(mix(vec3(1.0), att, smoothstep(-0.1, 0.15, depth))).toVar();

    // ---- caustics, only under water and only on surfaces facing the light
    const c = caustics(p, max(depth, 0.0)).mul(smoothstep(0.0, 0.25, depth)).mul(pow(max(N.y, 0.0), 1.5));
    lit.addAssign(c.mul(albedo.mul(0.75).add(0.10)).mul(U.sunColor));

    // Distant floor sinks into the water colour rather than staying crisp.
    const dist = length(cameraPosition.sub(P));
    lit.assign(mix(lit, U.deep.mul(0.7), smoothstep(90.0, 300.0, dist).mul(smoothstep(0.5, 3.0, depth)).mul(0.85)));

    return vec4(saturate3(lit, U.saturation), 1.0);
  })();

  const mesh = new Mesh(buildFloorGeometry(floorDepth, 260, segments), material);
  mesh.name = 'floor';
  mesh.frustumCulled = false;
  return mesh;
}

export function createSky() {
  const material = new MeshBasicNodeMaterial();
  material.side = BackSide;
  material.depthWrite = false;
  material.fog = false;
  material.colorNode = Fn(() => vec4(skyColor(normalize(positionWorld.sub(cameraPosition))), 1.0))();
  // Comfortably inside the camera's far plane: a dome outside it is a black sky.
  const mesh = new Mesh(new SphereGeometry(1400, 40, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  mesh.name = 'sky';
  return mesh;
}
