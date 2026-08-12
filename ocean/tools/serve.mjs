#!/usr/bin/env node
// Static server for local development.
//
//   node tools/serve.mjs [--port 8080]
//
// ES modules will not load over file://, so the demo and the examples both need
// something serving them. There is no build step - this hands out the sources as
// they are.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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
};

const server = createServer(async (req, res) => {
  try {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url.endsWith('/')) url += 'index.html';
    const path = normalize(join(ROOT, url));
    // Normalise first, then check: without this, /../../etc/passwd escapes ROOT.
    if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(path);
    if (info.isDirectory()) { res.writeHead(302, { location: url + '/' }).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`Abyssal serving ${ROOT}`);
  console.log(`  demo      http://localhost:${PORT}/`);
  console.log(`  examples  http://localhost:${PORT}/examples/`);
});
