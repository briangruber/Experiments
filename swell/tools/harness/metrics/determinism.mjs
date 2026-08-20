export const meta = {
  id: 'determinism',
  title: 'Same input, same pixels',
  kind: 'gate',
  note: 'The fixture is rendered twice at one simulation time and the frames must ' +
        'be byte-identical. Anything reading the wall clock, an unseeded random, or ' +
        'a persistent buffer fails here — and would otherwise make every comparison ' +
        'against this variant unrepeatable.',
};

export function run({ artifact }) {
  const same = artifact.hash === artifact.hashRepeat;
  return {
    value: same ? 1 : 0,
    unit: '',
    pass: same,
    detail: same ? [] : [`frame hashes differ: ${artifact.hash} vs ${artifact.hashRepeat}`],
  };
}
