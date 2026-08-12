// Static file server for local development.
//
//   node tools/serve.mjs [--port 8080] [--root .]
//
// There is no build step; this exists because WebGPU is only exposed in a
// secure context, and `file://` is not one. `http://localhost` is, so the game
// has to be served even though nothing is being compiled.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const ROOT = path.resolve(flag('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const PORT = Number(flag('port', 8080));

/**
 * `--csp` serves under a policy close to the one a published Artifact gets:
 * inline script and style, `data:` for anything embedded, and no host allowed
 * anywhere — not even this one. It exists so the single-file build
 * (tools/artifact.mjs) can be proved to run under those rules *before* it is
 * published, rather than discovered to be broken afterwards.
 *
 * `blob:` is listed because that is how GLTFLoader hands an embedded texture
 * to the decoder; if a real artifact turns out to forbid it, this is the line
 * that has to change.
 */
function buildCsp({ blob }) {
  const embedded = blob ? 'data: blob:' : 'data:';
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src ${embedded}`,
    `media-src ${embedded}`,
    'font-src data:',
    `connect-src ${embedded}`,
    ...(blob ? ['worker-src blob:'] : []),
  ].join('; ');
}

const CSP = args.includes('--csp') || args.includes('--csp-noblob')
  ? buildCsp({ blob: !args.includes('--csp-noblob') })
  : null;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';

    const file = path.join(ROOT, rel);
    // Refuse anything that escapes the served root.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: `${rel}/` }).end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      ...(CSP ? { 'Content-Security-Policy': CSP } : {}),
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`deadlight → http://localhost:${PORT}/${CSP ? '  (strict CSP)' : ''}`);
});
