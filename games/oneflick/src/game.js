/* ONE FLICK — pure game logic. No three.js, no DOM, so it runs under node.
   Physics is deliberately restricted to + - * / and sqrt: no transcendentals
   in the simulation loop, so a shot resolves the same way on every device. */

export const ARENA = { w: 18, d: 36 };          // proportioned like a phone so it fills a portrait screen
export const BALL_R = 0.45;
export const START = { x: 0, z: 14.6 };
const DT = 1 / 240;
const DECEL = 4.6;                              // rolling friction, units/s^2
const REST_WALL = 0.74;
const REST_PILLAR = 0.8;
const STOP_SPEED = 0.11;
const MAX_STEPS = 8000;
export const SPEED_MIN = 7, SPEED_MAX = 30;

/* ---------- seeded rng (same pair as PEEKED, pinned) ---------- */
export function xmur3(str){
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++){
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function(){
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
export function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- course ---------- */
export function courseFor(seed){
  const rng = mulberry32(xmur3("oneflick-v1-" + seed)());
  const pillars = [];
  const want = 7 + Math.floor(rng() * 4);
  let guard = 0;
  while (pillars.length < want && guard++ < 600){
    const r = 0.7 + rng() * 1.05;
    const hx = ARENA.w/2 - 2.3, hz = ARENA.d/2 - 2.6;
    const x = -hx + rng() * hx * 2;
    const z = -hz + rng() * (hz + 11);
    // keep the launch corridor clear
    const dxs = x - START.x, dzs = z - START.z;
    if (dxs*dxs + dzs*dzs < 25) continue;
    let clash = false;
    for (const p of pillars){
      const dx = p.x - x, dz = p.z - z;
      if (dx*dx + dz*dz < (p.r + r + 1.6) * (p.r + r + 1.6)){ clash = true; break; }
    }
    if (!clash) pillars.push({ x, z, r });
  }
  return { seed, pillars };
}

/* ---------- simulation ----------
   Returns the full path so the renderer can animate it, plus where it stopped. */
export function simulate(course, dirX, dirZ, speed){
  let x = START.x, z = START.z;
  let vx = dirX * speed, vz = dirZ * speed;
  const path = [{ x, z }];
  const hw = ARENA.w / 2 - BALL_R, hd = ARENA.d / 2 - BALL_R;
  let bounces = 0;

  for (let step = 0; step < MAX_STEPS; step++){
    const sp = Math.sqrt(vx*vx + vz*vz);
    if (sp < STOP_SPEED) break;
    // rolling friction opposes motion
    const drop = DECEL * DT;
    const ns = sp - drop <= 0 ? 0 : sp - drop;
    const k = ns / sp;
    vx *= k; vz *= k;
    if (ns === 0) break;

    x += vx * DT; z += vz * DT;

    if (x < -hw){ x = -hw; vx = -vx * REST_WALL; bounces++; }
    else if (x > hw){ x = hw; vx = -vx * REST_WALL; bounces++; }
    if (z < -hd){ z = -hd; vz = -vz * REST_WALL; bounces++; }
    else if (z > hd){ z = hd; vz = -vz * REST_WALL; bounces++; }

    for (const p of course.pillars){
      const dx = x - p.x, dz = z - p.z;
      const rr = p.r + BALL_R;
      const d2 = dx*dx + dz*dz;
      if (d2 < rr*rr && d2 > 0){
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        x = p.x + nx * rr; z = p.z + nz * rr;
        const dot = vx*nx + vz*nz;
        vx = (vx - 2*dot*nx) * REST_PILLAR;
        vz = (vz - 2*dot*nz) * REST_PILLAR;
        bounces++;
      }
    }
    if (step % 3 === 0) path.push({ x, z });
  }
  path.push({ x, z });
  return { x, z, path, bounces };
}

export function dist(ax, az, bx, bz){
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx*dx + dz*dz);
}

/* ---------- quantisation ---------- */
const B36 = (n, w) => Math.max(0, Math.min(Math.pow(36,w)-1, n|0)).toString(36).padStart(w,"0");
export const qPos   = v => B36(Math.round((v + 40) * 400), 3);
export const uqPos  = s => parseInt(s,36) / 400 - 40;
export const qAng   = a => B36(Math.round(a / (Math.PI*2) * 46656) % 46656, 3);
export const uqAng  = s => parseInt(s,36) / 46656 * Math.PI * 2;
export const qPow   = p => B36(Math.round(p * 1295), 2);
export const uqPow  = s => parseInt(s,36) / 1295;
export const powerToSpeed = p => SPEED_MIN + p * (SPEED_MAX - SPEED_MIN);

export function cleanName(s){
  return (s||"").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,12);
}

/* ---------- url state ----------
   #s={seed}&t={targetXZ}&c={name.AAAPPXXXZZZ~...}&k={checksum}
   Each entry keeps the shot (angle+power) so the ghost can be re-flown, and the
   resting position so the score never depends on cross-device float agreement. */
export function checksum(s, t, c){
  return (xmur3(s + "|" + t + "|" + c)() % 1296).toString(36).padStart(2,"0");
}
export function encodeEntry(e){
  return e.name + "." + qAng(e.angle) + qPow(e.power) + qPos(e.x) + qPos(e.z);
}
export function parseEntry(str){
  const i = str.lastIndexOf(".");
  if (i < 1) return null;
  const name = cleanName(str.slice(0, i)), p = str.slice(i + 1);
  if (!name || !/^[0-9a-z]{11}$/.test(p)) return null;
  return {
    name,
    angle: uqAng(p.slice(0,3)),
    power: uqPow(p.slice(3,5)),
    x: uqPos(p.slice(5,8)),
    z: uqPos(p.slice(8,11)),
  };
}
export function buildFragment(seed, target, chain){
  const s = seed.toString(36);
  const t = qPos(target.x) + qPos(target.z);
  const c = chain.map(encodeEntry).join("~");
  return "#s=" + s + "&t=" + t + "&c=" + c + "&k=" + checksum(s, t, c);
}
export function parseFragment(raw){
  const out = { seed:null, target:null, chain:[], tampered:false };
  if (!raw) return out;
  const q = {};
  for (const part of raw.replace(/^#/,"").split("&")){
    const i = part.indexOf("=");
    if (i > 0) q[part.slice(0,i)] = part.slice(i+1);
  }
  if (!q.s || !/^[0-9a-z]{6}$/.test(q.t || "")) return out;
  const seed = parseInt(q.s, 36);
  if (!Number.isFinite(seed)) return out;
  out.seed = seed;
  out.target = { x: uqPos(q.t.slice(0,3)), z: uqPos(q.t.slice(3,6)) };
  out.chain = (q.c || "") ? q.c.split("~").map(parseEntry).filter(Boolean) : [];
  out.tampered = (q.k || "") !== checksum(q.s, q.t, q.c || "");
  return out;
}
