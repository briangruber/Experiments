// Video export. MediaRecorder can only capture a canvas, and the title cards
// are DOM, so everything is composited onto a mixing canvas first: the WebGL
// frame, then the cards redrawn in 2D. The audio comes off the soundtrack's
// master bus as a MediaStream track.
//
// Saving goes through the published-page downloads capability when there is
// one, and falls back to an ordinary blob link when the page is just being
// served. The capability caps a file at 16 MiB, so each cut picks a bitrate
// that lands under it.

// H.264 + AAC in MP4 first: that is what every upload form actually wants.
// Bare 'video/mp4' comes last because Chrome will happily fill it with VP9 and
// Opus, which is an MP4 that half the internet will refuse.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

// What to call the format in the interface, so nobody is surprised by the file.
export function formatLabel(mime) {
  if (!mime) return '—';
  if (mime.includes('avc1')) return 'MP4 · H.264';
  if (mime.startsWith('video/mp4')) return 'MP4';
  if (mime.includes('vp9')) return 'WEBM · VP9';
  return 'WEBM';
}

// Cuts. The trailer is assembled from beats, which is both the right length
// for social and exactly how the genre advertises itself.
export const CUTS = {
  trailer: {
    label: 'TRÁILER',
    note: '55 s · 720p',
    width: 1280, height: 720,
    // [scene, from, seconds]
    segments: [
      [0, 20.5, 6],     // the company, and the title
      [2, 3.0, 5],      // he walks in
      [2, 24.0, 5],     // the almost-kiss
      [2, 37.5, 4],     // the villainess, watching
      [3, 14.0, 6],     // the cloth comes off the egg
      [3, 26.0, 5],     // thunder, the patriarch
      [4, 11.5, 6],     // the slap
      [5, 12.5, 5],     // the twin
      [6, 3.5, 5],      // the faint
      [6, 28.0, 8],     // the egg hatches, and it looks at you
    ],
  },
  episode: {
    label: 'EPISODIO COMPLETO',
    note: '5:40 · 540p',
    width: 960, height: 540,
    segments: null,     // the whole thing, start to finish
  },
};

const TARGET_BYTES = 14 * 1024 * 1024;   // under the 16 MiB save ceiling
const FPS = 30;

// --- drawing the title cards into the frame ---------------------------------

const GOLD = '#e8c98a';
const GOLD_DIM = '#a8895a';
const SERIF = '"Hoefler Text", "Playfair Display", Georgia, "Times New Roman", serif';

// Mirrors the clamp() sizes and top offsets in ui.css.
const CARD_STYLE = {
  main: { top: 0.34, min: 30, vw: 6.4, max: 86 },
  act: { top: 0.62, min: 17, vw: 2.5, max: 34 },
  end: { top: 0.40, min: 26, vw: 5.0, max: 68 },
  credit: { top: 0.58, min: 20, vw: 3.2, max: 44 },
  cast: { top: 0.63, min: 19, vw: 3.0, max: 40 },
  stinger: { top: 0.20, min: 18, vw: 3.0, max: 40 },
  subtitle: { top: 0.78, min: 15, vw: 2.05, max: 27 },
};

// Subtitles are the one card kind long enough to need wrapping. Two lines
// maximum — a third would run into the letterbox bar.
function wrap(ctx, text, maxWidth, maxLines = 2) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth && lines.length < maxLines - 1) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function drawCards(ctx, titles, w, h) {
  for (const c of titles.cards) {
    const a = c.alpha ?? 0;
    if (a <= 0.002) continue;
    const st = CARD_STYLE[c.kind] || CARD_STYLE.act;

    // Subtitles are set flush, in white, wrapped — everything the gold
    // display treatment below is not.
    if (c.kind === 'subtitle') {
      const size = Math.max(st.min, Math.min(st.max, (st.vw * w) / 100));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.letterSpacing = '0.015em';
      ctx.font = `italic 400 ${size}px ${SERIF}`;
      ctx.fillStyle = '#f2ece2';
      ctx.shadowColor = 'rgba(0,0,0,0.95)';
      ctx.shadowBlur = size * 0.5;
      const lines = wrap(ctx, c.text, Math.min(w * 0.78, 780));
      // Anchor the block's last line where a single line would sit, so a
      // two-line subtitle grows upward instead of into the letterbox.
      let y = st.top * h - (lines.length - 1) * size * 1.32;
      for (const l of lines) { ctx.fillText(l, w / 2, y); y += size * 1.32; }
      ctx.restore();
      continue;
    }

    const size = Math.max(st.min, Math.min(st.max, (st.vw * w) / 100));
    const cx = w / 2;
    let y = st.top * h + (c.drift ?? 1) * (0.5 - (c.progress ?? 0)) * 6;

    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = size * 0.35;

    if (c.kicker) {
      const ks = size * 0.26;
      ctx.font = `italic 400 ${ks}px ${SERIF}`;
      ctx.letterSpacing = '0.36em';
      ctx.fillStyle = GOLD_DIM;
      ctx.fillText(c.kicker, cx + ks * 0.18, y);
      y += ks * 1.2 + ks * 1.2;
    }

    ctx.font = `400 ${size}px ${SERIF}`;
    ctx.letterSpacing = '0.24em';
    ctx.fillStyle = GOLD;
    // Letter-spacing pads the right edge, so nudge back by half a step to keep
    // the line optically centred.
    ctx.fillText(c.text, cx + size * 0.12, y);
    y += size * 1.15;

    if (c.rule) {
      ctx.shadowBlur = 0;
      const rw = w * 0.22;
      const g = ctx.createLinearGradient(cx - rw, 0, cx + rw, 0);
      g.addColorStop(0, 'rgba(168,137,90,0)');
      g.addColorStop(0.5, GOLD_DIM);
      g.addColorStop(1, 'rgba(168,137,90,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - rw, y + size * 0.25, rw * 2, 1);
      y += size * 0.7;
      ctx.shadowBlur = size * 0.35;
    }

    if (c.sub) {
      const ss = size * (c.kind === 'credit' ? 0.34 : 0.3);
      ctx.font = `italic 400 ${ss}px ${SERIF}`;
      ctx.letterSpacing = '0.42em';
      ctx.fillStyle = '#d9c4a0';
      ctx.globalAlpha = a * 0.86;
      ctx.fillText(c.sub, cx + ss * 0.21, y + ss * 0.6);
    }
    ctx.restore();
  }
  ctx.letterSpacing = '0px';
}

// --- the recorder -----------------------------------------------------------

export class Recorder {
  constructor() {
    this.state = 'idle';       // idle | recording | encoding
    this.chunks = [];
    this.mime = null;
    this.error = null;
  }

  static get supported() {
    return typeof MediaRecorder !== 'undefined'
      && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  pickMime() {
    for (const m of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return null;
  }

  // seconds is used only to choose a bitrate that lands under the save ceiling.
  start({ width, height, seconds, audioStream }) {
    if (this.state !== 'idle') return false;
    this.mime = this.pickMime();
    if (!this.mime) { this.error = 'MediaRecorder no disponible'; return false; }

    this.mix = document.createElement('canvas');
    this.mix.width = width;
    this.mix.height = height;
    this.mixCtx = this.mix.getContext('2d', { alpha: false });
    this.mixCtx.fillStyle = '#000';
    this.mixCtx.fillRect(0, 0, width, height);

    // A fixed capture rate rather than manual requestFrame: the browser samples
    // the mixing canvas itself, so a 120Hz display doesn't push 120fps into the
    // encoder and the track carries ordinary, evenly spaced timestamps.
    this.stream = this.mix.captureStream(FPS);
    this.track = this.stream.getVideoTracks()[0];
    if (audioStream) {
      for (const t of audioStream.getAudioTracks()) this.stream.addTrack(t);
    }

    const audioBps = audioStream ? 96_000 : 0;
    const budget = Math.max(220_000, (TARGET_BYTES * 8) / Math.max(20, seconds) - audioBps);
    const videoBps = Math.min(2_600_000, budget);

    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mime,
      videoBitsPerSecond: Math.round(videoBps),
      audioBitsPerSecond: audioBps || undefined,
    });
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(1000);
    this.state = 'recording';
    this.frames = 0;
    this.startedAt = performance.now();
    return true;
  }

  // Called once per rendered frame while recording.
  capture(glCanvas, titles) {
    if (this.state !== 'recording') return;
    const { width: w, height: h } = this.mix;
    this.mixCtx.drawImage(glCanvas, 0, 0, w, h);
    if (titles) drawCards(this.mixCtx, titles, w, h);
    this.frames++;
  }

  async finish() {
    if (this.state !== 'recording') return null;
    this.state = 'encoding';
    let blob = await new Promise((res) => {
      this.recorder.onstop = () => res(new Blob(this.chunks, { type: this.mime }));
      this.recorder.stop();
    });
    for (const t of this.stream.getTracks()) t.stop();
    this.state = 'idle';
    this.chunks = [];

    // Write the duration the recorder left out, or the file opens as 00:00.
    if (this.extension === 'mp4' && blob.size) {
      try {
        blob = new Blob([fixMp4Duration(await blob.arrayBuffer())], { type: this.mime });
      } catch { /* ship what we have */ }
    }
    return blob;
  }

  get extension() { return this.mime && this.mime.startsWith('video/mp4') ? 'mp4' : 'webm'; }

  // What actually got captured. A recording that starves — the canvas stream
  // handing the encoder a handful of frames over a minute of wall clock — looks
  // fine until the file is opened, so the numbers are reported rather than
  // left to be discovered in a player.
  stats(blob) {
    const wall = (performance.now() - this.startedAt) / 1000;
    return {
      frames: this.frames,
      wall: +wall.toFixed(1),
      fps: +(this.frames / Math.max(0.1, wall)).toFixed(1),
      mb: blob ? +(blob.size / 1048576).toFixed(1) : 0,
      mime: this.mime,
    };
  }
}

// Can this view actually hand the viewer a file? A published page needs the
// downloads capability; a sandboxed frame without it can't save at all, and an
// export button that cannot deliver is worse than no button.
export async function canDeliver() {
  const api = typeof window !== 'undefined' && window.claude && window.claude.use
    ? await window.claude.use('downloads').catch(() => null)
    : null;
  if (api) return true;
  try { return window.top === window.self; } catch { return false; }
}

// Hand the file over: the published-page capability if this view has one,
// otherwise an ordinary download. Returns a short status for the UI.
export async function deliver(blob, filename) {
  const api = typeof window !== 'undefined' && window.claude && window.claude.use
    ? await window.claude.use('downloads').catch(() => null)
    : null;

  if (api) {
    try {
      await api.save({ filename, data: blob });
      return { ok: true, how: 'saved' };
    } catch (e) {
      const code = e && e.code;
      if (code === 'declined') return { ok: false, how: 'declined' };
      if (code === 'too_large') return { ok: false, how: 'too_large' };
      return { ok: false, how: 'error', message: (e && e.message) || String(e) };
    }
  }

  // No capability. An ordinary download works when the page is served, but a
  // sandboxed frame makes `<a download>` inert — say so rather than appearing
  // to do nothing.
  const framed = (() => { try { return window.top !== window.self; } catch { return true; } })();

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return framed ? { ok: false, how: 'blocked' } : { ok: true, how: 'downloaded' };
}

// --- container repair -------------------------------------------------------
// MediaRecorder writes no duration: it is streaming, and does not know how long
// the file will be until it stops. Browsers cope by scanning the whole file;
// QuickTime does not, and shows 00:00 on a clip that is really there. So walk
// the fragments, add up the sample durations, and write the totals into the
// headers where a player expects to find them.
//
// Everything below is deliberately defensive: on anything unexpected it returns
// the bytes untouched, so the worst case is the file we would have shipped
// anyway.

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function* boxes(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    const size = (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
    const type = fourcc(b, o + 4);
    const box = { type, start: o, body: o + 8, end: size === 0 ? end : o + size };
    if (size === 1) {   // 64-bit size; we do not produce these, so bail out
      return;
    }
    if (box.end <= o || box.end > end) return;
    yield box;
    o = box.end;
  }
}

const find = (b, from, to, type) => {
  for (const box of boxes(b, from, to)) if (box.type === type) return box;
  return null;
};

const u32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const setU32 = (b, o, v) => {
  b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
};
const setU64 = (b, o, v) => { setU32(b, o, Math.floor(v / 4294967296)); setU32(b, o + 4, v >>> 0); };

// Field offsets differ between version 0 and version 1 of these headers.
const layout = {
  mvhd: (v) => (v === 1 ? { timescale: 20, duration: 24, wide: true } : { timescale: 12, duration: 16, wide: false }),
  mdhd: (v) => (v === 1 ? { timescale: 20, duration: 24, wide: true } : { timescale: 12, duration: 16, wide: false }),
  // tkhd v1: version+flags(4) creation(8) modification(8) track_ID(4)
  // reserved(4) duration(8) — the duration starts at 28, not 32. Writing four
  // bytes further along lands on the field after it and zeroes a duration the
  // muxer had already filled in correctly.
  tkhd: (v) => (v === 1 ? { duration: 28, wide: true } : { duration: 20, wide: false }),
};

export function fixMp4Duration(bytes) {
  const b = new Uint8Array(bytes);
  const end = b.length;
  const moov = find(b, 0, end, 'moov');
  if (!moov) return bytes;

  const mvhd = find(b, moov.body, moov.end, 'mvhd');
  if (!mvhd) return bytes;
  const mvL = layout.mvhd(b[mvhd.body]);
  const movieTimescale = u32(b, mvhd.body + mvL.timescale);
  if (!movieTimescale) return bytes;

  // Per-track defaults live in mvex/trex, and may be overridden per fragment.
  const trexDefaults = new Map();
  const mvex = find(b, moov.body, moov.end, 'mvex');
  if (mvex) {
    for (const trex of boxes(b, mvex.body, mvex.end)) {
      if (trex.type !== 'trex') continue;
      trexDefaults.set(u32(b, trex.body + 4), u32(b, trex.body + 12));
    }
  }

  // Add up every sample in every fragment, per track.
  const totals = new Map();
  for (const top of boxes(b, 0, end)) {
    if (top.type !== 'moof') continue;
    for (const traf of boxes(b, top.body, top.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = find(b, traf.body, traf.end, 'tfhd');
      if (!tfhd) continue;
      const tfFlags = u32(b, tfhd.body) & 0xffffff;
      const trackId = u32(b, tfhd.body + 4);
      let p = tfhd.body + 8;
      if (tfFlags & 0x01) p += 8;                       // base_data_offset
      if (tfFlags & 0x02) p += 4;                       // sample_description_index
      let defDur = trexDefaults.get(trackId) || 0;
      if (tfFlags & 0x08) { defDur = u32(b, p); p += 4; }

      let total = totals.get(trackId) || 0;
      for (const trun of boxes(b, traf.body, traf.end)) {
        if (trun.type !== 'trun') continue;
        const flags = u32(b, trun.body) & 0xffffff;
        const count = u32(b, trun.body + 4);
        let q = trun.body + 8;
        if (flags & 0x001) q += 4;                      // data_offset
        if (flags & 0x004) q += 4;                      // first_sample_flags
        const perSample = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0)
          + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
        if (flags & 0x100) {
          for (let i = 0; i < count; i++) {
            if (q + 4 > trun.end) return bytes;
            total += u32(b, q);
            q += perSample;
          }
        } else {
          total += count * defDur;
        }
      }
      totals.set(trackId, total);
    }
  }
  if (!totals.size) return bytes;

  // Work out every edit first, then apply them. A half-written header is worse
  // than an unwritten one.
  const edits = [];
  let movieDuration = 0;
  for (const trak of boxes(b, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = find(b, trak.body, trak.end, 'tkhd');
    const mdia = find(b, trak.body, trak.end, 'mdia');
    if (!tkhd || !mdia) continue;
    const mdhd = find(b, mdia.body, mdia.end, 'mdhd');
    if (!mdhd) continue;

    const tkL = layout.tkhd(b[tkhd.body]);
    const mdL = layout.mdhd(b[mdhd.body]);
    const trackId = u32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
    const mediaTimescale = u32(b, mdhd.body + mdL.timescale);
    const media = totals.get(trackId);
    if (!media || !mediaTimescale) continue;

    const inMovie = Math.round((media / mediaTimescale) * movieTimescale);
    movieDuration = Math.max(movieDuration, inMovie);
    edits.push([mdhd.body + mdL.duration, media, mdL.wide]);
    edits.push([tkhd.body + tkL.duration, inMovie, tkL.wide]);
  }
  if (!movieDuration || !edits.length) return bytes;
  edits.push([mvhd.body + mvL.duration, movieDuration, mvL.wide]);

  for (const [at, value, wide] of edits) {
    if (at + (wide ? 8 : 4) > end) return bytes;
    if (wide) setU64(b, at, value); else setU32(b, at, value);
  }
  return b.buffer;
}
