#!/usr/bin/env node
/*
 * Halcyon relay — the optional part.
 *
 * The prototype works with no server at all: tabs find each other over a
 * BroadcastChannel and the rest of the room is simulated. This exists for
 * the one case that cannot cover, which is two people at two computers.
 *
 *   node tools/relay.mjs                    # 127.0.0.1:8790, this machine only
 *   node tools/relay.mjs --host 0.0.0.0     # your network, with a warning
 *   node tools/relay.mjs --port 9000
 *   node tools/relay.mjs --blocklist words.txt
 *
 * Deliberate properties, so that running it is a small decision and not a
 * large one:
 *
 *   - binds to loopback unless you say otherwise, and says so loudly
 *   - no dependencies: the WebSocket handshake and framing are below
 *   - keeps nothing. No log of message contents, no file on disk, no
 *     history replayed to anyone who joins. Close it and it is gone.
 *   - caps: connection count, message size, message rate, name length
 *   - forwards only the message shapes the client speaks, and drops the
 *     rest rather than trusting them
 *
 * It is a relay, not a service. It has no accounts and no moderation of
 * its own; the client does that, and everybody on the wire can see
 * everything. Do not put it on the public internet.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const LIMITS = {
  maxClients: 24,
  maxFrameBytes: 4096,
  maxTextChars: 500,
  burst: 8,             // messages allowed back to back
  refillMs: 1200,       // one credit back per this long
  idleMs: 90_000,       // silent connections are dropped
};

const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

const ALLOWED = new Set(['hello', 'beat', 'bye', 'chat', 'join', 'part', 'typing', 'im', 'botroster']);

/* ── arguments ───────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const host = arg('host', '127.0.0.1');
const port = Number(arg('port', '8790'));
const blocklistPath = arg('blocklist', '');

let blocklist = [];
if (blocklistPath) {
  try {
    blocklist = readFileSync(blocklistPath, 'utf8')
      .split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#'));
  } catch (e) {
    console.error('could not read blocklist ' + blocklistPath + ': ' + e.message);
    process.exit(1);
  }
}

/* ── server ──────────────────────────────────────────────────────────── */

const clients = new Set();

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Halcyon relay. ' + clients.size + ' connected.\n' +
          'This endpoint speaks WebSocket. Point the sign-on screen at it.\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || clients.size >= LIMITS.maxClients) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  attach(socket);
});

function attach(socket) {
  const client = {
    socket,
    buf: Buffer.alloc(0),
    skip: 0,
    credits: LIMITS.burst,
    lastSeen: Date.now(),
    alive: true,
  };
  clients.add(client);
  console.log('+ connection (' + clients.size + ' total)');

  socket.on('data', chunk => {
    client.buf = Buffer.concat([client.buf, chunk]);

    // An oversized frame is thrown away as it arrives rather than
    // disconnecting whoever sent it: one long paste should not end a
    // conversation.
    if (client.skip > 0) {
      const drop = Math.min(client.skip, client.buf.length);
      client.skip -= drop;
      client.buf = client.buf.subarray(drop);
    }

    let frame;
    while (client.skip === 0 && (frame = readFrame(client.buf))) {
      client.buf = client.buf.subarray(frame.consumed);
      if (frame.oversize) {
        client.skip = frame.oversize;
        const drop = Math.min(client.skip, client.buf.length);
        client.skip -= drop;
        client.buf = client.buf.subarray(drop);
        continue;
      }
      if (frame.opcode === 0x8) return close(client);          // close
      if (frame.opcode === 0x9) { send(client, frame.payload, 0xA); continue; } // ping
      if (frame.opcode !== 0x1) continue;                      // text only
      handle(client, frame.payload.toString('utf8'));
    }
  });

  socket.on('error', () => close(client));
  socket.on('close', () => close(client));
}

function close(client) {
  if (!client.alive) return;
  client.alive = false;
  clients.delete(client);
  try { client.socket.destroy(); } catch {}
  console.log('- connection (' + clients.size + ' total)');
}

/* ── message handling ────────────────────────────────────────────────── */

function handle(client, text) {
  const now = Date.now();
  client.credits = Math.min(LIMITS.burst,
    client.credits + (now - client.lastSeen) / LIMITS.refillMs);
  client.lastSeen = now;
  if (client.credits < 1) return;                 // dropped, silently
  client.credits -= 1;

  if (text.length > LIMITS.maxFrameBytes) return;

  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg !== 'object' || !ALLOWED.has(msg.t)) return;

  const clean = sanitise(msg);
  if (!clean) return;

  const out = Buffer.from(JSON.stringify(clean), 'utf8');
  for (const other of clients) if (other !== client && other.alive) send(other, out, 0x1);
}

/** Rebuild the envelope from known fields only. Nothing else travels. */
function sanitise(msg) {
  const str = (v, n) => typeof v === 'string'
    ? v.replace(CTRL, '').slice(0, n) : undefined;

  const out = { t: msg.t };
  const peer = str(msg.peer, 24);
  if (!peer) return null;
  out.peer = peer;

  const from = str(msg.from, 26); if (from !== undefined) out.from = from;
  const room = str(msg.room, 24); if (room !== undefined) out.room = room;
  const name = str(msg.name, 26); if (name !== undefined) out.name = name;
  const to = str(msg.to, 26);     if (to !== undefined) out.to = to;
  const kind = str(msg.kind, 12); if (kind !== undefined) out.kind = kind;
  if (typeof msg.on === 'boolean') out.on = msg.on;
  if (typeof msg.bot === 'boolean') out.bot = msg.bot;
  if (typeof msg.staff === 'boolean') out.staff = msg.staff;
  if (typeof msg.suspicious === 'boolean') out.suspicious = msg.suspicious;

  if (Array.isArray(msg.rooms))
    out.rooms = msg.rooms.slice(0, 12).map(r => str(r, 24)).filter(Boolean);
  if (Array.isArray(msg.names))
    out.names = msg.names.slice(0, 12).map(n => str(n, 26)).filter(Boolean);

  if (msg.text !== undefined) {
    const text = str(msg.text, LIMITS.maxTextChars);
    if (text === undefined) return null;
    if (blocklist.length && hitsBlocklist(text)) return null;
    out.text = text;
  }
  return out;
}

function hitsBlocklist(text) {
  const norm = text.toLowerCase()
    .replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o').replace(/[$5]/g, 's').replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
  return blocklist.some(w => norm.includes(w));
}

/* ── WebSocket framing ───────────────────────────────────────────────── */

/**
 * Reads one frame out of `buf`, or null when it is not all here yet.
 * A frame longer than the cap comes back as `{ oversize }` with only its
 * header consumed, so the caller can discard the body as it streams in.
 */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off); off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off); off += 8;
    len = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
  }

  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen) return null;

  if (len > LIMITS.maxFrameBytes) return { consumed: off + maskLen, oversize: len };
  if (buf.length < off + maskLen + len) return null;

  const mask = masked ? buf.subarray(off, off + 4) : null;
  off += maskLen;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

  return { consumed: off + len, opcode, payload };
}

function send(client, payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    return;                                    // we never send anything this big
  }
  try { client.socket.write(Buffer.concat([header, data])); } catch { close(client); }
}

/* ── housekeeping ────────────────────────────────────────────────────── */

setInterval(() => {
  const cut = Date.now() - LIMITS.idleMs;
  for (const c of clients) if (c.lastSeen < cut) close(c);
}, 15_000).unref();

server.listen(port, host, () => {
  const url = 'ws://' + (host === '0.0.0.0' ? localAddress() : host) + ':' + port;
  console.log('Halcyon relay listening on ' + url);
  console.log('Tick "Connect through a relay" on the sign-on screen and put that address in.');
  console.log('');
  if (host === '127.0.0.1' || host === 'localhost') {
    console.log('Bound to loopback: only this machine can connect.');
    console.log('Pass --host 0.0.0.0 to let other machines on your network in.');
  } else {
    console.log('!! Bound to ' + host + '. Anything that can reach this machine on port ' +
      port + ' can join,');
    console.log('!! read every message, and send as any screen name. There are no accounts');
    console.log('!! and no server-side moderation. Use it on a network you trust, and stop');
    console.log('!! it when you are done. Never expose it to the public internet.');
  }
  console.log('');
  console.log('Nothing is written to disk and no message contents are logged.');
  if (blocklist.length) console.log('Blocklist loaded: ' + blocklist.length + ' terms.');
  console.log('Ctrl-C to stop.');
});

function localAddress() {
  for (const list of Object.values(networkInterfaces()))
    for (const net of list || [])
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return '<this machine>';
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down; ' + clients.size + ' connection(s) closed, nothing kept');
    for (const c of [...clients]) close(c);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300).unref();
  });
}
