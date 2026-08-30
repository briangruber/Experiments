// The surface a pixel-art character is drawn onto, and the rule that makes it
// look like one.
//
// One art pixel is BLOCK screen pixels, fixed in screen space. A character
// further up the dock is fewer art pixels tall; it is never made of smaller
// ones. Pixel size belongs to the medium, not to the distance — this is the
// difference between a sprite and a photograph of a sprite.
//
// An earlier version of this file did something else and did it badly: it
// rendered the smooth vector puppet into a small buffer and blew it back up.
// That is downsampling, and downsampling a smooth source to thirty-five pixels
// is precisely what made the baked 3D body unusable. Reproducing a failure in
// a new medium is still reproducing it. Nothing is scaled down here now; the
// figure is authored on the grid, and this file only provides the grid.

export const BLOCK = 3;                 // screen pixels per art pixel
const OUTLINE = '#160d0b';

let buf = null, bctx = null;

function ensure(w, h) {
  if (!buf) {
    buf = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    bctx = buf.getContext('2d', { willReadFrequently: true });
  }
  if (buf.width !== w || buf.height !== h) { buf.width = w; buf.height = h; }
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.clearRect(0, 0, w, h);
  return bctx;
}

// Grow a one-pixel dark edge into the transparent ring around the figure.
// Outward rather than inward: at thirty-five pixels tall, an inward outline
// eats the character. This is the single thing that makes a sprite legible
// over a busy plank floor painted in the same browns as its coat.
function outline(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const solid = new Uint8Array(w * h);
  for (let i = 3, p = 0; i < d.length; i += 4, p++) {
    if (d[i] >= 128) { d[i] = 255; solid[p] = 1; } else d[i] = 0;
  }
  const [r, g, b] = [parseInt(OUTLINE.slice(1, 3), 16), parseInt(OUTLINE.slice(3, 5), 16), parseInt(OUTLINE.slice(5, 7), 16)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (solid[p]) continue;
      if (!((x > 0 && solid[p - 1]) || (x < w - 1 && solid[p + 1])
         || (y > 0 && solid[p - w]) || (y < h - 1 && solid[p + w]))) continue;
      const i = p * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// `paint(px, actor)` draws in art pixels: integer coordinates, origin between
// the feet, negative y upward. px.h is how many art pixels tall the figure is
// at this depth, which is the only thing that changes as the character walks
// upstage.
export function drawPixelSprite(dest, x, y, screenHeight, paint, actor, block = BLOCK) {
  const H = Math.max(8, Math.round(screenHeight / block));
  const w = Math.ceil(H * 0.9) + 10;
  const h = H + 4;
  const ctx = ensure(w, h);
  const ox = w >> 1, oy = h - 2;

  const px = {
    h: H,
    rect(rx, ry, rw, rh, colour) {
      if (rw <= 0 || rh <= 0) return;
      ctx.fillStyle = colour;
      ctx.fillRect(ox + Math.round(rx), oy + Math.round(ry), Math.round(rw), Math.round(rh));
    },
  };
  paint(px, actor);
  outline(ctx, w, h);

  // Snap the blit to whole blocks, or the grid resamples every frame and the
  // sprite shimmers as it walks.
  const dx = Math.round((x - ox * block) / block) * block;
  const dy = Math.round((y - oy * block) / block) * block;
  const was = dest.imageSmoothingEnabled;
  dest.imageSmoothingEnabled = false;
  dest.drawImage(buf, dx, dy, w * block, h * block);
  dest.imageSmoothingEnabled = was;
}
