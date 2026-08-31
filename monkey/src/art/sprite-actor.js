// A character whose body is a baked 3D sprite and whose face is still drawn.
//
// The body comes from tools/cast-sprites.mjs: a Tripo mesh, auto-rigged with
// Mixamo bone naming, animated by a Mixamo clip, rendered to an atlas. That
// buys the thing the vector puppet could never have — real weight, a coat that
// swings, a walk with actual mass.
//
// The face is drawn over it, and that is not a shortcut. Tripo's skeleton has
// no jaw bone and no morph targets, so a baked head cannot blink or speak; at
// a 35px head, the blink and the jaw flap are two of the very few things that
// read at all, in a game whose characters mostly stand still and talk. So the
// sprite supplies the body and the engine keeps the face — which is also what
// the atlas's per-frame head positions are for.

const TAU = Math.PI * 2;

export async function loadSpriteBody({ sheetUrl, manifest, height, face }) {
  const img = await new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = sheetUrl;
  });
  if (!img || !manifest) return null;

  // `heads` and `face` belong to the retired 3D path, where the body was baked
  // and the face had to be drawn back on. A hand-made or generated pixel pack
  // has its own face and no head track, so both are optional.
  const { cellW, cellH, cols, feetY, figureH, clips, bounds = [], heads = [], smooth = false, shadow = false } = manifest;

  // Which frame of which clip. Walking reads off the same stride phase the
  // engine already advances from distance travelled, so the feet stay in step
  // with the ground however fast the character moves.
  // How long a change of clip takes to cross-dissolve.
  //
  // A generated clip starts wherever its video started, so idle -> drink ->
  // asleep are three unrelated poses cut together, and the cut is visible: a
  // standing man becomes a differently-standing man between one frame and the
  // next. Two frames of dissolve is long enough to read as a change and short
  // enough not to read as a fade — at 19fps it is about a tenth of a second,
  // which is roughly the interval the eye stops resolving as separate images.
  //
  // Longer was tried first and is wrong: at a quarter-second the standing and
  // sitting Grouts are both legible at once, which looks like a mistake rather
  // than a transition.
  const FADE = 0.11;

  // Which clip a frame came from, not just which frame. The dissolve needs to
  // know that the clip CHANGED, and two clips can legitimately be showing the
  // same frame index at the moment they swap.
  const clipOf = (actor) => {
    if (actor.clip) return actor.clip;
    if (actor.state === 'walk') return actor.running && clips.run ? 'run' : 'walk';
    // Talking is its own clip, and the reason is a fault you can see from
    // across the room. The service's stock idle has the character working
    // their mouth and gesturing — a fine animation, and the wrong one to play
    // for the 95% of the time nobody is speaking, which had the whole cast
    // standing on the dock talking to nobody. `idle` is now a deliberately
    // still brief and `talk` is the gesturing one, chosen by whether there is
    // actually a line on screen.
    //
    // Below the named clip and below walking, both of which mean something
    // more specific: a man asleep who says something stays asleep, and a
    // character talking while she walks keeps walking.
    if (actor.line && clips.talk) return 'talk';
    return 'idle';
  };

  const frameFor = (actor) => {
    // A named clip wins over both. `drink` and `asleep` are not reachable from
    // the walk/idle pair, and the room needs them at scripted moments; a clip
    // marked `loop: false` in the manifest holds on its last frame rather than
    // starting over, so a man who has fallen asleep stays asleep.
    const named = actor.clip ? clips[actor.clip] : null;
    if (named) {
      const i = Math.floor(actor.clipT * (named.fps || 10));
      return named.start + (named.loop === false ? Math.min(named.count - 1, i) : i % named.count);
    }

    const walking = actor.state === 'walk';
    // Running is a different clip, not a faster walk. It only exists if the
    // character has one; a cast member without a run sheet just moves quicker
    // on their walk cycle, which reads as hurrying rather than as broken.
    const gait = walking && actor.running && clips.run ? 'run' : 'walk';
    const c = clips[walking ? gait : 'idle'] || clips.idle;

    if (walking) {
      // Walk frames advance with distance travelled, so the feet stay in step
      // with the ground at any speed. What they must advance by is one CYCLE
      // per stride, not one clip: a generated walk is a video sampled at a
      // fixed rate, and this one holds two strides in its twenty-five frames.
      // Mapping the whole clip onto one stride ran her legs at double speed.
      const per = c.framesPerCycle || c.count;
      const i = Math.floor(((actor.phase % 1) + 1) % 1 * per) % c.count;
      return c.start + i;
    }

    // Standing still, so: talking if there is a line, idle otherwise. Same
    // order as clipOf, which has to agree with this or the dissolve fades
    // between the wrong pair.
    const t = actor.line && clips.talk ? clips.talk : c;

    // Idle runs on a clock rather than on distance, because an idle character
    // travels none — driving it from the walk phase left it advancing at a
    // fifth of a cycle a second, which reads as a freeze rather than a breath.
    const fps = t.fps || 10;
    const i = Math.floor((performance.now() / 1000) * fps) % (t.framesPerCycle || t.count);
    return t.start + (i % t.count);
  };

  return {
    kind: 'sprite',
    figureH,

    // Which way this body can actually be drawn.
    //
    // Every sheet in this cast is a side view: the shared style line sent to
    // AutoSprite says "side view facing right", every animation prompt repeats
    // it, and the service files each result under a /right/ path. There is no
    // direction parameter in the API and the sprites are video-generated 2D
    // rather than a rotatable model, so front and back do not exist and cannot
    // be had by mirroring.
    //
    // Saying so out loud is the point. The room asks eight hotspots to be used
    // with the player facing 'back' — the barrel, the cup, the sign, the
    // lantern, the door, the window, the crates, the nets — and the actor was
    // happily holding a facing the renderer then ignored, drawing a profile.
    // An atlas that one day carries directional clips would declare them here
    // and the engine would use them with no further change.
    facings: new Set(['left', 'right']),
    // The height the room asks for, kept so callers can report the ratio
    // between it and the sheet — which is the character's art-pixel size.
    drawHeight: height,

    // How long a one-shot clip runs, in seconds — null for anything that
    // loops, since a loop has no end to wait for. The sequencer uses the
    // difference to decide whether playing a clip is a step or a state.
    clipSeconds(name) {
      const c = clips[name];
      if (!c || c.loop !== false) return null;
      return c.count / (c.fps || 10);
    },
    hasClip(name) { return !!clips[name]; },
    // Which cell is on screen right now — so a check can tell a frame that
    // changed from one that is merely being redrawn.
    frameOf(actor) { return frameFor(actor); },

    // How far one cycle of a clip carries the character, in room units —
    // measured off the sheet's own foot separation at cut time and scaled by
    // however tall the character is drawn. The engine used `height * 0.85`
    // with the vector puppet's height, which stopped describing anything once
    // the sprites were drawn at nearly twice it: the ground moved less than
    // the legs did, so the feet skated. Measured, Bonny's walk stride is 0.80
    // of her figure height and her run 1.47, which are the numbers a person
    // actually has.
    strideFor(name) {
      const c = clips[name] || clips.walk;
      return c?.stride ? c.stride * (height / figureH) : null;
    },

    // What the character occupies right now, in room units before depth
    // scaling — the figure in the current frame, not the cell it sits in. This
    // is what a click has to hit, and it is the only thing that knows a
    // sleeping man is a different shape from a standing one.
    boxAt(actor) {
      const k = height / figureH;
      const b = bounds[frameFor(actor)];
      return b ? { w: b[0] * k, h: b[1] * k } : { w: cellW * k, h: height };
    },

    // Depth scaling, and a correction. Rounding the zoom to a whole number
    // keeps every art pixel square, which is right in principle and wrong
    // here: with a 60px figure at 3.1x the room's depth range crosses exactly
    // one boundary, so the character changed size by a third in a single step
    // halfway up the dock. A visible pop is worse than slightly uneven pixels,
    // and the scaling adventure games actually shipped was continuous.
    //
    // So the scale is continuous and only the DESTINATION SIZE is rounded to
    // whole pixels — which is what stops the sprite shimmering as it walks
    // without quantising it into jumps.
    drawAt(ctx, actor, x, y, roomScale) {
      const k = (height / figureH) * roomScale;
      const f = frameFor(actor);
      const flip = actor.facing === 'left' ? -1 : 1;

      // Notice a change of clip here rather than being told about one, so the
      // walk/idle pair — which nothing calls playClip for, because it follows
      // the actor's state — dissolves like every other pair.
      const now = performance.now() / 1000;
      const clip = clipOf(actor);
      if (actor.lastClip !== undefined && actor.lastClip !== clip) {
        actor.fadeFrom = actor.lastFrame;
        actor.fadeAt = now;
      }
      actor.lastClip = clip;
      actor.lastFrame = f;
      const fade = actor.fadeFrom == null ? 1
        : Math.min(1, Math.max(0, (now - (actor.fadeAt ?? now)) / FADE));
      if (fade >= 1) actor.fadeFrom = null;

      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));

      if (shadow) {
        const r = figureH * k * 0.22;
        const g = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
        g.addColorStop(0, 'rgba(0,0,0,0.40)');
        g.addColorStop(0.6, 'rgba(0,0,0,0.13)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save(); ctx.scale(1, 0.2); ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.restore();
      }

      ctx.scale(flip, 1);
      const was = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = smooth;
      const dw = Math.max(1, Math.round(cellW * k));
      const dh = Math.max(1, Math.round(cellH * k));
      // Nearest-neighbour is for MAGNIFYING pixel art: it keeps the blocks
      // square instead of blurring them. It is the wrong filter for reducing,
      // where it simply drops rows and columns and leaves a figure that looks
      // coarser than the sheet it came from. So the filter follows the
      // direction of the resample rather than being a property of the asset.
      ctx.imageSmoothingEnabled = smooth || k < 1.05;
      const blit = (frame, alpha) => {
        if (alpha <= 0) return;
        const fx = (frame % cols) * cellW, fy = ((frame / cols) | 0) * cellH;
        const a0 = ctx.globalAlpha;
        if (alpha < 1) ctx.globalAlpha = a0 * alpha;
        ctx.drawImage(
          img, fx, fy, cellW, cellH,
          Math.round(-dw / 2), Math.round(-(feetY / cellH) * dh), dw, dh,
        );
        ctx.globalAlpha = a0;
      };
      // The outgoing pose underneath at full strength, the incoming one over
      // it rising to full: a cross-dissolve rather than a fade through the
      // background, which would show the floor through the character.
      if (fade < 1 && actor.fadeFrom != null) blit(actor.fadeFrom, 1);
      blit(f, fade);
      ctx.imageSmoothingEnabled = was;

      // The face is only drawn when the atlas has head positions to put it on
      // — that is the retired baked-3D path, whose heads could not blink. A
      // generated or hand-made pack draws its own face.
      const h = heads[f];
      if (h && face) {
        const r = height * 0.055;
        ctx.translate((h.x - cellW / 2) * k + r * 0.30, (h.y - feetY) * k - r * 1.05);
        drawFace(ctx, face, actor, r);
      }
      ctx.restore();
    },
  };
}

// Eyes, brow and a mouth, sized to the head. Everything is drawn facing +x,
// and the caller has already mirrored for a character facing left.
function drawFace(ctx, spec, actor, r) {
  const blink = actor.blink < 0 ? 0.12 : 1;
  const talking = actor.line !== null;
  const jaw = talking ? Math.abs(Math.sin(actor.phase * 26)) : 0;
  // In profile only the near eye reads; a second one floating on the cheek is
  // worse than none.
  const ex = r * 0.36, ey = -r * 0.06;

  ctx.save();
  // Not stark white: at this size a bright dot on a dark head is a headlight.
  ctx.fillStyle = '#e6dccb';
  ctx.beginPath(); ctx.ellipse(ex, ey, r * 0.17, r * 0.21 * blink, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = spec.pupil || '#20140c';
  ctx.beginPath(); ctx.ellipse(ex + r * 0.05, ey, r * 0.09, r * 0.13 * blink, 0, 0, TAU); ctx.fill();

  ctx.strokeStyle = spec.brow || '#3a2413';
  ctx.lineWidth = r * 0.09;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ex - r * 0.20, ey - r * 0.36);
  ctx.lineTo(ex + r * 0.26, ey - r * 0.42);
  ctx.stroke();

  ctx.fillStyle = spec.mouth || '#5a2418';
  ctx.beginPath();
  ctx.ellipse(r * 0.40, r * 0.42, r * 0.16, r * 0.05 + jaw * r * 0.17, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}
