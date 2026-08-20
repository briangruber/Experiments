export const meta = {
  slot: 'foam',
  id: 'bubble-raft',
  title: 'Bubble raft',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'Whitecaps as an optically thick bubble raft rather than white paint: measured ' +
    'reflectance near 0.3-0.8 depending on age, wrapped diffuse for the porous surface, ' +
    'forward scatter through the thin trailing veil, and a relief normal so a raft close ' +
    'to camera is not a flat smear.',
};

export const knobs = {
  foamRelief: 0.9,      // strength of the bubble-scale normal perturbation
  foamSheen: 0.35,      // wet specular sheen on top of the raft
  foamWrap: 0.45,       // diffuse wrap; a raft is lit round its own shoulder
  foamVeilAlbedo: 0.26, // reflectance of the old dissipating raft
};

export const schema = [
  ['foamRelief', 0, 3, 0.01, 'x'],
  ['foamSheen', 0, 1.5, 0.01, 'x'],
  ['foamWrap', 0, 1, 0.01, ''],
  ['foamVeilAlbedo', 0.05, 0.6, 0.005, ''],
];

export const glsl = /* glsl */`
vec3 sw_foamShade(Surf s, float coverage, float fresh){
  // Relief. Bubbles are millimetres across, so this has to fade with distance
  // or it turns into sparkle noise on the horizon.
  float relief = uFoamRelief * (0.35 + 0.85 * fresh) / (1.0 + s.dist * 0.02);
  vec2 q = s.P.xz * 3.1;
  float e = 0.35;
  float n0 = sw_fbm(q, 3);
  vec2 grad = vec2(sw_fbm(q + vec2(e, 0.0), 3) - n0,
                   sw_fbm(q + vec2(0.0, e), 3) - n0) / e;
  vec3 N = normalize(s.N + vec3(-grad.x, 0.0, -grad.y) * relief * 0.55);
  N = normalize(mix(N, s.N, 0.15));

  float NoL = dot(N, s.L);
  float NoV = clamp(dot(N, s.V), 1e-4, 1.0);

  // Fresh crest foam is an optically thick raft; the veil it decays into is
  // much darker than the eye expects, and getting this wrong is most of why
  // bad whitecaps read as chalk dust.
  float albedo = mix(uFoamVeilAlbedo, 0.80, fresh) * uFoamBrightness;

  // Wrapped diffuse: light crawls round the shoulder of a porous raft.
  float wrap = uFoamWrap;
  float diff = sat((NoL + wrap) / (1.0 + wrap));

  vec3 E = s.skyRad * (0.55 + 0.45 * sat(N.y)) + s.sunRad * diff;
  vec3 lit = uFoamColor * albedo * E * (1.0 / SW_PI);

  // Forward scatter through the thin veil when the sun is behind it.
  float fwd = pow(sat(dot(s.V, -s.L)), 3.0) * (1.0 - fresh);
  lit += uFoamColor * s.sunRad * fwd * (1.0 - albedo) * (0.42 / SW_PI);

  // A wet raft still has a sheen, but nothing like open water's glitter.
  float a = max(uFoamRoughness * uFoamRoughness, 0.004);
  vec3 H = normalize(s.L + s.V);
  float NoH = sat(dot(N, H));
  float d = (NoH * NoH * (a * a - 1.0) + 1.0);
  float spec = (a * a) / (SW_PI * d * d + 1e-6);
  lit += s.sunRad * spec * uFoamSheen * 0.045 * sat(NoL);

  return lit;
}
`;
