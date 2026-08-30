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
function build(H) {
  const r = (v) => Math.round(v);
  const head = Math.max(5, r(H * 0.20));
  const torso = r(H * 0.34);
  return {
    H, head, torso,
    headW: Math.max(5, r(H * 0.19)) | 1,      // odd, so it centres on a pixel
    torsoW: Math.max(5, r(H * 0.26)) | 1,
    leg: Math.max(2, r(H * 0.085)),
    arm: Math.max(2, r(H * 0.07)),
    shoulderY: head + 1,
    hipY: head + torso,
    armLen: r(H * 0.30),
  };
}

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
    hat: null, ...opt,
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
    const tw = B.torsoW, tx = -(tw >> 1);

    // --- legs. Two hips, set apart, so there is a gap to see daylight
    // through; a single block of trouser is the difference between a person
    // walking and a person sliding.
    const hipL = -Math.max(1, (B.leg >> 1) + 1), hipR = -hipL;
    const foot = (dx) => Math.round(dx * dir);
    for (const [hip, off, tone] of [[hipL, bFoot, c.coatDark], [hipR, fFoot, c.legsCol]]) {
      limb(px, hip, hipY, hip + foot(off), -2, B.leg, tone === c.coatDark ? shade(c.legsCol) : c.legsCol);
      px.rect(hip + foot(off) - (B.leg >> 1), -2, B.leg + 1, 2, c.boots);
    }

    // --- torso: three flat tones, which is all a nine-pixel chest can carry
    // and more than most sprites use.
    const th = B.hipY - B.shoulderY;
    px.rect(tx, shY, tw, th, c.coat);
    px.rect(tx, shY, 1, th, shade(c.coat));
    // A narrow placket rather than a filled chest: at nine pixels across, a
    // block of shirt reads as an apron and swallows the coat entirely.
    if (!back) {
      px.rect(-1, shY + 1, 3, th - 3, c.shirt);
      px.rect(tx + 1, shY, tw - 2, 1, shade(c.coat));      // collar
    }
    px.rect(tx, hipY - 2, tw, 2, c.sash);

    // --- arms, hung OUTSIDE the torso silhouette. Drawn inside it they are
    // invisible, which is how the first version lost them.
    const shL = tx - 1, shR = tx + tw;
    limb(px, shL, shY + 1, shL + foot(bArm), shY + B.armLen, B.arm, shade(c.coat));
    limb(px, shR, shY + 1, shR + foot(fArm), shY + B.armLen, B.arm, c.coat);
    px.rect(shR + foot(fArm) - 1, shY + B.armLen, 2, 2, c.skin);
    px.rect(shL + foot(bArm) - 1, shY + B.armLen, 2, 2, shade(c.skin));

    // --- head: a square with the corners knocked off, which is how a round
    // head is drawn at seven pixels.
    const hw = B.headW, hx = -(hw >> 1), hy = top;
    px.rect(hx + 1, hy, hw - 2, 1, c.skin);
    px.rect(hx, hy + 1, hw, B.head - 2, c.skin);
    px.rect(hx + 1, hy + B.head - 1, hw - 2, 1, c.skin);
    px.rect(hx, hy + B.head - 2, hw, 1, c.skinDark);

    if (back) {
      px.rect(hx, hy + 1, hw, B.head - 3, c.hair);
    } else {
      px.rect(hx, hy + 1, hw, 1, c.hair);                     // fringe, one row
      const ex = dir > 0 ? hx + hw - 4 : hx + 1;              // eyes lead the face
      px.rect(ex, hy + 3, 1, 1, '#20140c');
      px.rect(ex + 2, hy + 3, 1, 1, '#20140c');
      px.rect(ex + (dir > 0 ? 1 : 0), hy + 5, 2, 1, c.skinDark);
    }
    if (c.hat) {
      px.rect(hx - 1, hy, hw + 2, 2, c.hat);
      px.rect(hx - 1, hy + 2, 1, 1, c.hat);
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
