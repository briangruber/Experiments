export const meta = {
  slot: 'water',
  id: 'absorb-sss',
  title: 'Absorption and subsurface',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'Fresnel-weighted sky reflection with a GGX sun glitter, Beer-Lambert absorption ' +
    'along the real refracted path to the seabed, and a backlit subsurface term keyed ' +
    'to crest height so wave faces glow when the sun is behind them.',
};

export const knobs = {
  sssPower: 3.4,      // tightness of the backlit lobe
  sssHeight: 1.4,     // crest height, m, at which subsurface glow saturates
  reflectBlur: 0.55,  // how much roughness smears the reflected sky
  glitter: 1.0,       // gain on the sun path
};

export const schema = [
  ['sssPower', 1, 12, 0.1, ''],
  ['sssHeight', 0.2, 6, 0.05, 'm'],
  ['reflectBlur', 0, 2, 0.01, 'x'],
  ['glitter', 0, 3, 0.01, 'x'],
];

export const glsl = /* glsl */`
// GGX, isotropic, with the height-correlated Smith term. Nothing exotic; it is
// here so every water variant can be compared against the same specular.
float sw_ggx(vec3 N, vec3 V, vec3 L, float rough){
  float a = max(rough * rough, 1e-4);
  vec3 H = normalize(L + V);
  float NoH = sat(dot(N, H));
  float NoV = clamp(dot(N, V), 1e-4, 1.0);
  float NoL = sat(dot(N, L));
  float d = NoH * NoH * (a * a - 1.0) + 1.0;
  float D = (a * a) / (SW_PI * d * d + 1e-8);
  float k = a * 0.5;
  float G = 0.5 / max(mix(2.0 * NoL * NoV, NoL + NoV, k), 1e-5);
  return D * G * NoL;
}

vec3 sw_seabedAlbedo(vec2 p){
  float grain = sw_fbm(p * 0.35, 3) * 0.22 + sw_fbm(p * 0.04, 3) * 0.18;
  return uSandColor * (0.82 + grain);
}

vec3 sw_waterShade(Surf s){
  float NoV = clamp(dot(s.N, s.V), 1e-4, 1.0);
  // The wave trains this pixel could not resolve are still there; they arrive
  // as roughness. Without this the distant sea turns to glass and the sun path
  // collapses to a dot.
  float rough = sqrt(uRoughness * uRoughness + s.w.subRough * s.w.subRough);
  float F = sw_fresnel(NoV, 0.02);

  // --- reflection ----------------------------------------------------------
  vec3 R = reflect(-s.V, s.N);
  // A reflected ray that points into the sea would sample the ground lobe of
  // the sky; bend it back to grazing instead, which is what a real wave in
  // front of it would have shown.
  R.y = abs(R.y) * 0.55 + R.y * 0.45;
  R = normalize(mix(R, normalize(vec3(R.x, max(R.y, 0.02), R.z)), 0.85));
  vec3 blurDir = normalize(mix(R, vec3(0.0, 1.0, 0.0), rough * uReflectBlur * 2.2));
  // Disc-free: the GGX lobe below is already the sun. Sampling the disc here as
  // well paints a second, blurry sun onto the water.
  vec3 refl = sw_skyNoSun(blurDir, s.L);

  // --- transmission --------------------------------------------------------
  // Real refracted path length, not the vertical depth: at grazing angles the
  // light has much further to go, which is why distant shallows still read deep.
  vec3 T = refract(-s.V, s.N, 1.0 / 1.333);
  float down = max(-T.y, 0.08);
  float path = min(s.depth / down, 90.0);

  vec3 sigma = vec3(uAbsorption) * (vec3(2.9, 1.0, 0.72));  // red dies first
  vec3 trans = exp(-sigma * path);

  vec3 body;
  if (uShoreEnabled > 0.5 && s.depth < 60.0){
    vec2 bp = s.P.xz + T.xz * (path * uRefract);
    vec3 sand = sw_seabedAlbedo(bp);
    float bedLight = sat(0.35 + 0.65 * sat(s.L.y));
    vec3 bed = sand * (s.sunRad * bedLight * 0.09 + s.skyRad * 0.05);
    body = bed * trans;
  } else {
    body = uWaterDeep * (s.skyRad * 0.055 + s.sunRad * 0.012);
  }

  // In-scattered light inside the volume: this is the colour of the water
  // itself rather than of whatever is under it.
  vec3 inScatter = uWaterShallow * (1.0 - trans)
                 * (s.skyRad * 0.06 + s.sunRad * 0.028 * sat(s.L.y + 0.25));
  body += inScatter;

  // --- subsurface ----------------------------------------------------------
  // A crest with the sun behind it glows. Key it to height above the mean
  // surface so it happens on wave faces and nowhere else.
  float lift = sat(s.w.disp.y / max(uSssHeight, 0.05));
  float back = pow(sat(dot(s.V, -s.L)), uSssPower);
  float rim = sat(1.0 - NoV);
  vec3 sss = uWaterShallow * s.sunRad * back * lift * (0.25 + 0.75 * rim)
           * uScatter * 0.11;
  body += sss;

  // --- combine -------------------------------------------------------------
  vec3 col = mix(body, refl, F);
  col += s.sunRad * sw_ggx(s.N, s.V, s.L, max(rough, 0.008))
       * F * uSpecular * uGlitter;
  return col;
}
`;
