#!/usr/bin/env node
// Run the checkpoint capture set, one shot at a time (SwiftShader has no
// headroom for parallel browsers). Any failing shot fails the run.
//
//   node tools/shots.mjs                 the standard five
//   node tools/shots.mjs day night       just those
//   node tools/shots.mjs --prefix v2     writes shots/v2-day.png etc.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The checkpoint set: one framing per thing the concept art is about.
export const SETS = {
  harbor: ['--preset', 'day', '--cam', 'harbor', '--boat', '-62,14,-18', '--wait', '12000'],
  reef: ['--preset', 'day', '--cam', 'chase', '--boat', '-10,40,4', '--wait', '12000'],
  gameplay: ['--preset', 'afternoon', '--cam', 'chase', '--boat', '30,-60,18', '--wait', '12000', '--hud'],
  sunset: ['--preset', 'sunset', '--cam', 'harbor', '--boat', '-62,14,-14', '--wait', '12000'],
  night: ['--preset', 'night', '--cam', 'harbor', '--boat', '-20,-30,58', '--wait', '12000'],
  village: ['--preset', 'golden', '--cam', '-95,34,26,-150,26,-58,44', '--wait', '12000'],
  monster: ['--preset', 'afternoon', '--cam', 'overhead', '--boat', '60,-150,20', '--wait', '14000'],
};

const args = process.argv.slice(2);
// Anything that is not a flag and not the value of a flag is a shot name.
const FLAGS = new Set(['--prefix', '--w', '--h', '--quality']);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const names = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS.has(args[i - 1])));
const prefix = opt('--prefix', null) ? opt('--prefix') + '-' : '';
const want = names.length ? names : Object.keys(SETS);

const w = opt('--w', '1280');
const h = opt('--h', '720');
const quality = opt('--quality', 'med');

let failed = 0;
for (const name of want) {
  const extra = SETS[name];
  if (!extra) { console.error(`unknown shot: ${name}`); failed++; continue; }
  const out = `shots/${prefix}${name}.png`;
  process.stdout.write(`\n=== ${name} -> ${out}\n`);
  try {
    const { stdout } = await run(process.execPath,
      [join(ROOT, 'tools/shot.mjs'), '--out', out, '--w', w, '--h', h, '--quality', quality, ...extra],
      { cwd: ROOT, maxBuffer: 1 << 24 });
    const r = JSON.parse(stdout);
    console.log(`ok  luma ${r.meanLuma} +-${r.stdLuma}  sat ${r.meanSat}  frames ${r.frames}  hour ${r.hour}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error((e.stdout || '') + (e.stderr || '').slice(0, 4000));
  }
}
process.exit(failed ? 1 : 0);
