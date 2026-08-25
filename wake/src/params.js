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
    nearBoost:    { v: 0.85, min: 0,   max: 3,   step: 0.01, label: 'Near-field boost' },
    nearLength:   { v: 34.0, min: 3,   max: 150, step: 1,    label: 'Near-field length (m)' },
    fadeStart:    { v: 120.0, min: 2,   max: 200, step: 1,    label: 'Fade start (m)' },
    fadeLength:   { v: 380.0, min: 5,   max: 400, step: 1,    label: 'Fade length (m)' },
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
    width:        { v: 2.10, min: 0.2, max: 8,   step: 0.05, label: 'Width (m)' },
    widthGrow:    { v: 0.038,min: 0,   max: 0.5, step: 0.005,label: 'Width growth (m/m)' },
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
    life:         { v: 65.0, min: 1,   max: 120, step: 0.5,  label: 'Foam life (s)' },
    dissolve:     { v: 1.6,  min: 0.2, max: 5,   step: 0.05, label: 'Dissolve curve' },
  },

  ocean: {
    swellAmp:     { v: 0.22, min: 0,   max: 2,   step: 0.01, label: 'Swell amp (m)' },
    swellLen:     { v: 26.0, min: 3,   max: 120, step: 0.5,  label: 'Swell λ (m)' },
    chopAmp:      { v: 0.07, min: 0,   max: 0.6, step: 0.005,label: 'Chop amp (m)' },
    deepColor:    { v: 0.040,min: 0,   max: 0.4, step: 0.005,label: 'Water lightness' },
    tint:         { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Blue / teal' },
    sunElev:      { v: 52.0, min: 5,   max: 88,  step: 1,    label: 'Sun elevation (°)' },
    sunAzim:      { v: 140.0,min: 0,   max: 360, step: 1,    label: 'Sun azimuth (°)' },
    specular:     { v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Specular' },
    exposure:     { v: 1.0,  min: 0.2, max: 3,   step: 0.01, label: 'Exposure' },
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
