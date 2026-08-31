// A very small ISO base media file parser, and the one measurement that
// matters most here: whether the video actually moves.
//
// Headless Chromium ships no H.264 decoder, so nothing in this toolchain can
// play an mp4 back and look at it. That is exactly how a technically perfect
// video once shipped that was visually identical to the still — valid H.264,
// right length, right size, and nothing in it changed. So the file is checked
// as a file.
//
// The motion measure works because inter-coded frames are cheap in direct
// proportion to how little changed between them. A held still gives a big
// keyframe followed by near-empty P-frames; real movement gives P-frames that
// are a substantial fraction of the keyframe. Reading the per-sample byte
// sizes out of the stsz box therefore measures motion without decoding a
// single pixel.

export function* boxes(buf, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size < 8 || off + size > end) return;
    yield { type, start: off, size, body: off + 8 };
    off += size;
  }
}

export function find(buf, path, start = 0, end = buf.length) {
  const [head, ...rest] = path;
  for (const b of boxes(buf, start, end)) {
    if (b.type !== head) continue;
    if (!rest.length) return b;
    const inner = find(buf, rest, b.body, b.start + b.size);
    if (inner) return inner;
  }
  return null;
}

export function probe(buf) {
  const out = {
    bytes: buf.length,
    isMp4: buf.toString('latin1', 4, 8) === 'ftyp',
    avc: buf.toString('latin1', 8, 32).includes('avc1'),
    seconds: 0, width: 0, height: 0, ratio: 0,
    mdatBytes: 0, complete: false, motion: null,
  };

  const mdat = find(buf, ['mdat']);
  if (mdat) {
    out.mdatBytes = mdat.size;
    // A truncated download looks exactly like a valid header followed by
    // nothing, so the end offset is checked rather than assumed.
    out.complete = mdat.start + mdat.size <= buf.length;
  }

  const mvhd = find(buf, ['moov', 'mvhd']);
  if (mvhd) {
    const v = buf[mvhd.body];
    const o = mvhd.body + 4 + (v === 1 ? 16 : 8);
    const timescale = buf.readUInt32BE(o);
    const duration = v === 1 ? Number(buf.readBigUInt64BE(o + 4)) : buf.readUInt32BE(o + 4);
    out.seconds = timescale ? duration / timescale : 0;
  }

  const tkhd = find(buf, ['moov', 'trak', 'tkhd']);
  if (tkhd) {
    const v = buf[tkhd.body];
    const base = tkhd.start + (v === 1 ? 32 : 20) + 64;
    out.width = buf.readUInt32BE(base) / 65536;
    out.height = buf.readUInt32BE(base + 4) / 65536;
    out.ratio = out.height ? out.width / out.height : 0;
  }

  const stsz = find(buf, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']);
  if (stsz) {
    const o = stsz.body + 4;                      // version + flags
    const uniform = buf.readUInt32BE(o);
    const count = buf.readUInt32BE(o + 4);
    const sizes = [];
    if (uniform) for (let i = 0; i < count; i++) sizes.push(uniform);
    else for (let i = 0; i < count; i++) sizes.push(buf.readUInt32BE(o + 8 + i * 4));
    const key = Math.max(...sizes);               // the I-frame is the big one
    const rest = sizes.filter((s) => s !== key).sort((a, b) => a - b);
    const at = (p) => rest[Math.min(rest.length - 1, Math.floor(p * rest.length))];
    const median = rest.length ? at(0.5) : 0;
    const mean = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 0;
    const sd = rest.length ? Math.sqrt(rest.reduce((a, b) => a + (b - mean) ** 2, 0) / rest.length) : 0;

    // Two numbers, because one is not enough and reporting one was wrong.
    //
    // `activity` is the median inter-frame size per megapixel: how much changes
    // between frames, in absolute terms. The old ratio-to-keyframe divided by a
    // number that grows with resolution and picture sharpness, so a crisp 720p
    // pixel-art keyframe made real movement look like none.
    //
    // `burst` is the spread of inter-frame sizes, p90 over p10. It separates
    // the two things the old measure conflated. A genuinely frozen clip has
    // nothing happening in any frame: low activity AND a spread near 1. A
    // subtle background loop has low activity and a HIGH spread — mostly quiet,
    // with occasional movement. That is not a failure, it is the aesthetic.
    const mpx = (out.width * out.height) / 1e6 || 1;
    const activity = median / mpx;
    const burst = at(0.9) / Math.max(1, at(0.1));
    out.motion = {
      frames: count, keyBytes: key, medianBytes: median,
      ratio: key ? median / key : 0,
      activity: +activity.toFixed(0),
      burst: +burst.toFixed(1),
      cv: +(mean ? sd / mean : 0).toFixed(2),
    };
    out.fps = out.seconds ? +(count / out.seconds).toFixed(1) : 0;
  }
  return out;
}

// Is the clip a held still?
//
// Three measures have been tried and the history is worth keeping, because
// each failed in a way the next could not see.
//
//   1. `ratio` (median inter-frame bytes over the keyframe) at a 2% floor.
//      Too high a floor: a crisp 720p pixel-art keyframe is enormous, so real
//      movement measured under 1% of it and read as dead.
//   2. `activity` (median inter-frame bytes per megapixel) at 800. Scale-free
//      in resolution but NOT in bitrate, which nobody noticed until the
//      backdrops were re-encoded at CRF 20: identical pictures, 44 dB PSNR,
//      and activity fell from 1998 to 760 — one step from failing a check
//      about motion because of a change that altered no motion at all.
//   3. `cv`, the spread of inter-frame sizes. Stable under re-encoding (1.54
//      to 1.63) and useless as a gate: a held still's near-zero frames vary
//      hugely in relative terms, so the dead clips score HIGHER than the live
//      ones (2.0 and 11.0 against 1.3 and 1.6).
//
// So it is back to `ratio`, with the floor set from measurement rather than
// guessed, and with `burst` alongside it so a clip has to look dead by both
// before it is called dead. Measured, at the sizes and bitrates this project
// actually ships:
//
//   held still, CRF 20      ratio 0.0002   burst   1.6
//   held still, 5400 kb/s   ratio 0.0004   burst  13.7   <- the old test passed this
//   dock loop, original     ratio 0.0094   burst  40.4
//   dock loop, CRF 20       ratio 0.0052   burst  33.0
//   galley loop, original   ratio 0.0046   burst 133.1
//   galley loop, CRF 20     ratio 0.0028   burst 167.1
//
// A held still at a high bitrate is the case that matters: the old test called
// it alive, because spending bandwidth on nothing raises the spread. It is
// exactly the failure this measure exists to catch — a technically perfect
// video with nothing in it — and it escaped for as long as the gate was an
// absolute byte count. assets/fixtures/held-still.mp4 is that clip, kept so
// the reversal is checkable rather than asserted.
export const DEAD_RATIO = 0.001;
export const DEAD_BURST = 20;
export const isDead = (m) => !m || (m.ratio < DEAD_RATIO && m.burst < DEAD_BURST);

// Kept because check-scene.mjs still reports it as context.
export const MOVES = 0.02;
export const DEAD_ACTIVITY = 800;
