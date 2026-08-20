// Static server for the prototype folder. Shared by every tool here so a
// headless capture loads exactly the files a browser would.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

export function serve(root = ROOT) {
  return new Promise((res) => {
    const server = createServer(async (req, rq) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
        const file = join(root, rel === '/' ? 'index.html' : rel);
        if (!file.startsWith(root)) { rq.writeHead(403).end(); return; }
        const body = await readFile(file);
        rq.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
        rq.end(body);
      } catch {
        rq.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}
