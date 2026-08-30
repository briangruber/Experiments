// The backdrop, which is now a video.
//
// Everything the procedural layers in animate.js were hand-written to fake —
// drifting cloud, water shimmer, a flickering lantern, smoke — arrives for free
// in a looping video, and arrives better, because it was painted rather than
// approximated with gradients. The trick that makes it usable in a game is
// feeding the same still as both the first and last frame of a
// first-last-frame video model: the end has to arrive back at the beginning,
// so it cuts to itself without a seam and can play forever.
//
// Three fallbacks, in order, and each is a normal state rather than an error:
// the loop, the still it was made from, and the procedural art that needs no
// assets at all.

export const KIND = { VIDEO: 'video', STILL: 'still', NONE: 'none' };

export async function loadBackdrop() {
  const A = globalThis.window?.__ASSETS;

  const videoSrc = A?.sceneVideo ?? './assets/scene.mp4';
  const video = await new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;          // required, or autoplay is refused
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const ok = () => resolve(v);
    v.addEventListener('canplay', ok, { once: true });
    v.addEventListener('error', () => resolve(null), { once: true });
    v.src = videoSrc;
    // A video that never fires either event — a missing file served as HTML,
    // say — must not hang the game behind a promise that never settles.
    setTimeout(() => resolve(v.readyState >= 2 ? v : null), 6000);
  });
  if (video) {
    // Autoplay may still be refused until the page has been interacted with.
    // Retrying on the first pointer event costs nothing and covers it.
    const kick = () => video.play().catch(() => {});
    kick();
    window.addEventListener('pointerdown', kick, { once: true });
    return { kind: KIND.VIDEO, video, draw: (ctx, w, h) => ctx.drawImage(video, 0, 0, w, h) };
  }

  const stillSrc = A?.sceneStill ?? './assets/scene.jpg';
  const still = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = stillSrc;
  });
  if (still) return { kind: KIND.STILL, image: still, draw: (ctx, w, h) => ctx.drawImage(still, 0, 0, w, h) };

  return { kind: KIND.NONE, draw: null };
}
