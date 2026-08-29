// Shared plumbing: a static server for the prototype folder, and a Chromium
// that actually launches. Both tools need them; neither should own them.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = [
  'playwright',
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  '/usr/lib/node_modules/playwright/index.mjs',
  process.env.PLAYWRIGHT_PATH,
].filter(Boolean);

export async function launch(opts = {}) {
  const fails = [];
  for (const c of CANDIDATES) {
    try {
      const mod = await import(c);
      return await mod.chromium.launch({ args: ['--disable-dev-shm-usage'], ...opts });
    } catch (e) { fails.push(`${c}: ${String(e.message).split('\n')[0]}`); }
  }
  throw new Error('no launchable Chromium:\n  ' + fails.join('\n  '));
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.json': 'application/json',
};

export async function serve() {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'index.html' : url);
    try {
      const body = await readFile(path);
      const type = MIME[extname(path)] || 'application/octet-stream';
      // Without the charset the em dashes in the source come back as mojibake,
      // which looks like a bundler bug and is not one.
      const charset = /^(text|application\/(javascript|json))/.test(type) ? '; charset=utf-8' : '';
      res.writeHead(200, { 'content-type': type + charset });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((r) => server.listen(0, r));
  return { server, port: server.address().port, close: () => server.close() };
}
