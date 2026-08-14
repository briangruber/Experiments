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
      [0, 1.0, 6],      // the title, the courtyard
      [1, 3.0, 5],      // he walks in
      [1, 24.0, 5],     // the almost-kiss
      [1, 37.5, 4],     // the villainess, watching
      [2, 14.0, 6],     // the cloth comes off the egg
      [2, 26.0, 5],     // thunder, the patriarch
      [3, 11.5, 6],     // the slap
      [4, 12.5, 5],     // the twin
      [5, 3.5, 5],      // the faint
      [5, 28.0, 8],     // the egg hatches, and it looks at you
    ],
  },
  episode: {
    label: 'EPISODIO COMPLETO',
    note: '4:25 · 540p',
    width: 960, height: 540,
    segments: null,     // the whole thing, start to finish
  },
};

const TARGET_BYTES = 14 * 1024 * 1024;   // under the 16 MiB save ceiling

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
};

function drawCards(ctx, titles, w, h) {
  for (const c of titles.cards) {
    const a = c.alpha ?? 0;
    if (a <= 0.002) continue;
    const st = CARD_STYLE[c.kind] || CARD_STYLE.act;
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

    // captureStream(0) hands us manual control: one video frame per rendered
    // frame, so a slow machine stretches nothing.
    this.stream = this.mix.captureStream(0);
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
    return true;
  }

  // Called once per rendered frame while recording.
  capture(glCanvas, titles) {
    if (this.state !== 'recording') return;
    const { width: w, height: h } = this.mix;
    this.mixCtx.drawImage(glCanvas, 0, 0, w, h);
    if (titles) drawCards(this.mixCtx, titles, w, h);
    if (this.track.requestFrame) this.track.requestFrame();
    this.frames++;
  }

  async finish() {
    if (this.state !== 'recording') return null;
    this.state = 'encoding';
    const blob = await new Promise((res) => {
      this.recorder.onstop = () => res(new Blob(this.chunks, { type: this.mime }));
      this.recorder.stop();
    });
    for (const t of this.stream.getTracks()) t.stop();
    this.state = 'idle';
    this.chunks = [];
    return blob;
  }

  get extension() { return this.mime && this.mime.startsWith('video/mp4') ? 'mp4' : 'webm'; }
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
