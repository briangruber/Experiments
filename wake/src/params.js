// Every tunable in one place. `ui.js` builds the panel from this, the shaders
// read it as uniforms, and "Copy params" on the panel dumps the current values
// as JSON so a tuning session can be pasted straight back into a conversation.
//
// min/max/step are for the slider; `v` is the live value.

export const PARAMS = {
  boat: {
    speed:        { v: 13, min: 0,   max: 100,  step: 0.1,  label: 'Speed (m/s)' },
    turnRate:     { v: 0,  min: -25, max: 25,  step: 0.5,  label: 'Turn (°/s)' },
    accel:        { v: 5.3, min: 0.1, max: 12,  step: 0.05, label: 'Acceleration (m/s²)' },
    steerRate:    { v: 26, min: 2,   max: 90,  step: 1,    label: 'Steer rate (°/s)' },
    hardTurn:     { v: 2.4, min: 1,   max: 5,   step: 0.05, label: 'Shift turn ×' },
    throttleRate: { v: 7, min: 0.5, max: 30,  step: 0.5,  label: 'Throttle rate (m/s²)' },
    humpFroude:   { v: 0.95, min: 0.3, max: 2,   step: 0.01, label: 'Hump Froude no.' },
    trimRest:     { v: 1.2,  min: 0,   max: 6,   step: 0.1,  label: 'Bow-down at rest (°)' },
    trimHump:     { v: 5.5,  min: 0,   max: 15,  step: 0.1,  label: 'Trim at hump (°)' },
    trimPlane:    { v: 2.6,  min: 0,   max: 12,  step: 0.1,  label: 'Trim on plane (°)' },
    riseMax:      { v: 0.42, min: 0,   max: 2,   step: 0.01, label: 'Hull rise (m)' },
    wetShift:     { v: 0.52, min: 0,   max: 0.9, step: 0.01, label: 'Contact point aft' },
    planing:      { v: 6.5, min: 0.5, max: 20,  step: 0.1,  label: 'Planing speed (m/s)' },
    length:       { v: 9.9,  min: 3,   max: 20,  step: 0.1,  label: 'Hull length (m)' },
    beam:         { v: 2.65,  min: 1,   max: 8,   step: 0.05, label: 'Hull beam (m)' },
    engines:      { v: 2,    min: 1,   max: 4,   step: 1,    label: 'Engines' },
    engineSpacing:{ v: 2.4, min: 0.2, max: 4,   step: 0.05, label: 'Engine spacing (m)' },
  },

  // The V of spray sheets. In the reference these originate at the BOW, not the
  // transom, and stay bright for a long way astern.
  arms: {
    fromWaves:    { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Foam from breaking' },
    waveFoam:     { v: 1.6, min: 0,   max: 5,   step: 0.01, label: 'Breaking foam gain' },
    angle:        { v: 13, min: 4,   max: 40,  step: 0.1,  label: 'Half-angle (°)' },
    width0:       { v: 0.9, min: 0.1, max: 4,   step: 0.05, label: 'Width at bow (m)' },
    widthGrow:    { v: 0,min: 0,   max: 0.6, step: 0.001,label: 'Width growth (m/m)' },
    foam:         { v: 0.95, min: 0,   max: 3,   step: 0.01, label: 'Foam density' },
    height:       { v: 0.42, min: 0,   max: 2,   step: 0.01, label: 'Crest height (m)' },
    innerBias:    { v: 0.38, min: 0,   max: 1,   step: 0.01, label: 'Outer-edge bias' },
    rim:          { v: 0.7, min: 0,   max: 2,   step: 0.01, label: 'Outer rim line' },
    rimWidth:     { v: 0.45, min: 0.05,max: 3,   step: 0.01, label: 'Rim thickness (m)' },
    nearBoost:    { v: 0.58, min: 0,   max: 3,   step: 0.01, label: 'Near-field boost' },
    nearLength:   { v: 34, min: 3,   max: 150, step: 1,    label: 'Near-field length (m)' },
    fadeStart:    { v: 2, min: 2,   max: 200, step: 1,    label: 'Fade start (m)' },
    fadeLength:   { v: 203, min: 5,   max: 400, step: 1,    label: 'Fade length (m)' },
  },

  // The comb / scallop texture riding along each arm: periodic crests that lean
  // back from the arm axis and lengthen as the wake ages.
  feather: {
    spacing:      { v: 3.4,  min: 0.4, max: 20,  step: 0.05, label: 'Crest spacing (m)' },
    spacingGrow:  { v: 0.055,min: 0,   max: 0.4, step: 0.005,label: 'Spacing growth (m/m)' },
    lean:         { v: 1.35, min: -3,  max: 3,   step: 0.01, label: 'Crest lean' },
    depth:        { v: 0.78, min: 0,   max: 1,   step: 0.01, label: 'Comb depth' },
    jitter:       { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Phase jitter' },
    sharpness:    { v: 1.25,  min: 0.3, max: 6,   step: 0.05, label: 'Crest sharpness' },
    carve:        { v: 0.42, min: 0,   max: 1,   step: 0.01, label: 'Comb carves foam' },
  },

  // Turbulent water dragged behind the transom: the brightest, shortest-lived
  // foam in the whole wake.
  wash: {
    width:        { v: 0.6, min: 0.2, max: 8,   step: 0.05, label: 'Width (m)' },
    widthGrow:    { v: 0.025,min: 0,   max: 0.5, step: 0.005,label: 'Width growth (m/m)' },
    foam:         { v: 0.77,  min: 0,   max: 3,   step: 0.01, label: 'Foam density' },
    length:       { v: 27, min: 2,   max: 200, step: 1,    label: 'Decay length (m)' },
    tailFoam:     { v: 0, min: 0,   max: 1,   step: 0.01, label: 'Long tail streak' },
    depth:        { v: 0.22, min: 0,   max: 1.5, step: 0.01, label: 'Trough depth (m)' },
  },

  // Water between the arms: flattened, with the transverse (following) wave
  // train arcing across it.
  // Water between the arms: flattened, and no longer carrying its own ad-hoc
  // ripple -- the Kelvin system below does that properly.
  inner: {
    flatten:      { v: 0.7,  min: 0,   max: 1,   step: 0.01, label: 'Swell flattening' },
  },

  // The gravity waves. These are displacement only -- no foam -- so they carry
  // on rolling outward long after the white churn has died, and they reach the
  // full 19.47 degree wedge, which is wider than the spray arms.
  kelvin: {
    amp:          { v: 0.225, min: 0,   max: 1.5, step: 0.005,label: 'Wave height (m)' },
    froudePeak:   { v: 0.52, min: 0.15,max: 1.5, step: 0.01, label: 'Peak Froude no.' },
    humpFloor:    { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Planing floor' },
    beamGain:     { v: 0.85, min: 0,   max: 2,   step: 0.01, label: 'Beam → amplitude' },
    interference: { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Bow/stern interference' },
    turnBias:     { v: 0.6, min: 0,   max: 2,   step: 0.01, label: 'Outside-of-turn gain' },
    waveScale:    { v: 0.26, min: 0.1, max: 3,   step: 0.01, label: 'Wavelength scale' },
    divergent:    { v: 1, min: 0,   max: 2,   step: 0.01, label: 'Divergent train' },
    transverse:   { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Transverse train' },
    cusp:         { v: 1.4, min: 0,   max: 4,   step: 0.01, label: 'Cusp emphasis' },
    decay:        { v: 150,min: 10,  max: 800, step: 5,    label: 'Amplitude decay (m)' },
    life:         { v: 120,min: 5,   max: 300, step: 1,    label: 'Wave life (s)' },
    propagate:    { v: 1, min: 0,   max: 1,   step: 0.01, label: 'Waves run free' },
    breakSteep:   { v: 0.075,min: 0.005,max: 0.4, step: 0.005,label: 'Breaking steepness' },
    minWave:      { v: 3.6, min: 0.5, max: 20,  step: 0.1,  label: 'Shortest wave (m)' },
  },


  // Foam appearance: how the bubble field breaks up and dies.
  foamLook: {
    scale:        { v: 1.65, min: 0.1, max: 6,   step: 0.01, label: 'Bubble scale' },
    contrast:     { v: 1.45,  min: 0.2, max: 4,   step: 0.01, label: 'Bubble contrast' },
    breakup:      { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Break-up with age' },
    life:         { v: 72.5, min: 1,   max: 120, step: 0.5,  label: 'Foam life (s)' },
    dissolve:     { v: 3.35,  min: 0.2, max: 5,   step: 0.05, label: 'Dissolve curve' },
    lace:         { v: 4.05, min: 0.5, max: 8,   step: 0.05, label: 'Lace fineness' },
    laceAmount:   { v: 0.62, min: 0,   max: 1.5, step: 0.01, label: 'Lace reach' },
    coarsen:      { v: 0.24, min: 0,   max: 1,   step: 0.01, label: 'Cells coarsen with age' },
    softness:     { v: 0.58, min: 0.02,max: 1,   step: 0.01, label: 'Edge softness' },
  },


  // Air the prop drags UNDER the surface. Not foam: these bubbles scatter light
  // back up through water, so they tint it turquoise rather than whitening it,
  // and the surface above them still reflects the sky.
  bubbles: {
    plume:        { v: 0.86, min: 0,   max: 4,   step: 0.01, label: 'Plume density' },
    width:        { v: 0.5, min: 0.2, max: 10,  step: 0.05, label: 'Plume width (m)' },
    spread:       { v: 0.028,min: 0,   max: 0.5, step: 0.001,label: 'Spread (m/m)' },
    length:       { v: 46,min: 5,   max: 400, step: 1,    label: 'Decay length (m)' },
    fromArms:     { v: 0.42, min: 0,   max: 2,   step: 0.01, label: 'Entrained by arms' },
    armsLength:   { v: 70, min: 5,   max: 400, step: 1,    label: 'Entrained decay (m)' },
    life:         { v: 44, min: 2,   max: 200, step: 1,    label: 'Bubble life (s)' },
    depth:        { v: 1.7, min: 0.1, max: 6,   step: 0.05, label: 'Injection depth (m)' },
    rise:         { v: 0.26, min: 0.02,max: 2,   step: 0.01, label: 'Rise speed (m/s)' },
    extinction:   { v: 0.42, min: 0,   max: 2,   step: 0.01, label: 'Water extinction /m' },
    deepTint:     { v: 0.7, min: 0,   max: 1,   step: 0.01, label: 'Deep-water tint' },
    mottle:       { v: 0.72, min: 0,   max: 1,   step: 0.01, label: 'Cloudiness' },
    brightness:   { v: 0.87, min: 0,   max: 3,   step: 0.01, label: 'Backscatter' },
    tint:         { v: 0.5, min: 0,   max: 1,   step: 0.01, label: 'Green / blue' },
    milkiness:    { v: 0.35, min: 0,   max: 1,   step: 0.01, label: 'Milkiness' },
  },

  // The lace is alive: it surges with the waves, shears in the churn, and its
  // cells burst and re-form. All of it is LOCAL motion — nothing here may drift,
  // or the foam would slide across water it is supposed to be floating on.
  foamMotion: {
    rideWaves:    { v: 0.8, min: 0,   max: 3,   step: 0.01, label: 'Foam rides the waves' },
    drift:        { v: 0.55, min: 0,   max: 3,   step: 0.01, label: 'Rides the swell' },
    ringAmount:   { v: 0.75, min: 0,   max: 3,   step: 0.01, label: 'Ring push (m)' },
    ringScale:    { v: 3.4, min: 0.8, max: 30,  step: 0.1,  label: 'Ring spacing (m)' },
    ringSpeed:    { v: 0.4, min: 0.02,max: 2,   step: 0.01, label: 'Ring speed' },
    ringWidth:    { v: 0.7, min: 0.1, max: 5,   step: 0.05, label: 'Wavefront width (m)' },
    cellGrowth:   { v: 0, min: 0,   max: 0.8, step: 0.005,label: 'Cells expand' },
    ringRelief:   { v: 0, min: 0,   max: 3,   step: 0.01, label: 'Rings show in water' },
    boil:         { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Cells burst / re-form' },
    plumeSwirl:   { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Plume swirl' },
  },

  // How the foam sits on the water rather than on top of it.
  foamMix: {
    // Abyssal's foam grading expects a coverage field that saturates near 1;
    // the prototype's peaks around 0.12, so the wake needs gain before it is
    // shaded or it is drawn at a few percent opacity and reads as clean water.
    wakeGain:     { v: 5.5,  min: 0,   max: 16,  step: 0.1,  label: 'Wake foam gain' },
    density:      { v: 1.75, min: 0.3, max: 8,   step: 0.05, label: 'Opacity build' },
    translucency: { v: 0.58, min: 0,   max: 1,   step: 0.01, label: 'Water shows through' },
    aeration:     { v: 0.44, min: 0,   max: 1.5, step: 0.01, label: 'Aerated teal halo' },
    relief:       { v: 0.94, min: 0,   max: 3,   step: 0.01, label: 'Bubble relief' },
    troughBias:   { v: 0.4, min: 0,   max: 1.5, step: 0.01, label: 'Pools in troughs' },
    warmth:       { v: 0.18, min: 0,   max: 1,   step: 0.01, label: 'Sunlit warmth' },
  },

  ocean: {
    swellAmp:     { v: 0.05, min: 0,   max: 2,   step: 0.01, label: 'Swell amp (m)' },
    swellLen:     { v: 26, min: 3,   max: 120, step: 0.5,  label: 'Swell λ (m)' },
    chopAmp:      { v: 0.006, min: 0,   max: 0.6, step: 0.001,label: 'Chop amp (m)' },
    deepColor:    { v: 0.021,min: 0,   max: 0.4, step: 0.001,label: 'Water lightness' },
    tint:         { v: 0.42, min: 0,   max: 1,   step: 0.01, label: 'Blue / teal' },
    sunElev:      { v: 3, min: 0,   max: 88,  step: 1,    label: 'Sun elevation (°)' },
    sunAzim:      { v: 0,min: 0,   max: 360, step: 1,    label: 'Sun azimuth (°)' },
    reflectivity: { v: 1.15, min: 0,   max: 1.5, step: 0.01, label: 'Mirror / reflectivity' },
    hazeStart:    { v: 1400, min: 100, max: 8000,step: 50,   label: 'Haze onset (m)' },
    sunGlow:      { v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Sun glow' },
    sheen:        { v: 0.04, min: 0,   max: 1.5, step: 0.01, label: 'Wave sheen' },
    specular:     { v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Specular' },
    exposure:     { v: 1.2,  min: 0.2, max: 3,   step: 0.01, label: 'Exposure' },
  },

  // Cost, not looks. Auto-set on load from the device, then yours to override.
  // Sky, weather and shore.
  // Water that has left the water. Everything else the prototype draws is a
  // field on the surface; this is the one part that is airborne, so it is
  // particles and it lands.
  spray: {
    amount:    { v: 1,    min: 0,   max: 2,   step: 0.01, label: 'Spray amount' },
    rate:      { v: 26,   min: 0,   max: 160, step: 1,    label: 'Droplets /s per m/s' },
    sites:     { v: 4,    min: 1,   max: 8,   step: 1,    label: 'Emission sites' },
    minSpeed:  { v: 2.2,  min: 0,   max: 12,  step: 0.1,  label: 'Throws above (m/s)' },
    throw:     { v: 0.34, min: 0,   max: 1.2, step: 0.01, label: 'Throw x speed' },
    rise:      { v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Upward share' },
    spread:    { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Scatter' },
    drag:      { v: 1.35, min: 0,   max: 6,   step: 0.05, label: 'Air drag' },
    life:      { v: 1.1,  min: 0.1, max: 4,   step: 0.05, label: 'Droplet life (s)' },
    size:      { v: 0.10, min: 0.01,max: 0.6, step: 0.01, label: 'Droplet size (m)' },
    opacity:   { v: 0.85, min: 0,   max: 1,   step: 0.01, label: 'Droplet opacity' },
  },

  scene: {
    // 1 draws the vendored Abyssal FFT sea and volumetric sky; 0 the lab's own
    // analytic ocean. Both carry the same wake -- that is the point of keeping
    // the switch rather than deleting the loser.
    abyssal:      { v: 1,    min: 0,   max: 1,   step: 1,    label: 'Abyssal sea' },
    // Index into PRESET_NAMES in abyssalSea.js, calmest first: turning it up
    // means more sea. Drives the wave spectrum AND the light, because in
    // Abyssal they are one parameter set, not two.
    preset:       { v: 0,    min: 0,   max: 9,   step: 1,    label: 'Weather preset' },
    // The prototype already has a lake bottom (the terrain). Abyssal's presets
    // carry their own procedural seafloor, and a shallow one under green lake
    // water reads as a bright green pool. 0 pushes it out of sight, 1 restores
    // exactly what the preset asked for.
    floor:        { v: 0,    min: 0,   max: 1,   step: 0.01, label: 'Show sea floor' },
    waterTint:    { v: 0.8,  min: 0,   max: 1,   step: 0.01, label: 'Deep-water tint' },
    // Straight down, Fresnel reflects ~2% of the sky, so a look-down view sees
    // only what the water column scatters back. This scales that, and it is
    // the reason an overhead camera can look black on a preset authored for a
    // dark lake. 1 is exactly what the preset asked for.
    waterGlow:    { v: 3.0,  min: 0.2, max: 10,  step: 0.05, label: 'Water glow (look-down)' },
    warmth:       { v: 1.15, min: 0,   max: 1.5, step: 0.01, label: 'Sunset warmth' },
    cloud:        { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Cloud cover' },
    cloudScale:   { v: 0.55, min: 0.05,max: 3,   step: 0.01, label: 'Cloud scale' },
    cloudSoft:    { v: 0.30, min: 0.02,max: 1,   step: 0.01, label: 'Cloud softness' },
    treeline:     { v: 0.008, min: 0,   max: 0.08,step: 0.001,label: 'Shore height' },
    treeRough:    { v: 0.45, min: 0,   max: 1.5, step: 0.01, label: 'Shore roughness' },
    treeDark:     { v: 0.02, min: 0,   max: 0.6, step: 0.005,label: 'Shore lightness' },
  },

  // The lake itself -- real geometry, not a painted horizon.
  lake: {
    radius:       { v: 1850, min: 200, max: 4000,step: 10,   label: 'Lake radius (m)' },
    depth:        { v: 14,   min: 2,   max: 60,  step: 1,    label: 'Basin depth (m)' },
    rim:          { v: 70,   min: 10,  max: 400, step: 5,    label: 'Hill height (m)' },
    relief:       { v: 34,   min: 0,   max: 120, step: 1,    label: 'Relief (m)' },
    wobble:       { v: 0.30, min: 0,   max: 0.8, step: 0.01, label: 'Shoreline wobble' },
    islands:      { v: 55,   min: 0,   max: 200, step: 1,    label: 'Islands' },
    avoid:        { v: 1.00, min: 0,   max: 3,   step: 0.01, label: 'Shore avoidance' },
    canopy:       { v: 0.10, min: 0.01,max: 0.6, step: 0.005,label: 'Canopy lightness' },
  },

  quality: {
    renderScale:  { v: 2,  min: 0.5, max: 2,   step: 0.25, label: 'Render scale' },
    oceanDetail:  { v: 560,  min: 140, max: 760, step: 20,   label: 'Ocean detail' },
  },

  field: {
    // One knob over every lifetime and decay length in the wake. The individual
    // ones stay where they are; this scales all of them at once, because
    // "make it die faster" should not mean hunting through four groups.
    decay:        { v: 1.85, min: 0.2, max: 8,   step: 0.05, label: 'Wake decay ×' },
    adaptive:     { v: 0.85, min: 0,   max: 1,   step: 0.01, label: 'Shrink field on zoom-in' },
    extent:       { v: 270,  min: 80,  max: 700, step: 10,   label: 'Wake field size (m)' },
    trailLength:  { v: 280,  min: 50,  max: 1200,step: 10,   label: 'Trail length (m)' },
  },
};

export const flat = () => {
  const out = {};
  for (const [g, entries] of Object.entries(PARAMS))
    for (const [k, p] of Object.entries(entries)) out[`${g}.${k}`] = p.v;
  return out;
};

export const get = (path) => {
  const [g, k] = path.split('.');
  const entry = PARAMS[g]?.[k];
  // A missing parameter otherwise surfaces as "cannot read 'v' of undefined"
  // somewhere in a shader uniform sync, a long way from the actual cause.
  if (!entry) throw new Error(`unknown parameter: ${path}`);
  return entry.v;
};

export const set = (path, value) => {
  const [g, k] = path.split('.');
  if (PARAMS[g] && PARAMS[g][k]) PARAMS[g][k].v = +value;
};
