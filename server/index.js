'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room, C, TICK } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/* --------------------------------------------------------------- http */

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: totalPlayers() }));
  }

  const rel = path.normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('nope');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      // /ABCD room links are just the app again
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* -------------------------------------------------------------- rooms */

/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoom(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!c) return getRoom(makeCode());
  let room = rooms.get(c);
  if (!room) {
    room = new Room(c);
    rooms.set(c, room);
  }
  return room;
}

function totalPlayers() {
  let n = 0;
  for (const r of rooms.values()) n += r.humanCount();
  return n;
}

const clean = (s, max) =>
  [...String(s == null ? '' : s)]
    .filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)
    .join('').trim().slice(0, max);

/* ---------------------------------------------------------- websockets */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.pid = null;
  ws.on('pong', () => { ws.isAlive = true; });

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* client is gone */ }
    }
  };
  ws.sendJSON = send;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString().slice(0, 4096)); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (ws.room) leave(ws);
      const room = getRoom(m.room);
      const name = clean(m.name, 14) || 'Blob';
      const emoji = clean(m.emoji, 8) || '🙂';
      const id = 'p_' + crypto.randomBytes(6).toString('hex');
      const p = room.add(id, name, emoji, ws);
      if (!p) return send({ t: 'err', msg: 'That room is full — try a new one.' });

      ws.room = room;
      ws.pid = id;
      send({ t: 'welcome', id, code: room.code, max: C.MAX_PLAYERS });
      broadcast(room, room.meta());
      room.metaDirty = false;
      return;
    }

    const room = ws.room;
    if (!room) return;
    const me = room.players.get(ws.pid);
    if (!me) return;

    switch (m.t) {
      case 'in': {
        const x = Number(m.x) || 0;
        const y = Number(m.y) || 0;
        const mag = Math.hypot(x, y);
        me.input.x = mag > 1 ? x / mag : x;
        me.input.y = mag > 1 ? y / mag : y;
        if (m.d) me.input.dash = true;
        break;
      }
      case 'emote':
        me.emote = Math.max(1, Math.min(6, Number(m.i) || 1));
        me.emoteT = 1.6;
        break;
      case 'bot':
        if (room.addBot()) broadcast(room, room.meta());
        break;
      case 'nobots':
        room.removeBots();
        broadcast(room, room.meta());
        break;
      case 'ping':
        send({ t: 'pong', s: m.s });
        break;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.remove(ws.pid);
  ws.room = null;
  ws.pid = null;
  if (room.players.size === 0 || room.humanCount() === 0) {
    room.removeBots();
    if (room.players.size === 0) {
      room.state = 'lobby';
      room.round = 0;
    }
  }
  broadcast(room, room.meta());
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const [id, sock] of room.sockets) {
    if (!room.players.has(id)) continue;
    if (sock.readyState === sock.OPEN) {
      try { sock.send(msg); } catch { /* ignore */ }
    }
  }
}

/* ----------------------------------------------------------- game loop */

const SNAP_INTERVAL = 1 / C.SNAPSHOT_HZ;
let last = Date.now();

setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25; // don't let a stalled process teleport everyone

  for (const [code, room] of rooms) {
    room.update(dt);
    room.tick++;

    room.snapAccum += dt;
    if (room.snapAccum >= SNAP_INTERVAL) {
      room.snapAccum = 0;
      if (room.metaDirty) {
        broadcast(room, room.meta());
        room.metaDirty = false;
      }
      broadcast(room, room.snapshot());
      room.events.length = 0;
    }

    if (room.humanCount() === 0 && now - room.emptySince > 60_000) {
      rooms.delete(code);
    }
  }
}, TICK * 1000);

// drop half-open connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { leave(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 20_000);

server.listen(PORT, () => {
  console.log(`\n  💣  BOMB BLOBS running → http://localhost:${PORT}\n`);
});

module.exports = { server, rooms };
