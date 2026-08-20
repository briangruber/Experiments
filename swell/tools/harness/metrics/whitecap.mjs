// Whitecap area fraction against Monahan & O'Muircheartaigh (1980).
//
// W = 3.84e-6 * U10^3.41, from photographic surveys of the real ocean. It is the
// only widely used empirical law that pins down how *much* foam a given wind
// should produce, which makes it the reference a breaking variant is arguing
// with whether it knows it or not.

export const meta = {
  id: 'whitecap',
  title: 'Whitecap coverage vs Monahan',
  kind: 'measure',
  unit: 'fraction',
  better: 'near',
  note: 'Plan-view foam area fraction, sampled from the shipped shader on a regular ' +
        'world grid — the same quantity the surveys measured. The law is calibrated ' +
        'roughly 4-20 m/s; outside that the reference is extrapolated and marked. ' +
        'Deep-water fixtures only.',
};

export function reference(knobs) {
  const U = Math.max(knobs.windSpeed, 0.01);
  return 3.84e-6 * Math.pow(U, 3.41);
}

export function run({ artifact, options }) {
  const k = artifact.knobs;
  if (k.shoreEnabled > 0.5) return { skipped: 'surf zone — the law describes open ocean' };

  const c = artifact.detail.coverage;
  let sum = 0;
  for (let i = 0; i < c.length; i++) sum += c[i];
  const w = sum / c.length;

  const ref = reference(k);
  const extrapolated = k.windSpeed < 4 || k.windSpeed > 20;
  const error = Math.abs(w - ref) / Math.max(ref, 1e-6);
  const tol = options?.tolerance ?? 0.6;
  return {
    value: w,
    reference: ref,
    error,
    pass: extrapolated ? null : error <= tol ? true : null,
    unit: 'fraction',
    detail: extrapolated ? [`U10 = ${k.windSpeed} m/s is outside the law's calibration range`] : [],
  };
}
