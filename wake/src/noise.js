// Shared GLSL noise. Both the wake ribbon and the ocean surface need the same
// bubble texture — the ribbon for macro structure baked into the field, the
// ocean for the fine lace shaded per-pixel — and they have to agree, or the
// two scales of foam would look like different materials.

export const NOISE_GLSL = /* glsl */`
  float hash21(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }

  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
  }

  float fbm(vec2 p){
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; }
    return s / 0.9375;
  }

  float fbm3(vec2 p){
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++){ s += a*vnoise(p); p = p*2.07 + 11.3; a *= 0.5; }
    return s / 0.875;
  }

  // Sea foam is a bubble raft, not a cloud: open cells with bright walls
  // between them. Contours of a noise field give exactly that lattice, and it
  // is far cheaper than real Worley cells.
  float lattice(vec2 p, float w){
    float a = 1.0 - smoothstep(0.0, w,        abs(fbm(p)        - 0.50));
    float b = 1.0 - smoothstep(0.0, w * 0.86, abs(fbm(p * 2.17 + 41.3) - 0.47));
    return max(a, b * 0.85);
  }

  // Single-contour version for per-pixel work, where the second octave is not
  // worth its cost.
  float lattice1(vec2 p, float w){
    return 1.0 - smoothstep(0.0, w, abs(fbm3(p) - 0.50));
  }
`;
