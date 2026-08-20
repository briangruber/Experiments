export const meta = {
  id: 'flicker',
  title: 'Temporal stability',
  kind: 'gate',
  unit: 'index',
  better: 'lower',
  note: 'Two frames one 60th of a second apart, differenced and high-pass filtered, ' +
        'then divided by the high-frequency detail already in the frame. A wave crossing ' +
        'the screen produces a smooth difference; aliasing produces a speckled one. The ' +
        'normalisation is what makes the number comparable between a millpond and a ' +
        'storm — unnormalised it mostly measures how much detail a scene has. This is ' +
        'the gate that catches "I turned the detail up and the screenshot looks ' +
        'amazing", which is the most common regression in this project.',
};

// Judged against the champion rather than against a number I made up. What a
// fixed threshold really encodes is one person's guess at how much instability a
// particular scene is allowed, and that guess does not survive contact with a
// new scene. A regression gate needs no such guess: whatever the champion does
// on this fixture is the budget, plus a margin for measurement noise. The
// absolute ceiling stays only as a backstop against both sides being terrible.
export function run({ artifact, options, baseline }) {
  const v = artifact.flicker;
  const max = options?.max ?? Infinity;
  const ratio = options?.maxRatio ?? 1.35;
  const slack = options?.slack ?? 0.02;
  const budget = baseline ? Math.min(max, baseline.flicker * ratio + slack) : max;
  return {
    value: v,
    unit: 'index',
    pass: v <= budget,
    reference: Number.isFinite(budget) ? budget : null,
    detail: v > budget ? [`${v.toFixed(4)} against a budget of ${budget.toFixed(4)}`] : [],
  };
}
