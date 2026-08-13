// World generation. A world is fully determined by (seed, logSize, parent
// theme): the same rift always leads to the same world. Sizes are stored as
// log10(metres) because the descent is infinite and floats give up around
// 10^-308 — we never touch a linear size.
(function () {
  'use strict';
  const TW = (window.TW = window.TW || {});
  const TAU = Math.PI * 2;

  // The first few draws from the world's RNG establish its identity (theme,
  // palette, name). Rift previews replay exactly these draws on the child's
  // seed, so the tooltip on a rift shows the true name of what's inside.
  function worldIdentity(rng, logSize, parentThemeKey) {
    const themeKey = TW.pickThemeKey(rng, logSize, parentThemeKey);
    const theme = TW.THEMES[themeKey];
    const pal = rng.pick(theme.palettes);
    const name = TW.makeName(rng, theme.voice);
    const title = 'The ' + rng.pick(theme.adjs) + ' ' + rng.pick(theme.nouns) + ' of ' + name;
    const flavor = rng.pick(theme.flavor);
    return { themeKey, theme, pal, name, title, flavor };
  }

  function previewChild(childSeed, childLog, parentThemeKey) {
    const id = worldIdentity(new TW.RNG(childSeed), childLog, parentThemeKey);
    return { themeKey: id.themeKey, glow: id.pal.glow, name: id.name, title: id.title };
  }

  function generateWorld(seed, depth, logSize, parentThemeKey) {
    const rng = new TW.RNG(seed);
    const id = worldIdentity(rng, logSize, parentThemeKey);
    const theme = id.theme;
    const pal = id.pal;

    const w = {
      seed, depth, logSize,
      themeKey: id.themeKey, pal,
      name: id.name, title: id.title, flavor: id.flavor,
      rot0: rng.angle(),
      rotSpeed: rng.range(0.02, 0.05) * rng.sign(),
      tilt: rng.range(-0.5, 0.5),
    };

    // Planet body texture: latitude-ish bands plus drifting speckles.
    w.bands = [];
    const nBands = rng.int(2, 4);
    for (let i = 0; i < nBands; i++) {
      w.bands.push({
        y: rng.range(-0.75, 0.75),
        h: rng.range(0.08, 0.28),
        a: rng.range(0.05, 0.12),
        light: rng.chance(0.5),
      });
    }
    w.speckles = [];
    const nSpeck = rng.int(28, 44);
    for (let i = 0; i < nSpeck; i++) {
      w.speckles.push({
        a: rng.angle(),
        r: Math.sqrt(rng.float()) * 0.92,
        s: rng.range(0.012, 0.04),
        light: rng.chance(0.35),
      });
    }

    // Surface features, spaced around the rim with jitter.
    w.features = [];
    const nFeat = rng.int(14, 22);
    for (let i = 0; i < nFeat; i++) {
      const angle = (i / nFeat) * TAU + rng.range(-0.35, 0.35) / nFeat * TAU;
      w.features.push({
        type: rng.weighted(theme.features),
        angle,
        size: rng.range(0.7, 1.4),
        colorIdx: rng.int(0, pal.accents.length - 1),
        phase: rng.angle(),
        flip: rng.sign(),
        wob: rng.range(0.5, 1.5),
      });
    }

    // Rifts: the tiny worlds embedded in this one. Always at least two —
    // there is no world without a way further down.
    w.portals = [];
    const nPortals = depth === 0 ? rng.int(3, 4) : rng.int(2, 4);
    const startA = rng.angle();
    for (let i = 0; i < nPortals; i++) {
      const angle = startA + (i / nPortals) * TAU + rng.range(-0.2, 0.2);
      const childSeed = TW.mix(seed, 0x9e37 + i * 0x85eb);
      const childLog = logSize - rng.range(2.0, 3.2);
      w.portals.push({
        angle,
        dist: rng.range(0.34, 0.68),
        size: rng.range(0.10, 0.14),
        spin: rng.range(0.6, 1.4) * rng.sign(),
        childSeed, childLog,
        preview: previewChild(childSeed, childLog, id.themeKey),
      });
    }

    // Stardust motes, floating just off the surface.
    w.motes = [];
    const nMotes = rng.int(6, 11);
    for (let i = 0; i < nMotes; i++) {
      w.motes.push({
        angle: rng.angle(),
        dist: rng.range(1.14, 1.62),
        size: rng.range(2.2, 4.2),
        phase: rng.angle(),
        speed: rng.range(0.05, 0.22) * rng.sign(),
        collected: false,
      });
    }

    // Fauna.
    w.creatures = [];
    for (const spec of theme.creatures) {
      const n = rng.int(spec[1], spec[2]);
      for (let i = 0; i < n; i++) {
        w.creatures.push({
          type: spec[0],
          baseR: rng.range(1.12, 1.8),
          speed: rng.range(0.15, 0.5) * rng.sign(),
          phase: rng.angle(),
          size: rng.range(0.75, 1.3),
          wobA: rng.range(0.01, 0.06),
          wobF: rng.range(0.6, 1.8),
          colorIdx: rng.int(0, pal.accents.length - 1),
        });
      }
    }

    // Sky: moons, maybe a ring, stars, nebulae, distant sibling worlds.
    w.moons = [];
    if (rng.chance(0.55)) {
      const n = rng.int(1, 2);
      for (let i = 0; i < n; i++) {
        w.moons.push({
          dist: rng.range(1.9, 2.5),
          size: rng.range(0.05, 0.11),
          speed: rng.range(0.05, 0.16) * rng.sign(),
          phase: rng.angle(),
          squish: rng.range(0.28, 0.5), // orbit ellipse flattening
        });
      }
    }
    w.ring = rng.chance(0.22)
      ? { rIn: rng.range(1.25, 1.4), rOut: rng.range(1.5, 1.75), squish: rng.range(0.22, 0.34), alpha: rng.range(0.25, 0.5) }
      : null;

    w.stars = [];
    const nStars = rng.int(90, 150);
    for (let i = 0; i < nStars; i++) {
      w.stars.push({
        x: rng.float(), y: rng.float(),
        s: rng.range(0.4, 1.7),
        tw: rng.angle(),
        twf: rng.range(0.4, 2.4),
        bright: rng.chance(0.12),
      });
    }
    w.nebulas = [];
    const nNeb = rng.int(2, 4);
    for (let i = 0; i < nNeb; i++) {
      w.nebulas.push({
        x: rng.float(), y: rng.float(),
        r: rng.range(0.22, 0.5),
        color: rng.pick(pal.nebula),
        a: rng.range(0.10, 0.2),
        drift: rng.angle(),
      });
    }
    w.siblings = [];
    const nSib = rng.int(0, 3);
    for (let i = 0; i < nSib; i++) {
      w.siblings.push({ x: rng.float(), y: rng.float() * 0.6, r: rng.range(4, 11), a: rng.range(0.15, 0.4) });
    }

    return w;
  }

  // --- Scale formatting -----------------------------------------------------

  const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '.': '·' };
  function sup(n) {
    return String(n).split('').map((c) => SUP[c] || c).join('');
  }
  function nice(x) {
    if (x >= 100) return Math.round(x).toLocaleString('en-US');
    if (x >= 10) return x.toFixed(1);
    return x.toFixed(2);
  }

  const PLANCK_LOG = -34.79;

  // logM = log10(diameter in metres) -> human string.
  function formatSize(logM) {
    if (logM >= 3.5) return nice(Math.pow(10, logM - 3)) + ' km';
    if (logM >= 0) return nice(Math.pow(10, logM)) + ' m';
    if (logM >= -2) return nice(Math.pow(10, logM + 2)) + ' cm';
    if (logM >= -3) return nice(Math.pow(10, logM + 3)) + ' mm';
    if (logM >= -6) return nice(Math.pow(10, logM + 6)) + ' µm';
    if (logM >= -9) return nice(Math.pow(10, logM + 9)) + ' nm';
    if (logM >= -12) return nice(Math.pow(10, logM + 12)) + ' pm';
    if (logM >= -15) return nice(Math.pow(10, logM + 15)) + ' fm';
    const s = '10' + sup(logM.toFixed(logM > -100 ? 1 : 0)) + ' m';
    return logM < PLANCK_LOG ? s + ' · below the Planck length' : s;
  }

  // Fired once each, on the first world that crosses the line.
  const MILESTONES = [
    { l: 0.3, t: 'This whole world is smaller than you are.' },
    { l: -1.6, t: 'Smaller than a ladybug now.' },
    { l: -3.6, t: 'This world could hide inside a grain of sand.' },
    { l: -5, t: 'Smaller than a single living cell.' },
    { l: -7, t: 'Smaller than a virus. Bless it.' },
    { l: -9.3, t: 'Smaller than a molecule of water.' },
    { l: -10.5, t: 'Smaller than an atom.' },
    { l: -14.7, t: 'Smaller than an atomic nucleus.' },
    { l: -19, t: 'Smaller than anything humanity has ever measured.' },
    { l: PLANCK_LOG, t: 'Below the Planck length. Physics has given up. You haven’t.' },
    { l: -45, t: 'The universe is politely pretending not to notice you down here.' },
    { l: -60, t: 'Out of physics entirely. Running on pure imagination now.' },
    { l: -80, t: 'Somewhere far above, your first world has forgotten you.' },
    { l: -100, t: 'One hundred orders of magnitude. …How are you still going?' },
    { l: -150, t: 'The worlds down here are made of maybes and each other.' },
    { l: -200, t: 'Achievement unlocked, probably: Unreasonably Tiny.' },
    { l: -300, t: 'There is no bottom. There was never going to be a bottom. Isn’t it wonderful?' },
  ];

  TW.worldIdentity = worldIdentity;
  TW.previewChild = previewChild;
  TW.generateWorld = generateWorld;
  TW.formatSize = formatSize;
  TW.MILESTONES = MILESTONES;
  TW.PLANCK_LOG = PLANCK_LOG;
})();
