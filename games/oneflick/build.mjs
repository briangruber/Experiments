/* Bundles three.js + the game into ONE self-contained index.html.
   Required because the Artifact CSP blocks every external host, so a CDN
   <script> tag would silently fail to load. */
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const r = await esbuild.build({
  entryPoints: [join(here, 'src/main.js')],
  bundle: true, minify: true, format: 'iife', target: 'es2020',
  write: false, legalComments: 'none',
});
const js = r.outputFiles[0].text;
const html = readFileSync(join(here, 'template.html'), 'utf8').replace('/*BUNDLE*/', () => js);
writeFileSync(join(here, 'index.html'), html);
console.log('index.html  ' + (html.length/1024).toFixed(0) + ' KB  (js ' + (js.length/1024).toFixed(0) + ' KB)');
