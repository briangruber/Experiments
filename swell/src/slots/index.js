// The registry. Every variant in the project is imported here, grouped by slot,
// and assembled into one shader.
//
// Adding a variant means adding a file and one line to VARIANTS. Nothing else in
// the project needs to know it exists.

import { SLOTS, CONTRACTS, PREAMBLE } from './contracts.js';

import * as skySingleScatter from './sky/single-scatter.js';
import * as shorelineBeachRamp from './shoreline/beach-ramp.js';
import * as spectrumJonswap from './spectrum/jonswap-gerstner.js';
import * as spectrumSine from './spectrum/sine-sum.js';
import * as breakingFoldRidge from './breaking/fold-ridge.js';
import * as breakingSlope from './breaking/slope-threshold.js';
import * as foamBubbleRaft from './foam/bubble-raft.js';
import * as waterAbsorbSss from './water/absorb-sss.js';

const ALL = [
  skySingleScatter,
  shorelineBeachRamp,
  spectrumJonswap,
  spectrumSine,
  breakingFoldRidge,
  breakingSlope,
  foamBubbleRaft,
  waterAbsorbSss,
];

export { SLOTS, CONTRACTS };

export const VARIANTS = Object.fromEntries(SLOTS.map((s) => [s, []]));
for (const mod of ALL) {
  if (!VARIANTS[mod.meta.slot]) throw new Error(`unknown slot "${mod.meta.slot}" in ${mod.meta.id}`);
  VARIANTS[mod.meta.slot].push(mod);
}

export function variant(slot, id) {
  const found = VARIANTS[slot].find((v) => v.meta.id === id);
  if (!found) throw new Error(`no variant "${id}" for slot "${slot}"`);
  return found;
}

// knobName -> uniform name. windSpeed becomes uWindSpeed; that is the whole rule.
export const uniformName = (key) => 'u' + key[0].toUpperCase() + key.slice(1);

// Knobs contributed by the selected variants, on top of the core set.
export function slotKnobs(selection) {
  const out = {};
  for (const slot of SLOTS) Object.assign(out, variant(slot, selection[slot]).knobs || {});
  return out;
}

export function slotSchema(selection) {
  const groups = [];
  for (const slot of SLOTS) {
    const v = variant(slot, selection[slot]);
    if (v.schema && v.schema.length) {
      groups.push({ group: `${slot}: ${v.meta.title}`, keys: v.schema, slot });
    }
  }
  return groups;
}

// Uniform declarations, generated from whatever knobs exist. A variant that adds
// a knob gets its uniform for free.
export function uniformBlock(knobs) {
  const lines = [];
  for (const [k, v] of Object.entries(knobs)) {
    const type = Array.isArray(v) ? (v.length === 3 ? 'vec3' : 'vec4') : 'float';
    lines.push(`uniform ${type} ${uniformName(k)};`);
  }
  return lines.join('\n');
}

// Assemble the slot chain. Order is fixed and meaningful: a slot may call any
// function defined by a slot earlier in the list.
export function assemble(selection, knobs) {
  const parts = [uniformBlock(knobs), PREAMBLE];
  for (const slot of SLOTS) {
    const v = variant(slot, selection[slot]);
    for (const sig of CONTRACTS[slot].provides) {
      const name = sig.match(/\b(sw_\w+)\s*\(/)[1];
      if (!new RegExp(`\\b${name}\\s*\\(`).test(v.glsl)) {
        throw new Error(`variant ${slot}/${v.meta.id} does not define ${sig}`);
      }
    }
    parts.push(`// ---- slot: ${slot} = ${v.meta.id} ${'-'.repeat(Math.max(0, 48 - slot.length - v.meta.id.length))}`);
    parts.push(v.glsl);
  }
  return parts.join('\n');
}

export const DEFAULT_SELECTION = {
  sky: 'single-scatter',
  shoreline: 'beach-ramp',
  spectrum: 'jonswap-gerstner',
  breaking: 'fold-ridge',
  foam: 'bubble-raft',
  water: 'absorb-sss',
};
