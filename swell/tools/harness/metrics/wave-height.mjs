// Significant wave height against the fetch-limited JONSWAP growth law.
//
// This is the strongest objective handle the ocean domain has: for a given wind
// speed and fetch, oceanography says how big the waves should be, and the answer
// does not depend on anyone's taste.

const G = 9.81;

export const meta = {
  id: 'waveHeight',
  title: 'Significant wave height vs JONSWAP',
  kind: 'measure',
  unit: 'm',
  better: 'near',
  note: 'Hs measured as 4x the standard deviation of the height field, read back from ' +
        'the shipped shader over a 1 km patch. The reference is the fetch-limited energy ' +
        'growth law capped at the fully developed sea, in quadrature with the swell ' +
        'train. This is a conformance check, not a discovery: the champion spectrum ' +
        'normalises itself to this law on purpose, so what the metric catches is a ' +
        'variant that departs from it — a plain sine sum, or a regression. A patch ' +
        'sampled every 4 m cannot see trains shorter than about 20 m, so a small ' +
        'under-read is expected and is inside the tolerance. Deep water only.',
};

// Dimensionless energy against dimensionless fetch (Hasselmann et al. 1973),
// capped at the Pierson-Moskowitz fully developed sea. Stated in the
// dimensionless form rather than as a height formula because the two published
// forms of the height law disagree with JONSWAP's own alpha by about 1.7x, and
// this is the one the spectrum normalises itself against.
export function reference(knobs) {
  const U = Math.max(knobs.windSpeed, 0.01);
  const F = Math.max(knobs.fetch, 0.1) * 1000;
  const x = (G * F) / (U * U);
  const eps = Math.min(1.6e-7 * x, 3.64e-3);
  const windSea = 4 * Math.sqrt((eps * Math.pow(U, 4)) / (G * G));
  const swell = knobs.swellHeight || 0;
  // Independent trains: variances add, so heights add in quadrature.
  return Math.sqrt(windSea * windSea + swell * swell) * (knobs.amplitude ?? 1);
}

export function run({ artifact, options }) {
  const k = artifact.knobs;
  if (k.shoreEnabled > 0.5) {
    return { skipped: 'shoaling bottom — the closed form does not apply' };
  }
  if (k.windSpeed < 1) return { skipped: 'no wind' };

  const h = artifact.field.height;
  let mean = 0;
  for (let i = 0; i < h.length; i++) mean += h[i];
  mean /= h.length;
  let varSum = 0;
  for (let i = 0; i < h.length; i++) { const d = h[i] - mean; varSum += d * d; }
  const hs = 4 * Math.sqrt(varSum / h.length);

  const ref = reference(k);
  const error = Math.abs(hs - ref) / Math.max(ref, 1e-6);
  const tol = options?.tolerance ?? 0.4;
  return { value: hs, reference: ref, error, pass: error <= tol ? true : null, unit: 'm' };
}
