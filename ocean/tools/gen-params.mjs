#!/usr/bin/env node
// Generates docs/parameters.md from the parameter set itself.
//
//   node tools/gen-params.mjs > docs/parameters.md
//
// Written rather than hand-maintained because there are close to four hundred
// parameters and a hand-written table is wrong the first time someone adds one.
// Values come from src/presets.js (the source of truth); labels, ranges and
// grouping come from the demo's presentation schema.

import { defaults, PRESETS } from '../src/presets.js';
import { SCHEMA } from '../demo/schema.js';

const fmt = (v) => {
  if (v === undefined) return '—';
  if (typeof v === 'number') return `\`${Number.isInteger(v) ? v : +v.toFixed(4)}\``;
  if (typeof v === 'boolean' || typeof v === 'string') return `\`${v}\``;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `\`[${Array.from(v).map((x) => +(+x).toFixed(3)).join(', ')}]\``;
  return `\`${String(v)}\``;
};

const range = (it) => {
  if (it.type === 'range') return `${+it.min} … ${+it.max}`;
  if (it.type === 'bool') return 'on / off';
  if (it.type === 'enum') return it.options.map((o) => `\`${o}\``).join(', ');
  if (it.type === 'color') return 'linear RGB';
  return '';
};

const out = [];
out.push('# Parameter reference');
out.push('');
out.push('Every knob, with its default and its useful range. Generated from the');
out.push('parameter set by `npm run docs:params` — do not edit by hand.');
out.push('');
out.push('A parameter set is a plain object. Read and write it directly:');
out.push('');
out.push('```js');
out.push("import { newParams } from 'abyssal-ocean';");
out.push('');
out.push("const params = newParams('Storm Front');");
out.push('params.windSpeed = 18;');
out.push('water.rebuild();          // sea-state changes need the spectrum rebuilt');
out.push('```');
out.push('');
out.push('Parameters marked **rebuild** describe the sea itself rather than how it is');
out.push('shaded, so changing one needs `water.rebuild()`. Parameters marked **grid**');
out.push('need `water.rebuildGrid()`.');
out.push('');

const documented = new Set();
for (const group of SCHEMA) {
  out.push(`## ${group.group}`);
  out.push('');
  out.push('| parameter | meaning | default | range | |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const it of group.items) {
    if (!it.key) continue;
    documented.add(it.key);
    const flags = [];
    if (it.rebuild || it.rebuildSim) flags.push('**rebuild**');
    if (it.rebuildGrid) flags.push('**grid**');
    if (it.resize) flags.push('**resize**');
    out.push(`| \`${it.key}\` | ${it.label} | ${fmt(defaults[it.key])} | ${range(it)} | ${flags.join(' ')} |`);
  }
  out.push('');
}

const undocumented = Object.keys(defaults).filter((k) => !documented.has(k));
if (undocumented.length) {
  out.push('## Not exposed in the demo UI');
  out.push('');
  out.push('Settable, but with no control panel entry — mostly internals and');
  out.push('derived values.');
  out.push('');
  out.push('| parameter | default |');
  out.push('| --- | --- |');
  for (const k of undocumented) out.push(`| \`${k}\` | ${fmt(defaults[k])} |`);
  out.push('');
}

out.push('## Presets');
out.push('');
out.push('Sparse overrides on top of `defaults`. Anything a preset does not mention');
out.push('comes back from the defaults, so switching presets never leaves a stray');
out.push('value behind.');
out.push('');
out.push('| preset | overrides |');
out.push('| --- | --- |');
for (const [name, over] of Object.entries(PRESETS)) {
  out.push(`| \`${name}\` | ${Object.keys(over).length} |`);
}
out.push('');

console.log(out.join('\n'));
