// Parameters -> the handful of vectors every shader wants.
//
// The UI (and any host application) thinks in elevation and azimuth degrees,
// intensity and tint. The shaders think in unit direction vectors and premultiplied
// irradiance. This is the one place that conversion happens, so the standalone demo
// and the Three.js adapter cannot drift apart on where the sun is.

import { v3, DEG } from './math.js';

export function createDerived() {
  return {
    sunDir: v3(),
    moonDir: v3(),
    windVec3: v3(),
  };
}

// Writes into `d` (from createDerived) and also back into `p` for the two values
// the shaders read straight off the parameter set. Returns `d`.
export function derive(p, d) {
  const el = p.sunElevation * DEG, az = p.sunAzimuth * DEG;
  d.sunDir[0] = Math.cos(el) * Math.sin(az);
  d.sunDir[1] = Math.sin(el);
  d.sunDir[2] = -Math.cos(el) * Math.cos(az);

  const mel = p.moonElevation * DEG, maz = p.moonAzimuth * DEG;
  d.moonDir[0] = Math.cos(mel) * Math.sin(maz);
  d.moonDir[1] = Math.sin(mel);
  d.moonDir[2] = -Math.cos(mel) * Math.cos(maz);

  const wd = p.windDirDeg * DEG;
  d.windVec3[0] = Math.cos(wd) * p.windSpeed;
  d.windVec3[1] = 0;
  d.windVec3[2] = Math.sin(wd) * p.windSpeed;

  p.windDir = wd;
  p.swellDir = p.swellDirDeg * DEG;
  // Allocated once and mutated after: these go straight into uniform uploads
  // every frame, and a fresh Float32Array per frame per uniform is exactly the
  // sort of garbage that reads as jitter rather than as a lower frame rate.
  if (!p.sunIrradiance || p.sunIrradiance.length !== 3) p.sunIrradiance = new Float32Array(3);
  p.sunIrradiance[0] = p.sunTint[0] * p.sunIntensity;
  p.sunIrradiance[1] = p.sunTint[1] * p.sunIntensity;
  p.sunIrradiance[2] = p.sunTint[2] * p.sunIntensity;

  if (!p.moonColor || p.moonColor.length !== 3) p.moonColor = new Float32Array(3);
  p.moonColor[0] = 0.55 * p.moonIntensity * 2.4;
  p.moonColor[1] = 0.68 * p.moonIntensity * 2.4;
  p.moonColor[2] = 1.00 * p.moonIntensity * 2.4;

  return d;
}
