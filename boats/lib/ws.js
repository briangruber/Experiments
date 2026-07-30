// A small RFC 6455 server. The game sends short JSON messages and nothing else,
// so this covers exactly that: text frames, continuation frames, ping/pong and
// a clean close. No dependencies means `node server.js` is the whole setup.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 256 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOp = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this._finish());
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  send(data) {
    if (!this.open) return;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    try {
      this.socket.write(encodeFrame(OP_TEXT, payload));
    } catch {
      this.destroy();
    }
  }

  ping() {
    if (!this.open) return;
    try {
      this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)));
    } catch {
      this.destroy();
    }
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OP_CLOSE, body));
    } catch { /* socket already gone */ }
    this.open = false;
    this.socket.end();
  }

  destroy() {
    this.open = false;
    try { this.socket.destroy(); } catch { /* already destroyed */ }
    this._finish();
  }

  _finish() {
    if (this._finished) return;
    this._finished = true;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const frame = decodeFrame(this._buf);
      if (!frame) return;
      if (frame.error) { this.close(frame.code || 1002, frame.error); return; }
      this._buf = this._buf.subarray(frame.consumed);
      this._handleFrame(frame);
      if (!this.open) return;
    }
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case OP_PING:
        try { this.socket.write(encodeFrame(OP_PONG, frame.payload)); } catch { this.destroy(); }
        return;
      case OP_PONG:
        this.alive = true;
        return;
      case OP_CLOSE:
        this.close(1000);
        return;
      case OP_TEXT:
      case OP_BIN:
        if (frame.fin) { this._deliver(frame.opcode, frame.payload); return; }
        this._fragOp = frame.opcode;
        this._fragments = [frame.payload];
        return;
      case OP_CONT: {
        if (!this._fragOp) { this.close(1002, 'unexpected continuation'); return; }
        this._fragments.push(frame.payload);
        const total = this._fragments.reduce((n, b) => n + b.length, 0);
        if (total > MAX_PAYLOAD) { this.close(1009, 'message too large'); return; }
        if (!frame.fin) return;
        const op = this._fragOp;
        const payload = Buffer.concat(this._fragments);
        this._fragments = [];
        this._fragOp = 0;
        this._deliver(op, payload);
        return;
      }
      default:
        this.close(1002, 'bad opcode');
    }
  }

  _deliver(opcode, payload) {
    this.alive = true;
    if (opcode !== OP_TEXT) return; // the game speaks JSON only
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      return; // a malformed frame is not worth dropping a player over
    }
    if (msg && typeof msg === 'object') this.emit('message', msg);
  }
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(MAX_PAYLOAD)) return { error: 'message too large', code: 1009, consumed: 0 };
    len = Number(big);
    offset += 8;
  }
  if (len > MAX_PAYLOAD) return { error: 'message too large', code: 1009, consumed: 0 };
  if (!masked) return { error: 'client frames must be masked', code: 1002, consumed: 0 };
  if (buf.length < offset + 4 + len) return null;

  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
  return { fin, opcode, payload, consumed: offset + len };
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload], header.length + len);
}

/**
 * Attach a websocket endpoint to an existing http server.
 * @param {import('node:http').Server} server
 * @param {{ path?: string, onConnection: (conn: WebSocketConnection, req) => void }} opts
 */
export function attachWebSocketServer(server, { path = '/ws', onConnection }) {
  const connections = new Set();

  server.on('upgrade', (req, socket) => {
    const url = req.url ? req.url.split('?')[0] : '';
    const key = req.headers['sec-websocket-key'];
    if (url !== path || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const conn = new WebSocketConnection(socket);
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    onConnection(conn, req);
  });

  // Drop sockets that stop answering rather than letting ghost boats sail on.
  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (!conn.alive) { conn.destroy(); continue; }
      conn.alive = false;
      conn.ping();
    }
  }, 15000);
  heartbeat.unref?.();

  return { connections };
}
