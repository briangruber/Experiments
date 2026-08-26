/*
 * The wire.
 *
 * Two transports behind one interface:
 *
 *   local  — the default. Other browser tabs on this machine are real
 *            other users, found over BroadcastChannel; the rest of the
 *            room is simulated. Nothing leaves the browser. One tab is
 *            elected host and runs the simulation so every tab sees the
 *            same room.
 *
 *   relay  — an explicit opt-in. Talks to tools/relay.mjs over a
 *            WebSocket, which by default binds to localhost only. The
 *            simulation still runs (client side, host-elected) so a quiet
 *            room is never empty.
 *
 * Everything arriving from either transport is treated as untrusted: it
 * is length-capped, stripped of control characters, and only ever
 * rendered through textContent.
 */

import { PERSONAS, GUIDE, PHISHER, makeBrain, inflect, CHAIN_LETTERS, ASCII_ART }
  from '../apps/halcyon/people.js';
import { pick, chance, randInt } from './dom.js';
import { LIMITS } from './safety.js';
import { TRIVIA } from '../apps/halcyon/trivia.js';

const CHANNEL = 'halcyon-online-v1';
const HEARTBEAT = 2000;
const PEER_TTL = 6500;
const CTRL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const cap = (s, n = LIMITS.maxChars) => String(s ?? '').replace(CTRL, '').slice(0, n);

function emitter() {
  const map = new Map();
  return {
    on(ev, fn) {
      if (!map.has(ev)) map.set(ev, new Set());
      map.get(ev).add(fn);
      return () => map.get(ev).delete(fn);
    },
    emit(ev, data) {
      for (const fn of map.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } }
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────
   Net
   ───────────────────────────────────────────────────────────────────── */

export function createNet({ mode = 'local', screenName, relayUrl = '' } = {}) {
  const bus = emitter();
  const me = screenName;
  const peerId = Math.random().toString(36).slice(2, 10);

  const peers = new Map();          // peerId -> { name, rooms:Set, seen }
  const myRooms = new Set();
  let host = false;
  let bc = null, ws = null, beat = null, tick = null;
  let closed = false;

  const sim = createSimulation({
    say: (room, from, text, meta) => {
      const m = { t: 'chat', room, from, text: cap(text), bot: true, ...meta };
      send(m); deliver(m);
    },
    join: (room, name) => { const m = { t: 'join', room, name, bot: true }; send(m); deliver(m); },
    part: (room, name) => { const m = { t: 'part', room, name, bot: true }; send(m); deliver(m); },
    typing: (room, name, on) => { const m = { t: 'typing', room, name, on, bot: true }; send(m); deliver(m); },
    im: (to, from, text, meta) => {
      const m = { t: 'im', to, from, text: cap(text, LIMITS.imMaxChars), bot: true, ...meta };
      send(m); deliver(m);
    },
    roster: (room, names) => { const m = { t: 'botroster', room, names }; send(m); deliver(m); },
  });

  /* ── transport plumbing ───────────────────────────────────────────── */

  function send(msg) {
    const wire = { ...msg, from: msg.from ?? me, peer: peerId };
    if (bc) { try { bc.postMessage(wire); } catch {} }
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(wire)); } catch {} }
  }

  function receive(wire) {
    if (!wire || wire.peer === peerId) return;
    touchPeer(wire);
    switch (wire.t) {
      case 'hello':
        send({ t: 'beat', rooms: [...myRooms] });   // tell the newcomer we exist
        deliver(wire);
        break;
      case 'beat': break;
      case 'bye': peers.delete(wire.peer); rosterChanged(); electHost(); break;
      case 'chat': case 'join': case 'part': case 'typing': case 'im': case 'botroster':
        deliver(wire); break;
    }
    if (host) sim.observe(wire);
  }

  function touchPeer(wire) {
    if (!wire.peer) return;
    const isNew = !peers.has(wire.peer);
    const p = peers.get(wire.peer) || { rooms: new Set() };
    if (wire.from && !wire.bot) p.name = wire.from;
    p.seen = Date.now();
    if (wire.rooms) p.rooms = new Set(wire.rooms);
    if (wire.t === 'join' && !wire.bot) p.rooms.add(wire.room);
    if (wire.t === 'part' && !wire.bot) p.rooms.delete(wire.room);
    peers.set(wire.peer, p);
    if (isNew) { rosterChanged(); electHost(); }
    else if (wire.rooms || wire.t === 'join' || wire.t === 'part') rosterChanged();
  }

  function prune() {
    const cut = Date.now() - PEER_TTL;
    let gone = false;
    for (const [id, p] of peers) if (p.seen < cut) { peers.delete(id); gone = true; }
    if (gone) { rosterChanged(); electHost(); }
  }

  /** Lowest peer id wins. Deterministic, and re-runs whenever peers change. */
  function electHost() {
    const ids = [peerId, ...peers.keys()].sort();
    const nowHost = ids[0] === peerId;
    if (nowHost === host) return;
    host = nowHost;
    sim.setActive(host);
    bus.emit('host', { host });
  }

  /* ── delivery to the app ──────────────────────────────────────────── */

  function deliver(wire) {
    switch (wire.t) {
      case 'chat':
        bus.emit('chat', {
          room: wire.room,
          from: cap(wire.from, LIMITS.nameMax + 10),
          text: cap(wire.text, LIMITS.imMaxChars),
          kind: wire.kind || 'say',
          bot: !!wire.bot, staff: !!wire.staff,
          self: wire.from === me && !wire.bot,
        });
        break;
      case 'join':
        bus.emit('join', { room: wire.room, name: cap(wire.name), bot: !!wire.bot });
        rosterChanged(); break;
      case 'part':
        bus.emit('part', { room: wire.room, name: cap(wire.name), bot: !!wire.bot });
        rosterChanged(); break;
      case 'typing':
        bus.emit('typing', { room: wire.room, name: cap(wire.name), on: !!wire.on }); break;
      case 'im':
        if (wire.to && wire.to !== me) return;
        bus.emit('im', {
          from: cap(wire.from), text: cap(wire.text, LIMITS.imMaxChars),
          bot: !!wire.bot, staff: !!wire.staff, suspicious: !!wire.suspicious,
        });
        break;
      case 'botroster':
        sim.remoteRoster(wire.room, wire.names); rosterChanged(); break;
      case 'hello':
        bus.emit('peer', { name: cap(wire.from) }); break;
    }
  }

  let rosterTimer = null;
  function rosterChanged() {
    clearTimeout(rosterTimer);
    rosterTimer = setTimeout(() => {
      for (const room of myRooms) bus.emit('roster', { room, names: rosterFor(room) });
      bus.emit('peers', { count: peers.size });
    }, 60);
  }

  function rosterFor(room) {
    const out = new Map();
    if (myRooms.has(room)) out.set(me, { name: me, self: true, human: true });
    for (const p of peers.values())
      if (p.name && p.rooms.has(room)) out.set(p.name, { name: p.name, human: true, peer: true });
    for (const b of sim.roomRoster(room)) if (!out.has(b.name)) out.set(b.name, b);
    return [...out.values()];
  }

  /* ── public interface ─────────────────────────────────────────────── */

  const api = {
    on: bus.on,
    get me() { return me; },
    get isHost() { return host; },
    get peerCount() { return peers.size; },
    get mode() { return mode; },

    async connect() {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel(CHANNEL);
        bc.onmessage = ev => receive(ev.data);
      }
      if (mode === 'relay' && relayUrl) await openRelay();
      send({ t: 'hello', rooms: [] });
      beat = setInterval(() => { send({ t: 'beat', rooms: [...myRooms] }); prune(); }, HEARTBEAT);
      electHost();
      tick = setInterval(() => sim.tick(), 900);
      bus.emit('status', { state: 'online', mode });
      return true;
    },

    disconnect() {
      if (closed) return;
      closed = true;
      send({ t: 'bye' });
      clearInterval(beat); clearInterval(tick);
      sim.setActive(false); sim.reset();
      if (bc) { bc.close(); bc = null; }
      if (ws) { ws.close(); ws = null; }
      myRooms.clear();
      bus.emit('status', { state: 'offline' });
    },

    join(room) {
      if (myRooms.has(room)) return;
      myRooms.add(room);
      sim.humanEnter(room);
      send({ t: 'join', room, name: me, rooms: [...myRooms] });
      bus.emit('join', { room, name: me, self: true });
      rosterChanged();
    },

    leave(room) {
      if (!myRooms.delete(room)) return;
      sim.humanLeave(room);
      send({ t: 'part', room, name: me, rooms: [...myRooms] });
      rosterChanged();
    },

    /** `text` must already have been through safety.screen(). */
    say(room, text, kind = 'say') {
      const msg = { t: 'chat', room, from: me, text: cap(text), kind };
      send(msg);
      deliver(msg);
      if (host) sim.observe({ ...msg, peer: peerId });
    },

    im(to, text) {
      const msg = { t: 'im', to, from: me, text: cap(text, LIMITS.imMaxChars) };
      send(msg);
      if (host) sim.observe({ ...msg, peer: peerId });
    },

    typing(room, on) { send({ t: 'typing', room, name: me, on }); },

    roster: rosterFor,
    knownBots: () => sim.allBots(),

    /* Give a room a population before anybody walks into it, so a map of
       rooms is not a map of empty rooms. Host-only, like the rest of the
       simulation; other tabs learn about it from the roster broadcast. */
    prime: (room, min) => sim.prime(room, min),
  };

  function openRelay() {
    return new Promise(resolve => {
      try { ws = new WebSocket(relayUrl); } catch { return resolve(false); }
      const t = setTimeout(() => resolve(false), 4000);
      ws.onopen = () => {
        clearTimeout(t);
        try { ws.send(JSON.stringify({ t: 'hello', from: me, peer: peerId })); } catch {}
        resolve(true);
      };
      ws.onmessage = ev => { try { receive(JSON.parse(ev.data)); } catch {} };
      ws.onclose = () => { if (!closed) bus.emit('status', { state: 'relay-lost' }); };
      ws.onerror = () => { clearTimeout(t); resolve(false); };
    });
  }

  window.addEventListener('pagehide', () => api.disconnect());
  return api;
}

/* ─────────────────────────────────────────────────────────────────────
   The simulation — only ever runs on the elected host tab.
   ───────────────────────────────────────────────────────────────────── */

function createSimulation(out) {
  const brains = new Map(PERSONAS.map(p => [p.name, makeBrain(p)]));
  const rooms = new Map();          // room -> room state
  const remote = new Map();         // room -> bot names, for non-host tabs
  let active = false;
  let phishedAlready = false;

  function state(room) {
    if (!rooms.has(room)) rooms.set(room, {
      bots: new Set(), humans: 0, lastEvent: Date.now(), lastLine: Date.now(), quiz: null,
    });
    return rooms.get(room);
  }

  const personaOf = name => PERSONAS.find(p => p.name === name);

  function speak(room, name, text, meta = {}) {
    const brain = brains.get(name);
    const delay = Math.min(brain ? brain.typingMs(text) : 900, 5200);
    out.typing(room, name, true);
    setTimeout(() => {
      if (!active) return;
      out.typing(room, name, false);
      out.say(room, name, text, meta);
      state(room).lastLine = Date.now();
    }, delay);
  }

  function addBot(room, name) {
    const s = state(room);
    if (s.bots.has(name) || s.bots.size >= 7) return;
    s.bots.add(name);
    out.join(room, name);
    out.roster(room, [...s.bots]);
    const brain = brains.get(name);
    if (brain) setTimeout(() => active && speak(room, name, brain.greeting()), randInt(1200, 4000));
  }

  function dropBot(room, name) {
    const s = state(room);
    if (!s.bots.delete(name)) return;
    const brain = brains.get(name);
    const bye = brain && brain.persona.topics && brain.persona.topics.bye;
    if (bye) out.say(room, name, inflect(pick(bye), brain.persona.style));
    setTimeout(() => { out.part(room, name); out.roster(room, [...state(room).bots]); }, 700);
  }

  /* ── set pieces ───────────────────────────────────────────────────── */

  function roomEvent(room, s) {
    if (!s.bots.size) return;
    const roll = Math.random();

    if (roll < 0.3) {
      const name = pick([...s.bots]);
      speak(room, name, pick(CHAIN_LETTERS));
      setTimeout(() => {
        const others = [...state(room).bots].filter(n => n !== name);
        if (active && others.length) speak(room, pick(others),
          pick(['please do not forward those', 'that one is a hoax', 'my aunt sends me these']));
      }, 6000);

    } else if (roll < 0.55) {
      // Somebody scrolls the room and is removed for it. This is the
      // in-fiction moderation model the whole product runs on.
      const name = pick([...s.bots]);
      const art = pick(ASCII_ART);
      art.forEach((l, i) => setTimeout(() => active && out.say(room, name, l), i * 260));
      const after = art.length * 260;
      setTimeout(() => active && out.say(room, GUIDE.name,
        name + ', please do not scroll the room. This is your only warning.',
        { staff: true, kind: 'staff' }), after + 1400);
      setTimeout(() => {
        if (!active) return;
        out.say(room, GUIDE.name, name + ' has been removed from the room.',
          { staff: true, kind: 'staff' });
        dropBot(room, name);
      }, after + 5200);

    } else if (roll < 0.75) {
      out.say(room, GUIDE.name, pick([
        'Guide MJ here — everything looks quiet. Carry on.',
        'Reminder: Halcyon staff will never ask you for your password.',
        'Please keep the room friendly, folks. Thanks.',
      ]), { staff: true, kind: 'staff' });

    } else if (!phishedAlready) {
      // The password scam, and its debunking. Runs at most once a session.
      phishedAlready = true;
      setTimeout(() => active && out.im(null, PHISHER.name,
        'ATTENTION HALCYON MEMBER: our billing system has lost your account record. ' +
        'Reply to this message with your screen name and PASSWORD within 5 minutes ' +
        'or your account will be deleted.', { suspicious: true }), 2000);
    }
  }

  function handleIM(wire) {
    const to = String(wire.to || '');
    // Anything sent to the fake billing account gets a Guide, not a reply.
    if (/billing/i.test(to) || to === PHISHER.name) {
      setTimeout(() => active && out.im(wire.from, GUIDE.name,
        'Hi — that account was an impostor and has been closed. Look closely at the name: ' +
        'it was a capital i, not an l. Halcyon staff will NEVER ask for your password, ' +
        'not by instant message, not by e-mail, not ever. Nothing you typed left this ' +
        'machine, and there is nothing you need to change. Thanks for talking to me.',
        { staff: true }), 1800);
      return;
    }
    const p = personaOf(to);
    if (!p) return;
    const brain = brains.get(p.name);
    const line = brain.reply(wire.text, wire.from, {}) || inflect(pick([
      'hey whats up', 'oh hi', 'sorry i was afk', 'do i know you from the lobby',
    ]), p.style);
    setTimeout(() => active && out.im(wire.from, p.name, line), brain.typingMs(line));
  }

  /* ── Trivia Tavern actually plays ─────────────────────────────────── */

  function startQuiz(room) {
    const s = state(room);
    if (s.quiz && s.quiz.on) return;
    s.quiz = { on: true, q: null, asked: 0, scores: new Map(),
               nextAt: Date.now() + 9000, pool: TRIVIA.slice() };
    setTimeout(() => active && out.say(room, 'QuizMaster',
      'Welcome to the Trivia Tavern! I ask, you answer — first correct answer takes ' +
      'the point. Type SCORE at any time to see the board.',
      { staff: true, kind: 'staff' }), 2500);
  }

  function quizTick(room, s, now) {
    const q = s.quiz;
    if (now < q.nextAt) return;
    if (q.q) {                                   // time is up on the open question
      out.say(room, 'QuizMaster', 'Time! The answer was: ' + q.q.a[0] + '.',
        { staff: true, kind: 'staff' });
      q.q = null; q.nextAt = now + 6000; return;
    }
    if (!q.pool.length) q.pool = TRIVIA.slice();
    q.q = q.pool.splice(randInt(0, q.pool.length - 1), 1)[0];
    q.asked++;
    q.nextAt = now + 24000;
    out.say(room, 'QuizMaster', 'Question ' + q.asked + ': ' + q.q.q,
      { staff: true, kind: 'staff' });

    // A regular takes a swing at it, sometimes correctly, after a pause
    // long enough that a human gets first refusal.
    if (s.bots.size && chance(0.55)) {
      const name = pick([...s.bots]);
      const guess = chance(0.35) ? q.q.a[0] : pick(q.q.wrong || ['uhh', 'no idea', 'is it 7']);
      setTimeout(() => {
        if (active && s.quiz && s.quiz.q) speak(room, name, inflect(guess, (personaOf(name) || {}).style || {}));
      }, randInt(6000, 14000));
    }
  }

  const norm = t => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|a|an)\b/g, '').replace(/\s+/g, ' ').trim();

  function quizAnswer(room, who, text) {
    const s = state(room), q = s.quiz;
    if (!q || !q.on) return;
    if (/^\s*score\s*$/i.test(text)) {
      const board = [...q.scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([n, v]) => n + ' ' + v).join('   ');
      out.say(room, 'QuizMaster', board ? 'Scores: ' + board : 'Nobody is on the board yet.',
        { staff: true, kind: 'staff' });
      return;
    }
    if (!q.q) return;
    const guess = norm(text);
    if (!guess) return;
    const hit = q.q.a.some(a => norm(a) === guess || (guess.length > 3 && norm(a).includes(guess)));
    if (!hit) return;
    q.scores.set(who, (q.scores.get(who) || 0) + 1);
    out.say(room, 'QuizMaster',
      'Correct, ' + who + '! That is ' + q.scores.get(who) + ' for you.',
      { staff: true, kind: 'staff' });
    q.q = null;
    q.nextAt = Date.now() + 8000;
  }

  /* ── interface ────────────────────────────────────────────────────── */

  return {
    setActive(on) { active = on; },
    reset() { rooms.clear(); },

    /* Seed a room that nobody is standing in yet. Unlike humanEnter this
       starts no conversation: there is nobody there to hear it, and the
       chatter begins the moment somebody arrives. */
    prime(room, min = randInt(2, 5)) {
      if (!active) return;
      const s = state(room);
      if (s.primed || s.bots.size >= min) { s.primed = true; return; }
      s.primed = true;
      const avail = PERSONAS.map(p => p.name).filter(n => !s.bots.has(n));
      for (let i = s.bots.size; i < min && avail.length; i++) {
        const n = avail.splice(randInt(0, avail.length - 1), 1)[0];
        s.bots.add(n);
        out.join(room, n);
      }
      out.roster(room, [...s.bots]);
    },

    humanEnter(room) {
      const s = state(room);
      s.humans++;
      if (!active) return;
      // Seed the room so nobody ever walks into an empty one.
      const avail = PERSONAS.map(p => p.name).filter(n => !s.bots.has(n));
      const want = Math.min(randInt(3, 5), avail.length);
      for (let i = 0; i < want; i++) {
        const n = avail.splice(randInt(0, avail.length - 1), 1)[0];
        setTimeout(() => active && addBot(room, n), i * 500);
      }
      if (room === 'trivia') startQuiz(room);
    },

    humanLeave(room) { const s = state(room); s.humans = Math.max(0, s.humans - 1); },

    roomRoster(room) {
      const s = rooms.get(room);
      const names = s ? [...s.bots] : (remote.get(room) || []);
      const list = names.filter(n => n !== 'QuizMaster').map(n => {
        const p = personaOf(n);
        return { name: n, color: p && p.color, asl: p && p.asl, bot: true };
      });
      const quizOn = (s && s.quiz && s.quiz.on) || (remote.get(room) || []).includes('QuizMaster');
      if (quizOn) list.unshift({ name: 'QuizMaster', color: '#8a5a00', bot: true, staff: true });
      return list;
    },

    remoteRoster(room, names) {
      remote.set(room, Array.isArray(names) ? names.slice(0, 12).map(n => cap(n)) : []);
    },

    allBots: () => PERSONAS.map(p => ({ name: p.name, color: p.color })),

    /** Everything anyone says passes through here on the host tab. */
    observe(wire) {
      if (!active) return;
      if (wire.t === 'im' && !wire.bot) return handleIM(wire);
      if (wire.t !== 'chat' || wire.bot) return;
      const room = wire.room, s = state(room);
      s.lastLine = Date.now();

      if (s.quiz && s.quiz.on) quizAnswer(room, wire.from, wire.text);

      // One or two people react, after a believable pause.
      const candidates = [...s.bots].sort(() => Math.random() - 0.5);
      let replied = 0;
      for (const name of candidates) {
        if (replied >= 2) break;
        const brain = brains.get(name);
        const line = brain && brain.reply(wire.text, wire.from, { room });
        if (!line) continue;
        replied++;
        setTimeout(() => active && speak(room, name, line), randInt(400, 2200) + replied * 700);
      }

      // Somebody always tells you off for typing personal details.
      if (/\[(?:phone number|street address|e-mail address|card number|government number) removed\]/.test(wire.text)) {
        const scold = [...s.bots][0];
        if (scold) setTimeout(() => active && speak(room, scold, inflect(pick([
          'dont give that out online', 'never post that in a room',
          'good thing halcyon caught that',
        ]), (personaOf(scold) || {}).style || {})), 2400);
      }
    },

    tick() {
      if (!active) return;
      const now = Date.now();
      for (const [room, s] of rooms) {
        if (!s.humans) continue;

        if (now - s.lastLine > randInt(8000, 16000) && s.bots.size) {
          const name = pick([...s.bots]);
          const line = brains.get(name) && brains.get(name).idle({ room });
          if (line) speak(room, name, line);
        }

        if (chance(0.010) && s.bots.size > 2) dropBot(room, pick([...s.bots]));
        if (chance(0.013) && s.bots.size < 6) {
          const avail = PERSONAS.map(p => p.name).filter(n => !s.bots.has(n));
          if (avail.length) addBot(room, pick(avail));
        }

        if (now - s.lastEvent > 45000 && chance(0.05)) { s.lastEvent = now; roomEvent(room, s); }
        if (s.quiz && s.quiz.on) quizTick(room, s, now);
      }
    },
  };
}
