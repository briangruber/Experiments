export const meta = {
  id: 'cost',
  title: 'Frame cost',
  kind: 'measure',
  unit: 'ms',
  better: 'lower',
  note: 'Median frame time over a short burst, measured inside the page with an ' +
        'explicit glFinish. Absolute numbers come from a software rasteriser and are ' +
        'not a frame budget for real hardware; the ratio against the champion is the ' +
        'number that travels.',
};

export function run({ artifact, baseline }) {
  const v = artifact.timing.medianMs;
  const ref = baseline?.timing?.medianMs ?? null;
  return {
    value: v,
    p95: artifact.timing.p95Ms,
    reference: ref,
    ratio: ref ? v / ref : null,
    pass: null,
  };
}
