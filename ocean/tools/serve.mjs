#!/usr/bin/env node
// Static server for local development, with a rebuild-and-reload watch.
//
//   node tools/serve.mjs [--port 8080]
//
// ES modules will not load over file://, so the demo and the examples both need
// something serving them. Pages load as they are on disk. Edits under demo/,
// src/, or the HTML shells rebuild dist/abyssal-three.html (the inlined bundle
// the HUD lives in) and tell every open tab to reload.

import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = +argOf('port', 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

const RELOAD_SNIPPET = Buffer.from(
  '<script>(function(){var e=new EventSource("/__reload");'
  + 'e.onmessage=function(){location.reload()};})();</script>\n',
);

const clients = new Set();

const server = createServer(async (req, res) => {
  try {
    const raw = req.url.split('?')[0];
    if (raw === '/__reload') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(':\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    let url = decodeURIComponent(raw);
    if (url.endsWith('/')) url += 'index.html';
    const path = normalize(join(ROOT, url));
    // Normalise first, then check: without this, /../../etc/passwd escapes ROOT.
    if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(path);
    if (info.isDirectory()) { res.writeHead(302, { location: url + '/' }).end(); return; }
    let body = await readFile(path);
    const type = MIME[extname(path)] || 'application/octet-stream';
    if (type.startsWith('text/html')) body = Buffer.concat([body, RELOAD_SNIPPET]);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const ping = () => {
  for (const c of clients) c.write('data: reload\n\n');
};

let debounce = null;
let building = false;
let quietUntil = 0;
let lastKey = '';

const walkStamp = async (dir, acc) => {
  const ents = await readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      await walkStamp(p, acc);
    } else if (/\.(js|mjs|css|html)$/.test(e.name)) {
      const s = await stat(p);
      acc.push(`${p}:${s.size}:${Math.round(s.mtimeMs)}`);
    }
  }
  return acc;
};

const sourceKey = async () => {
  const acc = [];
  await walkStamp(join(ROOT, 'demo'), acc);
  await walkStamp(join(ROOT, 'src'), acc);
  try {
    const s = await stat(join(ROOT, 'three.html'));
    acc.push(`three.html:${s.size}:${Math.round(s.mtimeMs)}`);
  } catch { /* optional */ }
  return acc.sort().join('|');
};

const rebuildThenReload = async () => {
  if (building) return;
  building = true;
  quietUntil = Date.now() + 2500;
  try {
    const key = await sourceKey();
    if (key === lastKey) {
      building = false;
      return;
    }
    lastKey = key;
  } catch (e) {
    building = false;
    console.log('watch: stamp failed', e.message);
    return;
  }
  const started = Date.now();
  console.log('watch: rebuilding dist/abyssal-three.html');
  const child = spawn(process.execPath, [join(ROOT, 'tools/bundle-three.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    quietUntil = Date.now() + 2500;
    building = false;
    if (code === 0) {
      console.log(`watch: reload (${Date.now() - started} ms, ${clients.size} tab${clients.size === 1 ? '' : 's'})`);
      ping();
    } else {
      console.log(`watch: bundle failed (exit ${code})`);
    }
  });
};

const relevant = (file) => file && /\.(js|mjs|css|html)$/.test(file)
  && !file.includes('node_modules')
  && !file.includes('.git')
  && !file.startsWith('dist');

const onChange = (file) => {
  if (!relevant(file)) return;
  if (building || Date.now() < quietUntil) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => { rebuildThenReload(); }, 400);
};

for (const dir of ['demo', 'src']) {
  watch(join(ROOT, dir), { recursive: true }, (_ev, file) => onChange(file));
}
watch(join(ROOT, 'three.html'), () => onChange('three.html'));

server.listen(PORT, async () => {
  lastKey = await sourceKey();
  console.log(`Abyssal serving ${ROOT}`);
  console.log(`  demo      http://localhost:${PORT}/`);
  console.log(`  three     http://localhost:${PORT}/three.html`);
  console.log(`  bundle    http://localhost:${PORT}/dist/abyssal-three.html`);
  console.log(`  examples  http://localhost:${PORT}/examples/`);
  console.log('  watch     demo/ src/ → rebuild bundle + reload tabs');
});
