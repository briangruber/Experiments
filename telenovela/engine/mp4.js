// A minimal progressive MP4 writer for the stepped exporter: one video track
// (avc1, carrying the avcC description a VideoEncoder hands back) and
// optionally one audio track (mp4a, its esds built around the AudioEncoder's
// AudioSpecificConfig). The same spirit as record.js's fixMp4Duration — box
// surgery with the spec open — but run forwards: instead of repairing headers
// a browser muxer left blank, it writes the whole container itself.
//
// Layout is ftyp, then a single mdat holding every sample in arrival order,
// then moov last. moov-after-mdat is legal and every player accepts it; it
// just means the file is not "faststart" — a streaming client has to reach
// the tail before it can play. For files that are saved and then opened,
// which is what the exporter produces, that costs nothing, and it lets the
// sample bytes be laid down as they arrive instead of being buffered twice.
//
// What it does not do, on purpose: fragments, edit lists, b-frame reordering
// (no ctts — addSample throws on non-monotonic timestamps so a caller falls
// back rather than shipping a file whose frames play out of order), 64-bit
// sizes (a >4 GB export has other problems first).

// --- little-endian-free byte helpers (MP4 is big-endian throughout) ---------

const ascii = (s) => {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};
const u16 = (v) => Uint8Array.of((v >>> 8) & 255, v & 255);
const u32 = (v) => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A box is its 32-bit size, its fourcc, and its payload.
function box(type, ...parts) {
  const body = concat(parts);
  return concat([u32(8 + body.length), ascii(type), body]);
}
// A "full" box carries a version byte and 24 bits of flags first.
function full(type, version, flags, ...parts) {
  return box(type, Uint8Array.of(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...parts);
}

const toU8 = (d) => (d instanceof Uint8Array ? d
  : d instanceof ArrayBuffer ? new Uint8Array(d)
    : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      : new Uint8Array(d));

// MPEG-4 descriptors (inside esds) length-prefix with a base-128 expandable
// encoding rather than a plain byte. Ours are all short, but write the real
// encoding anyway — it is four lines.
function descriptor(tag, ...parts) {
  const body = concat(parts);
  let n = body.length;
  const len = [n & 0x7f];
  while ((n >>= 7)) len.unshift((n & 0x7f) | 0x80);
  return concat([Uint8Array.of(tag, ...len), body]);
}

// --- the muxer ---------------------------------------------------------------

const MOVIE_TIMESCALE = 1000;

export class Mp4Muxer {
  constructor() {
    this.tracks = [];
    this.chunks = [];      // every sample's bytes, file order
    this.mdatBytes = 0;
  }

  // `description` is the AVCDecoderConfigurationRecord the encoder reported
  // (metadata.decoderConfig.description with avc format 'avc') — it goes into
  // the avcC box verbatim. Video timestamps are microseconds; 90 kHz is the
  // conventional video timescale and divides every common frame rate cleanly.
  addVideoTrack({ width, height, description, timescale = 90000 }) {
    return this._track({ kind: 'video', width, height, description: toU8(description), timescale });
  }

  // `description` is the AudioSpecificConfig (again decoderConfig.description,
  // from an AAC AudioEncoder); it becomes the DecoderSpecificInfo inside esds.
  // The audio timescale is the sample rate, so an AAC packet's 1024 frames are
  // exactly 1024 units and no rounding accumulates.
  addAudioTrack({ sampleRate, channels, description, timescale }) {
    return this._track({
      kind: 'audio', sampleRate, channels, description: toU8(description),
      timescale: timescale || sampleRate,
    });
  }

  _track(t) {
    t.id = this.tracks.length + 1;
    t.samples = [];        // { size, offset (into the mdat body), timestamp, duration, key }
    this.tracks.push(t);
    return t.id;
  }

  // timestamp/duration are microseconds, straight off the EncodedVideoChunk /
  // EncodedAudioChunk. `key` should be chunk.type === 'key'; it feeds stss.
  addSample(trackId, bytes, { timestamp, duration, key = true }) {
    const t = this.tracks[trackId - 1];
    if (!t) throw new Error(`mp4: no track ${trackId}`);
    const last = t.samples[t.samples.length - 1];
    if (last && timestamp < last.timestamp) {
      // Out-of-order timestamps mean the encoder is emitting b-frames and the
      // file would need a ctts box this muxer does not write. Refuse loudly so
      // the exporter can fall back instead of producing frames that play out
      // of order.
      throw new Error('mp4: non-monotonic timestamps (b-frames?) — not supported');
    }
    t.samples.push({ size: bytes.length, offset: this.mdatBytes, timestamp, duration: duration || 0, key: !!key });
    this.chunks.push(bytes);
    this.mdatBytes += bytes.length;
  }

  finish() {
    const withSamples = this.tracks.filter((t) => t.samples.length);
    if (!withSamples.length) throw new Error('mp4: no samples');

    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'));
    // The mdat body starts right after ftyp plus the mdat header itself; every
    // recorded per-sample offset is relative to that body.
    const mdatBodyAt = ftyp.length + 8;

    // Per-track sample durations in track units, computed cumulatively — each
    // sample lasts until the next one starts, so µs→units rounding can never
    // drift, and only the very last sample uses its own reported duration.
    for (const t of withSamples) {
      const scale = t.timescale / 1e6;
      const s = t.samples;
      const at = (i) => Math.round(s[i].timestamp * scale);
      for (let i = 0; i < s.length; i++) {
        const end = i + 1 < s.length ? at(i + 1) : Math.round((s[i].timestamp + s[i].duration) * scale);
        s[i].dur = Math.max(1, end - at(i));
      }
      t.durUnits = s.reduce((a, x) => a + x.dur, 0);
      t.durMovie = Math.round((t.durUnits / t.timescale) * MOVIE_TIMESCALE);
    }
    const movieDur = Math.max(...withSamples.map((t) => t.durMovie));

    const moov = box('moov',
      full('mvhd', 0, 0,
        u32(0), u32(0),                     // creation, modification
        u32(MOVIE_TIMESCALE), u32(movieDur),
        u32(0x00010000), u16(0x0100), u16(0),   // rate 1.0, volume 1.0, reserved
        u32(0), u32(0),                     // reserved
        MATRIX,
        new Uint8Array(24),                 // pre_defined
        u32(this.tracks.length + 1),        // next_track_ID
      ),
      ...withSamples.map((t) => this._trak(t, mdatBodyAt)),
    );

    return concat([ftyp, u32(8 + this.mdatBytes), ascii('mdat'), ...this.chunks, moov]);
  }

  _trak(t, mdatBodyAt) {
    const video = t.kind === 'video';
    return box('trak',
      full('tkhd', 0, 3,                    // enabled + in movie
        u32(0), u32(0), u32(t.id), u32(0),
        u32(t.durMovie),
        new Uint8Array(8),                  // reserved
        u16(0), u16(0),                     // layer, alternate_group
        u16(video ? 0 : 0x0100), u16(0),    // volume (audio only), reserved
        MATRIX,
        u32(video ? t.width << 16 : 0),     // 16.16 fixed point
        u32(video ? t.height << 16 : 0),
      ),
      box('mdia',
        full('mdhd', 0, 0,
          u32(0), u32(0), u32(t.timescale), u32(t.durUnits),
          u16(0x55c4), u16(0),              // language 'und'
        ),
        full('hdlr', 0, 0,
          u32(0), ascii(video ? 'vide' : 'soun'), new Uint8Array(12),
          ascii(video ? 'VideoHandler\0' : 'SoundHandler\0'),
        ),
        box('minf',
          video ? full('vmhd', 0, 1, new Uint8Array(8)) : full('smhd', 0, 0, u32(0)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),   // flag 1: data is in this file
          this._stbl(t, mdatBodyAt),
        ),
      ),
    );
  }

  _stbl(t, mdatBodyAt) {
    const s = t.samples;

    // stts: run-length encoded durations.
    const runs = [];
    for (const x of s) {
      const last = runs[runs.length - 1];
      if (last && last.dur === x.dur) last.n++;
      else runs.push({ n: 1, dur: x.dur });
    }

    // Each sample is its own chunk — one stsc entry, one stco offset per
    // sample. Fatter tables than grouping into chunks, but unambiguous, and a
    // few tens of kilobytes on an episode-length file.
    const parts = [
      full('stsd', 0, 0, u32(1), t.kind === 'video' ? avc1Entry(t) : mp4aEntry(t)),
      full('stts', 0, 0, u32(runs.length), ...runs.map((r) => concat([u32(r.n), u32(r.dur)]))),
    ];
    // stss lists the sync samples; a track where everything is a sync sample
    // (audio, or intra-only video) omits it, which per spec means "all sync".
    if (!s.every((x) => x.key)) {
      const keys = [];
      s.forEach((x, i) => { if (x.key) keys.push(u32(i + 1)); });
      parts.push(full('stss', 0, 0, u32(keys.length), ...keys));
    }
    parts.push(
      full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
      full('stsz', 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.size))),
      full('stco', 0, 0, u32(s.length), ...s.map((x) => u32(mdatBodyAt + x.offset))),
    );
    return box('stbl', ...parts);
  }
}

const MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

function avc1Entry(t) {
  return box('avc1',
    new Uint8Array(6), u16(1),              // reserved, data_reference_index
    new Uint8Array(16),                     // pre_defined + reserved
    u16(t.width), u16(t.height),
    u32(0x00480000), u32(0x00480000),       // 72 dpi
    u32(0), u16(1),                         // reserved, frame_count
    new Uint8Array(32),                     // compressorname (empty pascal string)
    u16(0x0018), u16(0xffff),               // depth 24, pre_defined -1
    box('avcC', t.description),
  );
}

function mp4aEntry(t) {
  return box('mp4a',
    new Uint8Array(6), u16(1),              // reserved, data_reference_index
    new Uint8Array(8),                      // reserved
    u16(t.channels), u16(16),               // channelcount, samplesize
    u16(0), u16(0),                         // pre_defined, reserved
    u32(t.sampleRate << 16),                // 16.16 fixed point
    esds(t),
  );
}

function esds(t) {
  return full('esds', 0, 0,
    descriptor(0x03,                        // ES_Descriptor
      u16(t.id), Uint8Array.of(0),          // ES_ID, no flags
      descriptor(0x04,                      // DecoderConfigDescriptor
        Uint8Array.of(0x40, 0x15),          // objectType AAC, streamType audio
        Uint8Array.of(0, 0, 0),             // bufferSizeDB
        u32(0), u32(0),                     // max/avg bitrate: unspecified
        descriptor(0x05, t.description),    // DecoderSpecificInfo: the ASC
      ),
      descriptor(0x06, Uint8Array.of(0x02)),   // SLConfig: MP4 reserved
    ),
  );
}
