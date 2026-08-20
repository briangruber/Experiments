// Turns collected artifacts into a verdict.
//
// The one rule this file exists to enforce: measurements and preference are
// never mixed into a single score. Gates can reject a variant outright.
// Measurements can say it got cheaper, or closer to the physics. Neither can
// say it looks better, and pretending otherwise is how a project like this ends
// up with a leaderboard nobody trusts.

import * as errors from './metrics/errors.mjs';
import * as determinism from './metrics/determinism.mjs';
import * as flicker from './metrics/flicker.mjs';
import * as cost from './metrics/cost.mjs';
import * as waveHeight from './metrics/wave-height.mjs';
import * as whitecap from './metrics/whitecap.mjs';
import * as spectralSlope from './metrics/spectral-slope.mjs';

export const METRICS = Object.fromEntries(
  [errors, determinism, flicker, cost, waveHeight, whitecap, spectralSlope].map((m) => [m.meta.id, m]),
);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function score({ domain, candidate, baseline }) {
  const rows = [];

  for (const spec of domain.metrics) {
    const mod = METRICS[spec.id];
    if (!mod) throw new Error(`unknown metric "${spec.id}"`);

    const perFixture = candidate.map((art, i) => {
      const base = baseline?.[i];
      const c = mod.run({ artifact: art, options: spec.options, baseline: base });
      const b = base ? mod.run({ artifact: base, options: spec.options }) : null;
      return { fixture: art.fixture, candidate: c, baseline: b };
    });

    const live = perFixture.filter((f) => !f.candidate.skipped);
    const failures = live.filter((f) => f.candidate.pass === false);

    const row = {
      id: spec.id,
      title: mod.meta.title,
      kind: mod.meta.kind,
      unit: mod.meta.unit || '',
      better: mod.meta.better || null,
      note: mod.meta.note,
      skipped: perFixture.length - live.length,
      perFixture,
      value: mean(live.map((f) => f.candidate.value).filter((v) => typeof v === 'number')),
      baselineValue: mean(live.map((f) => f.baseline?.value).filter((v) => typeof v === 'number')),
      pass: mod.meta.kind === 'gate' ? failures.length === 0 : null,
      failures: failures.map((f) => ({ fixture: f.fixture, detail: f.candidate.detail || [] })),
    };

    // For a metric with a physical reference, "better" means "closer to it".
    // That is an objective comparison, and it is the only kind of better this
    // file is willing to assert.
    if (mod.meta.better === 'near') {
      row.error = mean(live.map((f) => f.candidate.error).filter((v) => typeof v === 'number'));
      row.baselineError = mean(live.map((f) => f.baseline?.error).filter((v) => typeof v === 'number'));
      // Equal errors mean the slot under test does not touch this quantity —
      // report that honestly instead of calling it a regression.
      row.movedCloser = row.baselineError == null ? null
        : Math.abs(row.error - row.baselineError) < 1e-9 ? 'unchanged'
        : row.error < row.baselineError;
    }
    if (spec.id === 'cost' && row.baselineValue) row.ratio = row.value / row.baselineValue;

    rows.push(row);
  }

  const gates = rows.filter((r) => r.kind === 'gate');
  const blocked = gates.some((r) => r.pass === false);
  const costRow = rows.find((r) => r.id === 'cost');

  return {
    rows,
    verdict: {
      blocked,
      blockedBy: gates.filter((r) => r.pass === false).map((r) => r.id),
      costRatio: costRow?.ratio ?? null,
      // Only quantities this slot actually moved. A slot that does not touch the
      // wave field should not be credited with improving it.
      physics: rows
        .filter((r) => r.better === 'near' && typeof r.movedCloser === 'boolean')
        .map((r) => ({ id: r.id, movedCloser: r.movedCloser, error: r.error, baselineError: r.baselineError })),
      unchanged: rows.filter((r) => r.movedCloser === 'unchanged').map((r) => r.id),
      // Deliberately absent: any claim about which one looks better.
      needsPreference: !blocked,
    },
  };
}

// Which budgets can this variant even be considered for.
export function eligibleBudgets(champions, costRatio) {
  if (costRatio == null) return [];
  return Object.entries(champions.budgets)
    .filter(([, b]) => costRatio <= b.maxCostRatio)
    .map(([id]) => id);
}
