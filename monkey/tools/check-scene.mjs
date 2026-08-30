#!/usr/bin/env node
// Verify the backdrop assets without being able to play them.
//
//   node tools/check-scene.mjs
//
// Headless Chromium ships no H.264 decoder, so the browser check cannot tell a
// good scene.mp4 from a truncated one — it falls back to the still and reports
// success either way. That is precisely the silent-fallback failure this
// project keeps rediscovering, so the video is checked as a file instead:
// walk the ISO-BMFF boxes and read the dimensions and duration out of the
// headers. It does not prove the picture is good; it proves the asset is real,
// the right shape, and the right length.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';
import { probe, isDead, DEAD_ACTIVITY, DEAD_BURST } from './mp4.mjs';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(name);
};
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const MP4 = join(ROOT, 'assets/scene.mp4');
if (!(await exists(MP4))) {
  console.error('no assets/scene.mp4 — run: node tools/scene.mjs still && node tools/scene.mjs loop');
  process.exit(1);
}
const buf = await readFile(MP4);
const p = probe(buf);

check('file is an ISO media file', p.isMp4, buf.toString('latin1', 8, 20).replace(/[^\x20-\x7e]/g, '.'));
check('declares H.264 (avc1)', p.avc);
check('has media data', p.mdatBytes > 0, `${(p.mdatBytes / 1024 / 1024).toFixed(2)} MB`);
// A truncated download is the common failure and it looks exactly like a valid
// header followed by nothing.
check('media data is complete', p.complete, `${p.mdatBytes} bytes of ${buf.length}`);
check('duration is a usable loop length', p.seconds > 2 && p.seconds < 20, `${p.seconds.toFixed(2)}s`);
check('track has dimensions', p.width > 0 && p.height > 0, `${p.width}x${p.height}`);
// The backdrop is stretched to fill a 16:9 room, so a source close to 16:9 is
// fine and a portrait or square one is not. MiniMax's native 768P is 1344x768
// (1.750), a 1.6% horizontal stretch — invisible on a soft painted image.
check('close enough to 16:9 to stretch', Math.abs(p.ratio - 16 / 9) < 0.06,
  `ratio ${p.ratio.toFixed(3)} vs ${(16 / 9).toFixed(3)}`);

// The artifact has a 16 MB ceiling and base64 costs a third on top, so the
// video's real budget is about 6 MB. A backdrop nobody can load is worse than
// a softer one.
const MB = buf.length / 1024 / 1024;
check('small enough to inline in a published page', MB < 6.5, `${MB.toFixed(2)} MB (~${(MB * 4 / 3).toFixed(1)} MB base64)`);

// Does the video actually MOVE? This is the check whose absence let a
// technically perfect video ship that was visually identical to the still —
// and whose first version then called a perfectly good subtle loop dead,
// because dividing by the keyframe punishes exactly the crisp high-resolution
// clips this room wants. Two numbers: how much changes between frames, and how
// unevenly. Dead means quiet AND even.
check('video contains motion', !isDead(p.motion),
  p.motion ? `${p.motion.frames} frames, activity ${p.motion.activity} B/MPx, burst ${p.motion.burst}x `
    + `(dead is under ${DEAD_ACTIVITY} AND under ${DEAD_BURST}x — quiet but uneven is a subtle loop)` : 'no sample table');

const STILL = join(ROOT, 'assets/scene.jpg');
check('web-sized still exists as a fallback', await exists(STILL),
  (await exists(STILL)) ? `${((await stat(STILL)).size / 1024).toFixed(0)} KB` : 'missing');

console.log('');
if (fails.length) { console.error(`FAILED: ${fails.join(', ')}`); process.exit(1); }
console.log('scene assets ok (playback itself is unverifiable here — headless Chromium has no H.264)');
