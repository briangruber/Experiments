// Every tunable in one place. `ui.js` builds the panel from this, the shaders
// read it as uniforms, and "Copy params" on the panel dumps the current values
// as JSON so a tuning session can be pasted straight back into a conversation.
//
// min/max/step are for the slider; `v` is the live value.

export const PARAMS = {
  boat: {
    speed:        { v: 13.0, min: 0,   max: 26,  step: 0.1,  label: 'Speed (m/s)' },
    turnRate:     { v: 0.0,  min: -25, max: 25,  step: 0.5,  label: 'Turn (°/s)' },
    length:       { v: 8.5,  min: 3,   max: 20,  step: 0.1,  label: 'Hull length (m)' },
    beam:         { v: 2.6,  min: 1,   max: 8,   step: 0.05, label: 'Hull beam (m)' },
    engines:      { v: 2,    min: 1,   max: 4,   step: 1,    label: 'Engines' },
    engineSpacing:{ v: 2.40, min: 0.2, max: 4,   step: 0.05, label: 'Engine spacing (m)' },
  },

  // The V of spray sheets. In the reference these originate at the BOW, not the
  // transom, and stay bright for a long way astern.
  arms: {
    angle:        { v: 15.5, min: 4,   max: 40,  step: 0.1,  label: 'Half-angle (°)' },
    width0:       { v: 2.10, min: 0.1, max: 4,   step: 0.05, label: 'Width at bow (m)' },
    widthGrow:    { v: 0.022,min: 0,   max: 0.6, step: 0.005,label: 'Width growth (m/m)' },
    foam:         { v: 0.95, min: 0,   max: 3,   step: 0.01, label: 'Foam density' },
    height:       { v: 0.42, min: 0,   max: 2,   step: 0.01, label: 'Crest height (m)' },
    innerBias:    { v: 0.38, min: 0,   max: 1,   step: 0.01, label: 'Outer-edge bias' },
    rim:          { v: 0.70, min: 0,   max: 2,   step: 0.01, label: 'Outer rim line' },
    rimWidth:     { v: 0.45, min: 0.05,max: 3,   step: 0.01, label: 'Rim thickness (m)' },
    nearBoost:    { v: 0.58, min: 0,   max: 3,   step: 0.01, label: 'Near-field boost' },
    nearLength:   { v: 34.0, min: 3,   max: 150, step: 1,    label: 'Near-field length (m)' },
    fadeStart:    { v: 46.0, min: 2,   max: 200, step: 1,    label: 'Fade start (m)' },
    fadeLength:   { v: 240.0, min: 5,   max: 400, step: 1,    label: 'Fade length (m)' },
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
    width:        { v: 0.45, min: 0.2, max: 8,   step: 0.05, label: 'Width (m)' },
    widthGrow:    { v: 0.022,min: 0,   max: 0.5, step: 0.005,label: 'Width growth (m/m)' },
    foam:         { v: 1.5,  min: 0,   max: 3,   step: 0.01, label: 'Foam density' },
    length:       { v: 20.0, min: 2,   max: 200, step: 1,    label: 'Decay length (m)' },
    tailFoam:     { v: 0.035, min: 0,   max: 1,   step: 0.01, label: 'Long tail streak' },
    depth:        { v: 0.22, min: 0,   max: 1.5, step: 0.01, label: 'Trough depth (m)' },
  },

  // Water between the arms: flattened, with the transverse (following) wave
  // train arcing across it.
  inner: {
    transAmp:     { v: 0.16, min: 0,   max: 1.2, step: 0.01, label: 'Transverse amp (m)' },
    transLen:     { v: 11.0, min: 2,   max: 80,  step: 0.5,  label: 'Transverse λ (m)' },
    transDecay:   { v: 48.0, min: 3,   max: 250, step: 1,    label: 'Transverse decay (m)' },
    flatten:      { v: 0.7,  min: 0,   max: 1,   step: 0.01, label: 'Swell flattening' },
  },

  // Foam appearance: how the bubble field breaks up and dies.
  foamLook: {
    scale:        { v: 1.05, min: 0.1, max: 6,   step: 0.01, label: 'Bubble scale' },
    contrast:     { v: 1.5,  min: 0.2, max: 4,   step: 0.01, label: 'Bubble contrast' },
    breakup:      { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Break-up with age' },
    life:         { v: 34.0, min: 1,   max: 120, step: 0.5,  label: 'Foam life (s)' },
    dissolve:     { v: 2.10,  min: 0.2, max: 5,   step: 0.05, label: 'Dissolve curve' },
    lace:         { v: 1.05, min: 0.5, max: 8,   step: 0.05, label: 'Lace fineness' },
    laceAmount:   { v: 0.62, min: 0,   max: 1.5, step: 0.01, label: 'Lace reach' },
    coarsen:      { v: 0.45, min: 0,   max: 1,   step: 0.01, label: 'Cells coarsen with age' },
    softness:     { v: 0.42, min: 0.02,max: 1,   step: 0.01, label: 'Edge softness' },
  },

  // Air the prop drags UNDER the surface. Not foam: these bubbles scatter light
  // back up through water, so they tint it turquoise rather than whitening it,
  // and the surface above them still reflects the sky.
  bubbles: {
    plume:        { v: 0.86, min: 0,   max: 4,   step: 0.01, label: 'Plume density' },
    width:        { v: 0.50, min: 0.2, max: 10,  step: 0.05, label: 'Plume width (m)' },
    spread:       { v: 0.028,min: 0,   max: 0.5, step: 0.005,label: 'Spread (m/m)' },
    length:       { v: 46.0,min: 5,   max: 400, step: 1,    label: 'Decay length (m)' },
    fromArms:     { v: 0.42, min: 0,   max: 2,   step: 0.01, label: 'Entrained by arms' },
    armsLength:   { v: 70.0, min: 5,   max: 400, step: 1,    label: 'Entrained decay (m)' },
    life:         { v: 44.0, min: 2,   max: 200, step: 1,    label: 'Bubble life (s)' },
    mottle:       { v: 0.72, min: 0,   max: 1,   step: 0.01, label: 'Cloudiness' },
    brightness:   { v: 0.66, min: 0,   max: 3,   step: 0.01, label: 'Backscatter' },
    tint:         { v: 0.50, min: 0,   max: 1,   step: 0.01, label: 'Green / blue' },
    milkiness:    { v: 0.35, min: 0,   max: 1,   step: 0.01, label: 'Milkiness' },
  },

  // The lace is alive: it surges with the waves, shears in the churn, and its
  // cells burst and re-form. All of it is LOCAL motion — nothing here may drift,
  // or the foam would slide across water it is supposed to be floating on.
  foamMotion: {
    drift:        { v: 0.55, min: 0,   max: 3,   step: 0.01, label: 'Rides the swell' },
    ringAmount:   { v: 0.75, min: 0,   max: 3,   step: 0.01, label: 'Ring push (m)' },
    ringScale:    { v: 3.40, min: 0.8, max: 30,  step: 0.1,  label: 'Ring spacing (m)' },
    ringSpeed:    { v: 0.40, min: 0.02,max: 2,   step: 0.01, label: 'Ring speed' },
    ringWidth:    { v: 0.70, min: 0.1, max: 5,   step: 0.05, label: 'Wavefront width (m)' },
    cellGrowth:   { v: 0.30, min: 0,   max: 0.8, step: 0.005,label: 'Cells expand' },
    ringRelief:   { v: 0.85, min: 0,   max: 3,   step: 0.01, label: 'Rings show in water' },
    boil:         { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Cells burst / re-form' },
    plumeSwirl:   { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Plume swirl' },
  },

  // How the foam sits on the water rather than on top of it.
  foamMix: {
    density:      { v: 1.75, min: 0.3, max: 8,   step: 0.05, label: 'Opacity build' },
    translucency: { v: 0.42, min: 0,   max: 1,   step: 0.01, label: 'Water shows through' },
    aeration:     { v: 0.45, min: 0,   max: 1.5, step: 0.01, label: 'Aerated teal halo' },
    relief:       { v: 0.75, min: 0,   max: 3,   step: 0.01, label: 'Bubble relief' },
    troughBias:   { v: 0.40, min: 0,   max: 1.5, step: 0.01, label: 'Pools in troughs' },
    warmth:       { v: 0.18, min: 0,   max: 1,   step: 0.01, label: 'Sunlit warmth' },
  },

  ocean: {
    swellAmp:     { v: 0.22, min: 0,   max: 2,   step: 0.01, label: 'Swell amp (m)' },
    swellLen:     { v: 26.0, min: 3,   max: 120, step: 0.5,  label: 'Swell λ (m)' },
    chopAmp:      { v: 0.07, min: 0,   max: 0.6, step: 0.005,label: 'Chop amp (m)' },
    deepColor:    { v: 0.021,min: 0,   max: 0.4, step: 0.005,label: 'Water lightness' },
    tint:         { v: 0.42, min: 0,   max: 1,   step: 0.01, label: 'Blue / teal' },
    sunElev:      { v: 52.0, min: 5,   max: 88,  step: 1,    label: 'Sun elevation (°)' },
    sunAzim:      { v: 140.0,min: 0,   max: 360, step: 1,    label: 'Sun azimuth (°)' },
    specular:     { v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Specular' },
    exposure:     { v: 1.0,  min: 0.2, max: 3,   step: 0.01, label: 'Exposure' },
  },

  // Cost, not looks. Auto-set on load from the device, then yours to override.
  quality: {
    renderScale:  { v: 2.0,  min: 0.5, max: 2,   step: 0.25, label: 'Render scale' },
    oceanDetail:  { v: 560,  min: 140, max: 760, step: 20,   label: 'Ocean detail' },
  },

  field: {
    extent:       { v: 340,  min: 80,  max: 700, step: 10,   label: 'Wake field size (m)' },
    trailLength:  { v: 620,  min: 50,  max: 1200,step: 10,   label: 'Trail length (m)' },
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
  return PARAMS[g][k].v;
};

export const set = (path, value) => {
  const [g, k] = path.split('.');
  if (PARAMS[g] && PARAMS[g][k]) PARAMS[g][k].v = +value;
};
