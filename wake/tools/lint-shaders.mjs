#!/usr/bin/env node
// Shader source lives inside JS template literals, so a stray backtick — most
// easily in a comment — silently ends the literal and the module stops parsing.
// The runtime error then names some identifier halfway down the shader and says
// nothing about backticks, which is a slow thing to track down twice.
//
// The failure is exactly "this file no longer parses", so that is what gets
// checked: imports are stripped (they need a bundler to resolve) and the rest
// is handed to the JS parser.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['src/ocean.js', 'src/wakeField.js', 'src/noise.js',
               'src/params.js', 'src/main.js', 'src/ui.js', 'src/boat.js'];

let bad = 0;
for (const f of FILES) {
  const src = await readFile(resolve(ROOT, f), 'utf8');
  const body = src
    .replace(/^\s*import\s[^;]*;/gm, '')
    .replace(/^\s*export\s+(const|let|var|function|class)\s/gm, '$1 ')
    .replace(/^\s*export\s*\{[^}]*\};?/gm, '');
  try {
    new Function(body);
  } catch (e) {
    console.error(`${f}  ${e.message}`);
    console.error('  (a backtick inside a shader template literal is the usual cause)');
    bad++;
  }
}
console.log(bad ? `FAIL: ${bad} file(s) do not parse` : `shaders ok (${FILES.length} files)`);
process.exit(bad ? 1 : 0);
