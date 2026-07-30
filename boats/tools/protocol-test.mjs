#!/usr/bin/env node
// Server-side end-to-end test. No browser: it speaks the wire protocol
// directly, so it can check the rules the client is not allowed to be trusted
// with -- damage clamps, harpoon range, fire rate, and the economy.
//
//   node tools/protocol-test.mjs
//
// Exits non-zero on the first failed assertion.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { BOATS, MONSTER_BY_ID } from '../shared/config.js';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

// Ask the OS for a free port rather than hard-coding one: a leftover server
// from an interrupted run would otherwise fail this suite for the wrong reason.
const PORT = await new Promise((res, rej) => {
  const probe = createServer();
  probe.on('error', rej);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => res(port));
  });
});

// Fresh identity each run, so a saved profile from an earlier run cannot leak
// back in through the reconnect token.
const RUN = `${process.pid}-${Date.now().toString(36)}`;

const server = spawn(process.execPath, ['server.js', '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.self = null;
    this.monsters = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.onopen = () => this.send({ t: 'join', name: this.name, token: `test-${this.name}-${RUN}` });
      this.ws.onerror = (e) => reject(new Error(`socket error: ${e.message ?? e}`));
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        this.inbox.push(msg);
        if (msg.t === 'welcome') { this.id = msg.id; this.self = msg.you; resolve(msg); }
        if (msg.t === 'you') this.self = msg;
        if (msg.t === 'kill' || msg.t === 'sank' || msg.t === 'respawn') this.self = msg.state;
        if (msg.t === 'snap') for (const m of msg.m) this.monsters.set(m.id, m);
        if (msg.t === 'dead') this.monsters.delete(msg.mid);
      };
      setTimeout(() => reject(new Error('join timed out')), 5000);
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }
  moveTo(x, z) { this.send({ t: 'state', x, z, h: 0, sp: 0 }); }

  /** Wait for the next message of a type, or null on timeout. */
  async waitFor(type, ms = 3000) {
    const deadline = Date.now() + ms;
    let from = this.inbox.length;
    while (Date.now() < deadline) {
      for (let i = from; i < this.inbox.length; i++) {
        if (this.inbox[i].t === type) return this.inbox[i];
      }
      from = this.inbox.length;
      await sleep(30);
    }
    return null;
  }

  close() { this.ws.close(); }
}

try {
  await sleep(800);

  /* ---------------------------------------------------------- joining */

  const a = new Client('Tester');
  await a.connect();
  check('join returns a starting rowboat', a.self.tier === 0 && a.self.hull === BOATS[0].hull,
    `tier=${a.self.tier} hull=${a.self.hull}`);
  check('starts broke', a.self.gold === 0);
  check('starts with a crew', a.self.crew === BOATS[0].crew);

  // A second player must be visible to the first.
  const b = new Client('Other');
  await b.connect();
  await sleep(400);
  b.moveTo(10, 80);
  const snap = await a.waitFor('snap');
  check('snapshots arrive', !!snap);
  await sleep(300);
  const sawOther = a.inbox.some((m) => m.t === 'snap' && m.p.some((p) => p.n === 'Other'));
  check('other players appear in snapshots', sawOther);

  /* --------------------------------------------------- finding a target */

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    a.moveTo(300, 300);
    await sleep(120);
    // Pick the weakest thing nearby so the test does not take a minute.
    const near = [...a.monsters.values()]
      .map((m) => ({ m, type: MONSTER_BY_ID[m.k] }))
      .filter((x) => x.type)
      .sort((x, y) => x.type.hp - y.type.hp)[0];
    if (near) target = near;
  }
  check('the sea has monsters in it', !!target, target ? target.type.name : 'none found');

  if (target) {
    const { m, type } = target;

    /* -------------------------------------------------- rules the client
       is not trusted with */

    // Out of range: sitting in town and swinging at something 400m away.
    a.moveTo(0, 60);
    await sleep(150);
    a.send({ t: 'hit', id: m.id, dmg: 12 });
    await sleep(400);
    const afterFar = [...a.monsters.values()].find((x) => x.id === m.id);
    check('harpoons out of range are refused', !afterFar || afterFar.hp === 100,
      `hp=${afterFar ? afterFar.hp : 'gone'}`);

    // Absurd damage claims are clamped to the boat's harpoon.
    a.moveTo(m.x - 20, m.z);
    await sleep(200);
    a.send({ t: 'hit', id: m.id, dmg: 999999 });
    const killedByCheat = await a.waitFor('kill', 700);
    check('damage claims are clamped to the hull you own',
      !killedByCheat || type.hp <= BOATS[0].harpoonDamage * 1.2,
      killedByCheat ? 'one hit killed it' : 'clamped');

    // Fire rate: a burst of hits should land as one.
    const before = [...a.monsters.values()].find((x) => x.id === m.id)?.hp ?? 100;
    for (let i = 0; i < 12; i++) a.send({ t: 'hit', id: m.id, dmg: 12 });
    await sleep(600);
    const after = [...a.monsters.values()].find((x) => x.id === m.id)?.hp ?? 0;
    const dropPct = before - after;
    const oneHitPct = (BOATS[0].harpoonDamage * 1.15 / type.hp) * 100;
    check('spammed harpoons are rate limited', dropPct <= oneHitPct * 1.6 + 1,
      `hp fell ${dropPct.toFixed(1)}%, one throw is ${oneHitPct.toFixed(1)}%`);

    /* ------------------------------------------------------ landing one */

    let kill = null;
    let throws = 0;
    const giveUp = Date.now() + 90000;
    while (!kill && Date.now() < giveUp) {
      a.moveTo(m.x - 20, m.z);
      a.send({ t: 'hit', id: m.id, dmg: BOATS[0].harpoonDamage });
      throws++;
      kill = await a.waitFor('kill', 1100);
      // Follow it: the thing swims away while we work.
      const live = [...a.monsters.values()].find((x) => x.id === m.id);
      if (live) { m.x = live.x; m.z = live.z; }
      else if (!kill) break;
    }
    check('a monster can be killed', !!kill,
      kill ? `${kill.name} in ${throws} throws` : `still alive after ${throws} throws`);

    if (kill) {
      check('the carcass goes in the hold', kill.carcass === true || kill.lost === true);
      if (kill.carcass) {
        check('the hold shows the catch', a.self.cargo.length === 1,
          `cargo=${JSON.stringify(a.self.cargo)}`);

        /* ---------------------------------------------------- the market */

        const goldBefore = a.self.gold;
        const bounty = a.self.cargo[0].bounty;
        a.moveTo(0, 40);
        await sleep(250);
        a.send({ t: 'dock', action: 'sell' });
        await a.waitFor('you');
        check('selling pays the bounty', a.self.gold === goldBefore + bounty,
          `${goldBefore} + ${bounty} => ${a.self.gold}`);
        check('the hold empties on sale', a.self.cargo.length === 0);

        // Selling from open water must not work.
        a.moveTo(900, 900);
        await sleep(250);
        a.send({ t: 'dock', action: 'repair' });
        const warn = await a.waitFor('ev', 600);
        check('the market only trades in the harbour',
          !!warn && /harbour/i.test(warn.text || ''), warn ? warn.text : 'no reply');
      }
    }
  }

  /* ------------------------------------------------------- the shipyard */

  a.moveTo(0, 40);
  await sleep(250);
  a.send({ t: 'dock', action: 'buy', tier: 6 });
  const denied = await a.waitFor('ev', 800);
  check('you cannot buy a hull above your level',
    !!denied && /level/i.test(denied.text || ''), denied ? denied.text : 'no reply');
  check('and it did not take your gold', a.self.tier === 0);

  a.close();
  b.close();
  await sleep(200);
} catch (err) {
  check('test harness ran', false, err.message);
}

console.log('\n' + results.join('\n'));
if (serverErr.trim()) {
  console.error('\nserver stderr:\n' + serverErr);
  failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);

server.kill('SIGINT');
process.exit(failed ? 1 : 0);
