// Phones are not one class of device: the same code has to run on a 2019
// budget Android and an iPad Pro. Rather than guess from the user agent, we
// guess once from the hardware, then correct continuously from measured frame
// time -- render resolution is the dial, because it is the one knob that moves
// GPU cost without changing what the player sees.

const TIERS = [
  { // low
    name: 'low',
    oceanSegments: 96, oceanHalf: 2000, waveDetail: 3.5,
    particles: 460, wakeLength: 42, skySegments: 24,
    monsterDistance: 520, townLight: false, antialias: false, basePixelRatio: 1.25,
  },
  { // medium
    name: 'medium',
    oceanSegments: 152, oceanHalf: 2300, waveDetail: 5,
    particles: 900, wakeLength: 72, skySegments: 32,
    monsterDistance: 750, townLight: true, antialias: false, basePixelRatio: 1.5,
  },
  { // high
    name: 'high',
    oceanSegments: 224, oceanHalf: 2600, waveDetail: 6,
    particles: 1400, wakeLength: 110, skySegments: 48,
    monsterDistance: 1100, townLight: true, antialias: true, basePixelRatio: 2,
  },
];

export function detectTier() {
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced) {
    const i = TIERS.findIndex((t) => t.name === forced);
    if (i >= 0) return { tier: TIERS[i], index: i };
  }
  const coarse = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || (coarse ? 4 : 8);
  const small = Math.min(innerWidth, innerHeight) * (devicePixelRatio || 1) < 900;
  const mem = navigator.deviceMemory || (coarse ? 4 : 8);

  let index = 2;
  if (coarse) index = cores >= 6 && mem >= 4 && !small ? 1 : 0;
  else if (cores <= 4 || mem <= 4) index = 1;
  return { tier: TIERS[index], index };
}

/**
 * Watches frame time and trims or restores render resolution. Slow to raise,
 * quick to drop: a stutter during a monster fight is worse than a soft frame.
 */
export class AdaptiveResolution {
  constructor(renderer, tier, { min = 0.55, max = 1 } = {}) {
    this.renderer = renderer;
    this.base = Math.min(devicePixelRatio || 1, tier.basePixelRatio);
    this.min = min;
    this.max = max;
    this.scale = 1;
    this.samples = [];
    this.cooldown = 1.5;
    this.apply();
  }

  apply() {
    this.renderer.setPixelRatio(this.base * this.scale);
    this.renderer.setSize(innerWidth, innerHeight, false);
  }

  update(dt) {
    this.samples.push(dt);
    if (this.samples.length > 50) this.samples.shift();
    this.cooldown -= dt;
    if (this.cooldown > 0 || this.samples.length < 40) return;

    // Median, not mean: one GC pause should not cost the player their pixels.
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];

    if (median > 0.023 && this.scale > this.min) {
      this.scale = Math.max(this.min, this.scale - 0.12);
      this.apply();
      this.cooldown = 2.5;
      this.samples.length = 0;
    } else if (median < 0.0135 && this.scale < this.max) {
      this.scale = Math.min(this.max, this.scale + 0.08);
      this.apply();
      this.cooldown = 5;
      this.samples.length = 0;
    } else {
      this.cooldown = 1;
    }
  }

  get fps() {
    if (!this.samples.length) return 0;
    const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    return Math.round(1 / mean);
  }
}

/** Keep the phone awake and the browser chrome out of the way. */
export async function goImmersive(element) {
  try {
    if (matchMedia('(pointer: coarse)').matches && element.requestFullscreen) {
      await element.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch { /* refused; the game is still perfectly playable */ }
  try {
    if ('wakeLock' in navigator) {
      const lock = await navigator.wakeLock.request('screen');
      // Re-acquire it after the player tabs away and comes back.
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && lock.released) {
          try { await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
        }
      });
    }
  } catch { /* not supported, or refused */ }
}

export { TIERS };
