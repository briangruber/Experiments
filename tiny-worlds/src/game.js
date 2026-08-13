// Game shell: the world stack, dive/surface transitions, input, HUD, saves.
// The universe is a tree of seeds; the player's position in it is just a
// stack of generated worlds, so climbing out always returns to the exact
// world you left.
(function () {
  'use strict';
  const TW = (window.TW = window.TW || {});
  const Sound = TW.Sound;

  const S = {
    canvas: null, ctx: null, W: 0, H: 0, dpr: 1,
    time: 0, last: 0,
    rootSeed: 0,
    stack: [],       // ancestors, root first
    world: null,     // where we are now
    mode: 'idle',    // idle | dive | surface
    trans: null,     // {outer, inner, idx, p}
    hover: -1,
    mouse: { x: -1e4, y: -1e4 },
    particles: [],
    wheelAcc: 0,
    bounce: 0,
    started: false,
    stardust: 0,
    deepest: 0,
    discovered: new Set(),
    collected: new Map(),  // world seed -> Set of mote indices
    milestonesFired: new Set(),
    vignette: null,
  };

  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const smooth = (a, b, x) => { const u = clamp01((x - a) / (b - a)); return u * u * (3 - 2 * u); };
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);

  // --- Persistence ----------------------------------------------------------

  function loadSave() {
    try {
      const d = JSON.parse(localStorage.getItem('tinyWorlds.save.v1'));
      if (!d) return;
      S.stardust = d.stardust | 0;
      S.deepest = d.deepest | 0;
      for (const s of d.discovered || []) S.discovered.add(s);
    } catch (e) { /* fresh start */ }
  }

  function save() {
    try {
      localStorage.setItem('tinyWorlds.save.v1', JSON.stringify({
        stardust: S.stardust,
        deepest: S.deepest,
        discovered: Array.from(S.discovered).slice(-4000),
      }));
    } catch (e) { /* private mode etc. */ }
  }

  // --- World management -------------------------------------------------

  function applyCollected(world) {
    const set = S.collected.get(world.seed);
    if (!set) return;
    for (const i of set) if (world.motes[i]) world.motes[i].collected = true;
  }

  function visitWorld(world, viaDive) {
    if (!S.discovered.has(world.seed)) {
      S.discovered.add(world.seed);
      addJournalEntry(world);
      if (viaDive && Sound) Sound.discover();
    }
    if (world.depth > S.deepest) S.deepest = world.depth;
    save();
    updateHud();
  }

  function checkMilestones(world) {
    let fired = null;
    for (const m of TW.MILESTONES) {
      if (world.logSize < m.l && !S.milestonesFired.has(m.l)) {
        S.milestonesFired.add(m.l);
        fired = m;
      }
    }
    if (fired) {
      showToast(fired.t, 'milestone');
      if (Sound) Sound.milestone();
    }
  }

  function diveInto(i) {
    if (S.mode !== 'idle' || !S.world || !S.world.portals[i]) return;
    const p = S.world.portals[i];
    const child = TW.generateWorld(p.childSeed, S.world.depth + 1, p.childLog, S.world.themeKey);
    applyCollected(child);
    S.trans = { outer: S.world, inner: child, idx: i, p: 0 };
    S.mode = 'dive';
    S.hover = -1;
    hideTooltip();
    if (Sound) Sound.dive();
  }

  function surfaceUp() {
    if (S.mode !== 'idle' || !S.world) return;
    if (!S.stack.length) {
      showToast('This is as big as it gets. The only way out is in.');
      S.bounce = 1;
      if (Sound) Sound.bump();
      return;
    }
    const parent = S.stack[S.stack.length - 1];
    let idx = parent.portals.findIndex((pp) => pp.childSeed === S.world.seed);
    if (idx < 0) idx = 0;
    S.trans = { outer: parent, inner: S.world, idx, p: 1 };
    S.mode = 'surface';
    S.hover = -1;
    hideTooltip();
    if (Sound) Sound.surface();
  }

  function newUniverse(seed) {
    S.rootSeed = seed >>> 0;
    S.stack = [];
    S.mode = 'idle';
    S.trans = null;
    S.world = TW.generateWorld(S.rootSeed, 0, 6.9 + (S.rootSeed % 1000) / 2000, null);
    applyCollected(S.world);
    try {
      const url = new URL(location.href);
      url.searchParams.set('seed', String(S.rootSeed));
      history.replaceState(null, '', url);
    } catch (e) { /* file:// */ }
    visitWorld(S.world, false);
    updateHud();
  }

  // --- HUD --------------------------------------------------------------

  function updateHud() {
    const w = S.world;
    if (!w) return;
    document.documentElement.style.setProperty('--accent', w.pal.glow);
    $('wTitle').textContent = w.title;
    $('wFlavor').textContent = w.flavor;
    $('wMeta').innerHTML =
      '<span>' + w.themeKey + '</span> · ⌀ ' + TW.formatSize(w.logSize) +
      ' · depth ' + w.depth;
    $('stStars').textContent = S.stardust.toLocaleString('en-US');
    $('stWorlds').textContent = S.discovered.size.toLocaleString('en-US');
    $('stDeep').textContent = S.deepest;
    $('stSeed').textContent = '#' + S.rootSeed;
  }

  function addJournalEntry(world) {
    const li = document.createElement('li');
    li.innerHTML = '<b>' + world.title + '</b><span>' +
      world.themeKey + ' · ⌀ ' + TW.formatSize(world.logSize) + ' · depth ' + world.depth + '</span>';
    const list = $('journalList');
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 60) list.removeChild(list.lastChild);
  }

  let toastTimer = 0;
  function showToast(text, cls) {
    const el = document.createElement('div');
    el.className = 'toast' + (cls ? ' ' + cls : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 600);
    }, 4600);
  }

  function showTooltip(portal, x, y) {
    const tip = $('tooltip');
    tip.style.display = 'block';
    tip.innerHTML = '<b>' + portal.preview.title + '</b><span>⌀ ' +
      TW.formatSize(portal.childLog) + ' — click to dive in</span>';
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(S.W - r.width - 8, x - r.width / 2)) + 'px';
    tip.style.top = Math.max(8, y - r.height - 18) + 'px';
  }
  function hideTooltip() { $('tooltip').style.display = 'none'; }

  // --- Particles ----------------------------------------------------------

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 30 + Math.random() * 90;
      S.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 20,
        life: 0.5 + Math.random() * 0.5, age: 0, color, size: 1 + Math.random() * 2,
      });
    }
    S.particles.push({ x, y: y - 8, vx: 0, vy: -34, life: 1.0, age: 0, text: '+1 ✦', color: '#fff3c0' });
  }

  function updateParticles(dt) {
    for (const p of S.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-2.2 * dt);
      p.vy *= Math.exp(-2.2 * dt);
    }
    S.particles = S.particles.filter((p) => p.age < p.life);
  }

  function drawParticles(ctx) {
    for (const p of S.particles) {
      const a = 1 - p.age / p.life;
      if (p.text) {
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,243,192,' + a + ')';
        ctx.fillText(p.text, p.x, p.y);
      } else {
        ctx.fillStyle = TW.draw.hexA(p.color, a);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // --- Rendering ----------------------------------------------------------

  function renderTransition(ctx) {
    const { outer, inner, idx } = S.trans;
    const p = S.trans.p;
    const t = S.time;
    const W = S.W, H = S.H;
    const layout = TW.draw.computeLayout(W, H);
    const A = { x: layout.cx, y: layout.cy };
    const pp = TW.draw.portalPos(outer, layout, idx, t);

    // the inner world's arrival: background fading in, planet scaling up
    const aIn = smooth(0.3, 0.62, p);
    const k = 0.22 + 0.78 * easeOut(smooth(0.3, 1, p));

    // outer world zooming into the rift; skipped once fully hidden
    if (aIn < 1) {
      const targetS = (Math.hypot(W, H) * 0.62) / pp.r;
      const s = 1 + easeInOut(p) * (targetS - 1);
      const drive = clamp01(p * 1.45);
      const qx = A.x + (pp.x - A.x) * drive;
      const qy = A.y + (pp.y - A.y) * drive;
      ctx.save();
      ctx.translate(A.x, A.y);
      ctx.scale(s, s);
      ctx.translate(-qx, -qy);
      TW.draw.drawWorld(ctx, outer, W, H, t, { hover: -1 });
      ctx.restore();
    }

    if (aIn > 0) {
      ctx.save();
      ctx.globalAlpha = aIn;
      TW.draw.drawBackground(ctx, inner, W, H, t);
      ctx.translate(A.x, A.y);
      ctx.scale(k, k);
      ctx.translate(-A.x, -A.y);
      TW.draw.drawWorld(ctx, inner, W, H, t, { hover: -1, noBackground: true });
      ctx.restore();
    }

    // glow flash at the crossover
    const flash = Math.exp(-Math.pow((p - 0.52) / 0.12, 2)) * 0.55;
    if (flash > 0.02) {
      const g = ctx.createRadialGradient(A.x, A.y, 0, A.x, A.y, Math.hypot(W, H) * 0.6);
      const glow = inner.pal.glow;
      g.addColorStop(0, TW.draw.hexA(glow, flash));
      g.addColorStop(1, TW.draw.hexA(glow, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function render() {
    const ctx = S.ctx;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);

    if (S.bounce > 0) {
      const b = 1 + 0.028 * Math.sin(S.bounce * Math.PI) * S.bounce;
      ctx.translate(S.W / 2, S.H / 2);
      ctx.scale(b, b);
      ctx.translate(-S.W / 2, -S.H / 2);
    }

    if (S.mode === 'idle') {
      TW.draw.drawWorld(ctx, S.world, S.W, S.H, S.time, { hover: S.hover });
    } else {
      renderTransition(ctx);
    }

    drawParticles(ctx);

    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    if (!S.vignette) {
      const v = ctx.createRadialGradient(S.W / 2, S.H / 2, Math.min(S.W, S.H) * 0.45, S.W / 2, S.H / 2, Math.hypot(S.W, S.H) * 0.62);
      v.addColorStop(0, 'rgba(2,3,12,0)');
      v.addColorStop(1, 'rgba(2,3,12,0.42)');
      S.vignette = v;
    }
    ctx.fillStyle = S.vignette;
    ctx.fillRect(0, 0, S.W, S.H);
  }

  // --- Update -------------------------------------------------------------

  function updateHover() {
    S.hover = -1;
    if (S.mode !== 'idle' || !S.started) { hideTooltip(); return; }
    const layout = TW.draw.computeLayout(S.W, S.H);
    for (let i = 0; i < S.world.portals.length; i++) {
      const pos = TW.draw.portalPos(S.world, layout, i, S.time);
      const d = Math.hypot(S.mouse.x - pos.x, S.mouse.y - pos.y);
      if (d < Math.max(pos.r * 1.45, 20)) {
        S.hover = i;
        showTooltip(S.world.portals[i], pos.x, pos.y - pos.r);
        break;
      }
    }
    if (S.hover < 0) hideTooltip();
    S.canvas.style.cursor = S.hover >= 0 ? 'pointer' : 'default';

    // hover-collect stardust
    for (let i = 0; i < S.world.motes.length; i++) {
      const m = S.world.motes[i];
      if (m.collected) continue;
      const pos = TW.draw.motePos(S.world, layout, i, S.time);
      if (Math.hypot(S.mouse.x - pos.x, S.mouse.y - pos.y) < 24) {
        m.collected = true;
        if (!S.collected.has(S.world.seed)) S.collected.set(S.world.seed, new Set());
        S.collected.get(S.world.seed).add(i);
        S.stardust++;
        burst(pos.x, pos.y, S.world.pal.glow, 10);
        if (Sound) Sound.ping(S.stardust);
        save();
        updateHud();
      }
    }
  }

  function tick(now) {
    const dt = Math.min(0.05, Math.max(0.0001, (now - S.last) / 1000));
    S.last = now;
    S.time += dt;

    if (S.mode === 'dive') {
      S.trans.p += dt / 1.35;
      if (S.trans.p >= 1) {
        S.stack.push(S.trans.outer);
        S.world = S.trans.inner;
        S.mode = 'idle';
        S.trans = null;
        visitWorld(S.world, true);
        checkMilestones(S.world);
      }
    } else if (S.mode === 'surface') {
      S.trans.p -= dt / 1.15;
      if (S.trans.p <= 0) {
        S.stack.pop();
        S.world = S.trans.outer;
        S.mode = 'idle';
        S.trans = null;
        updateHud();
      }
    }

    S.wheelAcc *= Math.exp(-3 * dt);
    if (S.bounce > 0) S.bounce = Math.max(0, S.bounce - dt * 2.2);

    updateParticles(dt);
    updateHover();
    render();
    requestAnimationFrame(tick);
  }

  // --- Input --------------------------------------------------------------

  function bindInput() {
    const c = S.canvas;

    c.addEventListener('mousemove', (e) => {
      S.mouse.x = e.clientX;
      S.mouse.y = e.clientY;
    });
    c.addEventListener('mouseleave', () => {
      S.mouse.x = S.mouse.y = -1e4;
    });

    c.addEventListener('click', () => {
      if (!S.started) return;
      if (Sound) Sound.init();
      if (S.hover >= 0) diveInto(S.hover);
    });

    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (S.started) surfaceUp();
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!S.started || S.mode !== 'idle') return;
      if (e.deltaY < 0) {
        // zoom in: dive through the rift under (or near) the cursor
        let target = S.hover;
        if (target < 0) {
          const layout = TW.draw.computeLayout(S.W, S.H);
          let best = 150;
          for (let i = 0; i < S.world.portals.length; i++) {
            const pos = TW.draw.portalPos(S.world, layout, i, S.time);
            const d = Math.hypot(S.mouse.x - pos.x, S.mouse.y - pos.y);
            if (d < best) { best = d; target = i; }
          }
        }
        if (target >= 0) diveInto(target);
      } else {
        S.wheelAcc += e.deltaY;
        if (S.wheelAcc > 180) {
          S.wheelAcc = 0;
          surfaceUp();
        }
      }
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!S.started) return;
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); surfaceUp(); }
      else if (e.key === 'm') { if (Sound) $('btnMute').textContent = Sound.toggleMute() ? '♪̸' : '♪'; }
      else if (e.key === 'j') toggleJournal();
      else if (e.key === 'n') newUniverse((Math.random() * 4294967296) >>> 0);
      else if (e.key === '?' || e.key === 'h') toggleOverlay();
    });

    window.addEventListener('resize', resize);

    $('btnOut').addEventListener('click', () => surfaceUp());
    $('btnJournal').addEventListener('click', toggleJournal);
    $('btnMute').addEventListener('click', () => {
      if (Sound) { Sound.init(); $('btnMute').textContent = Sound.toggleMute() ? '♪̸' : '♪'; }
    });
    $('btnNew').addEventListener('click', () => {
      newUniverse((Math.random() * 4294967296) >>> 0);
      showToast('A new universe unfolds.');
    });
    $('btnHelp').addEventListener('click', toggleOverlay);
    $('startBtn').addEventListener('click', () => {
      if (Sound) Sound.init();
      S.started = true;
      $('overlay').classList.add('hidden');
    });
  }

  function toggleJournal() { $('journal').classList.toggle('hidden'); }
  function toggleOverlay() {
    const o = $('overlay');
    const hidden = o.classList.toggle('hidden');
    if (!hidden) $('startBtn').textContent = 'keep going';
  }

  function resize() {
    S.dpr = Math.min(2, window.devicePixelRatio || 1);
    S.W = window.innerWidth;
    S.H = window.innerHeight;
    S.canvas.width = Math.round(S.W * S.dpr);
    S.canvas.height = Math.round(S.H * S.dpr);
    S.canvas.style.width = S.W + 'px';
    S.canvas.style.height = S.H + 'px';
    S.vignette = null;
  }

  // --- Boot ---------------------------------------------------------------

  function boot() {
    S.canvas = $('c');
    S.ctx = S.canvas.getContext('2d');
    resize();
    loadSave();

    let seed = 0;
    let autostart = false;
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('seed')) seed = parseInt(q.get('seed'), 10) >>> 0;
      autostart = q.get('autostart') === '1';
    } catch (e) { /* no URL API */ }
    if (!seed) seed = (Math.random() * 4294967296) >>> 0;

    bindInput();
    newUniverse(seed);

    if (autostart) {
      S.started = true;
      $('overlay').classList.add('hidden');
    }

    S.last = performance.now();
    requestAnimationFrame(tick);

    TW.debug = {
      dive: (i) => diveInto(i || 0),
      surface: surfaceUp,
      state: () => ({
        mode: S.mode,
        depth: S.world ? S.world.depth : -1,
        theme: S.world ? S.world.themeKey : '',
        title: S.world ? S.world.title : '',
        logSize: S.world ? S.world.logSize : 0,
        portals: S.world ? S.world.portals.length : 0,
        stardust: S.stardust,
        discovered: S.discovered.size,
        started: S.started,
      }),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
