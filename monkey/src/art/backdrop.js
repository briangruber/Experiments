// The backdrop, which is a looping video when one can play and a still when it
// cannot.
//
// Everything the procedural layers used to fake — water shimmer, a flickering
// lantern, firelight in a window — arrives painted in a video instead. Cloud
// and smoke are deliberately NOT asked for: a drifting cloud can only return
// to its starting position by leaving the frame or reversing, so asking for
// one is asking for the seam.
//
// The clip is closed at generation, by a first-last-frame model handed the
// same image as both frames. That is not the only way to get a loop, and the
// alternative is still here: crossfading the clip against itself, offset by
// half its length, hides the cut in an open-ended clip. But it is strictly
// worse when the loop already closes, because it means permanently showing a
// blend of two different moments — which mutes precisely the quiet,
// intermittent motion a good background loop is made of. So it is opt-in.
//
// The loading is deliberately not a race the game can lose. An earlier version
// awaited `canplay` with a six-second timeout before the game would start, and
// that is wrong twice over: it delays the room on a slow decode, and it
// silently downgrades to the still on anything slower than the timeout with no
// way to tell that from a missing file. Now the still shows immediately, the
// video loads alongside, and `draw` switches to it the moment it has a frame —
// so a slow video costs nothing and a broken one degrades visibly rather than
// secretly.
//
// Two candidate URLs are tried in order because the delivery scheme is not
// ours to choose: a published page may allow one of `data:` and `blob:` and
// not the other, and a blocked scheme fails silently by design.

export const KIND = { VIDEO: 'video', STILL: 'still', NONE: 'none' };

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Resolves with a playing <video>, or null. Never rejects, never hangs the
// caller — nobody awaits this on the critical path.
function loadVideo(sources, onNote) {
  return new Promise((resolve) => {
    const failures = [];
    let i = 0;
    const next = () => {
      if (i >= sources.length) {
        onNote?.(failures.length ? `no video (${failures.join('; ')})` : 'no video source');
        resolve(null);
        return;
      }
      const { url, label } = sources[i++];
      if (!url) { next(); return; }
      const v = document.createElement('video');
      v.muted = true;            // required, or autoplay is refused outright
      v.loop = true;
      v.playsInline = true;
      v.preload = 'auto';
      // Kept in the document. A detached media element is loaded at the
      // browser's discretion, and some will not decode one that is not in a
      // document at all — which reads exactly like a broken file.
      v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
      document.body.appendChild(v);

      let settled = false;
      const win = () => {
        if (settled) return;
        settled = true;
        onNote?.(`video via ${label}`);
        resolve(v);
      };
      const lose = (why) => {
        if (settled) return;
        settled = true;
        failures.push(`${label} ${why}`);
        v.remove();
        next();
      };
      v.addEventListener('loadeddata', win, { once: true });
      v.addEventListener('canplay', win, { once: true });
      v.addEventListener('error', () => lose('error ' + (v.error?.code ?? '?')), { once: true });
      // A generous ceiling, and only to move on to the next candidate — the
      // game is already running by now either way.
      // Short: a candidate that has not produced a frame in four seconds is
      // almost certainly refused, and the next candidate deserves the time
      // more than this one does.
      setTimeout(() => (v.readyState >= 2 ? win() : lose('timeout rs=' + v.readyState)), 4000);
      v.src = url;
      v.load();
    };
    next();
  });
}

export async function loadBackdrop() {
  const A = globalThis.window?.__ASSETS;
  const still = await loadImage(A?.sceneStill ?? './assets/scene.jpg');

  // A closed clip returns to its own first frame, so it needs no help. Only a
  // clip that does not is worth blending against itself.
  const closedLoop = A?.sceneClosedLoop !== false;

  const backdrop = {
    closedLoop,
    kind: still ? KIND.STILL : KIND.NONE,
    note: still ? 'still' : 'no backdrop assets',
    video: null,
    image: still,
    draw(ctx, w, h) {
      // readyState >= 2 means there is a current frame to paint. Drawing a
      // video with no frame yet throws in some browsers and paints nothing in
      // others, so the still covers the gap.
      const a = this.video, b = this.videoB;
      if (a && a.readyState >= 2) {
        const d = a.duration;
        if (b && b.readyState >= 2 && d && isFinite(d)) {
          // sin² and its complement, so the two weights always sum to one —
          // a linear pair would darken through the middle of the blend.
          const u = (a.currentTime % d) / d;
          ctx.drawImage(b, 0, 0, w, h);
          ctx.save();
          ctx.globalAlpha = Math.sin(Math.PI * u) ** 2;
          ctx.drawImage(a, 0, 0, w, h);
          ctx.restore();
        } else {
          ctx.drawImage(a, 0, 0, w, h);
        }
        return;
      }
      if (this.image) ctx.drawImage(this.image, 0, 0, w, h);
    },
  };

  // Not awaited: the room opens on the still and upgrades itself.
  loadVideo(
    // data: first — it is the documented scheme for embedded artifact media,
    // and blob: is the one this project invented. A scheme a published page
    // refuses fails silently, so the order matters and both are offered.
    [
      { url: A?.sceneVideoData, label: 'data:' },
      { url: A?.sceneVideo, label: A?.sceneVideoScheme || 'inline' },
      { url: A ? null : './assets/scene.mp4', label: 'file' },
    ],
    (n) => {
      backdrop.note = n;
      // Every note, not only success. Reporting a failure is the entire point
      // of having a note, and dispatching only on the happy path reproduces
      // the silent fallback this badge exists to expose.
      document.dispatchEvent(new CustomEvent('backdropchange', { detail: backdrop }));
    },
  ).then((v) => {
    if (!v) return;
    backdrop.video = v;
    backdrop.kind = KIND.VIDEO;
    // The shipped clip closes on itself, so it plays straight. Everything
    // below is the fallback for a clip that does not: crossfade it against
    // ITSELF, offset by half its length, weighted so whichever copy is
    // furthest from its own cut is the one you are mostly seeing, and the cut
    // always lands under a copy at zero opacity.
    if (closedLoop) {
      const play = () => v.play().catch(() => {});
      play();
      for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, play, { once: true });
      document.dispatchEvent(new CustomEvent('backdropchange', { detail: backdrop }));
      return;
    }
    const b = v.cloneNode();
    b.muted = true; b.loop = true; b.playsInline = true;
    b.style.cssText = v.style.cssText;
    document.body.appendChild(b);
    backdrop.videoB = b;

    const kick = () => { v.play().catch(() => {}); b.play().catch(() => {}); };
    const sync = () => {
      const d = v.duration;
      if (!d || !isFinite(d)) return;
      const want = (v.currentTime + d / 2) % d;
      if (Math.abs(b.currentTime - want) > 0.08) b.currentTime = want;
    };
    v.addEventListener('loadedmetadata', sync);
    b.addEventListener('canplay', sync, { once: true });
    sync();
    kick();
    // Two elements keep two clocks. Nudge them together occasionally rather
    // than every frame, which would stutter on the seek.
    setInterval(sync, 1000);
    // Autoplay can still be refused until the page has been interacted with,
    // and a click is the first thing that happens in this game anyway.
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, kick, { once: true });
    document.dispatchEvent(new CustomEvent('backdropchange', { detail: backdrop }));
  });

  return backdrop;
}
