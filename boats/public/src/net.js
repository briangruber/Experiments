// Thin websocket wrapper: typed handlers, an outbound rate limit for the
// position stream, and a reconnect that does not lose your progress (the server
// keys saved state to the token we send on join).

export class Net {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.ready = false;
    this.queue = [];
    this.token = localStorage.getItem('hh-token') || crypto.randomUUID();
    localStorage.setItem('hh-token', this.token);
    this.lastState = 0;
    this.reconnectDelay = 800;
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
