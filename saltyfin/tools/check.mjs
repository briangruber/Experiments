#!/usr/bin/env node
// Parse-check every source file, then import them all in a jsdom-free stub so
// module-level mistakes surface without booting a browser.
//
//   node tools/check.mjs            all of src/
//   node tools/check.mjs src/water  just that subtree

import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const start = process.argv[2] ? resolve(ROOT, process.argv[2]) : join(ROOT, 'src');

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) await walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = (await stat(start)).isDirectory() ? await walk(start) : [start];
let bad = 0;
for (const f of files.sort()) {
  try {
    await run(process.execPath, ['--check', f]);
    process.stdout.write(`ok   ${f.slice(ROOT.length + 1)}\n`);
  } catch (e) {
    bad++;
    process.stdout.write(`FAIL ${f.slice(ROOT.length + 1)}\n${e.stderr || e.message}\n`);
  }
}
console.log(`\n${files.length - bad}/${files.length} parsed`);
process.exit(bad ? 1 : 0);
