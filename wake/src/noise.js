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

  // Expanding ring ripples.
  //
  // Space is divided into cells, each hosting one emitter at a jittered
  // position that fires, spreads and dies on its own offset schedule. A point
  // is pushed radially outward as each wavefront sweeps past it, so the whole
  // field is made of rings going out from scattered origins — which is what
  // churning water actually does as bubbles burst and eddies surface.
  //
  // Returns a displacement in metres. Purely local: every emitter's push
  // returns to zero once its ring has passed and died, so nothing accumulates
  // and the foam never drifts.
  vec2 ringWarp(vec2 p, float t, float cell, float speed, float width, float expand){
    vec2 gi = floor(p / cell);
    vec2 acc = vec2(0.0);
    for (int y = -1; y <= 1; y++){
      for (int x = -1; x <= 1; x++){
        vec2 c = gi + vec2(float(x), float(y));
        float h1 = hash21(c);
        float h2 = hash21(c + 17.3);
        vec2  e  = (c + vec2(h1, h2)) * cell;      // emitter, jittered in its cell
        vec2  d  = p - e;
        float r  = length(d) + 1e-4;

        // Each emitter runs its own cycle, at its own slightly different rate.
        float ph = fract(t * speed * (0.72 + 0.56 * h1) + h2);
        float radius = ph * cell * 1.45;

        // The wavefront profile is two-lobed -- a crest with a trough behind
        // it, the derivative of a gaussian. Water in a passing ripple moves
        // out and then back, so a one-sided push reads as a shove rather than
        // as a wave. It also gives the ring a light and a dark side, which is
        // what makes it legible in the shading.
        float front = (r - radius) / max(width, 0.02);
        float prof = front * exp(-front * front) * 1.65;

        // Fades in at birth so nothing pops, then decays as the ring spreads
        // and its energy thins around a longer and longer circumference.
        float env = smoothstep(0.0, 0.08, ph) * (1.0 - ph);
        acc += (d / r) * prof * env;

        // Expansion. Scaling the pattern about a centre is a displacement
        // proportional to DISTANCE from that centre -- so this term grows the
        // cells inside the ring rather than just shoving them around, which a
        // wavefront bump alone can only ever do.
        float inside = 1.0 - smoothstep(radius * 0.70, radius * 1.20, r);
        acc += d * expand * inside * env;
      }
    }
    return acc;
  }

  // Single-contour version for per-pixel work, where the second octave is not
  // worth its cost.
  float lattice1(vec2 p, float w){
    return 1.0 - smoothstep(0.0, w, abs(fbm3(p) - 0.50));
  }
`;
