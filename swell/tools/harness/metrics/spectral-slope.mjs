// Slope of the wavenumber spectrum in the saturation range.
//
// Phillips' equilibrium argument says a wind sea saturates: above the peak, the
// omnidirectional spectrum falls as k^-3, so a 1-D transect through the surface
// falls as k^-3 too. A variant whose tail is too steep looks like syrup; too
// shallow and it looks like sandpaper. This measures which.

export const meta = {
  id: 'spectralSlope',
  title: 'Spectral tail slope',
  kind: 'measure',
  unit: 'exponent',
  better: 'near',
  note: 'Least-squares slope of log power against log wavenumber, fitted only above the ' +
        'spectral peak — the saturation range, where Phillips argued the shape is fixed ' +
        'by breaking rather than by the wind — and averaged over every row and column of ' +
        'a 512 m probe sampled every metre. Expected near -3 for a wind sea.',
};

// Iterative radix-2 FFT, in place, real input in `re`.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export function run({ artifact, options }) {
  if (artifact.knobs.shoreEnabled > 0.5) {
    return { skipped: 'shoaling bottom — the patch spans many depths, so one slope means nothing' };
  }
  const { height, resolution: N, metresPerSample: dx } = artifact.detail;
  const power = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  // Hann window, or the patch edges leak across every band we care about.
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const accumulate = (get) => {
    for (let line = 0; line < N; line++) {
      let mean = 0;
      for (let i = 0; i < N; i++) mean += get(line, i);
      mean /= N;
      for (let i = 0; i < N; i++) { re[i] = (get(line, i) - mean) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let i = 1; i < N / 2; i++) power[i] += re[i] * re[i] + im[i] * im[i];
    }
  };
  accumulate((r, i) => height[r * N + i]);
  accumulate((c, i) => height[i * N + c]);

  // Fit the saturation range only — the band *above* the spectral peak. Below
  // the peak the spectrum climbs steeply, and straddling it fits a slope to a
  // shape that has no slope. The upper end is where the grid stops carrying a
  // wave at all.
  const kOf = (i) => (2 * Math.PI * i) / (N * dx);
  const g = 9.81;
  const U = Math.max(artifact.knobs.windSpeed, 0.4);
  const F = Math.max(artifact.knobs.fetch, 0.1) * 1000;
  const fp = 3.5 * (g / U) * Math.pow(Math.min(Math.max((g * F) / (U * U), 1e2), 1e7), -0.33);
  const kPeak = Math.pow(2 * Math.PI * fp, 2) / g;
  const indexOf = (k) => Math.round((k * N * dx) / (2 * Math.PI));
  const lo = Math.max(2, indexOf(kPeak * (options?.abovePeak ?? 1.35)));
  const hi = Math.min(Math.floor(N / (options?.minSamplesPerWave ?? 8)), N / 2 - 1);
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let i = lo; i < Math.min(hi, N / 2); i++) {
    if (power[i] <= 0) continue;
    const x = Math.log(kOf(i)), y = Math.log(power[i]);
    sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
  }
  if (n < 6) return { skipped: 'not enough resolved band to fit a slope' };

  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const ref = options?.target ?? -3;
  const error = Math.abs(slope - ref);
  const tol = options?.tolerance ?? 0.9;
  return { value: slope, reference: ref, error, pass: error <= tol ? true : null, unit: 'exponent', detail: [`fitted over ${n} bands`] };
}
