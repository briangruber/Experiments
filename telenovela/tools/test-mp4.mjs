#!/usr/bin/env node
// Unit test for engine/mp4.js, runnable in plain node — no browser, no
// encoders. Synthetic "encoded chunks" go in, and the produced bytes are
// parsed back box by box: structure, sample tables, durations, offsets, and
// the actual sample payloads read back out of mdat through stco/stsz.
//
//   node tools/test-mp4.mjs
//
// This exists because the avc1+aac happy path cannot run end to end in the
// development sandbox (headless Chromium here has no H.264 encoder), so the
// muxer has to be provably correct on its own.

import { Mp4Muxer } from '../engine/mp4.js';

let failures = 0;
function ok(cond, what) {
  if (cond) return;
  failures++;
  console.error(`  FAIL: ${what}`);
}
function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w, `${what}: got ${g}, want ${w}`);
}

// --- a tiny box parser (the same shape record.js's repair code walks) --------

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8 | b[o + 1]) >>> 0;

function* boxes(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    const size = u32(b, o);
    const box = { type: fourcc(b, o + 4), start: o, body: o + 8, end: o + size };
    if (size < 8 || box.end > end) throw new Error(`bad box at ${o}: ${box.type} size ${size}`);
    yield box;
    o = box.end;
  }
  if (o !== end) throw new Error(`trailing bytes: ${end - o}`);
}
const find = (b, from, to, type) => {
  for (const box of boxes(b, from, to)) if (box.type === type) return box;
  return null;
};
const findAll = (b, from, to, type) => {
  const out = [];
  for (const box of boxes(b, from, to)) if (box.type === type) out.push(box);
  return out;
};

// --- build a file from synthetic chunks --------------------------------------

// A few hundred bytes each, content derived from the index so payload identity
// is checkable after the round trip.
const fakeBytes = (seed, len) => {
  const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) u[i] = (seed * 31 + i * 7) & 0xff;
  return u;
};

// Shaped like a real AVCDecoderConfigurationRecord header, but fake.
const AVCC = Uint8Array.of(0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80);
// AudioSpecificConfig for AAC-LC 48kHz stereo.
const ASC = Uint8Array.of(0x11, 0x90);

const FPS = 30;
const N_VIDEO = 300;                       // ten seconds
const SAMPLE_RATE = 48000;
const N_AUDIO = Math.floor((N_VIDEO / FPS) * SAMPLE_RATE / 1024);   // AAC packets

const mux = new Mp4Muxer();
const vt = mux.addVideoTrack({ width: 1280, height: 720, description: AVCC });

const videoPayloads = [], videoKeys = [];
for (let i = 0; i < N_VIDEO; i++) {
  const key = i % (FPS * 2) === 0;
  const bytes = fakeBytes(i, key ? 700 : 200 + (i % 5) * 40);
  videoPayloads.push(bytes);
  if (key) videoKeys.push(i + 1);
  mux.addSample(vt, bytes, {
    timestamp: Math.round((i * 1e6) / FPS),
    duration: Math.round(((i + 1) * 1e6) / FPS) - Math.round((i * 1e6) / FPS),
    key,
  });
}

// Audio committed after video, the way the exporter does it — the two tracks'
// bytes are not interleaved and the offsets must still land.
const at = mux.addAudioTrack({ sampleRate: SAMPLE_RATE, channels: 2, description: ASC });
const audioPayloads = [];
for (let i = 0; i < N_AUDIO; i++) {
  const bytes = fakeBytes(1000 + i, 340 + (i % 3) * 11);
  audioPayloads.push(bytes);
  mux.addSample(at, bytes, {
    timestamp: Math.round((i * 1024 * 1e6) / SAMPLE_RATE),
    duration: Math.round((1024 * 1e6) / SAMPLE_RATE),
    key: true,
  });
}

const file = mux.finish();

// --- parse it back and assert everything -------------------------------------

const top = [...boxes(file, 0, file.length)];
eq(top.map((b) => b.type), ['ftyp', 'mdat', 'moov'], 'top-level layout');
const [ftyp, mdat, moov] = top;
eq(fourcc(file, ftyp.body), 'isom', 'major brand');

const mvhd = find(file, moov.body, moov.end, 'mvhd');
ok(mvhd, 'mvhd present');
const movieTimescale = u32(file, mvhd.body + 12);
eq(movieTimescale, 1000, 'movie timescale');
eq(u32(file, mvhd.body + 16), 10000, 'movie duration: ten seconds at timescale 1000');

const traks = findAll(file, moov.body, moov.end, 'trak');
eq(traks.length, 2, 'two tracks');

function readTrack(trak) {
  const tkhd = find(file, trak.body, trak.end, 'tkhd');
  const mdia = find(file, trak.body, trak.end, 'mdia');
  const mdhd = find(file, mdia.body, mdia.end, 'mdhd');
  const hdlr = find(file, mdia.body, mdia.end, 'hdlr');
  const minf = find(file, mdia.body, mdia.end, 'minf');
  const stbl = find(file, minf.body, minf.end, 'stbl');
  const stsd = find(file, stbl.body, stbl.end, 'stsd');
  const entry = [...boxes(file, stsd.body + 8, stsd.end)][0];
  const stts = find(file, stbl.body, stbl.end, 'stts');
  const stsz = find(file, stbl.body, stbl.end, 'stsz');
  const stsc = find(file, stbl.body, stbl.end, 'stsc');
  const stco = find(file, stbl.body, stbl.end, 'stco');
  const stss = find(file, stbl.body, stbl.end, 'stss');
  return {
    id: u32(file, tkhd.body + 12),
    tkhdDur: u32(file, tkhd.body + 20),
    timescale: u32(file, mdhd.body + 12),
    mdhdDur: u32(file, mdhd.body + 16),
    handler: fourcc(file, hdlr.body + 8),
    format: entry.type,
    entry, stts, stsz, stsc, stco, stss,
  };
}

const sttsPairs = (t) => {
  const n = u32(file, t.stts.body + 4);
  const out = [];
  for (let i = 0; i < n; i++) out.push([u32(file, t.stts.body + 8 + i * 8), u32(file, t.stts.body + 12 + i * 8)]);
  return out;
};
const sizes = (t) => {
  eq(u32(file, t.stsz.body + 4), 0, `${t.format} stsz: no constant size`);
  const n = u32(file, t.stsz.body + 8);
  const out = [];
  for (let i = 0; i < n; i++) out.push(u32(file, t.stsz.body + 12 + i * 4));
  return out;
};
const offsets = (t) => {
  const n = u32(file, t.stco.body + 4);
  const out = [];
  for (let i = 0; i < n; i++) out.push(u32(file, t.stco.body + 8 + i * 4));
  return out;
};

function checkSamples(t, payloads, label) {
  const sz = sizes(t), off = offsets(t);
  eq(sz.length, payloads.length, `${label}: sample count in stsz`);
  eq(off.length, payloads.length, `${label}: chunk count in stco (one chunk per sample)`);
  eq([u32(file, t.stsc.body + 4), u32(file, t.stsc.body + 8), u32(file, t.stsc.body + 12), u32(file, t.stsc.body + 16)],
    [1, 1, 1, 1], `${label}: stsc single 1-sample-per-chunk run`);
  let bad = 0;
  for (let i = 0; i < payloads.length; i++) {
    if (sz[i] !== payloads[i].length) bad++;
    else if (off[i] < mdat.body || off[i] + sz[i] > mdat.end) bad++;
    else {
      const got = file.subarray(off[i], off[i] + sz[i]);
      for (let j = 0; j < got.length; j++) if (got[j] !== payloads[i][j]) { bad++; break; }
    }
  }
  eq(bad, 0, `${label}: every sample readable from mdat via stco/stsz, bytes intact`);
  const pairs = sttsPairs(t);
  const total = pairs.reduce((a, [n, d]) => a + n * d, 0);
  const count = pairs.reduce((a, [n]) => a + n, 0);
  eq(count, payloads.length, `${label}: stts covers every sample`);
  eq(total, t.mdhdDur, `${label}: stts durations sum to mdhd duration`);
  return { sz, off };
}

const video = readTrack(traks[0]);
const audio = readTrack(traks[1]);

eq(video.id, 1, 'video track id');
eq(video.handler, 'vide', 'video handler');
eq(video.format, 'avc1', 'video sample entry');
eq(video.timescale, 90000, 'video timescale');
eq(video.mdhdDur, 900000, 'video mdhd duration: 300 frames at 30fps in 90kHz');
eq(video.tkhdDur, 10000, 'video tkhd duration in movie timescale');
eq(u16(file, video.entry.body + 24), 1280, 'avc1 width');
eq(u16(file, video.entry.body + 26), 720, 'avc1 height');
{
  // avcC sits after the 78 fixed bytes of the visual sample entry.
  const avcC = find(file, video.entry.body + 78, video.entry.end, 'avcC');
  ok(avcC, 'avcC present');
  eq([...file.subarray(avcC.body, avcC.end)], [...AVCC], 'avcC carries the description verbatim');
}
checkSamples(video, videoPayloads, 'video');
{
  ok(video.stss, 'video stss present (not every frame is sync)');
  const n = u32(file, video.stss.body + 4);
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(u32(file, video.stss.body + 8 + i * 4));
  eq(keys, videoKeys, 'stss lists exactly the key samples, 1-based');
}

eq(audio.id, 2, 'audio track id');
eq(audio.handler, 'soun', 'audio handler');
eq(audio.format, 'mp4a', 'audio sample entry');
eq(audio.timescale, SAMPLE_RATE, 'audio timescale is the sample rate');
eq(audio.mdhdDur, N_AUDIO * 1024, 'audio mdhd duration: 1024 frames per packet');
eq(u16(file, audio.entry.body + 16), 2, 'mp4a channelcount');
eq(u32(file, audio.entry.body + 24) >>> 16, SAMPLE_RATE, 'mp4a samplerate 16.16');
{
  const esds = find(file, audio.entry.body + 28, audio.entry.end, 'esds');
  ok(esds, 'esds present');
  const b = file.subarray(esds.body + 4, esds.end);   // past version/flags
  eq(b[0], 0x03, 'ES_Descriptor tag');
  // Find the DecoderSpecificInfo (tag 5) and compare against the ASC.
  let asc = null;
  for (let i = 0; i < b.length - 1; i++) {
    if (b[i] === 0x05 && b[i + 1] === ASC.length) { asc = b.subarray(i + 2, i + 2 + ASC.length); break; }
  }
  ok(asc, 'DecoderSpecificInfo found');
  if (asc) eq([...asc], [...ASC], 'AudioSpecificConfig carried verbatim');
  eq(b.includes(0x40), true, 'objectTypeIndication AAC present');
}
checkSamples(audio, audioPayloads, 'audio');
ok(!audio.stss, 'audio omits stss (all samples sync)');

// stts run-length actually compresses the constant frame rate.
ok(sttsPairs(video).length <= 3, `video stts is run-length encoded (${sttsPairs(video).length} runs for 300 samples)`);

// mdat size accounts for every payload byte.
const payloadBytes = [...videoPayloads, ...audioPayloads].reduce((a, p) => a + p.length, 0);
eq(mdat.end - mdat.body, payloadBytes, 'mdat body size is exactly the sample bytes');

// The b-frame guard: out-of-order timestamps must throw, not silently mux.
{
  const m2 = new Mp4Muxer();
  const t = m2.addVideoTrack({ width: 64, height: 64, description: AVCC });
  m2.addSample(t, fakeBytes(1, 50), { timestamp: 33333, duration: 33333, key: true });
  let threw = false;
  try { m2.addSample(t, fakeBytes(2, 50), { timestamp: 0, duration: 33333, key: false }); } catch { threw = true; }
  ok(threw, 'non-monotonic timestamps rejected (no ctts support)');
}

if (failures) {
  console.error(`\ntest-mp4: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`test-mp4: ok — ${N_VIDEO} video + ${N_AUDIO} audio samples, ${(file.length / 1024).toFixed(1)} KB file, every table verified`);
