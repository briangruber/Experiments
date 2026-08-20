export const meta = {
  slot: 'breaking',
  id: 'slope-threshold',
  title: 'Slope threshold',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'The obvious first thing anyone writes: foam wherever the height field is steep, ' +
    'broken up with noise. No history, so foam rides on the crest instead of trailing ' +
    'behind it, and no depth-limited break. Kept as the cheap end of the ladder - it is ' +
    'roughly a third of the cost of fold-ridge and is the right pick on a phone.',
};

export const knobs = { slopeBias: 0.55, slopeCut: 0.42 };
export const schema = [
  ['slopeBias', 0, 2, 0.01, ''],
  ['slopeCut', 0, 2, 0.005, ''],
];

export const glsl = /* glsl */`
vec2 sw_breaking(Wave w, vec2 p, float t, float depth, float footprint){
  float drive = w.slope * uSlopeBias * uFoamCoverage;
  drive *= mix(1.0, sat(0.5 + 0.5 * w.face), uFoamFace);
  if (uShoreEnabled > 0.5){
    drive += smoothstep(1.6, 0.2, depth) * 0.8 * uFoamCoverage;
  }
  vec2 q = p * uFoamScale;
  float n = sw_fbm(q + vec2(t * 0.03, 0.0), 4);
  // An absolute cut on slope, which is exactly the naivety this variant is here
  // to represent: it has no idea how steep the sea it is looking at happens to
  // be, so coverage drifts with every change to the spectrum.
  float cov = sat(smoothstep(uSlopeCut,
                             uSlopeCut + max(uFoamSoftness, 0.01),
                             drive * (0.5 + 1.05 * n)));
  return vec2(cov, 1.0);
}
`;
