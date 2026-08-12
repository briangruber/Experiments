// Copies the three.js files DEADLIGHT needs into vendor/.
//
//   npm install three@0.185.1 && node tools/vendor.mjs
//
// The repository rule is that a prototype runs by serving its own folder with
// no build step, so three is vendored rather than resolved from node_modules.
// Entry points are listed below; their relative imports are followed
// transitively, so adding an addon here pulls in whatever it depends on.

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vendor');

/** Where node_modules/three lives — override with --three <path>. */
const argIdx = process.argv.indexOf('--three');
const SRC = argIdx === -1
  ? path.join(ROOT, 'node_modules', 'three')
  : path.resolve(process.argv[argIdx + 1]);

/** Bundles copied verbatim. `three` and `three/webgpu` share one file: the
 *  WebGPU build re-exports all of core, so mapping both at it keeps a single
 *  copy of three in the page (two would break `instanceof` checks). */
const BUNDLES = [
  ['build/three.webgpu.min.js', 'three.webgpu.min.js'],
  // The WebGPU bundle imports core rather than inlining it. Missing this
  // fails only at runtime, as a 404 that stops the whole module graph, so
  // `verifyBundles` below re-derives the list and refuses to finish if a
  // future three release adds another sibling.
  ['build/three.core.min.js', 'three.core.min.js'],
  ['build/three.tsl.min.js', 'three.tsl.min.js'],
];

/** Addon entry points. Relative imports are followed from here. */
const ADDONS = [
  'loaders/GLTFLoader.js',
  'tsl/display/BloomNode.js',
  'tsl/display/FilmNode.js',
  'tsl/display/ChromaticAberrationNode.js',
];

const BARE = new Set(['three', 'three/webgpu', 'three/tsl', 'three/tsl/display']);

/** Every relative specifier in an ES module, import and re-export alike. */
function relativeImports(source) {
  const out = new Set();
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  const side = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const re2 of [re, side]) {
    let m;
    while ((m = re2.exec(source))) {
      const spec = m[1];
      if (spec.startsWith('.')) out.add(spec);
      else if (!BARE.has(spec)) {
        throw new Error(`unexpected bare import "${spec}" — add it to BARE or vendor it`);
      }
    }
  }
  return out;
}

async function walk(rel, seen) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const from = path.join(SRC, 'examples/jsm', rel);
  if (!existsSync(from)) throw new Error(`missing addon: ${rel}`);
  const source = await readFile(from, 'utf8');
  const to = path.join(OUT, 'addons', rel);
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, source);
  for (const spec of relativeImports(source)) {
    await walk(path.normalize(path.join(path.dirname(rel), spec)), seen);
  }
}

/**
 * Confirm every relative import inside the copied bundles resolves to a file
 * that was also copied. The bundles are minified, so this is a regex over
 * `from"./x.js"` rather than a parse — which is enough, because a bundle only
 * ever imports its own siblings.
 */
async function verifyBundles() {
  const copied = new Set(BUNDLES.map(([, to]) => to));
  for (const [, name] of BUNDLES) {
    const source = await readFile(path.join(OUT, name), 'utf8');
    for (const m of source.matchAll(/(?:from|import)\s*['"](\.\/[^'"]+)['"]/g)) {
      const target = m[1].slice(2);
      if (!copied.has(target)) {
        throw new Error(
          `${name} imports "${m[1]}" which was not vendored — add build/${target} to BUNDLES`,
        );
      }
    }
  }
}

async function main() {
  if (!existsSync(SRC)) {
    throw new Error(`three not found at ${SRC} — run: npm install three@0.185.1`);
  }
  const version = JSON.parse(await readFile(path.join(SRC, 'package.json'), 'utf8')).version;

  await mkdir(OUT, { recursive: true });
  for (const [from, to] of BUNDLES) {
    await copyFile(path.join(SRC, from), path.join(OUT, to));
  }
  await verifyBundles();

  const seen = new Set();
  for (const entry of ADDONS) await walk(entry, seen);

  await writeFile(
    path.join(OUT, 'VERSION'),
    `three@${version}\nvendored by tools/vendor.mjs\n`,
  );
  console.log(`vendored three@${version}: ${BUNDLES.length} bundles, ${seen.size} addon modules`);
  for (const rel of [...seen].sort()) console.log(`  addons/${rel}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
