// The floor of the sea, as one function.
//
// Port Kelder sits in a lagoon: a shallow sand shelf, a reef that almost
// breaks the surface, and then a drop-off into water that never gets its
// bottom back. That profile is the whole emotional arc of the game -- you can
// see every grain of sand by the docks, and you cannot see anything at all
// where the big ones live -- so it lives here, shared by the mesh that draws it
// and the water shader that decides how much of it you can see through.

export const LAGOON = {
  shore: 96,      // where the island meets the water
  flat: 168,      // sandy lagoon floor
  reef: 232,      // the reef crest, nearly awash
  brink: 296,     // the lip of the drop-off
  deep: 460,      // by here the light is gone
  floor: -155,    // nominal depth of the open sea
};

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return (
    hash(ix, iy) * (1 - ux) * (1 - uy) +
    hash(ix + 1, iy) * ux * (1 - uy) +
    hash(ix, iy + 1) * (1 - ux) * uy +
    hash(ix + 1, iy + 1) * ux * uy
  );
}

const smooth = (a, b, t) => {
  const c = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return c * c * (3 - 2 * c);
};

/** Height of the sea floor at a world position. Above water near the island. */
export function seabedHeight(x, z) {
  const r = Math.hypot(x, z);

  // Base profile by distance from the island.
  let y;
  if (r < LAGOON.flat) {
    // Sand shelving gently away from the beach.
    y = -0.6 - smooth(LAGOON.shore, LAGOON.flat, r) * 4.2;
  } else if (r < LAGOON.reef) {
    // Lagoon floor, then the reef rising back toward the light.
    const t = smooth(LAGOON.flat, LAGOON.reef, r);
    y = -4.8 - 2.2 * Math.sin(t * Math.PI) + t * 3.4;
  } else if (r < LAGOON.brink) {
    // Over the reef and onto the brink.
    const t = smooth(LAGOON.reef, LAGOON.brink, r);
    y = -1.4 - t * t * 22;
  } else {
    // The drop. Steep, then endless.
    const t = smooth(LAGOON.brink, LAGOON.deep, r);
    y = -23 - Math.pow(t, 1.5) * (Math.abs(LAGOON.floor) - 23);
  }

  // Sand ripples in the shallows, boulders and coral heads on the reef.
  const shallow = 1 - smooth(LAGOON.reef, LAGOON.brink, r);
  y += (noise2(x * 0.09, z * 0.09) - 0.5) * 1.1 * shallow;
  y += (noise2(x * 0.31, z * 0.31) - 0.5) * 0.35 * shallow;
  const heads = Math.pow(noise2(x * 0.055 + 11, z * 0.055 - 7), 3);
  y += heads * 5.2 * smooth(LAGOON.flat - 40, LAGOON.reef, r) * shallow;

  return y;
}

/** How far below the still-water line the floor sits. Always >= 0. */
export function seaDepth(x, z) {
  return Math.max(0, -seabedHeight(x, z));
}

/** GLSL twin of seabedHeight(), so the water shades against the real floor. */
export function seabedGLSL() {
  return /* glsl */`
const float LAGOON_SHORE = ${f(LAGOON.shore)};
const float LAGOON_FLAT  = ${f(LAGOON.flat)};
const float LAGOON_REEF  = ${f(LAGOON.reef)};
const float LAGOON_BRINK = ${f(LAGOON.brink)};
const float LAGOON_DEEP  = ${f(LAGOON.deep)};
const float LAGOON_FLOOR = ${f(LAGOON.floor)};

float bedHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bedNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bedHash(i), bedHash(i + vec2(1, 0)), f.x),
             mix(bedHash(i + vec2(0, 1)), bedHash(i + vec2(1, 1)), f.x), f.y);
}

float seabedHeight(vec2 p) {
  float r = length(p);
  float y;
  if (r < LAGOON_FLAT) {
    y = -0.6 - smoothstep(LAGOON_SHORE, LAGOON_FLAT, r) * 4.2;
  } else if (r < LAGOON_REEF) {
    float t = smoothstep(LAGOON_FLAT, LAGOON_REEF, r);
    y = -4.8 - 2.2 * sin(t * 3.14159265) + t * 3.4;
  } else if (r < LAGOON_BRINK) {
    float t = smoothstep(LAGOON_REEF, LAGOON_BRINK, r);
    y = -1.4 - t * t * 22.0;
  } else {
    float t = smoothstep(LAGOON_BRINK, LAGOON_DEEP, r);
    y = -23.0 - pow(t, 1.5) * (abs(LAGOON_FLOOR) - 23.0);
  }
  float shallow = 1.0 - smoothstep(LAGOON_REEF, LAGOON_BRINK, r);
  y += (bedNoise(p * 0.09) - 0.5) * 1.1 * shallow;
  y += (bedNoise(p * 0.31) - 0.5) * 0.35 * shallow;
  float heads = pow(bedNoise(p * 0.055 + vec2(11.0, -7.0)), 3.0);
  y += heads * 5.2 * smoothstep(LAGOON_FLAT - 40.0, LAGOON_REEF, r) * shallow;
  return y;
}`;
}

function f(v) {
  const s = Number(v).toFixed(4);
  return s.includes('.') ? s : s + '.0';
}
