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

// How much of copy A to show, given how far through it we are.
//
// The first version of this was sin², which sums to one with its complement
// and so never darkens — but it also means the two copies are blended
// EVERYWHERE except at two instants, and blending a clip with itself half a
// period away ghosts every moving thing in it. That is a permanent cost paid
// to fix a fault that lasts half a second, which is why it was opt-in and off.
//
// This shows copy A on its own for almost the whole clip and hands over to B
// only near A's cut. B is then mid-clip, nowhere near its own cut, so the wrap
// is simply never on screen; and B's own cut falls where A is at full opacity,
// so it is not on screen either. Nothing ghosts outside the window.
const SEAM = 0.08;   // of the clip's length, either side of the cut

export function seamWeight(u) {
  const dist = Math.min(u, 1 - u);
  if (dist >= SEAM) return 1;
  const t = dist / SEAM;
  return t * t * (3 - 2 * t);   // smoothstep, so the handover has no corner
}

// A room's backdrop, by room id. The first room's assets sit at the bare paths
// they were written to before there was a second, so it keeps them.
const SCENE = (room, ext) => (room === 'dock' ? `./assets/scene.${ext}` : `./assets/${room}/scene.${ext}`);

export async function loadBackdrop(room = 'dock') {
  const A = globalThis.window?.__ASSETS;
  const inline = room === 'dock' ? A : A?.rooms?.[room];
  const still = await loadImage(inline?.sceneStill ?? SCENE(room, 'jpg'));

  // The clip was generated with the same image as its first and last frame, so
  // in principle it closes on itself and needs no help. In practice it does
  // not quite: it comes back a shade dim for a moment after the wrap, which
  // reads as a flicker once every ten seconds. That is in the file, not in the
  // playback — the same wrap looks the same in any player.
  //
  // It also carries 241 frames at 24fps where a whole ten seconds is 240, which
  // is what asking for first-and-last-the-same gets you: the shared frame is
  // in there twice, and the wrap holds it for two frames instead of one.
  //
  // Neither is fixable without re-encoding, and both are fixable by not
  // showing the wrap. Set `sceneClosedLoop: true` to trust the clip and play
  // it straight.
  const closedLoop = inline?.sceneClosedLoop === true;

  const backdrop = {
    closedLoop,
    kind: still ? KIND.STILL : KIND.NONE,
    note: still ? 'still' : 'no backdrop assets',
    video: null,
    image: still,
    // Whatever the backdrop is showing RIGHT NOW, for code that needs to copy a
    // piece of the painting over another piece of it. The live video when one
    // is playing, so a patch keeps step with the firelight instead of sitting
    // there as a still rectangle in a moving picture.
    source() {
      const a = this.video, b = this.videoB;
      if (a && a.readyState >= 2 && a.videoWidth) return { el: a, w: a.videoWidth, h: a.videoHeight };
      if (b && b.readyState >= 2 && b.videoWidth) return { el: b, w: b.videoWidth, h: b.videoHeight };
      if (this.image) return { el: this.image, w: this.image.naturalWidth, h: this.image.naturalHeight };
      return null;
    },

    draw(ctx, w, h) {
      // readyState >= 2 means there is a current frame to paint. Drawing a
      // video with no frame yet throws in some browsers and paints nothing in
      // others, so the still covers the gap.
      const a = this.video, b = this.videoB;
      const aOK = a && a.readyState >= 2;
      const bOK = b && b.readyState >= 2;
      // Either copy alone is better than the still. readyState dips for a
      // frame at the wrap in some browsers, and falling back to a JPEG for one
      // frame is itself a flash — two decoders almost never dip together.
      if (aOK || bOK) {
        const d = (aOK ? a : b).duration;
        if (aOK && bOK && d && isFinite(d)) {
          const u = (a.currentTime % d) / d;
          ctx.drawImage(b, 0, 0, w, h);
          ctx.save();
          ctx.globalAlpha = seamWeight(u);
          ctx.drawImage(a, 0, 0, w, h);
          ctx.restore();
        } else {
          ctx.drawImage(aOK ? a : b, 0, 0, w, h);
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
      { url: inline?.sceneVideoData, label: 'data:' },
      { url: inline?.sceneVideo, label: inline?.sceneVideoScheme || 'inline' },
      { url: A ? null : SCENE(room, 'mp4'), label: 'file' },
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
    // Crossfade the clip against ITSELF, offset by half its length, so that
    // whichever copy is nearest its own cut is the one at zero opacity and the
    // wrap is never the thing you are looking at. See seamWeight above for why
    // this costs nothing outside the window around the cut.
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
