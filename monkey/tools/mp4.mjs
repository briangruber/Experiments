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
    const median = rest.length ? rest[rest.length >> 1] : 0;
    out.motion = { frames: count, keyBytes: key, medianBytes: median, ratio: key ? median / key : 0 };
    out.fps = out.seconds ? +(count / out.seconds).toFixed(1) : 0;
  }
  return out;
}

// Under 2% of the keyframe means nothing in the picture is moving.
export const MOVES = 0.02;
