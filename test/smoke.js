'use strict';

/**
 * End-to-end smoke test: boots the real server, joins with two real websocket
 * clients, adds bots, mashes inputs, and asserts a whole round plays out —
 * countdown, a live bomb, an explosion, and a winner.
 *
 *   npm test
 */

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DEADLINE = 190_000;

const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function client(room, name, emoji) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = {
    ws, id: null, code: null, meta: null, snaps: 0,
    states: new Set(), events: [], lastSnap: null,
    send: (o) => ws.readyState === 1 && ws.send(JSON.stringify(o)),
    ready: null,
  };
  c.ready = new Promise((resolve) => {
    ws.on('open', () => c.send({ t: 'join', room, name, emoji }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'welcome') { c.id = m.id; c.code = m.code; resolve(c); }
      else if (m.t === 'meta') c.meta = m;
      else if (m.t === 's') {
        c.snaps++;
        c.lastSnap = m;
        c.states.add(m.st);
        for (const e of m.ev || []) c.events.push(e);
      }
    });
    ws.on('error', (e) => { console.error('ws error', e.message); });
  });
  return c;
}

(async () => {
  console.log('\n💣  BOMB BLOBS smoke test\n');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d.toString(); });

  const kill = () => { try { server.kill('SIGKILL'); } catch { /* already gone */ } };
  const bail = setTimeout(() => {
    console.error('\nHard deadline hit.\n' + serverErr);
    kill();
    process.exit(1);
  }, DEADLINE);

  try {
    // --- server is up ------------------------------------------------------
    await waitFor('http listener', () => false, 600).catch(() => {});
    const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
    ok('server responds on /healthz', health.ok === true);

    const page = await fetch(BASE).then((r) => r.text());
    ok('serves the game page', page.includes('BOMB') && page.includes('game.js'));

    const deepLink = await fetch(`${BASE}/WXYZ`).then((r) => r.text());
    ok('room deep-links fall back to the app', deepLink.includes('game.js'));

    // --- two humans in one room -------------------------------------------
    const a = client('TEST', 'Alice', '🐸');
    const b = client('TEST', 'Bob', '🦊');
    await Promise.all([a.ready, b.ready]);
    ok('both clients joined', a.code === 'TEST' && b.code === 'TEST', `code ${a.code}`);
    ok('players get distinct ids', a.id !== b.id);

    await waitFor('roster sync', () => a.meta && a.meta.players.length === 2);
    ok('roster shows both players', a.meta.players.map((p) => p.name).sort().join(',') === 'Alice,Bob');
    const colors = new Set(a.meta.players.map((p) => p.color));
    ok('players get unique colors', colors.size === 2);

    // --- bots --------------------------------------------------------------
    a.send({ t: 'bot' });
    a.send({ t: 'bot' });
    await waitFor('bots to appear', () => a.meta && a.meta.players.length === 4);
    ok('bots can be added', a.meta.players.filter((p) => p.bot).length === 2);

    // --- the match runs ----------------------------------------------------
    await waitFor('snapshots', () => a.snaps > 5);
    ok('server streams snapshots', a.snaps > 5, `${a.snaps} received`);

    await waitFor('countdown', () => a.states.has('countdown'));
    ok('match auto-starts into countdown', true);

    await waitFor('playing', () => a.states.has('playing'), 15_000);
    ok('round goes live', true);

    // mash inputs so the humans actually move around
    const drive = setInterval(() => {
      for (const c of [a, b]) {
        const ang = Math.random() * Math.PI * 2;
        c.send({ t: 'in', x: Math.cos(ang), y: Math.sin(ang), d: Math.random() < 0.25 ? 1 : 0 });
      }
    }, 120);

    await waitFor('a fuse to be lit', () => a.events.some((e) => e.e === 'fuse'), 15_000);
    ok('a bomb gets assigned', true);

    await waitFor('bomb holder in snapshots',
      () => a.lastSnap && a.lastSnap.p.some((p) => (p[5] & 2) !== 0), 15_000);
    const holders = a.lastSnap.p.filter((p) => (p[5] & 2) !== 0).length;
    // DOUBLE TROUBLE rounds run two at once, so the range is the invariant.
    ok('a sane number of bombs are in play', holders >= 1 && holders <= 2, `${holders} holder(s)`);

    const moved = await (async () => {
      const first = a.lastSnap.p.find((p) => p[0] === a.id);
      const p0 = [first[1], first[2]];
      await sleep(1200);
      const now = a.lastSnap.p.find((p) => p[0] === a.id);
      return Math.hypot(now[1] - p0[0], now[2] - p0[1]) > 20;
    })();
    ok('inputs actually move a blob', moved);

    await waitFor('an explosion', () => a.events.some((e) => e.e === 'boom'), 60_000);
    ok('the fuse burns down and detonates', true);

    await waitFor('an elimination', () => a.events.some((e) => e.e === 'out'), 5_000);
    ok('explosions eliminate blobs', true);

    const outId = a.events.find((e) => e.e === 'out').id;
    await waitFor('a ghost', () => {
      const row = a.lastSnap.p.find((p) => p[0] === outId);
      return row && (row[5] & 64) !== 0;
    }, 5_000);
    ok('eliminated players become ghosts, not spectators', true);

    await waitFor('a winner', () => a.events.some((e) => e.e === 'win' || e.e === 'draw'), 45_000);
    const win = a.events.find((e) => e.e === 'win');
    ok('round resolves with a winner', !!win || a.events.some((e) => e.e === 'draw'),
      win ? `score now ${win.score}` : 'draw');

    ok('both clients saw the same events',
      b.events.filter((e) => e.e === 'boom').length > 0);

    clearInterval(drive);

    // --- next round --------------------------------------------------------
    await waitFor('a second round', () => a.events.filter((e) => e.e === 'round').length >= 2, 20_000);
    ok('a fresh round starts automatically', true);
    ok('everyone is revived for the new round',
      a.lastSnap.p.filter((p) => (p[5] & 1) !== 0).length === 4);

    // --- leaving -----------------------------------------------------------
    b.ws.close();
    await waitFor('roster shrink', () => a.meta.players.length === 3, 10_000);
    ok('leaving removes you from the roster', true);

    // --- input is sanitised -------------------------------------------------
    const evil = client('TEST', '<script>x</script>'.padEnd(40, '!'), '💀');
    await evil.ready;
    await waitFor('evil roster', () => a.meta.players.some((p) => p.name.includes('script')), 10_000);
    const ev = a.meta.players.find((p) => p.name.includes('script'));
    ok('long names are truncated server-side', ev.name.length <= 14, `"${ev.name}"`);
    evil.ws.close();

    a.ws.close();
  } catch (err) {
    ok('unexpected failure', false, err.message);
  }

  clearTimeout(bail);
  await sleep(300);
  kill();

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (serverErr.trim()) console.log('server stderr:\n' + serverErr);
  process.exit(failed.length ? 1 : 0);
})();
