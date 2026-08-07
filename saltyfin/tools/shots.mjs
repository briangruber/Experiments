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

export const SETS = {
  day: ['--preset', 'day', '--cam', 'harbor', '--boat', '-40,0,10', '--wait', '9000'],
  gameplay: ['--preset', 'day', '--cam', 'chase', '--wait', '9000', '--hud'],
  sunset: ['--preset', 'sunset', '--cam', 'harbor', '--boat', '-40,0,6', '--wait', '9000'],
  night: ['--preset', 'night', '--cam', 'harbor', '--boat', '-40,0,6', '--wait', '9000'],
  monster: ['--preset', 'afternoon', '--cam', 'overhead', '--wait', '11000'],
  reef: ['--preset', 'day', '--cam', 'close', '--wait', '9000'],
};

const args = process.argv.slice(2);
const pi = args.indexOf('--prefix');
const prefix = pi >= 0 ? args[pi + 1] + '-' : '';
const names = args.filter((a, i) => !a.startsWith('--') && i !== pi + 1);
const want = names.length ? names : Object.keys(SETS);

const w = args.includes('--w') ? args[args.indexOf('--w') + 1] : '1280';
const h = args.includes('--h') ? args[args.indexOf('--h') + 1] : '720';

let failed = 0;
for (const name of want) {
  const extra = SETS[name];
  if (!extra) { console.error(`unknown shot: ${name}`); failed++; continue; }
  const out = `shots/${prefix}${name}.png`;
  process.stdout.write(`\n=== ${name} -> ${out}\n`);
  try {
    const { stdout } = await run(process.execPath,
      [join(ROOT, 'tools/shot.mjs'), '--out', out, '--w', w, '--h', h, ...extra],
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
