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
    const c = clips[walking ? 'walk' : 'idle'] || clips.idle;

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

    // Idle runs on a clock rather than on distance, because an idle character
    // travels none — driving it from the walk phase left it advancing at a
    // fifth of a cycle a second, which reads as a freeze rather than a breath.
    const fps = c.fps || 10;
    const i = Math.floor((performance.now() / 1000) * fps) % (c.framesPerCycle || c.count);
    return c.start + (i % c.count);
  };

  return {
    kind: 'sprite',
    figureH,

    // How long a one-shot clip runs, in seconds — null for anything that
    // loops, since a loop has no end to wait for. The sequencer uses the
    // difference to decide whether playing a clip is a step or a state.
    clipSeconds(name) {
      const c = clips[name];
      if (!c || c.loop !== false) return null;
      return c.count / (c.fps || 10);
    },
    hasClip(name) { return !!clips[name]; },

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
      const sx = (f % cols) * cellW, sy = ((f / cols) | 0) * cellH;
      const flip = actor.facing === 'left' ? -1 : 1;

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
      ctx.drawImage(
        img, sx, sy, cellW, cellH,
        Math.round(-dw / 2), Math.round(-(feetY / cellH) * dh), dw, dh,
      );
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
