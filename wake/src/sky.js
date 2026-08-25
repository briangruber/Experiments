// One sky, shared.
//
// The detailed ocean and the far water both reflect the sky, and if they
// reflect *different* skies the join between them shows up as a bright square
// sitting in a darker sea. So the gradient and the tonemap live here and both
// import them, rather than each carrying its own version.
//
// Requires: uHorizon, uZenith, uSky, uSunDir, uSunGlow, uExposure.

export const SKY_GLSL = /* glsl */`
  vec3 skyColour(vec3 dir){
    float h = clamp(dir.y, 0.0, 1.0);
    // Pale at the horizon, deepening overhead. A flat fill reads as paper;
    // this is most of what makes a sky read as distance.
    vec3 c = mix(uHorizon, uZenith, pow(h, 0.42));
    float s = max(dot(normalize(dir), normalize(uSunDir)), 0.0);
    c += uSky * pow(s, 6.0) * uSunGlow * 0.5;
    c += uSky * pow(s, 900.0) * uSunGlow * 6.0;
    return c;
  }

  vec3 tonemap(vec3 c){
    c *= uExposure;
    c = c / (c + 0.72);
    return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
  }
`;
