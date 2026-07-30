'use strict';

/**
 * Builds dist/solo.html — a single self-contained page you can open anywhere,
 * with no server and no network.
 *
 * It is NOT a reimplementation. It inlines `server/game.js` and `public/game.js`
 * verbatim and slots a fake WebSocket between them: the real simulation runs in
 * a timer in the same tab and hands the real client the same `meta` and `s`
 * messages the real server would have sent over the wire. One source of truth
 * for physics, so the practice build can't drift from the networked game.
 *
 *   npm run build:solo   →   dist/solo.html
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const sim = read('server', 'game.js');
const client = read('public', 'game.js');
const css = read('public', 'style.css');
const html = read('public', 'index.html');

// Pull the markup out of the real page so the HUD can never fall out of sync
// with the client script that drives it.
const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

if (!body.includes('id="stage"')) throw new Error('could not extract the page markup');

/* Offline trims: nothing here should promise multiplayer it cannot deliver. */
const SOLO_CSS = `
/* ---- practice build ---- */
#invite, #lobbycopy, #start .field.small { display: none; }
#solobadge {
  position: fixed;
  left: 14px;
  top: 14px;
  z-index: 30;
  padding: 6px 11px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 2px;
  color: var(--dim);
  background: rgba(10, 8, 26, 0.7);
  border: 1px solid var(--edge);
  border-radius: 8px;
  pointer-events: none;
}
#feed { top: 52px; }
@media (prefers-reduced-motion: reduce) {
  #feed div { animation: none; }
}
`;

const SOLO_BADGE = '<div id="solobadge">PRACTICE BUILD · YOU vs BOTS</div>';

/**
 * The shim. Mirrors the message handling in server/index.js, minus anything
 * that only matters when there is a real socket on the other end.
 */
const SHIM = `
(() => {
  'use strict';
  const { Room, C, TICK } = window.__BB_SIM;

  const room = new Room('SOLO');
  let socket = null;
  let ids = 0;

  const emit = (obj) => {
    if (socket && socket.onmessage) socket.onmessage({ data: JSON.stringify(obj) });
  };

  class LocalSocket {
    constructor() {
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      socket = this;
      setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }, 0);
    }

    send(raw) {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'join') {
        const id = 'p_' + (++ids);
        const p = room.add(id, String(m.name || 'Blob').slice(0, 14), m.emoji || '🙂', null);
        if (!p) return emit({ t: 'err', msg: 'That room is full.' });
        this.pid = id;
        // Nobody else is coming, so stock the arena immediately.
        for (let i = 0; i < 3; i++) room.addBot();
        emit({ t: 'welcome', id, code: 'SOLO', max: C.MAX_PLAYERS });
        emit(room.meta());
        room.metaDirty = false;
        return;
      }

      const me = room.players.get(this.pid);
      if (!me) return;

      if (m.t === 'in') {
        const x = Number(m.x) || 0;
        const y = Number(m.y) || 0;
        const mag = Math.hypot(x, y);
        me.input.x = mag > 1 ? x / mag : x;
        me.input.y = mag > 1 ? y / mag : y;
        if (m.d) me.input.dash = true;
      } else if (m.t === 'emote') {
        me.emote = Math.max(1, Math.min(6, Number(m.i) || 1));
        me.emoteT = 1.6;
      } else if (m.t === 'bot') {
        if (room.addBot()) { emit(room.meta()); room.metaDirty = false; }
      }
    }

    close() { this.readyState = 3; }
  }

  window.WebSocket = LocalSocket;

  let last = performance.now();
  let acc = 0;
  setInterval(() => {
    if (!socket) return;
    const now = performance.now();
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;   // a backgrounded tab must not teleport anyone

    room.update(dt);
    room.tick++;

    acc += dt;
    if (acc >= 1 / C.SNAPSHOT_HZ) {
      acc = 0;
      if (room.metaDirty) { emit(room.meta()); room.metaDirty = false; }
      emit(room.snapshot());
      room.events.length = 0;
    }
  }, TICK * 1000);
})();
`;

// Everything below <body>, shared by both outputs.
const CONTENT = `<title>BOMB BLOBS — practice build</title>
<style>
${css}
${SOLO_CSS}
</style>
${SOLO_BADGE}
${body}
<script>
window.__BB_SIM = (() => {
  const module = { exports: {} };
${sim}
  return module.exports;
})();
</script>
<script>
${SHIM}
</script>
<script>
${client}
</script>
`;

const standalone = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0b0a1a">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💣</text></svg>">
</head>
<body>
${CONTENT}</body>
</html>
`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });

const write = (name, text) => {
  const dest = path.join(ROOT, 'dist', name);
  fs.writeFileSync(dest, text);
  console.log(`built ${dest} (${(text.length / 1024).toFixed(0)} KB)`);
};

// A complete document you can double-click, and a bare-content variant for
// hosts that supply their own <html>/<head>/<body> wrapper.
write('solo.html', standalone);
write('solo.fragment.html', CONTENT);
