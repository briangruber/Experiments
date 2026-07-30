// The game itself: monster spawning and AI, damage, gold, and the consequences
// of sinking. Deliberately transport-free — it talks to players through objects
// with a send() method and nothing else, so the same code runs behind a
// WebSocket on a real server and directly inside the browser in solo play.

import {
  WORLD, BOATS, MONSTERS, MONSTER_BY_ID, CREW, HARPOON,
  SINK_GOLD_PENALTY, crewCost, xpForLevel, levelFromXp, monstersForDistance,
} from './config.js';

/**
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.log] called for server-side notices
 * @returns a world you drive with step() and feed with join/handle/leave
 */
export function createWorld() {
  /* -------------------------------------------------------------------- state */

  const players = new Map();   // id -> player
  const monsters = new Map();  // id -> monster
  const profiles = new Map();  // token -> saved progress, so a refresh is not a death
  let nextId = 1;
  let nextMonsterId = 1;

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

  function boatOf(p) { return BOATS[p.tier] || BOATS[0]; }

  function freshPlayer(id, name, conn) {
    const boat = BOATS[0];
    return {
      id, name, conn,
      tier: 0, hull: boat.hull, crew: boat.crew,
      gold: 0, xp: 0, level: 1,
      cargo: [],
      x: rand(-40, 40), z: rand(60, 110), h: Math.PI, sp: 0,
      dead: false, docked: true,
      tethers: new Set(),
      reelBudget: 0, hitAt: 0,
      joinedAt: Date.now(),
    };
  }

  function publicPlayer(p) {
    const boat = boatOf(p);
    return {
      id: p.id, n: p.name, t: p.tier,
      x: round(p.x), z: round(p.z), h: round(p.h, 3), sp: round(p.sp, 2),
      hp: Math.max(0, Math.round((p.hull / boat.hull) * 100)),
      lv: p.level, d: p.dead ? 1 : 0,
      th: p.tethers.size ? [...p.tethers] : undefined,
    };
  }

  function selfState(p) {
    const boat = boatOf(p);
    return {
      id: p.id, name: p.name, tier: p.tier, boat: boat.id,
      hull: Math.round(p.hull), hullMax: boat.hull,
      crew: p.crew, crewMax: boat.crew,
      gold: Math.round(p.gold), xp: Math.round(p.xp), level: p.level,
      xpNext: xpForLevel(p.level), xpPrev: p.level > 1 ? xpForLevel(p.level - 1) : 0,
      cargo: p.cargo.map((c) => ({ id: c.id, name: c.name, bounty: Math.round(c.bounty), slots: c.slots })),
      hold: boat.hold, dead: p.dead,
    };
  }

  function round(v, d = 2) {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  }

  function broadcast(msg, except = null) {
    const json = JSON.stringify(msg);
    for (const p of players.values()) {
      if (p === except || !p.conn.open) continue;
      p.conn.send(json);
    }
  }

  function event(text, kind = 'info') {
    broadcast({ t: 'ev', kind, text });
  }

  /* ------------------------------------------------------------------ monsters */

  function spawnMonster() {
    // Bias spawns toward where players actually are, so the sea feels populated
    // without simulating the whole 3200m disc.
    const anchors = [...players.values()].filter((p) => !p.dead && !p.docked);
    let cx = 0, cz = 0, r;
    if (anchors.length && Math.random() < 0.75) {
      const a = anchors[(Math.random() * anchors.length) | 0];
      cx = a.x; cz = a.z;
      r = rand(220, 520);
    } else {
      r = rand(WORLD.safeRadius, WORLD.radius);
    }
    const ang = rand(0, Math.PI * 2);
    let x = cx + Math.cos(ang) * r;
    let z = cz + Math.sin(ang) * r;

    let d = Math.hypot(x, z);
    if (d < WORLD.safeRadius + 40 || d > WORLD.radius) {
      const target = rand(WORLD.safeRadius + 60, WORLD.radius - 40);
      const s = target / (d || 1);
      x *= s; z *= s;
      d = target;
    }

    const pool = monstersForDistance(d);
    if (!pool.length) return;
    // Weight toward the smaller end of whatever the band allows, so a giant is
    // always a moment rather than a chore.
    const weights = pool.map((m) => 1 / (1 + m.tier * 0.9));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let type = pool[0];
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { type = pool[i]; break; }
    }

    const id = nextMonsterId++;
    monsters.set(id, {
      id, type: type.id,
      x, z, h: rand(0, Math.PI * 2), sp: 0,
      hp: type.hp, hpMax: type.hp,
      state: 'wander', target: 0,
      wanderTimer: rand(2, 7), attackCd: rand(1, 3),
      thrash: rand(0, 6.28), enrage: 0,
      tethers: new Set(), damage: new Map(),
      born: Date.now(),
    });
  }

  function publicMonster(m) {
    return {
      id: m.id, k: m.type,
      x: round(m.x), z: round(m.z), h: round(m.h, 3), sp: round(m.sp, 2),
      hp: Math.round((m.hp / m.hpMax) * 100),
      s: m.state === 'hunt' ? 1 : m.state === 'fight' ? 2 : 0,
      th: m.tethers.size ? [...m.tethers] : undefined,
    };
  }

  function huntableTarget(m, type) {
    let best = null, bestD = type.aggro;
    for (const p of players.values()) {
      if (p.dead || p.docked) continue;
      const d = dist(m.x, m.z, p.x, p.z);
      // A boat that has a rope in you is the obvious thing to be angry at.
      const weight = m.tethers.has(p.id) ? 0.45 : 1;
      if (d * weight < bestD) { bestD = d * weight; best = p; }
    }
    return best;
  }

  function stepMonster(m, dt, now) {
    const type = MONSTER_BY_ID[m.type];
    if (!type) { monsters.delete(m.id); return; }

    // Drop tethers from players who left.
    for (const pid of m.tethers) if (!players.has(pid)) m.tethers.delete(pid);

    const tetherer = m.tethers.size ? players.get([...m.tethers][0]) : null;
    const target = tetherer && !tetherer.dead ? tetherer : huntableTarget(m, type);

    if (m.enrage > 0) m.enrage -= dt;
    m.thrash += dt * (2.2 + type.speed * 0.18);

    if (m.tethers.size && target) {
      m.state = 'fight';
    } else if (target && dist(m.x, m.z, target.x, target.z) < type.aggro) {
      m.state = 'hunt';
    } else {
      m.state = 'wander';
    }

    let desiredH = m.h;
    let speed = type.speed * 0.35;

    if (m.state === 'wander') {
      m.wanderTimer -= dt;
      if (m.wanderTimer <= 0) {
        m.wanderTimer = rand(3, 9);
        m.h += rand(-1.1, 1.1);
      }
      desiredH = m.h;
      // Curl back before wandering off the edge of the world.
      const d = Math.hypot(m.x, m.z);
      if (d > WORLD.radius - 120) desiredH = Math.atan2(-m.z, -m.x);
      if (d < WORLD.safeRadius + 30) desiredH = Math.atan2(m.z, m.x);
    } else if (m.state === 'hunt') {
      const d = dist(m.x, m.z, target.x, target.z);
      const toBoat = Math.atan2(target.z - m.z, target.x - m.x);
      // Circle at biting distance rather than swimming through the hull.
      const gap = standoff(type, target);
      desiredH = d < gap ? toBoat + Math.PI * 0.85 : toBoat;
      speed = type.speed * (m.enrage > 0 ? 1.25 : 1) * (d < gap ? 0.5 : 1);
    } else if (m.state === 'fight') {
      const d = dist(m.x, m.z, target.x, target.z);
      const toBoat = Math.atan2(target.z - m.z, target.x - m.x);
      // The sleigh ride: it runs, thrashing, and only turns to bite when the
      // winch has dragged it close.
      const away = toBoat + Math.PI;
      const gap = standoff(type, target);
      const lunging = d < type.reach * 1.6 && d > gap;
      desiredH = (lunging ? toBoat : away) + Math.sin(m.thrash * 0.9) * 0.55;
      speed = type.speed * (lunging ? 0.75 : 0.95);
    }

    const turnRate = 1.4 + type.speed * 0.06;
    m.h = approachAngle(m.h, desiredH, turnRate * dt);
    m.sp += (speed - m.sp) * Math.min(1, dt * 1.6);
    m.x += Math.cos(m.h) * m.sp * dt;
    m.z += Math.sin(m.h) * m.sp * dt;

    // Attack whatever is in reach.
    m.attackCd -= dt;
    if (m.attackCd <= 0 && target && !target.dead) {
      const d = dist(m.x, m.z, target.x, target.z);
      if (d < type.reach + BOATS[target.tier].length * 0.4) {
        m.attackCd = rand(2.2, 3.4);
        attackPlayer(m, type, target, now);
      } else {
        m.attackCd = 0.4;
      }
    }
  }

  /** How close a monster will get before it starts circling instead. */
  function standoff(type, player) {
    return type.size * 2.2 + BOATS[player.tier].length * 0.35;
  }

  function approachAngle(cur, want, maxStep) {
    let diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (diff > maxStep) diff = maxStep;
    if (diff < -maxStep) diff = -maxStep;
    return cur + diff;
  }

  function attackPlayer(m, type, p, now) {
    const boat = BOATS[p.tier];
    // Fighting above your weight hurts, badly.
    const gap = clamp(type.tier - p.tier, -3, 3);
    const dmg = type.damage * rand(0.85, 1.15) * (1 + gap * 0.12);
    p.hull -= dmg;

    let crewLost = 0;
    if (p.crew > 0 && Math.random() < type.bite) {
      crewLost = Math.min(p.crew, type.tier >= 4 ? 2 : 1);
      p.crew -= crewLost;
    }
    // An empty deck means nobody is bailing.
    if (p.crew <= 0) p.hull -= dmg * 0.35;

    p.conn.send({
      t: 'hurt',
      dmg: Math.round(dmg), crew: crewLost, monster: type.id, mid: m.id,
      x: round(m.x), z: round(m.z),
      hull: Math.max(0, Math.round(p.hull)), hullMax: boat.hull, crewLeft: p.crew,
    });

    if (crewLost) {
      event(`${type.name} took ${crewLost} of ${p.name}'s crew`, 'bite');
    }
    if (p.hull <= 0) sinkPlayer(p, type);
    else if (crewLost || Math.random() < 0.5) p.conn.send({ t: 'you', ...selfState(p) });
  }

  function sinkPlayer(p, type) {
    if (p.dead) return;
    const lostBoat = BOATS[p.tier];
    const lostCargo = p.cargo.length;
    const goldLost = Math.round(p.gold * SINK_GOLD_PENALTY);

    p.dead = true;
    p.gold -= goldLost;
    p.cargo = [];
    p.tier = 0;
    p.hull = 0;
    p.crew = 0;
    for (const mid of p.tethers) monsters.get(mid)?.tethers.delete(p.id);
    p.tethers.clear();

    p.conn.send({
      t: 'sank',
      by: type ? type.name : 'the sea',
      boat: lostBoat.name,
      cargo: lostCargo,
      gold: goldLost,
      state: selfState(p),
    });
    event(`${type ? type.name : 'The sea'} sent ${p.name}'s ${lostBoat.name} to the bottom`, 'sink');
  }

  /* --------------------------------------------------------------- kill payout */

  function killMonster(m, type) {
    const contributions = [...m.damage.entries()]
      .map(([id, dmg]) => ({ p: players.get(id), dmg }))
      .filter((c) => c.p);
    const total = contributions.reduce((a, c) => a + c.dmg, 0) || 1;
    contributions.sort((a, b) => b.dmg - a.dmg);

    const winner = contributions[0]?.p || null;
    monsters.delete(m.id);
    for (const c of contributions) c.p.tethers.delete(m.id);

    let carcassTo = null;
    if (winner) {
      const boat = BOATS[winner.tier];
      const used = winner.cargo.reduce((a, c) => a + c.slots, 0);
      if (used + type.slots <= boat.hold) {
        winner.cargo.push({ id: type.id, name: type.name, bounty: type.bounty, slots: type.slots });
        carcassTo = winner.id;
      }
    }

    for (const c of contributions) {
      const share = c.dmg / total;
      // Everyone who bled for it gets paid; the carcass itself is the prize,
      // and it is only worth full price at the dock.
      const isWinner = c.p === winner;
      const cash = isWinner
        ? (carcassTo === null ? type.bounty * 0.5 : 0)
        : type.bounty * share * 0.55;
      if (cash > 0) c.p.gold += cash;
      grantXp(c.p, type.xp * Math.max(share, isWinner ? 0.5 : 0));
      c.p.conn.send({
        t: 'kill',
        mid: m.id, monster: type.id, name: type.name,
        share: round(share, 3),
        carcass: isWinner && carcassTo !== null,
        lost: isWinner && carcassTo === null,
        gold: Math.round(cash),
        state: selfState(c.p),
      });
    }

    broadcast({ t: 'dead', mid: m.id, x: round(m.x), z: round(m.z), k: type.id });
    if (winner) {
      const helpers = contributions.length - 1;
      event(
        `${winner.name} landed a ${type.name}${helpers > 0 ? ` (+${helpers} crew of others)` : ''}`,
        type.tier >= 4 ? 'big' : 'kill'
      );
    }
  }

  function grantXp(p, xp) {
    p.xp += xp;
    const level = levelFromXp(p.xp);
    if (level > p.level) {
      p.level = level;
      p.conn.send({ t: 'ev', kind: 'level', text: `You reached level ${level}` });
      event(`${p.name} reached level ${level}`, 'level');
    }
  }

  /* ------------------------------------------------------------- players */

  function handleJoin(conn, msg) {
    const name = sanitizeName(msg.name);
    const id = nextId++;
    const p = freshPlayer(id, name, conn);

    const saved = msg.token && profiles.get(String(msg.token));
    if (saved) {
      p.tier = clamp(saved.tier | 0, 0, BOATS.length - 1);
      p.gold = Math.max(0, +saved.gold || 0);
      p.xp = Math.max(0, +saved.xp || 0);
      p.level = levelFromXp(p.xp);
      p.hull = clamp(+saved.hull || BOATS[p.tier].hull, 1, BOATS[p.tier].hull);
      p.crew = clamp(saved.crew | 0, 0, BOATS[p.tier].crew);
      p.cargo = Array.isArray(saved.cargo) ? saved.cargo.slice(0, 8) : [];
    }
    p.token = msg.token ? String(msg.token).slice(0, 64) : null;
    players.set(id, p);

    conn.send({
      t: 'welcome',
      id,
      you: selfState(p),
      players: [...players.values()].map(publicPlayer),
      monsters: [...monsters.values()].map(publicMonster),
      serverTime: Date.now(),
    });
    broadcast({ t: 'ev', kind: 'join', text: `${name} put to sea` }, p);
    return p;
  }

  function sanitizeName(raw) {
    const cleaned = String(raw ?? '').replace(/[^\w \-'.]/g, '').trim().slice(0, 16);
    return cleaned || `Deckhand ${Math.floor(Math.random() * 900 + 100)}`;
  }

  function saveProfile(p) {
    if (!p.token) return;
    profiles.set(p.token, {
      name: p.name, tier: p.tier, gold: p.gold, xp: p.xp,
      hull: p.hull, crew: p.crew, cargo: p.cargo, at: Date.now(),
    });
  }

  function handleMessage(p, msg) {
    switch (msg.t) {
      case 'state': {
        if (p.dead) return;
        const x = +msg.x, z = +msg.z;
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        if (Math.hypot(x, z) > WORLD.radius + 200) return;
        p.x = x; p.z = z;
        p.h = +msg.h || 0;
        p.sp = +msg.sp || 0;
        p.docked = Math.hypot(x, z) < WORLD.townRadius;
        return;
      }

      case 'hit': {
        if (p.dead) return;
        const m = monsters.get(msg.id | 0);
        if (!m) return;
        // One harpoon per throw: a client that spams hits gets ignored, not
        // rewarded.
        const now = Date.now();
        if (now - (p.hitAt || 0) < HARPOON.cooldown * 900) return;
        p.hitAt = now;
        const boat = boatOf(p);
        if (dist(p.x, p.z, m.x, m.z) > boat.rope * 1.4) return;
        const dmg = clamp(+msg.dmg || 0, 0, boat.harpoonDamage * 1.15);
        applyDamage(p, m, dmg);
        m.tethers.add(p.id);
        p.tethers.add(m.id);
        broadcast({ t: 'stick', mid: m.id, pid: p.id });
        return;
      }

      case 'reel': {
        if (p.dead) return;
        const m = monsters.get(msg.id | 0);
        if (!m || !m.tethers.has(p.id)) return;
        const boat = boatOf(p);
        // Budget-limited so a fast client cannot crank faster than the winch.
        const now = Date.now();
        const elapsed = (now - (p.reelAt || now)) / 1000;
        p.reelAt = now;
        p.reelBudget = Math.min(boat.reel * 1.5, p.reelBudget + elapsed * boat.reel * 1.2);
        const dmg = Math.min(clamp(+msg.dmg || 0, 0, boat.reel), p.reelBudget);
        if (dmg <= 0) return;
        p.reelBudget -= dmg;
        applyDamage(p, m, dmg);
        return;
      }

      case 'cut': {
        const m = monsters.get(msg.id | 0);
        if (m) m.tethers.delete(p.id);
        p.tethers.delete(msg.id | 0);
        broadcast({ t: 'unstick', mid: msg.id | 0, pid: p.id });
        return;
      }

      case 'fire':
        // Purely cosmetic: lets other players see the shot leave your bow.
        broadcast({
          t: 'shot', pid: p.id,
          x: round(+msg.x || 0), y: round(+msg.y || 0), z: round(+msg.z || 0),
          vx: round(+msg.vx || 0), vy: round(+msg.vy || 0), vz: round(+msg.vz || 0),
        }, p);
        return;

      case 'dock':
        handleDock(p, msg);
        return;

      case 'respawn': {
        if (!p.dead) return;
        p.dead = false;
        p.tier = 0;
        p.hull = BOATS[0].hull;
        p.crew = BOATS[0].crew;
        p.x = rand(-40, 40); p.z = rand(60, 110); p.sp = 0;
        p.conn.send({ t: 'respawn', x: p.x, z: p.z, state: selfState(p) });
        return;
      }

      case 'chat': {
        const text = String(msg.text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
        if (!text) return;
        broadcast({ t: 'chat', id: p.id, name: p.name, text });
        return;
      }
    }
  }

  function applyDamage(p, m, dmg) {
    if (dmg <= 0 || m.hp <= 0) return;
    const type = MONSTER_BY_ID[m.type];
    m.hp -= dmg;
    m.damage.set(p.id, (m.damage.get(p.id) || 0) + dmg);
    m.enrage = Math.max(m.enrage, 1.5);
    if (m.hp <= 0) killMonster(m, type);
  }

  function handleDock(p, msg) {
    if (p.dead) return;
    if (Math.hypot(p.x, p.z) > WORLD.townRadius * 1.25) {
      p.conn.send({ t: 'ev', kind: 'warn', text: 'You must be in the harbour for that' });
      return;
    }
    const boat = boatOf(p);

    switch (msg.action) {
      case 'sell': {
        if (!p.cargo.length) return;
        const total = p.cargo.reduce((a, c) => a + c.bounty, 0);
        const count = p.cargo.length;
        p.gold += total;
        p.cargo = [];
        p.conn.send({ t: 'ev', kind: 'gold', text: `Sold ${count} catch for ${Math.round(total)}g` });
        event(`${p.name} sold ${count} catch at the docks`, 'trade');
        break;
      }

      case 'repair': {
        const missing = boat.hull - p.hull;
        if (missing <= 0.5) return;
        const cost = Math.ceil(missing * CREW.repairPerPoint);
        if (p.gold < cost) {
          // Partial repairs: never let a broke player be stranded.
          const afford = Math.floor(p.gold / CREW.repairPerPoint);
          if (afford <= 0) { p.conn.send({ t: 'ev', kind: 'warn', text: 'Not enough gold to repair' }); return; }
          p.hull += afford;
          p.gold -= afford * CREW.repairPerPoint;
        } else {
          p.hull = boat.hull;
          p.gold -= cost;
        }
        p.conn.send({ t: 'ev', kind: 'ok', text: 'Hull patched' });
        break;
      }

      case 'crew': {
        if (p.crew >= boat.crew) return;
        const cost = crewCost(p.tier);
        if (p.gold < cost) { p.conn.send({ t: 'ev', kind: 'warn', text: 'Not enough gold to hire' }); return; }
        p.gold -= cost;
        p.crew += 1;
        p.conn.send({ t: 'ev', kind: 'ok', text: 'A hand signs on' });
        break;
      }

      case 'buy': {
        const tier = msg.tier | 0;
        const next = BOATS[tier];
        if (!next || tier <= p.tier) return;
        if (p.level < next.level) {
          p.conn.send({ t: 'ev', kind: 'warn', text: `${next.name} needs level ${next.level}` });
          return;
        }
        const cost = buyCost(p, tier);
        if (p.gold < cost) { p.conn.send({ t: 'ev', kind: 'warn', text: 'Not enough gold' }); return; }
        p.gold -= cost;
        p.tier = tier;
        p.hull = next.hull;
        p.crew = next.crew;
        p.conn.send({ t: 'ev', kind: 'ok', text: `You take command of a ${next.name}` });
        event(`${p.name} bought a ${next.name}`, 'buy');
        break;
      }
    }
    p.conn.send({ t: 'you', ...selfState(p) });
    saveProfile(p);
  }

  function buyCost(p, tier) {
    const tradeIn = p.tier > 0 ? BOATS[p.tier].price * 0.3 : 0;
    return Math.max(0, Math.round(BOATS[tier].price - tradeIn));
  }


  const dt = 1 / WORLD.tickRate;
  let lastSnapshot = 0;
  let lastSave = 0;

  /**
   * One simulation step. Called on a timer by the Node server, and from the
   * render loop when the whole world is running inside the browser.
   */
  function step(now = Date.now()) {

    for (const m of monsters.values()) stepMonster(m, dt, now);

    // Keep the population up, and clear out monsters nobody is near.
    if (players.size) {
      const active = [...players.values()].filter((p) => !p.dead);
      for (const m of [...monsters.values()]) {
        if (m.tethers.size) continue;
        let near = false;
        for (const p of active) {
          if (dist(m.x, m.z, p.x, p.z) < 1100) { near = true; break; }
        }
        if (!near && now - m.born > 30000) monsters.delete(m.id);
      }
      const want = Math.min(WORLD.monsterCap, 10 + active.length * 9);
      if (monsters.size < want && Math.random() < 0.35) spawnMonster();
    }

    if (now - lastSnapshot >= 1000 / WORLD.stateRate) {
      lastSnapshot = now;
      const allPlayers = [...players.values()];
      const allMonsters = [...monsters.values()];
      for (const p of allPlayers) {
        if (!p.conn.open) continue;
        p.conn.send({
          t: 'snap',
          p: allPlayers.filter((o) => o !== p && dist(o.x, o.z, p.x, p.z) < 1400).map(publicPlayer),
          m: allMonsters.filter((m) => dist(m.x, m.z, p.x, p.z) < 1000).map(publicMonster),
        });
      }
    }

    if (now - lastSave > 10000) {
      lastSave = now;
      for (const p of players.values()) saveProfile(p);
      for (const [token, prof] of profiles) {
        if (now - prof.at > 12 * 3600 * 1000) profiles.delete(token);
      }
    }
  }

  // Seed a sea that already has monsters in it before anyone arrives.
  for (let i = 0; i < 14; i++) spawnMonster();

  return {
    join: handleJoin,
    handle: handleMessage,
    step,
    leave(player) {
      if (!player) return;
      saveProfile(player);
      for (const mid of player.tethers) monsters.get(mid)?.tethers.delete(player.id);
      players.delete(player.id);
      broadcast({ t: 'bye', id: player.id });
      event(`${player.name} sailed home`, 'leave');
    },
    get playerCount() { return players.size; },
    get monsterCount() { return monsters.size; },
  };
}
