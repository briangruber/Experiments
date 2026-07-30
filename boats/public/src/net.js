// Thin websocket wrapper: typed handlers, an outbound rate limit for the
// position stream, and a reconnect that does not lose your progress (the server
// keys saved state to the token we send on join).

function newToken() {
  return crypto.randomUUID?.() ?? `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export class Net {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.ready = false;
    this.queue = [];
    // Guarded: crypto.randomUUID needs a secure context, and localStorage can
    // throw outright in a locked-down or private-mode page.
    this.token = safeGet('hh-token') || newToken();
    safeSet('hh-token', this.token);
    this.lastState = 0;
    this.reconnectDelay = 800;
    this.transport = null;   // set when the world runs in this page
    this.solo = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, msg) {
    const list = this.handlers.get(type);
    if (list) for (const fn of list) fn(msg);
  }

  /** Dispatch a message as if it had arrived on the wire (used by solo play). */
  receive(msg) {
    if (msg.t === 'welcome' && this._resolveWelcome) {
      const r = this._resolveWelcome;
      this._resolveWelcome = null;
      r(msg);
    }
    this.emit(msg.t, msg);
  }

  /**
   * Play with the world running in this page. No socket, so this works from a
   * file:// page or a published single file, and it is the fallback when there
   * is no server to reach.
   */
  connectSolo(name, attach) {
    this.name = name;
    this.solo = true;
    return new Promise((resolve) => {
      this._resolveWelcome = resolve;
      attach(this);
      this.ready = true;
      this.transport.send({ t: 'join', name, token: this.token });
      for (const m of this.queue.splice(0)) this.transport.send(JSON.parse(m));
    });
  }

  connect(name) {
    this.name = name;
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try {
        ws = new WebSocket(`${proto}//${location.host}/ws`);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      let settled = false;

      ws.onopen = () => {
        this.ready = true;
        this.reconnectDelay = 800;
        ws.send(JSON.stringify({ t: 'join', name, token: this.token }));
        for (const m of this.queue.splice(0)) ws.send(m);
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === 'welcome' && !settled) { settled = true; resolve(msg); }
        this.emit(msg.t, msg);
      };
      // A solo world never reconnects to anything.
      if (this.transport) { settled = true; }
      ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error('could not reach the harbourmaster')); }
      };
      ws.onclose = () => {
        this.ready = false;
        this.emit('disconnected', {});
        if (settled) this.scheduleReconnect();
      };
    });
  }

  scheduleReconnect() {
    if (this._retry) return;
    this._retry = setTimeout(() => {
      this._retry = null;
      this.connect(this.name).catch(() => this.scheduleReconnect());
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(8000, this.reconnectDelay * 1.7);
  }

  send(obj) {
    if (this.transport) { this.transport.send(obj); return; }
    const json = JSON.stringify(obj);
    if (this.ws && this.ready && this.ws.readyState === 1) this.ws.send(json);
    else if (this.queue.length < 40) this.queue.push(json);
  }

  /** Position updates are throttled here rather than at every call site. */
  sendState(x, z, h, sp, hz = 12) {
    const now = performance.now();
    if (now - this.lastState < 1000 / hz) return;
    this.lastState = now;
    this.send({ t: 'state', x: +x.toFixed(2), z: +z.toFixed(2), h: +h.toFixed(3), sp: +sp.toFixed(2) });
  }
}
