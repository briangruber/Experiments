// Harpoon & Hold -- game server.
//
//   node server.js [--port 8080]
//
// This file is only transport: it serves the client out of ./public and pipes
// WebSocket messages into the world in shared/sim.js. The simulation itself
// knows nothing about sockets, which is what lets the identical code run inside
// the browser for solo play.

import http from 'node:http';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from './lib/ws.js';
import { createWorld } from './shared/sim.js';
import { WORLD, BOATS, MONSTERS } from './shared/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');

const argv = process.argv.slice(2);
const PORT = Number(getArg('--port') ?? process.env.PORT ?? 8080);
const HOST = getArg('--host') ?? process.env.HOST ?? '0.0.0.0';

function getArg(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/* ------------------------------------------------------------------ static */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    let file;
    if (pathname.startsWith('/shared/')) {
      file = path.join(SHARED, pathname.slice('/shared/'.length));
      if (!file.startsWith(SHARED)) return send(res, 403, 'forbidden');
    } else {
      file = path.join(PUBLIC, pathname);
      if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
    }

    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, 'not found');
    send(res, 500, 'server error');
  }
});

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}


/* ------------------------------------------------------------------- world */

const world = createWorld();

attachWebSocketServer(server, {
  path: '/ws',
  onConnection(conn) {
    let player = null;
    conn.on('message', (msg) => {
      try {
        if (!player) {
          if (msg.t !== 'join') return;
          player = world.join(conn, msg);
          return;
        }
        world.handle(player, msg);
      } catch (err) {
        console.error('message error', err);
      }
    });
    conn.on('close', () => world.leave(player));
  },
});

setInterval(() => world.step(), 1000 / WORLD.tickRate);

/* ------------------------------------------------------------------ listen */

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Harpoon & Hold — ${MONSTERS.length} monsters, ${BOATS.length} hulls, ${world.monsterCount} beasts already circling.\n`);
  console.log(`  You:        http://localhost:${PORT}`);
  for (const ip of localAddresses()) {
    console.log(`  Same wifi:  http://${ip}:${PORT}   <- phones and friends type this`);
  }
  console.log('');
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
