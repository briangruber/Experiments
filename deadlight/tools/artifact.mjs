// Builds DEADLIGHT as one self-contained HTML file.
//
//   node tools/artifact.mjs [--out dist/deadlight.html] [--texture 512]
//
// The target is a Claude Artifact, which is served under a policy that permits
// no requests at all — no scripts, no fonts, no images, no fetch, not even to
// the origin the page came from. Everything therefore has to be *in* the file:
// three.js and the addons bundled into one module, the stylesheet inlined, and
// every generated GLB embedded as base64 and handed to GLTFLoader.parse rather
// than fetched (see AssetLibrary#loadAll).
//
// The same constraint bans the import map the served build relies on, which is
// why this bundles rather than concatenates: `three`, `three/webgpu`,
// `three/tsl` and `three/addons/*` are resolved to vendor/ by the plugin below.
// Both `three` and `three/webgpu` resolve to the same file on purpose — two
// copies of three in one page breaks every `instanceof` in the renderer.
//
// Textures are re-encoded smaller than the served build. base64 costs a third
// on top of the bytes it carries, and the whole point of this file is that
// somebody can open it.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const OUT = path.resolve(ROOT, flag('out', 'dist/deadlight.html'));
/** Texture edge for the creature and mannequins; props get half. */
const TEXTURE = Number(flag('texture', 512));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

// ------------------------------------------------------------------ bundle

/** Maps the bare specifiers the served build gets from its import map. */
const vendorPlugin = {
  name: 'deadlight-vendor',
  setup(build) {
    const vendor = path.join(ROOT, 'vendor');
    build.onResolve({ filter: /^three$|^three\/webgpu$/ }, () => ({
      path: path.join(vendor, 'three.webgpu.min.js'),
    }));
    build.onResolve({ filter: /^three\/tsl$/ }, () => ({
      path: path.join(vendor, 'three.tsl.min.js'),
    }));
    build.onResolve({ filter: /^three\/addons\// }, (a) => ({
      path: path.join(vendor, 'addons', a.path.replace('three/addons/', '')),
    }));
  },
};

async function bundleScript() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/main.js')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false,
    plugins: [vendorPlugin],
  });
  return result.outputFiles[0].text;
}

// ------------------------------------------------------------------ assets

/** Assemble a GLB from a glTF JSON object and its binary chunk. */
function packGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + bin.length + binPad;

  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);

  let at = 12;
  out.writeUInt32LE(jsonBuf.length + jsonPad, at);
  out.writeUInt32LE(0x4e4f534a, at + 4); // 'JSON'
  jsonBuf.copy(out, at + 8);
  // The JSON chunk pads with spaces, the binary chunk with zeroes.
  out.fill(0x20, at + 8 + jsonBuf.length, at + 8 + jsonBuf.length + jsonPad);
  at += 8 + jsonBuf.length + jsonPad;

  out.writeUInt32LE(bin.length + binPad, at);
  out.writeUInt32LE(0x004e4942, at + 4); // 'BIN\0'
  Buffer.from(bin).copy(out, at + 8);
  out.fill(0, at + 8 + bin.length, at + 8 + bin.length + binPad);

  return out;
}

/**
 * Re-encode one asset smaller, with its textures as `data:` URIs, and return
 * it as base64.
 *
 * The data: URIs are the point. A normal GLB keeps its images in the binary
 * chunk, and GLTFLoader hands those to the decoder by wrapping each one in a
 * Blob and fetching the resulting `blob:` URL. Under an artifact's policy that
 * fetch is the single most likely thing to be refused — and when it is, every
 * texture in the game fails while the geometry loads perfectly, which reads as
 * a rendering bug rather than a policy one. Writing the images as `data:`
 * instead skips blob entirely, and `data:` is the scheme artifacts are built
 * around.
 *
 * Geometry stays in the binary chunk, so the mesh data costs no request at all.
 *
 * Reading the already-optimised asset rather than assets/raw keeps this build
 * independent of raw output, which is gitignored. It is a second lossy pass on
 * an already lossy texture, which at these sizes is invisible in a corridor lit
 * by one torch, and it is the difference between a file that opens and one that
 * does not.
 */
async function embedAsset(file, size) {
  const doc = await io.read(path.join(ROOT, 'assets', file));
  await doc.transform(
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 78 }),
    // Quantization halves the geometry, which is what dominates this build
    // once the textures are down — and unlike meshopt or Draco it needs no
    // decoder in the page, because three reads KHR_mesh_quantization natively.
    // Positions stay at 14 bits: the monsters are skinned, and coarser
    // quantization shows up as a mesh that shimmers as it animates.
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
    prune({ keepAttributes: false, keepLeaves: false }),
  );

  const { json, resources } = await io.writeJSON(doc);

  // Images become data: URIs; the buffer becomes the GLB's binary chunk.
  for (const image of json.images ?? []) {
    if (!image.uri) continue;
    const bytes = resources[image.uri];
    if (!bytes) continue;
    const mime = image.mimeType ?? (image.uri.endsWith('.png') ? 'image/png' : 'image/webp');
    image.uri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }

  const bufferDef = json.buffers?.[0];
  const bin = bufferDef?.uri ? resources[bufferDef.uri] : new Uint8Array(0);
  if (bufferDef) {
    delete bufferDef.uri;
    bufferDef.byteLength = bin.length;
  }

  return packGlb(json, bin).toString('base64');
}

async function embedAssets() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
  const files = {};

  let before = 0;
  let after = 0;
  for (const [key, meta] of Object.entries(manifest.assets)) {
    const size = meta.role === 'prop' ? Math.round(TEXTURE / 2) : TEXTURE;
    const base64 = await embedAsset(meta.file, size);
    files[meta.file] = base64;

    before += (await stat(path.join(ROOT, 'assets', meta.file))).size;
    after += Math.ceil((base64.length * 3) / 4);
    console.log(`  ${key.padEnd(14)} ${size}px  ${mb(after)} cumulative`);
  }
  console.log(`  assets ${mb(before)} → ${mb(after)} before base64`);

  // `taskId` and `prompt` are provenance for the repository, not for a page
  // somebody is about to play; they are several kilobytes of nothing here.
  const slim = { assets: {} };
  for (const [key, meta] of Object.entries(manifest.assets)) {
    const { taskId, prompt, ...rest } = meta;
    slim.assets[key] = rest;
  }

  return { manifest: slim, files };
}

// -------------------------------------------------------------------- page

/**
 * The page body, taken from index.html.
 *
 * An artifact is wrapped in its own document skeleton at publish time, so the
 * doctype, the import map and the module tag all come out; the markup between
 * them is the same DOM the served build uses, which is what keeps the two
 * builds from drifting apart.
 */
async function pageBody() {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  return html
    .replace(/<!doctype html>/i, '')
    .replace(/<meta charset[^>]*>/i, '')
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<link rel="stylesheet"[^>]*>/i, '')
    .replace(/<script type="importmap">[\s\S]*?<\/script>/i, '')
    .replace(/<script type="module"[^>]*><\/script>/i, '')
    .replace(/<!-- Inline, so the page[\s\S]*?-->/i, '')
    // The artifact platform sets its own tab icon.
    .replace(/<link rel="icon"[^>]*>/i, '')
    .trim();
}

async function main() {
  console.log('bundling…');
  const [script, css, body] = await Promise.all([
    bundleScript(),
    readFile(path.join(ROOT, 'src/ui.css'), 'utf8'),
    pageBody(),
  ]);
  console.log(`  script ${mb(script.length)}`);

  console.log('embedding assets…');
  const assets = await embedAssets();

  const page = `<title>DEADLIGHT</title>
<style>
${css}
/* The artifact is embedded, so it owns the whole frame and nothing scrolls. */
html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
</style>

${body}

<script>
// Every mesh in the game, base64-encoded. AssetLibrary picks these up instead
// of fetching, because the page is served under a policy that allows no
// requests at all.
window.__DEADLIGHT_ASSETS = ${JSON.stringify(assets)};
</script>

<script type="module">
${script}
</script>
`;

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, page);
  console.log(`\nwrote ${path.relative(ROOT, OUT)} · ${mb(page.length)}`);
  if (page.length > 16 * 1024 * 1024) {
    console.error('over the 16 MB artifact limit — lower --texture');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
