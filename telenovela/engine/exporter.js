// The stepped exporter: one code path for the export button and the CLI.
//
// The realtime recorder (record.js) asks the browser to keep up with the wall
// clock; tools/render.mjs used to step the world and pipe JPEGs to ffmpeg,
// where measurement showed 99% of every frame went to canvas.toDataURL. This
// does neither: it steps the world through the existing offline contract and
// hands each composited frame straight to a VideoEncoder as a VideoFrame — no
// JPEG, no ffmpeg — renders the soundtrack through the same OfflineAudioContext
// the JPEG pipe used, AAC-encodes it, and muxes both with engine/mp4.js. On
// hardware with an H.264 encoder this is faster than watching the piece, and
// deterministic: it cannot drop a frame.
//
// Fallbacks, in order: no AAC encoder → silent mp4 plus the WAV so the sound
// is not lost; no H.264 encoder (or no WebCodecs at all) → { ok: false } so
// the button keeps the realtime recorder and the CLI keeps the JPEG pipe.
//
// The world is handed in rather than imported: main.js owns the offline
// stepping contract (offlineBegin / one-step / audio render) and this module
// only drives it, so the CLI and the button cannot diverge.

import { Mp4Muxer } from './mp4.js';

// High profile first for quality at these bitrates, older baselines as a
// last resort. The level nibble is a declaration, not a request — encoders
// answer for the resolution and rate they are actually configured with.
const AVC_CANDIDATES = ['avc1.64002A', 'avc1.640028', 'avc1.4D4028', 'avc1.42E028'];

// Can this browser drive the stepped path at all? `video` is the codec string
// that answered, `audio` says whether AAC is available too. ok:false carries
// the reason, so callers can report why they fell back.
export async function probeSteppedExport({ width, height, fps = 30 }) {
  const out = { ok: false, video: null, audio: false, reason: null };
  if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) {
    out.reason = 'no WebCodecs';
    return out;
  }
  for (const codec of AVC_CANDIDATES) {
    try {
      const r = await VideoEncoder.isConfigSupported({
        codec, width, height, framerate: fps, avc: { format: 'avc' },
      });
      if (r && r.supported) { out.video = codec; break; }
    } catch { /* an unparseable string is just "no" */ }
  }
  if (!out.video) { out.reason = 'no H.264 encoder'; return out; }
  if (typeof AudioEncoder !== 'undefined' && AudioEncoder.isConfigSupported) {
    try {
      const r = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 160_000,
      });
      out.audio = !!(r && r.supported);
    } catch { /* video-only is still worth having */ }
  }
  out.ok = true;
  return out;
}

// Encoders fill their queue faster than they drain it; when it backs up, wait
// for a dequeue rather than piling frames into encoder memory. The timeout is
// a safety net so an implementation that never fires the event cannot hang
// the export — it degrades to polling, not to a freeze.
function drained(enc) {
  return new Promise((res) => {
    let timer = null;
    const done = () => { enc.removeEventListener('dequeue', done); clearTimeout(timer); res(); };
    timer = setTimeout(done, 250);
    enc.addEventListener('dequeue', done);
  });
}

// setTimeout in a hidden tab is throttled to once a second, which would turn a
// two-minute export into an hour the moment the user switches tabs. A
// MessageChannel post is a macrotask that is not throttled, so yielding this
// way keeps the interface painting AND keeps a backgrounded export moving.
let _channel = null;
function breathe() {
  if (typeof MessageChannel === 'undefined') return Promise.resolve();
  if (!_channel) _channel = new MessageChannel();
  return new Promise((res) => {
    _channel.port1.onmessage = () => res();
    _channel.port2.postMessage(0);
  });
}

// world: the offline stepping contract, provided by main.js —
//   begin({fps,width,height,seconds}) → {ok,total}   size and rewind everything
//   frame() → canvas | null                          step once, return the mix
//   goTo(sceneRef, sceneSeconds)                     jump for trailer segments
//   audio() → Promise<AudioBuffer|null>              render the offline mix
//   fullSeconds() → number                           whole-episode length
//   end()                                            put the page back
//
// Options beyond the obvious: `maxBytes` caps the bitrate the way the realtime
// recorder does (the published page refuses saves over 16 MiB); `limitSeconds`
// truncates the cut (the CLI's --seconds); `cancelled` is polled every frame;
// `codec`/`mux:false` exist for the test harness, which proves the feeding/
// backpressure/flush loop with whatever encoder the machine has without
// shipping that codec as a product path.
export async function exportSteppedVideo({
  cut, width, height, fps = 30, quality = 1, onProgress = () => {}, world,
  cancelled = () => false, maxBytes = 0, limitSeconds = 0,
  videoBitrate = 0, audioBitrate = 160_000, codec = null, mux = true,
}) {
  const probe = codec
    ? { ok: true, video: codec, audio: false }
    : await probeSteppedExport({ width, height, fps });
  if (!probe.ok) return { ok: false, reason: probe.reason };

  const cutSeconds = cut.segments
    ? cut.segments.reduce((a, s) => a + s[2], 0)
    : world.fullSeconds();
  const seconds = limitSeconds > 0 ? Math.min(limitSeconds, cutSeconds) : cutSeconds;

  // Bits per pixel scaled by `quality` unless the caller pinned a rate; under
  // a save ceiling, the same length-derived budget the realtime recorder uses,
  // floored where it floors, so the two paths make the same promise.
  const audioBps = probe.audio ? audioBitrate : 0;
  let bps = videoBitrate || Math.round(width * height * fps * 0.1 * quality);
  if (maxBytes > 0) {
    bps = Math.min(bps, Math.max(220_000, (maxBytes * 8) / Math.max(20, seconds) - audioBps));
  }

  const begun = await world.begin({ fps, width, height, seconds });
  if (!begun || !begun.ok) {
    world.end?.();
    return { ok: false, reason: (begun && begun.error) || 'offline begin failed' };
  }

  const muxer = mux ? new Mp4Muxer() : null;
  const frameDur = (i) => Math.round(((i + 1) * 1e6) / fps) - Math.round((i * 1e6) / fps);

  let videoTrack = 0, encErr = null, chunksOut = 0;
  const early = [];   // chunks that land before the decoderConfig does
  const takeSample = (chunk, meta) => {
    chunksOut++;
    if (!muxer) return;
    if (!videoTrack && meta && meta.decoderConfig && meta.decoderConfig.description) {
      videoTrack = muxer.addVideoTrack({ width, height, description: meta.decoderConfig.description });
    }
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    const s = { bytes, timestamp: chunk.timestamp, duration: chunk.duration || 0, key: chunk.type === 'key' };
    if (!videoTrack) { early.push(s); return; }
    while (early.length) {
      const e = early.shift();
      muxer.addSample(videoTrack, e.bytes, e);
    }
    muxer.addSample(videoTrack, s.bytes, s);
  };

  const enc = new VideoEncoder({
    output: (chunk, meta) => { try { takeSample(chunk, meta); } catch (e) { encErr = encErr || e; } },
    error: (e) => { encErr = encErr || e; },
  });
  const config = { codec: probe.video, width, height, framerate: fps, bitrate: bps, latencyMode: 'quality' };
  if (probe.video.startsWith('avc1')) config.avc = { format: 'avc' };
  try {
    enc.configure(config);
  } catch (e) {
    world.end?.();
    return { ok: false, reason: `configure: ${(e && e.message) || e}` };
  }

  const bail = (why) => {
    try { enc.close(); } catch { /* already closed */ }
    world.end?.();
    return why === 'cancelled'
      ? { ok: false, cancelled: true }
      : { ok: false, reason: why };
  };

  // The frame loop — the same segment walk tools/render.mjs does for the
  // trailer: jump to each beat, then step through it a frame at a time.
  const total = begun.total;
  let done = 0, segIndex = -1, segFramesLeft = 0;
  for (let i = 0; i < total; i++) {
    if (cancelled()) return bail('cancelled');
    if (encErr) return bail(`encoder: ${(encErr && encErr.message) || encErr}`);
    if (cut.segments && segFramesLeft <= 0) {
      segIndex++;
      const seg = cut.segments[segIndex];
      if (!seg) break;
      segFramesLeft = Math.round(seg[2] * fps);
      world.goTo(seg[0], seg[1]);
    }
    const canvas = world.frame();
    if (!canvas) break;
    const vf = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1e6) / fps), duration: frameDur(i),
    });
    // A keyframe every two seconds keeps the file seekable without giving the
    // bitrate away to I-frames.
    enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    while (enc.encodeQueueSize > 2) await drained(enc);
    segFramesLeft--;
    done++;
    onProgress({ phase: 'video', done, total });
    if ((i & 3) === 3) await breathe();
  }

  try {
    await enc.flush();
    enc.close();
  } catch (e) {
    encErr = encErr || e;
  }
  if (encErr) return bail(`encoder: ${(encErr && encErr.message) || encErr}`);
  if (muxer && !videoTrack && chunksOut) return bail('encoder reported no decoderConfig description');
  if (muxer && !chunksOut) return bail('encoder produced no chunks');

  // The soundtrack. AAC it into the file when there is an encoder; otherwise
  // keep the mix as a WAV so a silent mp4 still ships with its sound beside
  // it, which can be joined elsewhere — the same posture render.mjs takes
  // when its ffmpeg has no audio encoder.
  let silent = true, wav = null;
  if (muxer) {
    let audioBuf = null;
    try { audioBuf = await world.audio(); } catch { audioBuf = null; }
    if (audioBuf) {
      // The offline context is sized seconds+3 for decay tails; trim the
      // export to the cut so the file does not end on three silent seconds.
      const frames = Math.min(audioBuf.length, Math.ceil(seconds * audioBuf.sampleRate));
      if (probe.audio && !cancelled()) {
        silent = !(await encodeAudioTrack(muxer, audioBuf, frames, audioBitrate, onProgress));
      }
      if (silent) wav = wavBytes(audioBuf, frames);
    }
  }
  if (cancelled()) return bail('cancelled');

  let bytes = null;
  if (muxer) {
    try { bytes = muxer.finish(); } catch (e) { return bail(`mux: ${(e && e.message) || e}`); }
  }
  world.end?.();
  return {
    ok: true, bytes, wav, silent, codec: probe.video,
    frames: done, chunks: chunksOut, seconds: done / fps, bitrate: bps,
  };
}

// AAC-encode an AudioBuffer. Everything is collected locally and only
// committed to the muxer after a clean flush, so a failing audio encoder
// degrades to the silent-mp4-plus-WAV path instead of leaving a half-written
// track in the file.
async function encodeAudioTrack(muxer, buf, frames, bitrate, onProgress) {
  const channels = Math.min(2, buf.numberOfChannels);
  let desc = null, err = null;
  const out = [];
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (!desc && meta && meta.decoderConfig && meta.decoderConfig.description) {
        desc = meta.decoderConfig.description;
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      out.push({ bytes, timestamp: chunk.timestamp, duration: chunk.duration || 0, key: true });
    },
    error: (e) => { err = err || e; },
  });
  try {
    enc.configure({ codec: 'mp4a.40.2', sampleRate: buf.sampleRate, numberOfChannels: channels, bitrate });
    const BLOCK = 48 * 1024;   // about a second per AudioData
    const chans = [];
    for (let c = 0; c < channels; c++) chans.push(buf.getChannelData(c));
    for (let off = 0; off < frames; off += BLOCK) {
      const n = Math.min(BLOCK, frames - off);
      const data = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) data.set(chans[c].subarray(off, off + n), c * n);
      const ad = new AudioData({
        format: 'f32-planar', sampleRate: buf.sampleRate,
        numberOfFrames: n, numberOfChannels: channels,
        timestamp: Math.round((off / buf.sampleRate) * 1e6), data,
      });
      enc.encode(ad);
      ad.close();
      while (enc.encodeQueueSize > 2) await drained(enc);
      onProgress({ phase: 'audio', done: Math.min(off + n, frames), total: frames });
      await breathe();
    }
    await enc.flush();
    enc.close();
  } catch (e) {
    err = err || e;
  }
  if (err || !desc || !out.length) return false;
  const track = muxer.addAudioTrack({ sampleRate: buf.sampleRate, channels, description: desc });
  for (const s of out) muxer.addSample(track, s.bytes, s);
  return true;
}

// A 16-bit PCM WAV of the buffer's first `frames` frames. Shared with the
// offline contract's offlineAudio(), which is the same bytes base64'd.
export function wavBytes(buf, frames = buf.length) {
  const chans = Math.min(2, buf.numberOfChannels);
  const n = Math.min(frames, buf.length);
  const bytes = new DataView(new ArrayBuffer(44 + n * chans * 2));
  const put = (o, s) => { for (let i = 0; i < s.length; i++) bytes.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); bytes.setUint32(4, 36 + n * chans * 2, true); put(8, 'WAVEfmt ');
  bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, chans, true);
  bytes.setUint32(24, buf.sampleRate, true); bytes.setUint32(28, buf.sampleRate * chans * 2, true);
  bytes.setUint16(32, chans * 2, true); bytes.setUint16(34, 16, true);
  put(36, 'data'); bytes.setUint32(40, n * chans * 2, true);
  const data = [];
  for (let c = 0; c < chans; c++) data.push(buf.getChannelData(c));
  let p = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < chans; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      bytes.setInt16(p, v < 0 ? v * 32768 : v * 32767, true);
      p += 2;
    }
  }
  return new Uint8Array(bytes.buffer);
}
