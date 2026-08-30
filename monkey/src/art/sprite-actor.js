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

  const { cellW, cellH, cols, feetY, figureH, clips, heads } = manifest;
  const scale = height / figureH;

  // Which frame of which clip. Walking reads off the same stride phase the
  // engine already advances from distance travelled, so the feet stay in step
  // with the ground however fast the character moves.
  const frameFor = (actor) => {
    const walking = actor.state === 'walk';
    const c = clips[walking ? 'walk' : 'idle'] || clips.idle;
    const t = walking ? actor.phase : actor.phase * 0.35;
    const i = Math.floor(((t % 1) + 1) % 1 * c.count) % c.count;
    return c.start + i;
  };

  return {
    kind: 'sprite',
    draw(ctx, actor) {
      const f = frameFor(actor);
      const sx = (f % cols) * cellW, sy = ((f / cols) | 0) * cellH;
      const flip = actor.facing === 'left' ? -1 : 1;

      ctx.save();
      ctx.scale(flip, 1);
      // Contact shadow first, under the sprite and unmirrored in effect.
      const sh = ctx.createRadialGradient(0, 0, height * 0.02, 0, 0, height * 0.22);
      sh.addColorStop(0, 'rgba(0,0,0,0.40)');
      sh.addColorStop(0.6, 'rgba(0,0,0,0.13)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.scale(1, 0.2);
      ctx.fillStyle = sh;
      ctx.beginPath(); ctx.arc(0, 0, height * 0.22, 0, TAU); ctx.fill();
      ctx.restore();

      ctx.drawImage(
        img, sx, sy, cellW, cellH,
        -cellW * scale / 2, -feetY * scale, cellW * scale, cellH * scale,
      );

      // The face, at the head position this frame was rendered with.
      const h = heads[f];
      if (h && face) {
        // The manifest records the head BONE, which sits at the base of the
        // skull; the face belongs above and slightly forward of it.
        const r = height * 0.055;
        ctx.translate((h.x - cellW / 2) * scale + r * 0.30, (h.y - feetY) * scale - r * 1.05);
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
