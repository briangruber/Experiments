// Lagoon floor profile: clear sand near town, reef, then deep blue.

export const LAGOON = {
  shore: 90,
  flat: 160,
  reef: 220,
  brink: 290,
  deep: 440,
  floor: -140,
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

export function seabedHeight(x, z) {
  const r = Math.hypot(x, z - 20);
  let y;
  if (r < LAGOON.flat) {
    y = -0.5 - smooth(LAGOON.shore, LAGOON.flat, r) * 3.8;
  } else if (r < LAGOON.reef) {
    const t = smooth(LAGOON.flat, LAGOON.reef, r);
    y = -4.2 - 2.0 * Math.sin(t * Math.PI) + t * 3.0;
  } else if (r < LAGOON.brink) {
    const t = smooth(LAGOON.reef, LAGOON.brink, r);
    y = -1.2 - t * t * 20;
  } else {
    const t = smooth(LAGOON.brink, LAGOON.deep, r);
    y = -21 - Math.pow(t, 1.5) * (Math.abs(LAGOON.floor) - 21);
  }
  const shallow = 1 - smooth(LAGOON.reef, LAGOON.brink, r);
  y += (noise2(x * 0.09, z * 0.09) - 0.5) * 1.0 * shallow;
  y += (noise2(x * 0.31, z * 0.31) - 0.5) * 0.32 * shallow;
  const heads = Math.pow(noise2(x * 0.055 + 11, z * 0.055 - 7), 3);
  y += heads * 4.8 * smooth(LAGOON.flat - 40, LAGOON.reef, r) * shallow;
  return y;
}

function f(v) {
  const s = Number(v).toFixed(4);
  return s.includes('.') ? s : `${s}.0`;
}

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
  float r = length(p - vec2(0.0, 20.0));
  float y;
  if (r < LAGOON_FLAT) {
    y = -0.5 - smoothstep(LAGOON_SHORE, LAGOON_FLAT, r) * 3.8;
  } else if (r < LAGOON_REEF) {
    float t = smoothstep(LAGOON_FLAT, LAGOON_REEF, r);
    y = -4.2 - 2.0 * sin(t * 3.14159265) + t * 3.0;
  } else if (r < LAGOON_BRINK) {
    float t = smoothstep(LAGOON_REEF, LAGOON_BRINK, r);
    y = -1.2 - t * t * 20.0;
  } else {
    float t = smoothstep(LAGOON_BRINK, LAGOON_DEEP, r);
    y = -21.0 - pow(t, 1.5) * (abs(LAGOON_FLOOR) - 21.0);
  }
  float shallow = 1.0 - smoothstep(LAGOON_REEF, LAGOON_BRINK, r);
  y += (bedNoise(p * 0.09) - 0.5) * 1.0 * shallow;
  y += (bedNoise(p * 0.31) - 0.5) * 0.32 * shallow;
  float heads = pow(bedNoise(p * 0.055 + vec2(11.0, -7.0)), 3.0);
  y += heads * 4.8 * smoothstep(LAGOON_FLAT - 40.0, LAGOON_REEF, r) * shallow;
  return y;
}`;
}
