export const meta = {
  slot: 'sky',
  id: 'single-scatter',
  title: 'Single-scatter atmosphere',
  author: 'swell',
  source: 'https://github.com/briangruber/experiments',
  license: 'MIT',
  parent: null,
  summary:
    'Uniform-medium single scattering: Rayleigh plus Henyey-Greenstein Mie, with a ' +
    'Kasten-Young air mass so the sun genuinely reddens as it sets rather than being ' +
    'tinted by hand. Overcast blends to a luminance-matched deck.',
};

// Knobs this variant adds on top of the core set.
export const knobs = {
  mieG: 0.76,          // forward-scattering asymmetry of the sun halo
  sunAngularSize: 1.2, // x the real 0.53 deg, for a slightly kinder disc
  groundAlbedo: 0.08,
};

export const schema = [
  ['mieG', 0, 0.95, 0.01, ''],
  ['sunAngularSize', 0.3, 6, 0.1, 'x'],
  ['groundAlbedo', 0, 0.5, 0.01, ''],
];

export const glsl = /* glsl */`
// Scattering coefficients at sea level, relative units tuned so that an
// overhead sun gives roughly unit transmittance.
const vec3 SW_BETA_R = vec3(0.190, 0.450, 1.100);
const vec3 SW_BETA_M = vec3(0.210);

float sw_rayleighPhase(float mu){ return 0.0596831 * (1.0 + mu * mu); }

float sw_miePhase(float mu, float g){
  float g2 = g * g;
  return 0.1193662 * (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5);
}

// Young's relative air mass: 1 at the zenith, ~38 at the horizon. The second
// term wants elevation in *degrees*, which is easy to get wrong and is the
// whole reason low sun goes orange rather than staying white.
float sw_airMass(float sinElev){
  float s = clamp(sinElev, -1.0, 1.0);
  float hDeg = degrees(asin(s));
  return 1.0 / (max(s, 0.008) + 0.15 * pow(max(hDeg + 3.885, 0.05), -1.253));
}

vec3 sw_extinction(float airMass){
  float T = uTurbidity;
  return exp(-(SW_BETA_R * 0.42 + SW_BETA_M * 0.06 * T) * airMass);
}

vec3 sw_sunRadiance(vec3 sunDir){
  vec3 trans = sw_extinction(sw_airMass(sunDir.y));
  // Below the horizon the disc is gone, but the sky keeps a little glow.
  float set = smoothstep(-0.06, 0.02, sunDir.y);
  return trans * 22.0 * uSunIntensity * set * (1.0 - 0.92 * uOvercast);
}

vec3 sw_skyInscatter(vec3 dir, vec3 sunDir){
  float mu = dot(dir, sunDir);
  float amView = sw_airMass(dir.y);
  vec3  sunTrans = sw_extinction(sw_airMass(sunDir.y));

  vec3 betaR = SW_BETA_R * 0.42;
  vec3 betaM = SW_BETA_M * 0.06 * uTurbidity;
  vec3 betaT = betaR + betaM;

  vec3 scatter = betaR * sw_rayleighPhase(mu) + betaM * sw_miePhase(mu, uMieG);
  // Closed-form integral of in-scattering through a uniform slab.
  vec3 depthTerm = (1.0 - exp(-betaT * amView)) / max(betaT, vec3(1e-4));
  vec3 col = scatter * depthTerm * sunTrans * 24.0 * uSunIntensity;

  // Multiple scattering, faked: keeps the zenith from going black and the
  // horizon from going neon at high turbidity.
  col += sunTrans * vec3(0.014, 0.024, 0.042) * uSunIntensity
         * (0.35 + 0.65 * sat(sunDir.y + 0.12)) * (1.0 + 0.6 * amView / 12.0);
  return col;
}

vec3 sw_sky(vec3 dir, vec3 sunDir){
  vec3 col = sw_skyInscatter(dir, sunDir);

  // Sun disc, softened at the limb.
  float cosSize = cos(radians(0.265 * uSunAngularSize));
  float mu = dot(dir, sunDir);
  float disc = smoothstep(cosSize, mix(cosSize, 1.0, 0.35), mu);
  col += sw_sunRadiance(sunDir) * disc * 42.0;

  // Below the horizon: dim ground bounce rather than a hard black band.
  float below = smoothstep(0.0, -0.05, dir.y);
  vec3 ground = sw_skyInscatter(vec3(dir.x, 0.02, dir.z), sunDir) * uGroundAlbedo * 2.2;
  col = mix(col, ground, below);

  // Storm deck: collapse to a grey dome that keeps the sky's own luminance.
  if (uOvercast > 0.001){
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 deck = vec3(lum) * mix(1.0, 0.62, sat(dir.y)) * vec3(0.96, 0.98, 1.02);
    col = mix(col, deck, uOvercast);
  }
  return max(col, vec3(0.0));
}

// Hemispherical ambient, sampled rather than integrated: cheap, and stable
// under the overcast blend above.
vec3 sw_skyAmbient(vec3 sunDir){
  vec3 a = sw_sky(vec3(0.0, 1.0, 0.0), sunDir);
  vec3 b = sw_sky(normalize(vec3(sunDir.x, 0.28, sunDir.z)), sunDir);
  vec3 c = sw_sky(normalize(vec3(-sunDir.x, 0.28, -sunDir.z)), sunDir);
  return (a * 0.5 + b * 0.3 + c * 0.2) * 2.4;
}
`;
