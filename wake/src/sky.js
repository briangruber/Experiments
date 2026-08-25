// One sky, shared.
//
// The detailed ocean and the far water both reflect the sky, and if they
// reflect *different* skies the join between them shows up as a bright square
// sitting in a darker sea. So the gradient, the clouds, the treeline and the
// tonemap all live here, and both import them.
//
// The water gets the shore and the clouds for free: reflections sample this
// same function, and a near-horizontal reflection looks straight at the
// treeline, which is exactly what puts a dark shore in the water.
//
// Requires: uHorizon, uZenith, uSky, uSunDir, uSunGlow, uExposure,
//           uSunset, uSkyWarm, uCloud, uCloudScale, uCloudSoft,
//           uTree, uTreeHt, uTreeRough, uTime.

export const SKY_GLSL = /* glsl */`
  float skHash(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }
  float skNoise(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(skHash(i), skHash(i+vec2(1,0)), f.x),
               mix(skHash(i+vec2(0,1)), skHash(i+vec2(1,1)), f.x), f.y);
  }
  float skFbm(vec2 p){
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++){ s += a*skNoise(p); p = p*2.06 + 13.7; a *= 0.5; }
    return s / 0.969;
  }

  vec3 skyColour(vec3 dir){
    vec3 d = normalize(dir);
    float h = clamp(d.y, 0.0, 1.0);

    // Base gradient: pale at the horizon, deepening overhead.
    vec3 c = mix(uHorizon, uZenith, pow(h, 0.42));

    // A low sun spreads a warm band along the horizon, strongest towards its
    // own bearing and fading with height. This is what turns the same gradient
    // into a sunset without a second set of colours to keep in sync.
    float toward = max(dot(normalize(d.xz + 1e-5), normalize(uSunDir.xz + 1e-5)), 0.0);
    float low = 1.0 - smoothstep(0.02, 0.42, uSunDir.y);
    float band = pow(1.0 - h, 8.0) * mix(0.20, 1.0, pow(toward, 2.2));
    c = mix(c, uSunset, clamp(band * low * uSkyWarm, 0.0, 1.0));

    // Clouds, projected onto a plane overhead so they foreshorten towards the
    // horizon the way real cloud decks do.
    if (uCloud > 0.001 && d.y > 0.005) {
      vec2 cp = d.xz / max(d.y, 0.05) * uCloudScale + uTime * 0.004;
      float n = skFbm(cp);
      float cover = smoothstep(1.0 - uCloud, 1.0 - uCloud + uCloudSoft, n);
      cover *= smoothstep(0.0, 0.10, d.y);          // no cloud at the very horizon
      // Underlit: cloud bases catch the low sun and go warm, tops stay cold.
      vec3 lit = mix(uZenith * 1.5 + 0.02, uSunset, low * uSkyWarm * 0.75 * toward);
      c = mix(c, lit, cover * 0.85);
    }

    // Sun: broad haze plus a small disc, never a hard circle.
    float s = max(dot(d, normalize(uSunDir)), 0.0);
    c += uSunset * pow(s, 5.0) * uSunGlow * mix(0.35, 1.0, low) * 0.6;
    c += uSky * pow(s, 900.0) * uSunGlow * 6.0;

    // Treeline: a dark shore standing just above the waterline. Its profile is
    // noise on the bearing, so it reads as trees rather than as a ruled band.
    if (uTreeHt > 0.0001) {
      float bearing = atan(d.z, d.x);
      float ridge = uTreeHt * (0.55 + uTreeRough * skFbm(vec2(bearing * 9.0, 0.0))
                                    + uTreeRough * 0.4 * skFbm(vec2(bearing * 31.0, 5.0)));
      // Fills everything below the ridge, including well under the horizon:
      // the far water is drawn over that part anyway, and cutting it off at the
      // waterline leaves a bright seam between the shore and its reflection.
      float tree = 1.0 - smoothstep(ridge - uTreeHt * 0.06, ridge + uTreeHt * 0.06, d.y);
      c = mix(c, uTree, tree);
    }

    return c;
  }

  vec3 tonemap(vec3 c){
    c *= uExposure;
    c = c / (c + 0.72);
    return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
  }
`;
