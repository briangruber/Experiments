# How it works

Why the sea looks the way it does. This is a map of the models, not a derivation —
each section says what is being computed and what would go wrong with the obvious
cheaper choice. The source comments carry the detail.

---

## The sea

### The spectrum

Wave energy comes from **JONSWAP** with **Kitaigorodskii** depth attenuation
(the TMA form), so fetch and water depth are real inputs rather than decoration.
Direction comes from **Donelan–Banner** spreading, `0.5·b·sech²(b·θ)`, which
narrows at the peak frequency and broadens in the tail — a sea whose short waves
run at the same angle as its swell reads as corduroy.

One subtlety worth knowing about: Hasselmann's fits for `α(χ)`, `ω_p(χ)` and the
significant-height relation are three independent regressions through the same
data and **they do not close**. Using them together leaves the spectrum's energy
disagreeing with the wave height it is supposed to produce. `oceanSim.js`
renormalises rather than pretending the inconsistency is not there.

### Cascades

The surface is four FFT patches at **3137 m, 397 m, 87 m and 17.3 m**. Those
sizes are deliberately non-commensurate: a patch tiles, and patch sizes with a
common factor put their seams in the same place, which is exactly the repeating
horizon that gives real-time water away. With no shared period the visible
repeat is pushed past the horizon.

Each cascade fades out at the distance where its texels drop well below a pixel.
The fade is wide — 0.55× to 1.6× — because a narrow one prints a horizontal seam
across the sea at the switching distance.

### Displacement

Vertical height plus horizontal **Lagrangian (choppy) displacement**, which is
what turns round swell into the sharp crests and broad troughs a real sea has.

The consequence to remember: the fields are indexed by the **undisplaced**
coordinate. The water at world point *p* is not the texture value at *p*.
Anything that needs the surface at a known world position — a hull, a probe, a
buoy — has to invert that, which the probe shader does by fixed-point iteration.
Skipping it puts the bow wave a metre or two off the boat and makes it slide
around as waves pass.

### Shading

- **Filtered slope variance → GGX roughness** (LEADR in spirit). Waves smaller
  than a pixel must become roughness rather than geometry, or the sea aliases
  into a sheet of crawling sparkle. The GGX lobe width is matched to a mip level
  so the transition is continuous.
- **Cox–Munk** mean-square slope: the sea's slope distribution is wider along the
  wind than across it, so the specular lobe is anisotropic. Mean-square slope
  grows roughly linearly with wind speed; the capillary cutoff carries the
  variance the cascades do not resolve.
- **Exact unpolarised dielectric Fresnel**, not Schlick. They agree at normal
  incidence and diverge where the sea spends most of its pixels — the grazing
  angles out towards the horizon.
- **Smith masking**, matched to the GGX distribution, anisotropic where the
  distribution is.
- **Subsurface scattering** through the wave body, driven by height above the
  trough and view/light geometry, which is what makes a backlit crest glow.

### Foam

Whitecap coverage follows **Monahan & O'Muircheartaigh**, `W = 3.84e-6·U₁₀^3.41`
— steeply enough in wind speed that force 4 and force 8 are visibly different
seas. Below about force 3 a real sea has no whitecaps at all, which the raw law
does not give you, so it is floored.

Foam is two populations, not one: fresh crest foam that is optically thick, and
the thinning raft it decays into, which is a Beer–Lambert veil in its own
thickness with the sea showing through. Painting aged foam as opaque white is the
single most common thing that makes CG water look like a bath.

---

## The sky

### Atmosphere

Rayleigh and Mie scattering with an ozone layer, integrated by raymarch. Multiple
scattering is an energy series rather than another integral — the second and later
orders are the reason a clear zenith is blue rather than black, and blue scatters
about five times more than red, so the series converges at a different rate per
channel.

The whole thing is evaluated into a **512×256 lat-long lookup table** which is
rebuilt only when the sun, the air composition or the eye height actually change.
It does not depend on where you are looking, so rebuilding it per frame was pure
waste. The water samples the same table for its reflections, which is what keeps
the sea and the sky the same colour.

### Clouds

Volumetric, marched on **spherical shells** rather than a flat slab, so clouds
lie down towards the horizon the way they do over an ocean.

- A 2D **weather field** carries coverage and cloud type; a vertical profile
  turns type into a density envelope.
- The high-frequency **detail band is gated on step length**, so it is not paying
  for erosion detail the march cannot resolve.
- Lighting is a short **cone march** towards the sun, plus **multiple-scattering
  octaves** — each order dimmer, broader and more isotropic — closed with an
  analytic tail. Without them a cloud's shadow side is black instead of blue-grey.
- **Powder** darkens the approach to a lit surface, where a single scattering
  event is unlikely. **Silver lining** is what the isotropic octaves put on a
  backlit edge.
- Bayer 4×4 dithering on the march offset, so the step pattern becomes noise
  rather than banding.

---

## The wake

A wake is a **record**, not a fluid. The obvious approach — advect a field
semi-Lagrangian, decay it — was tried and thrown away: at the speeds involved the
field moves a fraction of a texel per frame, so the bilinear fetch is pure
numerical diffusion and the wake dissolves into a smudge in a couple of seconds.

Instead the field stores, per texel, *when* the water there was stirred, how hard,
and how far off the track it was. The **Kelvin** pattern — arms at the classical
19.47° half-angle — is then reconstructed analytically from that record at sample
time. Age drives decay, so a circle you drove a minute ago is still there, still
the right shape.

---

## Performance shape

Measured by ablation on a riding frame, largest first:

1. **Volumetric cloud march** — about a fifth of the frame.
2. **Spray draw** — overlapping translucent billboards, so pure fill.
3. **Water grid** — at full quality 400×640, a quarter of a million vertices with
   four cascade fetches each. On a phone this is often vertex binding cost rather
   than fill, which is why trimming resolution alone cannot fix it.

The demo's adaptive controller spends those in that order: render scale first
(it touches everything at once), then cloud steps, then grid density. Quality is
given back in reverse — cheapest first — so headroom is not immediately respent.

Capping frame rate has to **skip frames**, not lower quality. Quality knobs trade
picture for frame rate, and neither is what makes a laptop hot; only doing less
work per second is.

---

## Reading the source

| file | what is in it |
| --- | --- |
| `src/shaders/oceanSim.js` | spectrum, FFT butterflies, displacement assembly, foam accumulation |
| `src/shaders/water.js` | the surface BRDF — Fresnel, GGX, SSS, foam, aerial perspective |
| `src/shaders/sky.js` | atmosphere integral, LUT, cloud raymarch |
| `src/ocean.js` | cascade setup, spectrum rebuild, per-frame simulation passes |
| `src/wake.js` | the age-record wake field and the GLSL to sample it |
