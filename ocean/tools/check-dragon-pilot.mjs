#!/usr/bin/env node
// Does piloting the sea dragon hold course, accept input, and beat faster
// when it goes faster?
//
//   node tools/check-dragon-pilot.mjs
//
// No GPU. The kinematics live in demo/seadragon.js and must be true before a
// frame is ever drawn: release a key and speed / heading / pitch stay put;
// hold W or ArrowUp and it accelerates; Shift+Up is a bigger step;
// hold A and it turns; hold E and it climbs;
// a fast E climb that breaks the surface leaves the water without Space
// and falls on gravity (higher when the run is fast);
// Space surges forward first, then leaps higher when the run is fast,
// falls on gravity, sounds deeper than it started,
// then floats back to that depth at the previous cruise speed;
// while airborne the tail beat holds travel cadence (not slow motion) and the body follows a gravity arc;
// Level zeros pitch and holds depth; a sprint's tail phase advances faster
// than a loaf's.

import { SeaDragon, swimStroke, swimTopSpeed, loafSpeed, jumpApexOf, splashEnergy, STROUHAL_REF, SWIM_PADDLE, maxDiveDepth } from '../demo/seadragon.js';

const p = {
  sdSpeed: 40,
  sdAccel: 0.55,
  sdTurnRate: 0.55,
  sdClimb: 0.45,
  sdBeat: 0.35,
  sdBeatSpeed: 0.030,
  sdAmp: 0.055,
  sdLength: 60,
  sdDepth: 10,
  sdSeaLevel: 0,
};

const step = (d, keys, n = 1, dt = 1 / 60) => {
  const camera = { keys, yaw: 0, pos: [ 0, 4, 0 ] };
  for (let i = 0; i < n; i++) d.update(dt, p, null, camera);
};

const fail = [];
const near = (a, b, eps, label) => {
  if (!(Math.abs(a - b) <= eps)) fail.push(`${label}: ${a.toFixed(4)} ≉ ${b.toFixed(4)} ±${eps}`);
};
const above = (a, b, label) => {
  if (!(a > b)) fail.push(`${label}: ${a} is not greater than ${b}`);
};

const d = new SeaDragon();
d.active = true;
d.reset({ yaw: 0.4, pos: [ 10, 4, -20 ] }, p);
d.pos[0] = 0; d.pos[1] = -22; d.pos[2] = 0;
d.heading = 0.4;
d.speed = 12;
d.cruiseSpeed = 12;
d.pitch = 0.12;
d.depth = 22;
d.cruiseDepth = 22;

const empty = new Set();
const h0 = d.heading, s0 = d.speed, p0 = d.pitch, x0 = d.pos[0], z0 = d.pos[2];
step(d, empty, 90);
near(d.heading, h0, 1e-4, 'heading holds with no input');
near(d.speed, s0, 0.15, 'speed holds with no input');
near(d.pitch, p0, 1e-4, 'pitch holds with no input');
const travelled = Math.hypot(d.pos[0] - x0, d.pos[2] - z0);
above(travelled, 12 * 1.4, 'coasts along its heading');

const s1 = d.speed;
step(d, new Set([ 'KeyW' ]), 90);
above(d.speed, s1 + 2, 'W raises cruise speed');

const h1 = d.heading;
step(d, new Set([ 'KeyA' ]), 60);
above(h1 - d.heading, 0.15, 'A turns to port');
above(- d.headYaw, 0.10, 'A arches the head & neck to port (left turn)');

const hPort = d.heading;
step(d, new Set([ 'KeyD' ]), 120);
above(d.heading - hPort, 0.15, 'D turns to starboard');
above(d.headYaw, 0.10, 'D arches the head & neck to starboard (right turn)');

step(d, empty, 60);
near(d.headYaw, 0, 0.05, 'released turn centers the head');

d.level();
d.pos[1] = -12;
d.depth = 12;
d.pitch = 0;
d.jumpAirborne = false;
const y1 = d.pos[1];
step(d, new Set([ 'KeyE' ]), 60);
above(d.pos[1], y1 + 0.4, 'E pitches up and climbs');
above(d.pitch, 0.2, 'E pitches up while held');

const pHeld = d.pitch;
const y2 = d.pos[1];
step(d, empty, 45);
near(d.pitch, pHeld, 1e-4, 'released E holds pitch');
above(d.pos[1], y2 + 0.15, 'held climb pitch keeps rising until leveled');

d.level();
d.pos[1] = -3;
d.depth = 3;
d.cruiseSpeed = 12;
d.speed = 12;
d.pitch = 0;
const resume = d.cruiseSpeed;
const startY = d.pos[1];
step(d, new Set([ 'Space' ]), 1);
above(d.jumping ? 1 : 0, 0.5, 'Space starts a leap');
const yRun = d.pos[1], sRun = d.speed;
step(d, empty, 60);
near(d.pos[1], yRun, 0.45, 'run-up holds depth before the climb');
above(d.speed, sRun + 4, 'run-up accelerates forward first');
above(d.jumpPhase === 'accel' ? 1 : 0, 0.5, 'still gathering after a second of run-up');
let cleared = false, maxY = d.pos[1], minY = d.pos[1], maxSplash = d.splash, landSplash = 0, maxPush = 0, landAge = 99;
let airN = 0, lateAir = 0, lateAirN = 0;
let wetN = 0, lateWet = 0, lateWetN = 0;
for (let i = 0; i < 720; i++) {
  const wasAir = d.jumpPhase === 'air';
  const phase0 = d.phase;
  step(d, empty, 1);
  const dPhase = d.phase - phase0;
  if (d.jumpAirborne) {
    airN += 1;
    if (airN > 24) { lateAir += dPhase; lateAirN += 1; }
  } else if (d.jumpPhase === 'water') {
    wetN += 1;
    if (wetN > 45) { lateWet += dPhase; lateWetN += 1; }
  }
  if (d.pos[1] > maxY) maxY = d.pos[1];
  if (d.pos[1] < minY) minY = d.pos[1];
  if (d.splash > maxSplash) maxSplash = d.splash;
  if (d.splashPush > maxPush) maxPush = d.splashPush;
  if (wasAir && d.jumpPhase === 'water') { landSplash = d.splash; landAge = d.splashAge; }
  if (d.pos[1] > 1) cleared = true;
  if (!d.jumping && cleared) break;
}
above(maxY, 1, 'the leap clears the water');
above(8 - maxY, 0, 'a modest-speed leap stays a few metres above the sea');
above(3.2 - airN / 60, 0, 'the breach is a short arc, not a long hang');
above(jumpApexOf(36, 60) - jumpApexOf(12, 60), 2.5, 'more speed aims a higher apex');
{
  const fast = new SeaDragon();
  fast.active = true;
  fast.reset({ yaw: 0, pos: [ 0, -3, 0 ] }, p);
  fast.pos[1] = -3;
  fast.depth = 3;
  fast.speed = 36;
  fast.cruiseSpeed = 36;
  fast.pitch = 0;
  step(fast, new Set([ 'Space' ]), 1);
  let fastY = fast.pos[1], airVy0 = null, airVy1 = null, airDt = 0;
  for (let i = 0; i < 480; i++) {
    const wasAir = fast.jumpPhase === 'air';
    const vy0 = fast.jumpVy;
    step(fast, empty, 1);
    if (fast.pos[1] > fastY) fastY = fast.pos[1];
    if (!wasAir && fast.jumpPhase === 'air') airVy0 = fast.jumpVy;
    if (wasAir && fast.jumpPhase === 'air' && airVy0 != null && airDt < 0.2) {
      airDt += 1 / 60;
      airVy1 = fast.jumpVy;
    }
    if (!fast.jumping && fastY > 1) break;
  }
  above(fastY, maxY + 2.5, 'a faster run jumps higher');
  above(fastY, 8, 'enough speed clears more than a hop');
  above(20 - fastY, 0, 'even a fast leap is a gravity arc, not a hang-glider');
  above(airVy0 != null && airVy1 != null ? 1 : 0, 0.5, 'the fast leap has an airborne fall to measure');
  if (airVy0 != null && airVy1 != null) {
    const g = (airVy0 - airVy1) / Math.max(airDt, 1 / 60);
    above(g, 8, 'airborne fall is gravity, not a float');
    above(12 - g, 0, 'airborne fall is not a slam faster than g');
  }
}
{
  const swimOut = ( speed ) => {
    const body = new SeaDragon();
    body.active = true;
    body.reset({ yaw: 0, pos: [ 0, -2, 0 ] }, p);
    body.pos[1] = -2;
    body.depth = 2;
    body.speed = speed;
    body.cruiseSpeed = speed;
    body.pitch = 0.55;
    let peak = body.pos[1], airVy0 = null, airVy1 = null, airDt = 0, landed = false;
    for (let i = 0; i < 480; i++) {
      const wasAir = body.jumpAirborne;
      step(body, new Set([ 'KeyE' ]), 1);
      if (body.jumping) fail.push('a swim-out started a Space leap');
      if (body.pos[1] > peak) peak = body.pos[1];
      if (!wasAir && body.jumpAirborne) airVy0 = body.jumpVy;
      if (wasAir && body.jumpAirborne && airVy0 != null && airDt < 0.2) {
        airDt += 1 / 60;
        airVy1 = body.jumpVy;
      }
      if (wasAir && !body.jumpAirborne && peak > 1) { landed = true; break; }
    }
    return { body, peak, airVy0, airVy1, airDt, landed };
  };
  const fastSwim = swimOut(36);
  const slowSwim = swimOut(12);
  above(fastSwim.peak, 1, 'a fast climb leaves the water without Space');
  above(fastSwim.landed ? 1 : 0, 0.5, 'a swim-out falls back into the sea');
  above(fastSwim.body.jumping ? 0 : 1, 0.5, 'a swim-out is not a Space leap');
  above(20 - fastSwim.peak, 0, 'a swim-out is a gravity arc, not a hang-glider');
  above(fastSwim.peak, slowSwim.peak + 2, 'a faster swim-out jumps higher');
  above(fastSwim.airVy0 != null && fastSwim.airVy1 != null ? 1 : 0, 0.5, 'a swim-out has an airborne fall to measure');
  if (fastSwim.airVy0 != null && fastSwim.airVy1 != null) {
    const g = (fastSwim.airVy0 - fastSwim.airVy1) / Math.max(fastSwim.airDt, 1 / 60);
    above(g, 8, 'a swim-out fall is gravity, not a float');
    above(12 - g, 0, 'a swim-out fall is not a slam faster than g');
  }
}
above(startY - minY, 2.4, 'the fall carries it deeper than it started');
above(cleared && !d.jumping ? 1 : 0, 0.5, 'the leap ends after it floats back');
near(d.speed, resume, 0.8, 'float-back restores the previous cruise speed');
near(d.cruiseSpeed, resume, 0.8, 'float-back restores cruiseSpeed');
near(d.pos[1], startY, 1.2, 'it floats back to the depth it jumped from');
above(maxSplash, 1.2, 'the leap throws a physics-scaled splash');
above(landSplash, 1.5, 'the landing splash is bigger than a ski slap');
above(landSplash, splashEnergy(8, 12, 60, true) - 0.05, 'a harder fall throws more water');
above(maxPush, 1.5, 'the landing leaves a lingering spray crown');
above(d.splashHit, 1.2, 'the hit feeds the ripple field');
above(0.05 - landAge, 0, 'the ripple clock restarts on landing');
above(lateAirN, 10, 'the leap stays airborne long enough to measure the air beat');
above(lateAir / lateAirN, 0.04, 'airborne beat keeps a clear travelling wave');
{
  const cruisePerFrame = swimStroke(p, resume).f * Math.PI * 2 / 60;
  above(lateAir / lateAirN, cruisePerFrame * 0.85, 'airborne beat holds travel cadence, not a slow-mo drop');
}
above(lateWetN, 10, 'the landing lasts long enough to measure the wet beat');
above(lateWet / lateWetN, 0.04, 're-entry still has a travelling wave');
{
  const cruiseF = swimStroke(p, resume).f;
  let post = 0;
  for (let i = 0; i < 60; i++) {
    const a = d.phase;
    step(d, empty, 1);
    post += d.phase - a;
  }
  above(post, cruiseF * Math.PI * 2 * 0.7, 'after the leap the beat matches the restored cruise');
}

// THE SPLASH CLOCK MUST RUN WITH THE PILOT LET GO. It lived in pilot() and so
// stopped the moment control went back to the AI - and a frozen splashAge under
// three-main.js's 7 s window leaves the crater, the jet and the raft standing in
// the sea permanently. Only pilot() can START a leap; anyone can finish one.
// A separate animal, because the AI path steers off a vehicle this fixture does
// not have and only the clock is under test here.
const ai = new SeaDragon();
ai.update(1 / 60, p, null, { keys: empty, yaw: 0, pos: [ 0, 4, 0 ] });
ai.active = false;
ai.splashHit = 2.5;
ai.splashAge = 0;
ai.splashPush = 2;
for (let i = 0; i < 30; i++) ai.update(1 / 60, p, null, { keys: empty, yaw: 0, pos: [ 0, 4, 0 ] });
above(ai.splashAge, 0.3, 'the splash keeps ageing with the AI driving');
above(2 - ai.splashPush, 0, '...and its lingering crown keeps decaying too');

d.level();
near(d.pitch, 0, 1e-6, 'level zeros pitch');
near(d.climb, 0, 1e-6, 'level zeros climb');
const yHold = d.pos[1];
step(d, empty, 30);
near(d.pitch, 0, 1e-6, 'level holds a flat pitch');
near(d.pos[1], yHold, 0.08, 'leveled animal holds depth');

near(maxDiveDepth({ depth: 26, sdLength: 60 }), 40, 1e-6, 'a 26 m sea still floors at 40 m');
above(maxDiveDepth({ depth: 200, sdLength: 60 }), 100, 'a 200 m column allows a deep dive');
const diveP = { ...p, depth: 200, sdLength: 60 };
const diver = new SeaDragon();
diver.active = true;
diver.reset({ yaw: 0, pos: [ 0, 4, 0 ] }, diveP);
diver.pos[1] = -22;
diver.speed = 28;
diver.cruiseSpeed = 28;
diver.pitch = -0.65;
const camQ = { keys: new Set([ 'KeyQ' ]), yaw: 0, pos: [ 0, 4, 0 ] };
for (let i = 0; i < 240; i++) diver.update(1 / 60, diveP, null, camQ);
above(diver.depth, 40, 'Q on a 200 m sea dives past the old 40 m floor');

const s2 = d.speed;
step(d, new Set([ 'KeyS' ]), 90);
above(s2 - d.speed, 2, 'S lowers cruise speed');

const arrow = new SeaDragon();
arrow.active = true;
arrow.reset({ yaw: 0, pos: [ 0, 4, 0 ] }, p);
arrow.cruiseSpeed = 12; arrow.speed = 12;
step(arrow, new Set([ 'ArrowUp' ]), 45);
above(arrow.cruiseSpeed, 12.5, 'ArrowUp raises cruise speed');
const upPlain = arrow.cruiseSpeed - 12;
const boosted = new SeaDragon();
boosted.active = true;
boosted.reset({ yaw: 0, pos: [ 0, 4, 0 ] }, p);
boosted.cruiseSpeed = 12; boosted.speed = 12;
step(boosted, new Set([ 'ArrowUp', 'ShiftLeft' ]), 45);
above(boosted.cruiseSpeed - 12, upPlain * 1.6, 'Shift+Up raises cruise faster than Up alone');

const loaf = new SeaDragon();
loaf.active = true;
loaf.reset({ yaw: 0, pos: [ 0, 4, 0 ] }, p);
loaf.cruiseSpeed = 3; loaf.speed = 3;
const sprint = new SeaDragon();
sprint.active = true;
sprint.reset({ yaw: 0, pos: [ 0, 4, 0 ] }, p);
sprint.cruiseSpeed = 28; sprint.speed = 28;
const rads = (body, spd) => {
  body.speed = spd;
  body.cruiseSpeed = spd;
  let sum = 0;
  for (let i = 0; i < 60; i++) {
    const a = body.phase;
    body.update(1 / 60, p, null, { keys: empty, yaw: 0, pos: [ 0, 4, 0 ] });
    sum += body.phase - a;
  }
  return sum;
};
const slow = rads(loaf, 3);
const fast = rads(sprint, 28);
above(fast, slow * 1.6, 'tail phase at 28 m/s vs 3 m/s');
above(sprint.swimAmp, loaf.swimAmp, 'tail sweep grows with speed');

const at60 = swimStroke(p, 12);
const at120 = swimStroke({ ...p, sdLength: 120 }, 12);
above(at60.f, at120.f * 1.15, 'a 120 m body beats slower than a 60 m at the same speed');
above(at120.distancePerBeat, at60.distancePerBeat * 1.15, 'a 120 m body covers more water per beat');
above(swimTopSpeed({ ...p, sdLength: 120 }), swimTopSpeed(p) * 1.3, 'top speed grows with sqrt(length)');

const live = {
  ...p,
  sdSpeed: 80,
  sdAmp: 0.11,
  sdWaves: 0.96,
  sdBeat: 0,
  sdBeatSpeed: 0.032,
  sdLength: 60,
};
const at37 = swimStroke( live, 37 );
const paddleMin = 37 * 0.96 / 60 * SWIM_PADDLE;
near( at37.St, STROUHAL_REF, 0.02, 'default trim is St ≈ 0.30' );
above( at37.f, paddleMin - 0.02, 'cadence keeps the body wave ahead of a 37 m/s swim' );
near( at37.f, at37.fSt, 0.05, 'at this speed Strouhal, not the loaf floor, sets the beat' );
const tooLow = swimStroke( { ...live, sdBeatSpeed: 0.007 }, 37 );
above( tooLow.f, paddleMin - 0.02, 'a too-low trim still cannot slide through its own wave' );

near(loafSpeed({ ...p, sdCruise: 12 }), 12, 1e-6, 'loafSpeed reads sdCruise');
near(loafSpeed({ ...p, sdCruise: 90 }), swimTopSpeed(p), 1e-6, 'loafSpeed cannot exceed top speed');

const pathLen = ( body, params, seconds ) => {
  let len = 0;
  let px = body.pos[ 0 ], pz = body.pos[ 2 ];
  const n = Math.round( seconds * 60 );
  const cam = { keys: empty, yaw: 0, pos: [ 0, 4, 0 ] };
  for ( let i = 0; i < n; i ++ ) {
    body.update( 1 / 60, params, null, cam );
    len += Math.hypot( body.pos[ 0 ] - px, body.pos[ 2 ] - pz );
    px = body.pos[ 0 ];
    pz = body.pos[ 2 ];
  }
  return len;
};
const aiBase = {
  ...p,
  sdOrbit: 0.2,
  sdOffset: 8,
  sdOffsetClose: 4,
  sdLead: 0,
  sdRushSpeed: 30,
  sdMinDepth: 2,
  sdDepthSwing: 0,
  sdAccel: 1.2,
};
const slowAi = new SeaDragon();
slowAi.reset( { yaw: 0, pos: [ 0, 4, 0 ] }, { ...aiBase, sdCruise: 6 } );
const fastAi = new SeaDragon();
fastAi.reset( { yaw: 0, pos: [ 0, 4, 0 ] }, { ...aiBase, sdCruise: 24 } );
pathLen( slowAi, { ...aiBase, sdCruise: 6 }, 2.5 );
pathLen( fastAi, { ...aiBase, sdCruise: 24 }, 2.5 );
const dSlow = pathLen( slowAi, { ...aiBase, sdCruise: 6 }, 3 );
const dFast = pathLen( fastAi, { ...aiBase, sdCruise: 24 }, 3 );
above( dFast, dSlow * 2.2, 'AI cruise 24 m/s covers more water than 6 m/s' );
near( dSlow, 18, 6, 'AI cruise 6 travels ~18 m in 3 s once settled' );

if (fail.length) {
  console.error('FAIL dragon-pilot');
  for (const f of fail) console.error('  ' + f);
  process.exit(1);
}
console.log('ok  dragon-pilot  hold / accel / turn / climb / leap / beat');
