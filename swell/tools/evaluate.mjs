#!/usr/bin/env node
// Champion vs candidate, across the whole fixture matrix.
//
//   node tools/evaluate.mjs --slot breaking --variant my-new-thing
//   node tools/evaluate.mjs --slot spectrum --variant sine-sum --budget lean
//
// Writes submissions/<slot>-<variant>/ containing before/ and after/ frames,
// report.json, and sheet.html. That directory is the entire contents of a
// submission: a reviewer needs nothing else, and neither does a bot.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './browser.mjs';
import { collect } from './harness/collect.mjs';
import { score, eligibleBudgets } from './harness/scorecard.mjs';
import { sheetHtml } from './harness/sheet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const slot = opt('slot');
const candidateId = opt('variant');
if (!slot || !candidateId) {
  console.error('usage: evaluate.mjs --slot <slot> --variant <id> [--budget standard] [--out DIR] [--scenes a,b]');
  process.exit(2);
}

const domain = JSON.parse(await readFile(join(ROOT, 'domain.json'), 'utf8'));
const champions = JSON.parse(await readFile(join(ROOT, 'champions.json'), 'utf8'));
const budget = opt('budget', 'standard');
if (!champions.champions[budget]) {
  console.error(`unknown budget "${budget}" — have: ${Object.keys(champions.champions).join(', ')}`);
  process.exit(2);
}

const baseSelection = champions.champions[budget];
const championId = baseSelection[slot];
if (championId === candidateId) {
  console.error(`"${candidateId}" is already the ${budget} champion for ${slot}; nothing to compare`);
  process.exit(2);
}
const candSelection = Object.assign({}, baseSelection, { [slot]: candidateId });

const only = opt('scenes')?.split(',').map((s) => s.trim());
const fixtures = domain.fixtures
  .filter((f) => !only || only.includes(f.scene))
  .flatMap((f) => f.times.map((t) => ({ scene: f.scene, time: t })));

const outDir = resolve(ROOT, opt('out', join('submissions', `${slot}-${candidateId}`)));
await mkdir(join(outDir, 'before'), { recursive: true });
await mkdir(join(outDir, 'after'), { recursive: true });

const { width, height } = domain.capture;
console.log(`evaluating ${slot}: ${candidateId} against ${championId} (${budget}) over ${fixtures.length} fixtures`);

const h = await open({ width, height, scene: fixtures[0].scene });
const fatal = h.errors.filter((e) => !/favicon/i.test(e));
if (fatal.length) {
  console.error('page failed to load cleanly:\n' + fatal.slice(0, 6).join('\n'));
  await h.close();
  process.exit(1);
}

const runSide = async (selection, dir) => {
  const out = [];
  for (const f of fixtures) {
    process.stdout.write(`  ${dir.padEnd(6)} ${f.scene} t=${f.time}s\r`);
    const art = await collect(h.page, {
      scene: f.scene, time: f.time, variants: selection,
      width, height, options: domain.probe,
    });
    const name = `${f.scene}-t${String(f.time).replace('.', '_')}.png`;
    await writeFile(join(outDir, dir, name), art.png);
    art.image = `${dir}/${name}`;
    delete art.png;
    out.push(art);
  }
  process.stdout.write('\n');
  return out;
};

const baseline = await runSide(baseSelection, 'before');
const candidate = await runSide(candSelection, 'after');
await h.close();

const scorecard = score({ domain, candidate, baseline });
const costRatio = scorecard.verdict.costRatio;

const report = {
  generated: new Date().toISOString(),
  domain: domain.domain,
  slot,
  candidate: candidateId,
  champion: championId,
  budget,
  selection: { champion: baseSelection, candidate: candSelection },
  fixtures,
  verdict: scorecard.verdict,
  eligibleBudgets: eligibleBudgets(champions, costRatio),
  metrics: scorecard.rows.map((r) => ({
    id: r.id, title: r.title, kind: r.kind, unit: r.unit,
    candidate: r.value, champion: r.baselineValue,
    error: r.error ?? null, championError: r.baselineError ?? null,
    movedCloser: r.movedCloser ?? null, ratio: r.ratio ?? null,
    pass: r.pass, skipped: r.skipped,
    failures: r.failures,
  })),
};

const pairs = fixtures.map((f, i) => ({
  scene: f.scene, time: f.time,
  before: baseline[i].image, after: candidate[i].image,
}));

await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
await writeFile(join(outDir, 'sheet.html'), sheetHtml({
  meta: {
    slot, candidate: candidateId, champion: championId,
    generated: report.generated, renderer: 'chromium / swiftshader',
  },
  scorecard, pairs,
}));

// ---- console summary -------------------------------------------------------
const line = (s) => console.log(s);
line('');
for (const r of scorecard.rows) {
  const tag = r.kind === 'gate'
    ? (r.pass === false ? 'FAIL' : 'pass')
    : r.id === 'cost' && r.ratio ? `${r.ratio.toFixed(2)}x`
    : r.movedCloser == null ? '—'
    : r.movedCloser === 'unchanged' ? 'same'
    : (r.movedCloser ? 'closer' : 'further');
  const val = typeof r.value === 'number' ? r.value.toFixed(4) : '—';
  const ref = typeof r.baselineValue === 'number' ? r.baselineValue.toFixed(4) : '—';
  line(`  ${r.id.padEnd(14)} ${tag.padEnd(8)} candidate=${val.padEnd(10)} champion=${ref}`);
}
line('');
if (scorecard.verdict.blocked) {
  line(`BLOCKED by ${scorecard.verdict.blockedBy.join(', ')}.`);
} else {
  line(`Gates pass. Eligible budgets: ${report.eligibleBudgets.join(', ') || 'none — too expensive for every budget'}.`);
  line('Looks are not decided here. Open sheet.html and vote.');
}
line(`\nwrote ${outDir}`);
process.exit(scorecard.verdict.blocked && !has('no-fail') ? 1 : 0);
