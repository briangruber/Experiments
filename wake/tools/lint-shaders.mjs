#!/usr/bin/env node
// Shader source lives inside JS template literals, so a stray backtick — most
// easily in a comment — silently ends the literal and the module stops parsing.
// The runtime error then names some identifier halfway down the shader and says
// nothing about backticks, which is a slow thing to track down twice.
//
// The failure is exactly "this file no longer parses", so that is what gets
// checked: imports are stripped (they need a bundler to resolve) and the rest
// is handed to the JS parser.
import { readdirSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// DISCOVERED, not listed. The list this replaces named eleven files under
// src/ and nothing under vendor/, so when a backtick went into a GLSL comment
// in the vendored water shader -- the exact bug this tool exists to catch,
// for the third time -- it reported "shaders ok" and the artifact shipped
// broken. A linter with a hand-written file list is a linter that stops
// covering the code the moment the code moves.
function walk(dir, out = []) {
  for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}
// vendor/three is minified upstream and has no GLSL of ours in it.
const FILES = [...walk('src'), ...walk('vendor/abyssal/src')];

let bad = 0;
// Parsed by NODE, not by a regex approximation of ES modules.
//
// The previous version stripped `export` with three hand-written patterns and
// fed the rest to new Function(). That handles the export forms someone
// thought of; `export default`, `export async function` and `export * from`
// all trip it, and every one of those reports as a parse failure in a file
// that is perfectly fine -- which trains you to ignore the tool. Copying to
// a .mjs and running node --check uses the real parser and has no opinions.
const tmp = await mkdtemp(join(tmpdir(), 'lint-shaders-'));
for (const f of FILES) {
  const src = await readFile(resolve(ROOT, f), 'utf8');
  const probe = join(tmp, 'probe.mjs');
  await writeFile(probe, src);
  const r = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || '').split('\n').find((l) => /SyntaxError/.test(l)) || 'parse failed';
    console.error(`${f}  ${msg.trim()}`);
    console.error('  (a backtick inside a shader template literal is the usual cause)');
    bad++;
  }
}
await rm(tmp, { recursive: true, force: true });
console.log(bad ? `FAIL: ${bad} file(s) do not parse` : `shaders ok (${FILES.length} files)`);
process.exit(bad ? 1 : 0);
