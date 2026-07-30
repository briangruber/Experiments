/* Pure-logic checks — no browser. Run: node games/oneflick/test-logic.mjs */
import * as G from './src/game.js';

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  ok  ' : '  FAIL') + '  ' + n + (x && !c ? '  [' + x + ']' : '')); };

console.log('\nCourse');
const course = G.courseFor(4242);
ok('generates pillars', course.pillars.length >= 7 && course.pillars.length <= 10, course.pillars.length);
ok('deterministic for a seed', JSON.stringify(G.courseFor(99)) === JSON.stringify(G.courseFor(99)));
ok('different seeds differ', JSON.stringify(G.courseFor(1)) !== JSON.stringify(G.courseFor(2)));
ok('pillars stay inside the arena', course.pillars.every(p =>
  Math.abs(p.x) + p.r < G.ARENA.w / 2 && Math.abs(p.z) + p.r < G.ARENA.d / 2));
ok('launch corridor is clear', course.pillars.every(p => {
  const dx = p.x - G.START.x, dz = p.z - G.START.z;
  return Math.sqrt(dx * dx + dz * dz) > p.r + G.BALL_R + 1;
}));

console.log('\nPhysics');
let escaped = 0, stuck = 0, cells = new Set(), bmax = 0;
for (let a = 0; a < 72; a++) {
  for (let p = 0; p <= 24; p++) {
    const ang = a / 72 * Math.PI * 2;
    const r = G.simulate(course, Math.sin(ang), -Math.cos(ang), G.powerToSpeed(p / 24));
    if (Math.abs(r.x) > G.ARENA.w / 2 || Math.abs(r.z) > G.ARENA.d / 2) escaped++;
    if (course.pillars.some(q => Math.sqrt((r.x - q.x) ** 2 + (r.z - q.z) ** 2) < q.r + G.BALL_R - 0.02)) stuck++;
    cells.add(Math.round(r.x / 2) + ',' + Math.round(r.z / 2));
    bmax = Math.max(bmax, r.bounces);
  }
}
ok('no ball ever leaves the arena', escaped === 0, escaped + ' escapes');
ok('no ball ends inside a pillar', stuck === 0, stuck + ' embedded');
ok('aim genuinely matters (wide spread of outcomes)', cells.size > 90, cells.size + ' distinct cells');
ok('bounces happen', bmax >= 3, 'max ' + bmax);
const s1 = G.simulate(course, 0.3, -0.95, 20), s2 = G.simulate(course, 0.3, -0.95, 20);
ok('simulation is deterministic', s1.x === s2.x && s1.z === s2.z);
ok('path is animatable', s1.path.length > 5);

console.log('\nEncoding');
let q = 0;
for (let i = 0; i < 8000; i++) {
  const v = -35 + Math.random() * 70;
  if (Math.abs(G.uqPos(G.qPos(v)) - v) > 0.0035) q++;
  const a = Math.random() * Math.PI * 2;
  if (Math.abs(G.uqAng(G.qAng(a)) - a) > 0.0003) q++;
  const pw = Math.random();
  if (Math.abs(G.uqPow(G.qPow(pw)) - pw) > 0.001) q++;
}
ok('quantisation stays within tolerance', q === 0, q + ' out of range');

let bad = 0, longest = 0;
for (let i = 0; i < 500; i++) {
  const chain = Array.from({ length: Math.floor(Math.random() * 14) }, () => ({
    name: ['sam', 'priya', 'dan', 'bri', 'zzzzzzzzzzzz'][Math.floor(Math.random() * 5)],
    angle: Math.random() * Math.PI * 2, power: Math.random(),
    x: -18 + Math.random() * 36, z: -17 + Math.random() * 34
  }));
  const seed = Math.floor(Math.random() * 1679616);
  const target = { x: -9 + Math.random() * 18, z: -18 + Math.random() * 36 };
  const f = G.buildFragment(seed, target, chain);
  const p = G.parseFragment(f);
  longest = Math.max(longest, f.length);
  if (p.tampered || p.seed !== seed || p.chain.length !== chain.length) bad++;
  if (Math.abs(p.target.x - target.x) > 0.0035 || Math.abs(p.target.z - target.z) > 0.0035) bad++;
  for (let j = 0; j < p.chain.length; j++) {
    if (p.chain[j].name !== chain[j].name) bad++;
    if (Math.abs(p.chain[j].x - chain[j].x) > 0.0035) bad++;
    if (Math.abs(p.chain[j].power - chain[j].power) > 0.001) bad++;
  }
}
ok('500 chains round-trip exactly', bad === 0, bad + ' defects');
ok('longest url fragment stays tiny', longest < 400, longest + ' chars');

console.log('\nRobustness');
ok('empty fragment yields a fresh course', G.parseFragment('').seed === null);
ok('garbage fragment is rejected safely', G.parseFragment('#s=!!&c=@@@&k=zz').seed === null);
ok('truncated target is rejected', G.parseFragment('#s=abc&t=xy&c=&k=00').seed === null);
const good = G.buildFragment(7, { x: 1, z: 2 }, [{ name: 'sam', angle: 1, power: .5, x: 1, z: 2 }]);
ok('edited chain is detected', G.parseFragment(good.replace('sam', 'bob')).tampered);
ok('intact chain is not flagged', !G.parseFragment(good).tampered);
ok('malformed entries are dropped, not fatal', G.parseFragment('#s=7&t=aaaaaa&c=sam.zzz~!!!&k=00').chain.length === 0);
ok('names are sanitised', G.cleanName('  Sam-O\'Neill!! ') === 'samoneill');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
