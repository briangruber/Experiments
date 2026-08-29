#!/usr/bin/env node
// Which sliders on the panel are wired to anything?
//
// Every param is declared in src/params.js and reached with get('group.key').
// A param nothing ever reads is a control that cannot do anything, and there is
// no way to tell that by looking at the panel -- which is the whole problem.
// So: enumerate the declarations, grep the source for each key, and report the
// ones with no reader. Mechanical, and it cannot be fooled by a slider that
// LOOKS like it ought to work.
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const src = await readFile(join(ROOT, 'src/params.js'), 'utf8');
// Walk the declaration text: "group: {" then "  key: { v: ..." lines under it.
const groups = [];
let cur = null;
for (const line of src.split('\n')) {
  const g = line.match(/^\s{2}([A-Za-z_]\w*):\s*\{\s*$/);
  if (g) { cur = { name: g[1], keys: [] }; groups.push(cur); continue; }
  if (/^\s{2}\},?\s*$/.test(line)) { cur = null; continue; }
  const k = line.match(/^\s{4}([A-Za-z_]\w*):\s*\{\s*v:/);
  if (k && cur) cur.keys.push({ key: k[1], line: line.trim() });
}

// Every file that could read a param.
const files = [];
async function walk(d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const p = join(d, e.name);
    if (e.isDirectory()) await walk(p);
    else if (/\.(js|mjs)$/.test(e.name) && !p.endsWith('src/params.js')) files.push(p);
  }
}
await walk(join(ROOT, 'src'));
await walk(join(ROOT, 'vendor'));
await walk(join(ROOT, 'tools'));
const blobs = await Promise.all(files.map(async (f) => [f, await readFile(f, 'utf8')]));

const dead = [], live = [];
for (const g of groups) {
  for (const { key, line } of g.keys) {
    const path = `${g.name}.${key}`;
    const readers = blobs.filter(([, t]) => t.includes(`'${path}'`) || t.includes(`"${path}"`))
                         .map(([f]) => f.replace(ROOT + '/', ''));
    // A hit only in tools/ is a probe reading it, not the app using it.
    const appReaders = readers.filter((f) => !f.startsWith('tools/'));
    (appReaders.length ? live : dead).push({ path, label: (line.match(/label:\s*'([^']*)'/) || [])[1],
                                             readers: appReaders, toolsOnly: readers.length && !appReaders.length });
  }
}
console.log(JSON.stringify({
  groups: groups.map((g) => ({ name: g.name, n: g.keys.length })),
  totalParams: live.length + dead.length,
  deadCount: dead.length,
  dead,
}, null, 2));
