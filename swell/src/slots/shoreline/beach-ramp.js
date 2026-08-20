export const meta = {
  slot: 'shoreline',
  id: 'beach-ramp',
  title: 'Linear beach with sandbars',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'A planar beach running along +Z, softened onto the deep floor with a softplus so ' +
    'there is no crease at the shelf break. Two sandbars and a low-frequency lateral ' +
    'wander keep the break line from being a straight edge.',
};

export const knobs = {
  sandbarHeight: 1.1,   // m of relief on the offshore bars
  sandbarSpacing: 95.0, // m between bars
  shoreWander: 22.0,    // m of lateral meander in the waterline
};

export const schema = [
  ['sandbarHeight', 0, 4, 0.05, 'm'],
  ['sandbarSpacing', 20, 400, 1, 'm'],
  ['shoreWander', 0, 120, 1, 'm'],
];

export const glsl = /* glsl */`
// Smooth floor clamp. Without this the shelf break reads as a hard crease in
// every shallow-water term downstream.
float sw_softFloor(float x, float floorY, float k){
  float a = (x - floorY) * k;
  return floorY + (a > 24.0 ? (x - floorY) : log(1.0 + exp(a)) / k);
}

float sw_seabedHeight(vec2 p){
  if (uShoreEnabled < 0.5) return -uSeaFloorDepth;

  // The waterline meanders instead of running dead straight.
  float wander = (sw_fbm(vec2(p.x * 0.0016, 11.7), 3) - 0.5) * 2.0 * uShoreWander;
  float d = p.y - (uShoreZ + wander);   // + is shoreward

  float h = d * uBeachSlope;

  // Offshore bars: crests parallel to the beach, fading out in deep water.
  float bars = sin(d * (6.2831853 / max(uSandbarSpacing, 1.0)))
             * uSandbarHeight * exp(-max(-d, 0.0) * 0.0035);
  h += bars * smoothstep(0.0, -30.0, d);

  // Texture on the bed so shallow water is not glassy-flat.
  h += (sw_fbm(p * 0.012, 3) - 0.5) * 0.9 * smoothstep(-400.0, -20.0, d);

  return sw_softFloor(h, -uSeaFloorDepth, 0.05);
}

// Still-water level is y = 0, so depth is just the negated bed. Values <= 0
// are dry sand.
float sw_waterDepth(vec2 p){
  return -sw_seabedHeight(p);
}
`;
