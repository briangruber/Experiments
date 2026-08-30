// A character authored at pixel resolution, rather than reduced to it.
//
// Two attempts at this character failed the same way. The first baked a Tripo
// mesh, rigged and retargeted, down to a sprite atlas. The second rendered the
// vector puppet into a small buffer and blew it back up. Both produced mush,
// and both for one reason: at the size a character actually occupies in this
// room — about thirty-five pixels — there is no room to lose. A smooth source
// downsampled to thirty-five pixels spends all of them on gradients and none
// on shape, whatever the smooth source happened to be.
//
// So the figure is built the other way round. Every dimension below is in art
// pixels and every one is an integer: a limb is three pixels wide because two
// is a wire and four is a log, and the head is eight across because seven
// cannot hold two eyes and a nose. Nothing is scaled down into place.
//
// The animation is unchanged in spirit and simplified in form. A pixel walk
// cycle is not a smooth interpolation sampled at 24fps — it is a handful of
// distinct poses, and the snap between them is the medium, not a defect. Four
// poses make a half-stride, mirrored for the other half; the same eight frames
// every 2D adventure game shipped.

const F = {                        // four key poses across a half stride
  //        front foot, back foot, hip drop, front arm, back arm
  contact: [ 7, -6, 0,  -5,  5],
  down:    [ 4, -4, 1,  -3,  3],
  pass:    [ 0,  1, 0,   0,  0],
  up:      [-4,  5, -1,  4, -4],
};
const CYCLE = [F.contact, F.down, F.pass, F.up];

// Proportions in art pixels for a figure H tall, as fractions of H rounded
// once. Rounding at the point of use instead would let a limb change width
// mid-stride, which reads as a glitch rather than as animation.
// Proportions taken off the era rather than off a cartoon. The Dig and
// Thimbleweed Park both build a character on a SMALL head and LONG legs — the
// head is about a seventh of the figure and the legs are half of it — which is
// what reads as an adult person rather than a mascot. The first version here
// used a fifth for the head and gave the legs a third, and that single ratio
// is most of why it looked modern-cartoon instead of 1994.
function build(H) {
  const r = (v) => Math.round(v);
  const head = Math.max(5, r(H * 0.15));
  const torso = r(H * 0.34);
  return {
    H, head, torso,
    headW: Math.max(5, r(H * 0.15)) | 1,      // odd, so it centres on a pixel
    shoulderW: Math.max(7, r(H * 0.24)) | 1,
    waistW: Math.max(5, r(H * 0.19)) | 1,
    leg: Math.max(2, r(H * 0.075)),
    arm: Math.max(2, r(H * 0.06)),
    shoulderY: head + 1,
    hipY: head + torso,
    armLen: r(H * 0.32),
  };
}

// One light side. Every sprite in these games is lit from somewhere and shaded
// on the other side in a single flat step — not a ramp, one step — and it is
// what stops a figure reading as a paper cut-out. This room's light is the
// tavern lantern, off to the right.
function tint(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
const LIT = 1.22, DIM = 0.72;

// A limb at an angle is a staircase of solid runs. Anti-aliasing it would put
// grey between the character and the background, which is the one thing a
// sprite over a busy plank floor cannot afford.
function limb(px, x0, y0, x1, y1, w, colour) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    px.rect(Math.round(x0 + (x1 - x0) * t) - (w >> 1), Math.round(y0 + (y1 - y0) * t), w, 1, colour);
  }
}

export function makePixelPerson(opt) {
  const c = {
    skin: '#e8b48c', skinDark: '#c98f68', hair: '#7b3a1c',
    coat: '#7c2f2a', coatDark: '#5a1f1c', shirt: '#e9dcc2',
    sash: '#d9a441', legsCol: '#3d4d63', boots: '#241811',
    // Silhouette, not colour, is what tells two sprites apart at this size.
    // Both characters were one build in different palettes and read as the
    // same person twice; hat shape and a beard are the cheapest fix, because
    // they change the outline rather than the fill.
    hat: null, hatStyle: 'bandana', beard: null, ...opt,
  };

  // The height arrives per frame, because it shrinks with depth: the figure is
  // rebuilt at whatever size the room gives it rather than scaled to fit.
  return function drawPixelPerson(px, actor) {
    const H = px.h;
    const B = build(H);
    const walking = actor?.state === 'walk';
    const phase = ((actor?.phase ?? 0) % 1 + 1) % 1;
    // Eight frames across a full stride: four poses, then the same four with
    // the legs swapped.
    const i = Math.floor(phase * 8) % 8;
    const pose = CYCLE[i % 4];
    const flip = i >= 4 ? -1 : 1;
    const [fFoot, bFoot, drop, fArm, bArm] = walking
      ? [pose[0] * flip, pose[1] * flip, pose[2], pose[3] * flip, pose[4] * flip]
      : [2, -2, 0, 0, 0];

    const dir = actor?.facing === 'left' ? -1 : 1;
    const back = actor?.facing === 'back';
    const top = -H;
    const hipY = top + B.hipY + drop;
    const shY = top + B.shoulderY + drop;
    const light = 1;                      // the lantern is stage right

    // --- legs. Long, narrow, and set apart far enough to see daylight
    // between them; this is half the figure's height and most of its read.
    const hip = Math.max(1, (B.leg >> 1) + 1);
    const foot = (dx) => Math.round(dx * dir);
    const legPairs = [[-hip, bFoot, DIM], [hip, fFoot, 1]];
    for (const [hx0, off, f] of legPairs) {
      limb(px, hx0, hipY, hx0 + foot(off), -3, B.leg, tint(c.legsCol, f));
      px.rect(hx0 + foot(off) - (B.leg >> 1), -3, B.leg + 1, 3, tint(c.boots, f));
      px.rect(hx0 + foot(off) - (B.leg >> 1), -1, B.leg + 2, 1, tint(c.boots, f * 0.8));
    }

    // --- torso, tapered from shoulder to waist. A rectangle reads as a box;
    // two pixels of taper reads as a body.
    const th = B.hipY - B.shoulderY;
    for (let i = 0; i < th; i++) {
      const t = i / Math.max(1, th - 1);
      const w = Math.round(B.shoulderW + (B.waistW - B.shoulderW) * t) | 1;
      const x0 = -(w >> 1);
      px.rect(x0, shY + i, w, 1, c.coat);
      px.rect(light > 0 ? x0 + w - 1 : x0, shY + i, 1, 1, tint(c.coat, LIT));
      px.rect(light > 0 ? x0 : x0 + w - 1, shY + i, 1, 1, tint(c.coat, DIM));
    }
    if (!back) {
      // A placket and a collar, which is the whole of the clothing detail a
      // figure this size can hold — and enough, because it is the shapes at
      // the neck and waist that say "coat" rather than "shirt".
      px.rect(-1, shY + 2, 2, th - 5, c.shirt);
      px.rect(-(B.shoulderW >> 1) + 1, shY, B.shoulderW - 2, 1, tint(c.coat, DIM));
      px.rect(-2, shY + 1, 4, 1, c.shirt);
    }
    px.rect(-(B.waistW >> 1) - 1, hipY - 2, B.waistW + 2, 2, c.sash);
    px.rect(-(B.waistW >> 1) - 1, hipY - 1, B.waistW + 2, 1, tint(c.sash, DIM));

    // A short coat skirt, proud of the waist, breaking the straight line from
    // shoulder to boot that made the first version read as a plank.
    const skirt = Math.max(2, Math.round(H * 0.07));
    px.rect(-(B.waistW >> 1) - 1, hipY, B.waistW + 2, skirt, c.coat);
    px.rect(-(B.waistW >> 1) - 1, hipY, 1, skirt, tint(c.coat, DIM));
    px.rect((B.waistW >> 1), hipY, 1, skirt, tint(c.coat, LIT));
    px.rect(-(B.waistW >> 1) - 1, hipY + skirt - 1, B.waistW + 2, 1, tint(c.coat, DIM));

    // --- arms, hung outside the torso so they exist at all, with a cuff and a
    // hand. Drawn after the torso, or the torso covers them.
    const shL = -(B.shoulderW >> 1) - 1, shR = (B.shoulderW >> 1) + 1;
    const armEnd = shY + B.armLen;
    limb(px, shL, shY + 2, shL + foot(bArm), armEnd, B.arm, tint(c.coat, DIM));
    limb(px, shR, shY + 2, shR + foot(fArm), armEnd, B.arm, tint(c.coat, LIT));
    px.rect(shL + foot(bArm) - 1, armEnd, B.arm, 1, tint(c.shirt, DIM));
    px.rect(shR + foot(fArm) - 1, armEnd, B.arm, 1, c.shirt);
    px.rect(shL + foot(bArm) - 1, armEnd + 1, B.arm, 2, tint(c.skin, DIM));
    px.rect(shR + foot(fArm) - 1, armEnd + 1, B.arm, 2, c.skin);

    // --- head. Small, which is the single most era-defining choice here.
    const hw = B.headW, hx = -(hw >> 1), hy = top;
    px.rect(hx + 1, hy, hw - 2, 1, c.skin);
    px.rect(hx, hy + 1, hw, B.head - 2, c.skin);
    px.rect(hx + 1, hy + B.head - 1, hw - 2, 1, c.skin);
    px.rect(hx, hy + 1, 1, B.head - 2, tint(c.skin, DIM));
    px.rect(hx + hw - 1, hy + 1, 1, B.head - 2, tint(c.skin, LIT));
    px.rect(-1, hy + B.head, 2, 1, tint(c.skin, DIM));          // neck

    if (back) {
      px.rect(hx, hy + 1, hw, B.head - 2, c.hair);
    } else {
      px.rect(hx, hy + 1, hw, 2, c.hair);
      px.rect(dir > 0 ? hx : hx + hw - 1, hy + 1, 1, B.head - 3, c.hair);
      const ex = dir > 0 ? hx + hw - 3 : hx + 1;
      px.rect(ex, hy + 3, 1, 1, '#20140c');
      px.rect(ex + (dir > 0 ? -2 : 2), hy + 3, 1, 1, '#20140c');
      if (c.beard) px.rect(hx, hy + B.head - 3, hw, 3, c.beard);
    }
    if (c.hat) {
      if (c.hatStyle === 'tricorn') {
        px.rect(hx - 3, hy - 1, hw + 6, 2, c.hat);
        px.rect(hx - 4, hy, 2, 1, c.hat);
        px.rect(hx + hw + 2, hy, 2, 1, c.hat);
        px.rect(hx + 1, hy - 3, hw - 2, 2, c.hat);
        px.rect(hx + hw + 2, hy - 1, 1, 2, tint(c.hat, LIT));
      } else {
        px.rect(hx, hy, hw, 2, c.hat);
        px.rect(hx - 1, hy + 1, hw + 2, 1, c.hat);
        px.rect(hx + hw, hy, 1, 2, tint(c.hat, LIT));
        const bx = dir > 0 ? hx - 2 : hx + hw + 1;
        px.rect(bx, hy + 1, 2, 2, c.hat);
        px.rect(bx + (dir > 0 ? -1 : 1), hy + 3, 1, 3, tint(c.hat, DIM));
      }
    }
  };
}

// One tone down, for the limb on the far side of the body. Depth at this size
// is two flat values, not a gradient.
function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = 0.68;
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}
