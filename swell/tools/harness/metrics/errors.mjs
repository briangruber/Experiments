export const meta = {
  id: 'errors',
  title: 'Runs clean',
  kind: 'gate',
  note: 'Any WebGL, shader-compile or JavaScript error on any fixture. A variant ' +
        'that throws is not a slower variant, it is not a variant.',
};

export function run({ artifact }) {
  const errs = artifact.errors || [];
  return {
    value: errs.length,
    unit: 'errors',
    pass: errs.length === 0,
    detail: errs.slice(0, 5),
  };
}
