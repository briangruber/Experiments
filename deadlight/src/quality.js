// Device tier, and what the game costs on it.
//
// This is a fragment-bound game: a shadow-casting torch, a volumetric cone,
// forty dressed props and a post chain with a bloom mip pyramid. On a desktop
// GPU that is nothing. On a phone it is a slideshow at best and a thermal
// shutdown at worst, and a horror game running at eight frames per second is
// not frightening — it is broken.
//
// So the tier is picked once at boot and every expensive number in the game
// reads from it. Everything here is a *quantity*, never a feature: the mobile
// tier has fewer props, a smaller shadow map and no bloom, but it has the same
// monsters, the same puzzles and the same scares. A cut-down horror game is
// not worth shipping.

/**
 * `pointer: coarse` is the honest question — it asks whether the primary input
 * is a finger, which is exactly what decides both the control scheme and, in
 * practice, the GPU budget. Screen size alone misclassifies a touchscreen
 * laptop and a phone held in landscape at 900 CSS pixels wide.
 */
export function isTouchDevice() {
  return (window.matchMedia?.('(pointer: coarse)').matches ?? false)
    || (navigator.maxTouchPoints ?? 0) > 1;
}

/** Rough screen area in CSS pixels, used only to separate phones from tablets. */
function screenArea() {
  return (window.screen?.width ?? window.innerWidth) * (window.screen?.height ?? window.innerHeight);
}

const DESKTOP = {
  tier: 'desktop',
  touch: false,
  maxPixelRatio: 1.75,
  renderScale: 1,
  shadowMapSize: 1024,
  shadowDistance: 30,
  bloom: true,
  motes: 130,
  practicals: 7,
  mannequins: 8,
  watchers: 3,
  /** Prop counts by tag, for the level dresser. */
  dressing: { large: 22, wall: 10, medium: 16, small: 12 },
  fogDensity: 0.075,
};

const TABLET = {
  ...DESKTOP,
  tier: 'tablet',
  touch: true,
  maxPixelRatio: 1.25,
  renderScale: 0.9,
  shadowMapSize: 768,
  bloom: true,
  motes: 70,
  practicals: 5,
  mannequins: 6,
  watchers: 3,
  dressing: { large: 14, wall: 6, medium: 10, small: 7 },
};

const PHONE = {
  ...DESKTOP,
  tier: 'phone',
  touch: true,
  // 1.0 rather than the device's 3.0: this scene spends its whole budget on
  // fragments, and a phone's native pixel count is three times what it can
  // actually shade here.
  maxPixelRatio: 1,
  renderScale: 0.8,
  shadowMapSize: 512,
  shadowDistance: 18,
  // Bloom is a mip pyramid and several extra full-screen passes. The torch
  // hotspot loses its halo without it, which is a real loss — and still the
  // right trade against halving the frame rate.
  bloom: false,
  motes: 32,
  practicals: 4,
  mannequins: 5,
  watchers: 2,
  dressing: { large: 10, wall: 4, medium: 7, small: 5 },
  // Denser fog hides the shorter draw distance and buys back fill rate.
  fogDensity: 0.1,
};

/**
 * Pick a tier. `?quality=phone|tablet|desktop` forces one, which is how the
 * capture harness tests a tier it is not running on.
 */
export function detectQuality() {
  let forced = null;
  try {
    forced = new URLSearchParams(location.search).get('quality');
  } catch {
    // Sandboxed frame. Fall through to detection.
  }

  const preset = { phone: PHONE, tablet: TABLET, desktop: DESKTOP }[forced];
  if (preset) return { ...preset, forced: true };

  if (!isTouchDevice()) return { ...DESKTOP };
  // A tablet has both a finger and the die area to push pixels with.
  return screenArea() >= 1280 * 800 ? { ...TABLET } : { ...PHONE };
}
