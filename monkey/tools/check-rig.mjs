#!/usr/bin/env node
// Assert which way the joints bend.
//
//   node tools/check-rig.mjs
//
// This exists because the knee has been flipped in error twice, and because
// neither flip was caught by anything: the game still ran, the playthrough
// still passed, and the fault was only visible to a person looking at a
// contact sheet of a 35px figure. A backwards knee is a geometric fact, so it
// can be asserted rather than eyeballed.
//
// The convention, restated: canvas +y is down, the limb runs downward from its
// root, and after ctx.scale(flip, 1) local +x is the direction the character
// faces. So a human knee lands at +x of the hip-to-ankle line and a human
// elbow lands at -x of the shoulder-to-hand line.

import { joint, KNEE_FORWARD, ELBOW_BACK } from '../src/art/paint.js';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(name);
};

// A leg: hip above the ankle, foot slightly forward, both bones equal.
const HIP = { x: 0, y: -70 };
const ANKLE = { x: 12, y: -3 };
const knee = joint(HIP.x, HIP.y, ANKLE.x, ANKLE.y, 35, 35, KNEE_FORWARD);
// Signed offset of the joint from the straight root-to-tip line. Positive is
// forward, because local +x is the facing direction.
const side = (root, tip, j) => {
  const dx = tip.x - root.x, dy = tip.y - root.y;
  return ((j.x - root.x) * dy - (j.y - root.y) * dx) / Math.hypot(dx, dy);
};
const kneeSide = side(HIP, ANKLE, knee);
check('knee bends forward', kneeSide > 2, `offset ${kneeSide.toFixed(1)}px (want > 0)`);

// An arm: shoulder above the hand, hand slightly forward.
const SHO = { x: 0, y: -60 };
const HAND = { x: 10, y: -6 };
const elbow = joint(SHO.x, SHO.y, HAND.x, HAND.y, 28, 28, ELBOW_BACK);
const elbowSide = side(SHO, HAND, elbow);
check('elbow bends backward', elbowSide < -2, `offset ${elbowSide.toFixed(1)}px (want < 0)`);

// The joint must stay on its bones: |root->joint| == l1, and the tip reachable.
const len = Math.hypot(knee.x - HIP.x, knee.y - HIP.y);
check('thigh keeps its length', Math.abs(len - 35) < 0.01, `${len.toFixed(3)} vs 35`);
const shin = Math.hypot(ANKLE.x - knee.x, ANKLE.y - knee.y);
check('shin reaches the ankle', Math.abs(shin - 35) < 0.5, `${shin.toFixed(3)} vs 35`);

// Overreach must clamp rather than produce NaN: a foot placed further away
// than the leg is long is what happens the moment stride outruns leg length.
const far = joint(0, -70, 200, -3, 35, 35, KNEE_FORWARD);
check('overreach clamps instead of NaN', Number.isFinite(far.x) && Number.isFinite(far.y),
  `(${far.x.toFixed(1)}, ${far.y.toFixed(1)})`);

console.log('');
if (fails.length) { console.error(`FAILED: ${fails.join(', ')}`); process.exit(1); }
console.log('rig geometry ok');
