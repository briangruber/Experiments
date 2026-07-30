/* BOMB BLOBS — client. Renders server snapshots, sends intent, makes noise. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  // Must mirror server/game.js
  const PLAYER_R = 28;
  const ARENA_START = 350;
  const ACCEL = 1000;
  const DRAG = 4.0;
  const INTERP = 90;   // ms of deliberate lag, so movement is smooth not jittery

  const FLAG = { ALIVE: 1, BOMB: 2, DASH: 4, SHIELD: 8, BOOST: 16, FALL: 32, GHOST: 64 };

  // localStorage throws outright in some sandboxed contexts, so it stays optional.
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* no-op */ } },
  };
  const EMOTES = [null, '😂', '😱', '😎', '🤡', '🔥', '💀'];

  /* ------------------------------------------------------------- state */

  const G = {
    ws: null,
    id: null,
    code: null,
    meta: new Map(),          // id -> {name, emoji, color, score, bot}
    order: [],
    buf: [],                  // snapshot buffer
    latest: null,
    state: 'lobby',
    arena: ARENA_START,
    bombT: 0,
    fuseMax: 13,
    sudden: false,
    mod: '',
    modBlurb: '',
    accelMult: 1,
    dragMult: 1,
    timer: 0,
    winner: null,
    scale: 1,
    shake: 0,
    parts: [],
    floats: [],
    confetti: [],
    pred: null,               // local prediction {x,y,vx,vy}
    connected: false,
    lastSent: 0,
  };

  const input = { x: 0, y: 0, dash: false };
  const keys = new Set();

  /* ------------------------------------------------------------ canvas */

  const cv = $('#stage');
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width = Math.floor(W * DPR);
    cv.height = Math.floor(H * DPR);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ------------------------------------------------------------- audio */

  let AC = null;
  function audio() {
    if (!AC) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) AC = new Ctor();
    }
    if (AC && AC.state === 'suspended') AC.resume();
    return AC;
  }

  function blip(freq, dur, type = 'square', gain = 0.08, slide = 0) {
    const ac = audio();
    if (!ac) return;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ac.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ac.currentTime + dur);
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + dur + 0.02);
  }

  function boomSound() {
    const ac = audio();
    if (!ac) return;
    const len = ac.sampleRate * 0.5;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1600, ac.currentTime);
    f.frequency.exponentialRampToValueAtTime(90, ac.currentTime + 0.45);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.5, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.5);
    src.connect(f).connect(g).connect(ac.destination);
    src.start();
  }

  function jingle() {
    [0, 0.11, 0.22, 0.36].forEach((t, i) =>
      setTimeout(() => blip([523, 659, 784, 1047][i], 0.22, 'triangle', 0.1), t * 1000));
  }

  /* ------------------------------------------------------------ effects */

  function burst(x, y, n, color, speed, life) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = speed * (0.35 + Math.random() * 0.9);
      G.parts.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: life * (0.6 + Math.random() * 0.6),
        max: life,
        r: 2 + Math.random() * 4,
        color,
      });
    }
  }

  function floatText(x, y, text, color) {
    G.floats.push({ x, y, text, color, life: 1.1 });
  }

  function popConfetti() {
    const colors = ['#ff4d6d', '#4dd4ff', '#ffd93d', '#7cff6b', '#c77dff'];
    for (let i = 0; i < 140; i++) {
      G.confetti.push({
        x: Math.random() * W,
        y: -20 - Math.random() * H * 0.5,
        vy: 120 + Math.random() * 260,
        vx: (Math.random() - 0.5) * 90,
        w: 5 + Math.random() * 7,
        h: 8 + Math.random() * 10,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 8,
        color: colors[(Math.random() * colors.length) | 0],
        life: 4,
      });
    }
  }

  /* --------------------------------------------------------------- feed */

  const feedEl = $('#feed');
  function feed(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    feedEl.appendChild(d);
    while (feedEl.children.length > 5) feedEl.removeChild(feedEl.firstChild);
    setTimeout(() => d.remove(), 5200);
  }
  const who = (id) => {
    const m = G.meta.get(id);
    if (!m) return 'Someone';
    return `<span style="color:${m.color}">${m.emoji} ${escapeHTML(m.name)}</span>`;
  };
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastT = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('show'), 1800);
  }

  /* ------------------------------------------------------------ network */

  function connect(code, name, emoji) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    G.ws = ws;

    ws.onopen = () => {
      G.connected = true;
      ws.send(JSON.stringify({ t: 'join', room: code, name, emoji }));
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'welcome') {
        G.id = m.id;
        G.code = m.code;
        // Sandboxed frames reject both of these; neither is worth a crash.
        try { history.replaceState(null, '', '/' + m.code); } catch { /* no-op */ }
        $('#roomcode').textContent = m.code;
        $('#lobbycode').textContent = m.code;
        $('#start').classList.add('hidden');
        $('#hud').classList.remove('hidden');
        store.set('bb_name', name);
        store.set('bb_emoji', emoji);
      } else if (m.t === 'meta') {
        G.meta.clear();
        G.order = m.players.map((p) => p.id);
        for (const p of m.players) G.meta.set(p.id, p);
        renderBoard();
        renderLobbyRoster();
      } else if (m.t === 's') {
        onSnapshot(m);
      } else if (m.t === 'err') {
        toast(m.msg || 'Something went wrong.');
      }
    };

    ws.onclose = () => {
      G.connected = false;
      toast('Disconnected — reconnecting…');
      setTimeout(() => connect(G.code || code, name, emoji), 1200);
    };
    ws.onerror = () => { /* onclose handles it */ };
  }

  function onSnapshot(s) {
    s.rt = performance.now();
    G.buf.push(s);
    while (G.buf.length > 24) G.buf.shift();
    G.latest = s;

    const prevState = G.state;
    G.state = s.st;
    G.bombT = s.bt;
    G.fuseMax = s.bx || 13;
    G.sudden = !!s.sd;
    G.mod = s.md || '';
    G.modBlurb = s.mb || '';
    G.accelMult = (s.mv && s.mv[0]) || 1;
    G.dragMult = (s.mv && s.mv[1]) || 1;
    G.timer = s.tm;
    G.winner = s.w;

    $('#lobby').classList.toggle('hidden', s.st !== 'lobby');
    if (prevState !== s.st && s.st === 'lobby') G.pred = null;

    if (s.st === 'lobby') {
      const n = Math.ceil(s.tm);
      $('#lobbytitle').textContent = n > 0 ? `Starting in ${n}…` : 'Waiting for blobs…';
      $('#lobbysub').textContent = n > 0
        ? 'Add another bot to push it back.'
        : 'Send the link. Roll around while you wait.';
    }

    for (const e of s.ev || []) handleEvent(e);
  }

  function handleEvent(e) {
    switch (e.e) {
      case 'boom':
        burst(e.x, e.y, 46, '#ff9f45', 420, 0.75);
        burst(e.x, e.y, 22, '#ffffff', 260, 0.4);
        G.shake = Math.min(1, G.shake + 0.9);
        boomSound();
        break;
      case 'saved':
        floatText(0, 0, 'SHIELD SAVE!', '#4dd4ff');
        feed(`${who(e.id)} tanked it with a shield 🛡`);
        blip(880, 0.25, 'triangle', 0.09, 400);
        break;
      case 'out':
        if (e.how === 'boom') feed(`${who(e.id)} went 💥`);
        else feed(`${who(e.id)} fell into the void 🕳`);
        if (e.id === G.id) {
          G.shake = Math.min(1, G.shake + 0.5);
          floatText(0, 0, 'HAUNT THEM', '#c9c3ff');
        }
        break;
      case 'spook':
        burst(e.x, e.y, 18, '#c9c3ff', 240, 0.5);
        if (e.id === G.id) G.shake = Math.min(1, G.shake + 0.35);
        if (e.by === G.id) floatText(0, 0, 'DIRECT HIT', '#c9c3ff');
        blip(180, 0.18, 'sine', 0.07, 240);
        break;
      case 'orb':
        blip(520, 0.14, 'sine', 0.05, -280);
        break;
      case 'sudden':
        feed('⚡ <b>SUDDEN DEATH</b> — the floor is going');
        blip(160, 0.5, 'sawtooth', 0.09, 90);
        break;
      case 'fall':
        burst(e.x, e.y, 14, '#6b6b9a', 120, 0.6);
        break;
      case 'pass':
        burst(e.x, e.y, 12, '#ff4d6d', 200, 0.35);
        if (e.to === G.id) { blip(300, 0.14, 'sawtooth', 0.09, 260); G.shake = Math.min(1, G.shake + 0.25); }
        else if (e.from === G.id) blip(700, 0.12, 'triangle', 0.07, -300);
        break;
      case 'fuse':
        if (e.id === G.id) floatText(0, 0, "YOU'VE GOT IT!", '#ff4d6d');
        break;
      case 'grab':
        burst(e.x, e.y, 16, e.kind === 'boost' ? '#ffd93d' : '#4dd4ff', 180, 0.5);
        blip(e.kind === 'boost' ? 660 : 440, 0.16, 'triangle', 0.07, 300);
        break;
      case 'bump':
        if (e.p > 0.35) blip(120 + e.p * 90, 0.07, 'square', 0.04 * e.p);
        break;
      case 'dash':
        if (e.id === G.id) blip(240, 0.1, 'sawtooth', 0.05, 200);
        break;
      case 'win': {
        const m = G.meta.get(e.id);
        feed(`🏆 ${who(e.id)} takes the round!`);
        if (e.streak >= 2) feed(`🔥 ${who(e.id)} is on ${e.streak} in a row`);
        if (e.mvp) feed(`🥔 ${who(e.mvp.id)} passed it ${e.mvp.passes} times`);
        popConfetti();
        jingle();
        if (m) toast(e.id === G.id ? 'YOU WIN! 🏆' : `${m.name} wins the round`);
        break;
      }
      case 'draw':
        feed('☠️ Everybody died. Nobody wins.');
        if (e.mvp) feed(`🥔 ${who(e.mvp.id)} passed it ${e.mvp.passes} times`);
        break;
      case 'round':
        feedEl.innerHTML = '';
        G.confetti.length = 0;
        break;
    }
  }

  function sendInput(force) {
    const now = performance.now();
    if (!force && now - G.lastSent < 45) return;
    if (!G.ws || G.ws.readyState !== 1) return;
    G.lastSent = now;
    G.ws.send(JSON.stringify({ t: 'in', x: +input.x.toFixed(3), y: +input.y.toFixed(3), d: input.dash ? 1 : 0 }));
    input.dash = false;
  }

  /* ------------------------------------------------------------- input */

  const KEYMAP = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
  };

  function refreshAxes() {
    input.x = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    input.y = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
    const m = Math.hypot(input.x, input.y);
    if (m > 1) { input.x /= m; input.y /= m; }
  }

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); refreshAxes(); sendInput(true); e.preventDefault(); }
    else if (e.code === 'Space') { input.dash = true; sendInput(true); e.preventDefault(); }
    else if (/^Digit[1-4]$/.test(e.code)) emote(+e.code.slice(5));
  });
  window.addEventListener('keyup', (e) => {
    if (KEYMAP[e.code]) { keys.delete(KEYMAP[e.code]); refreshAxes(); sendInput(true); }
  });
  window.addEventListener('blur', () => { keys.clear(); refreshAxes(); sendInput(true); });

  function emote(i) {
    audio();
    if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify({ t: 'emote', i }));
  }
  document.querySelectorAll('#emotes button').forEach((b) =>
    b.addEventListener('click', () => emote(+b.dataset.e)));

  // touch
  const isTouch = matchMedia('(pointer: coarse)').matches;
  if (isTouch) {
    $('#touch').classList.remove('hidden');
    const stick = $('#stick');
    const nub = stick.querySelector('i');
    let sid = null, cx = 0, cy = 0;
    const R = 40;

    const setNub = (dx, dy) => { nub.style.transform = `translate(${dx}px, ${dy}px)`; };

    stick.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      const r = stick.getBoundingClientRect();
      sid = t.identifier;
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (sid === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== sid) continue;
        let dx = t.clientX - cx, dy = t.clientY - cy;
        const d = Math.hypot(dx, dy);
        if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
        setNub(dx, dy);
        input.x = dx / R;
        input.y = dy / R;
        sendInput();
      }
    }, { passive: false });

    const endTouch = (e) => {
      if (sid === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== sid) continue;
        sid = null;
        setNub(0, 0);
        input.x = 0; input.y = 0;
        sendInput(true);
      }
    };
    window.addEventListener('touchend', endTouch);
    window.addEventListener('touchcancel', endTouch);

    $('#dashbtn').addEventListener('touchstart', (e) => {
      input.dash = true;
      sendInput(true);
      e.preventDefault();
    }, { passive: false });
  }

  /* -------------------------------------------------------------- views */

  function renderBoard() {
    const board = $('#board');
    const snap = G.latest;
    const alive = new Map();
    if (snap) for (const p of snap.p) alive.set(p[0], (p[5] & FLAG.ALIVE) !== 0);

    const list = [...G.meta.values()].sort((a, b) => b.score - a.score);
    board.innerHTML = list.map((p) => {
      const dead = snap && alive.get(p.id) === false;
      return `<div class="${dead ? 'dead' : ''} ${p.id === G.id ? 'me' : ''}" style="border-left-color:${p.color}">
        <span>${p.emoji}</span><span>${escapeHTML(p.name)}</span><b>${p.score}</b></div>`;
    }).join('');
  }

  function renderLobbyRoster() {
    $('#lobbyroster').innerHTML = [...G.meta.values()].map((p) =>
      `<div><span>${p.emoji}</span><span style="color:${p.color}">${escapeHTML(p.name)}</span></div>`).join('');
  }

  const inviteLink = () => `${location.origin}/${G.code || ''}`;
  async function copyLink() {
    const link = inviteLink();
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Invite link copied!'); }
      catch { toast(link); }
      ta.remove();
    }
  }
  $('#invite').addEventListener('click', copyLink);
  $('#lobbycopy').addEventListener('click', copyLink);
  $('#addbot').addEventListener('click', () => {
    audio();
    if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify({ t: 'bot' }));
  });

  /* --------------------------------------------------------- interpolate */

  function sample() {
    const target = performance.now() - INTERP;
    const buf = G.buf;
    if (!buf.length) return null;

    let a = buf[0], b = buf[0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].rt <= target) { a = buf[i]; b = buf[Math.min(i + 1, buf.length - 1)]; break; }
      if (i === 0) { a = buf[0]; b = buf[Math.min(1, buf.length - 1)]; }
    }
    const span = b.rt - a.rt;
    const t = span > 0 ? clamp((target - a.rt) / span, 0, 1) : 0;

    const bMap = new Map(b.p.map((p) => [p[0], p]));
    const out = [];
    for (const pa of a.p) {
      const pb = bMap.get(pa[0]) || pa;
      out.push({
        id: pa[0],
        x: lerp(pa[1], pb[1], t),
        y: lerp(pa[2], pb[2], t),
        vx: lerp(pa[3], pb[3], t),
        vy: lerp(pa[4], pb[4], t),
        f: pb[5],
        emote: pb[6],
        dash: pb[7] / 100,
        bombT: (pb[8] || 0) / 10,
        orb: (pb[9] || 0) / 100,
      });
    }
    return { players: out, arena: lerp(a.ar, b.ar, t), pickups: b.u, orbs: b.o || [] };
  }

  /**
   * The local blob is simulated client-side with the same numbers as the server
   * and pulled back toward the authoritative position every frame. Without it,
   * every keypress would visibly cost a round trip.
   */
  function predict(me, dt) {
    if (!me) { G.pred = null; return me; }
    const ghost = me.f & FLAG.GHOST;
    const playing = (G.state === 'playing' || ghost) &&
      (ghost || ((me.f & FLAG.ALIVE) && !(me.f & FLAG.FALL)));
    if (!playing) { G.pred = { x: me.x, y: me.y, vx: me.vx, vy: me.vy }; return me; }

    if (!G.pred) G.pred = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };
    const p = G.pred;

    // Mirror whatever the round modifier is doing, or prediction fights the server.
    const boost = ghost ? 0.8
      : ((me.f & FLAG.BOOST) ? 1.7 : 1) * G.accelMult * ((me.f & FLAG.BOMB) ? 1.15 : 1);
    p.vx += input.x * ACCEL * boost * dt;
    p.vy += input.y * ACCEL * boost * dt;
    const drag = Math.exp(-DRAG * (ghost ? 1 : G.dragMult) * dt);
    p.vx *= drag;
    p.vy *= drag;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // pull home
    const k = 1 - Math.exp(-9 * dt);
    p.x = lerp(p.x, me.x, k);
    p.y = lerp(p.y, me.y, k);
    p.vx = lerp(p.vx, me.vx, 1 - Math.exp(-6 * dt));
    p.vy = lerp(p.vy, me.vy, 1 - Math.exp(-6 * dt));

    if (Math.hypot(p.x - me.x, p.y - me.y) > 80) { p.x = me.x; p.y = me.y; p.vx = me.vx; p.vy = me.vy; }

    return { ...me, x: p.x, y: p.y };
  }

  /* -------------------------------------------------------------- render */

  let lastFrame = performance.now();
  let tickAccum = 0;
  let time = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    time += dt;
    requestAnimationFrame(frame);

    const world = sample();
    stepEffects(dt);
    updateHUD(dt);
    draw(world, dt);
  }

  function stepEffects(dt) {
    G.shake = Math.max(0, G.shake - dt * 2.2);

    for (let i = G.parts.length - 1; i >= 0; i--) {
      const p = G.parts[i];
      p.life -= dt;
      if (p.life <= 0) { G.parts.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
    }
    for (let i = G.floats.length - 1; i >= 0; i--) {
      const f = G.floats[i];
      f.life -= dt;
      if (f.life <= 0) G.floats.splice(i, 1);
    }
    for (let i = G.confetti.length - 1; i >= 0; i--) {
      const c = G.confetti[i];
      c.life -= dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;
      if (c.life <= 0 || c.y > H + 40) G.confetti.splice(i, 1);
    }
  }

  // fuse ticking
  let tickTimer = 0;
  function updateHUD(dt) {
    const me = G.latest && G.latest.p.find((p) => p[0] === G.id);
    const myFuse = me ? (me[8] || 0) / 10 : 0;
    const iAmGhost = !!(me && (me[5] & FLAG.GHOST));

    // Your own fuse if you're holding one, otherwise the most urgent in play.
    const shown = myFuse > 0 ? myFuse : G.bombT;
    const fuse = $('#fuse');
    const playing = G.state === 'playing';
    fuse.classList.toggle('hidden', !playing || shown <= 0);

    if (playing && shown > 0) {
      const bar = fuse.querySelector('i');
      bar.style.width = clamp(shown / G.fuseMax, 0, 1) * 100 + '%';
      fuse.querySelector('.fuse-label').textContent = myFuse > 0 ? 'YOUR FUSE' : 'FUSE';
      // Only tick in your ear when it's your problem, or nobody can hear anything.
      tickTimer -= dt;
      if (tickTimer <= 0) {
        tickTimer = clamp(shown * 0.11, 0.085, 0.55);
        const mine = myFuse > 0;
        blip(shown < 3 ? 1200 : 760, 0.05, 'square',
          (shown < 3 ? 0.07 : 0.04) * (mine ? 1 : 0.45));
      }
    }

    const msg = $('#bigmsg');
    const sub = $('#submsg');
    let subText = '';

    if (G.state === 'countdown') {
      const n = Math.ceil(G.timer - 0.4);
      msg.textContent = n > 0 ? String(n) : 'GO!';
      msg.style.color = n > 0 ? '#f4f2ff' : '#7cff6b';
      subText = G.mod ? `${G.mod} — ${G.modBlurb}` : '';
    } else if (G.state === 'over') {
      const w = G.meta.get(G.winner);
      msg.textContent = w ? (G.winner === G.id ? '🏆 YOU WIN' : `🏆 ${w.name}`) : 'EVERYBODY DIED';
      msg.style.color = '#ffd93d';
    } else if (G.state === 'playing') {
      if (iAmGhost) {
        msg.textContent = '👻 GHOST';
        msg.style.color = '#c9c3ff';
        subText = me[9] >= 100 ? 'SPACE — LAUNCH A SPOOK' : 'RECHARGING…';
      } else if (me && (me[5] & FLAG.BOMB)) {
        msg.textContent = 'PASS IT!';
        msg.style.color = '#ff4d6d';
      } else {
        msg.textContent = G.sudden ? 'SUDDEN DEATH' : '';
        msg.style.color = '#ff4d6d';
      }
    } else {
      msg.textContent = '';
    }
    sub.textContent = subText;

    const chip = $('#modchip');
    chip.classList.toggle('hidden', !G.mod || G.state === 'lobby');
    chip.textContent = G.mod;

    const db = $('#dashbtn');
    if (db) {
      db.disabled = !me || (iAmGhost ? me[9] : me[7]) < 100;
      db.textContent = iAmGhost ? 'SPOOK' : 'DASH';
    }
  }

  function draw(world, dt) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // background
    const bg = ctx.createRadialGradient(W / 2, H * 0.35, 40, W / 2, H * 0.5, Math.max(W, H) * 0.8);
    bg.addColorStop(0, '#1a1440');
    bg.addColorStop(1, '#070615');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    if (!world) { drawConfetti(); return; }

    const arena = world.arena;
    const want = Math.min(W, H) / (2 * (arena + 70));
    G.scale = lerp(G.scale, clamp(want, 0.2, 2.2), 1 - Math.exp(-3 * dt));

    ctx.save();
    const sh = G.shake * 16;
    ctx.translate(
      W / 2 + (Math.random() - 0.5) * sh,
      H / 2 + (Math.random() - 0.5) * sh);
    ctx.scale(G.scale, G.scale);

    drawArena(arena);
    for (const u of world.pickups) drawPickup(u);
    for (const o of world.orbs) drawOrb(o);

    const players = world.players.slice().sort((a, b) => a.y - b.y);
    const meRaw = players.find((p) => p.id === G.id);
    const mePredicted = predict(meRaw, dt);

    for (const p of players) drawBlob(p === meRaw ? mePredicted : p, p.id === G.id);
    drawParticles();
    drawFloats(mePredicted);

    ctx.restore();
    drawConfetti();
    drawVignette();
  }

  function drawOrb(o) {
    const [, x, y, color] = o;
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowBlur = 24;
    ctx.shadowColor = color || '#c9c3ff';
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = color || '#c9c3ff';
    ctx.beginPath();
    ctx.arc(0, 0, 13 + Math.sin(time * 14) * 2, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawArena(arena) {
    const danger = arena < 260 || G.sudden;

    ctx.save();
    ctx.shadowBlur = 60;
    ctx.shadowColor = danger ? 'rgba(255,77,109,0.55)' : 'rgba(120,90,255,0.45)';
    ctx.beginPath();
    ctx.arc(0, 0, arena, 0, TAU);
    const g = ctx.createRadialGradient(0, -arena * 0.3, arena * 0.1, 0, 0, arena);
    g.addColorStop(0, '#2a2360');
    g.addColorStop(0.75, '#1b1747');
    g.addColorStop(1, '#141038');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    // concentric rings for depth cues
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 2;
    for (let r = 90; r < arena; r += 90) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
    }

    // rim
    const pulse = 0.6 + 0.4 * Math.sin(time * (danger ? 7 : 2.5));
    ctx.lineWidth = 6;
    ctx.strokeStyle = danger
      ? `rgba(255,77,109,${0.5 + pulse * 0.5})`
      : `rgba(160,130,255,${0.35 + pulse * 0.25})`;
    ctx.beginPath();
    ctx.arc(0, 0, arena, 0, TAU);
    ctx.stroke();
  }

  function drawPickup(u) {
    const [, x, y, kind] = u;
    const bob = Math.sin(time * 3 + x) * 5;
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.shadowBlur = 22;
    ctx.shadowColor = kind === 0 ? '#ffd93d' : '#4dd4ff';
    ctx.fillStyle = kind === 0 ? 'rgba(255,217,61,0.18)' : 'rgba(77,212,255,0.18)';
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = '22px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(kind === 0 ? '⚡' : '🛡', 0, 1);
    ctx.restore();
  }

  function drawBlob(p, isMe) {
    const meta = G.meta.get(p.id) || { name: '???', emoji: '🙂', color: '#888' };
    const alive = p.f & FLAG.ALIVE;
    const falling = p.f & FLAG.FALL;

    if (p.f & FLAG.GHOST) return drawGhost(p, isMe, meta);
    if (!alive && !falling) return; // eliminated: gone from the floor

    const speed = Math.hypot(p.vx, p.vy);
    const squash = clamp(speed / 1500, 0, 0.18);
    const ang = Math.atan2(p.vy, p.vx);
    const scale = falling ? 0.72 : 1;   // shrink as you drop out of the world

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = falling ? 0.55 : 1;

    // shadow on the floor
    ctx.save();
    ctx.scale(1, 0.42);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(0, PLAYER_R * 1.5, PLAYER_R * 0.95, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (p.f & FLAG.BOOST) {
      ctx.strokeStyle = 'rgba(255,217,61,0.5)';
      ctx.lineWidth = 3;
      for (let i = 1; i <= 3; i++) {
        ctx.globalAlpha = (falling ? 0.4 : 0.9) * (0.3 / i);
        ctx.beginPath();
        ctx.arc(-p.vx * 0.02 * i, -p.vy * 0.02 * i, PLAYER_R, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = falling ? 0.55 : 1;
    }

    // bomb aura
    if (p.f & FLAG.BOMB) {
      const urgency = clamp(1 - G.bombT / 8, 0, 1);
      const rate = 3 + urgency * 12;
      const puls = 0.5 + 0.5 * Math.sin(time * rate);
      ctx.save();
      ctx.shadowBlur = 30 + puls * 30;
      ctx.shadowColor = '#ff4d6d';
      ctx.strokeStyle = `rgba(255,77,109,${0.45 + puls * 0.5})`;
      ctx.lineWidth = 4 + puls * 4;
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_R + 12 + puls * 8, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // body
    ctx.save();
    ctx.rotate(ang);
    ctx.scale((1 + squash) * scale, (1 - squash) * scale);
    ctx.rotate(-ang);

    if (p.f & FLAG.DASH) {
      ctx.shadowBlur = 26;
      ctx.shadowColor = meta.color;
    }
    ctx.fillStyle = meta.color;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    // glossy top
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.ellipse(0, -PLAYER_R * 0.38, PLAYER_R * 0.55, PLAYER_R * 0.33, 0, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = isMe ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.3)';
    ctx.lineWidth = isMe ? 3 : 2;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R, 0, TAU);
    ctx.stroke();

    ctx.font = '27px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.emoji, 0, 2);
    ctx.restore();

    if (p.f & FLAG.SHIELD) {
      ctx.strokeStyle = 'rgba(77,212,255,0.85)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -time * 30;
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_R + 7, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // bomb sitting on top
    if (p.f & FLAG.BOMB) {
      ctx.font = '26px serif';
      ctx.fillText('💣', 0, -PLAYER_R - 20 + Math.sin(time * 9) * 3);
    }

    // name
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'center';
    ctx.fillText(meta.name, 0, PLAYER_R + 18);

    // emote bubble
    if (p.emote) {
      ctx.font = '30px serif';
      ctx.fillText(EMOTES[p.emote] || '❓', 0, -PLAYER_R - 46 + Math.sin(time * 6) * 3);
    }

    ctx.restore();
  }

  /** Eliminated players hover outside the rim, waiting to ruin someone's day. */
  function drawGhost(p, isMe, meta) {
    const bob = Math.sin(time * 2.4 + p.x * 0.02) * 6;
    const charged = p.orb >= 1;

    ctx.save();
    ctx.translate(p.x, p.y + bob);
    ctx.globalAlpha = isMe ? 0.85 : 0.5;

    if (charged) {
      ctx.shadowBlur = 22;
      ctx.shadowColor = meta.color;
    }

    // wispy body: a dome with a ragged hem
    ctx.fillStyle = meta.color;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R * 0.8, Math.PI, 0);
    const hem = PLAYER_R * 0.8;
    ctx.lineTo(hem, hem * 0.7);
    for (let i = 0; i < 4; i++) {
      const x0 = hem - (i * 2 + 1) * (hem / 4);
      ctx.quadraticCurveTo(x0 + hem / 8, hem * 0.7 + 7, x0, hem * 0.7);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.globalAlpha = isMe ? 1 : 0.7;
    ctx.font = '20px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.emoji, 0, -2);

    // Aim line. The server fires along your last steering direction, so read it
    // straight off local input rather than guessing from velocity.
    if (isMe) {
      const im = Math.hypot(input.x, input.y);
      const rad = Math.hypot(p.x, p.y) || 1;
      const fx = im > 0.05 ? input.x / im : -p.x / rad;
      const fy = im > 0.05 ? input.y / im : -p.y / rad;
      ctx.globalAlpha = charged ? 0.5 : 0.18;
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(fx * 34, fy * 34);
      ctx.lineTo(fx * 120, fy * 120);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.globalAlpha = 0.55;
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(meta.name, 0, PLAYER_R + 10);
    ctx.restore();
  }

  function drawParticles() {
    for (const p of G.parts) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloats(me) {
    for (const f of G.floats) {
      const x = f.x || (me ? me.x : 0);
      const y = (f.y || (me ? me.y : 0)) - (1.1 - f.life) * 60 - 50;
      ctx.globalAlpha = clamp(f.life, 0, 1);
      ctx.font = '900 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  function drawConfetti() {
    for (const c of G.confetti) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.globalAlpha = clamp(c.life, 0, 1);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* --------------------------------------------------------------- boot */

  const FACES = ['🙂', '😎', '🤠', '👽', '🐸', '🐱', '🦊', '🐼',
    '🍕', '💀', '🤡', '👻', '🐙', '🦄', '🔥', '🌮'];

  const pickEl = $('#emojipick');
  let chosen = store.get('bb_emoji') || FACES[(Math.random() * FACES.length) | 0];
  pickEl.innerHTML = FACES.map((f) => `<button type="button" data-f="${f}">${f}</button>`).join('');
  function syncPick() {
    pickEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === chosen));
  }
  pickEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    chosen = b.dataset.f;
    syncPick();
  });
  syncPick();

  $('#name').value = store.get('bb_name') || '';
  const urlCode = location.pathname.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
  if (urlCode) $('#code').value = urlCode;

  function start() {
    audio();
    const name = ($('#name').value || '').trim() || 'Blob';
    const code = ($('#code').value || '').trim().toUpperCase();
    connect(code, name, chosen);
  }
  $('#play').addEventListener('click', start);
  $('#start').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });

  // keep the scoreboard's alive/dead styling honest
  setInterval(() => { if (G.meta.size) renderBoard(); }, 400);

  requestAnimationFrame(frame);
})();
