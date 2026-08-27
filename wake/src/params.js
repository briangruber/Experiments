// Every tunable in one place. `ui.js` builds the panel from this, the shaders
// read it as uniforms, and "Copy params" on the panel dumps the current values
// as JSON so a tuning session can be pasted straight back into a conversation.
//
// min/max/step are for the slider; `v` is the live value.

export const PARAMS = {
  boat: {
    speed:        { v: 0, min: 0,   max: 100,  step: 0.1,  label: 'Speed (m/s)' },
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
    // A hull making way turns about a point roughly a third of its length aft
    // of the stem, not about the stem itself. The mesh origin IS the stem, so
    // without this a turn sweeps the stern through an arc and the boat walks
    // away from its own wake. 0 restores that older behaviour.
    // Which hull is drawn. Indexes BOATS in src/boatModels.js; the last entry
    // is the original blocky placeholder, kept because it is the only one whose
    // proportions were built to match the wake's own hull maths.
    model:        { v: 0,    min: 0,   max: 5,   step: 1,    label: 'Boat model' },
    // How deep the model sits: a fraction of its own height pushed under the
    // waterline. The GLBs know nothing about where their waterline is.
    // METRES the lowest point sits below the waterline -- not a fraction of the
    // model's height, which sank a masted boat three times as deep as a dinghy
    // and put the sea inside the open ones.
    // Deep enough that a hull still has its keel wetted ON PLANE: boat.riseMax
    // lifts the whole body 0.42 m at speed, so a 0.30 m draft left the boat
    // hovering with daylight under it.
    draft:        { v: 0.85, min: 0,   max: 3,   step: 0.01, label: 'Draft (m)' },
    pivot:        { v: 0.32, min: 0,   max: 0.8, step: 0.01, label: 'Turn pivot (aft of bow)' },
    // Planing hulls bank INTO a turn. atan(v*omega/g) -- the coordinated-turn
    // relation -- so lean follows speed and rate together rather than needing
    // a curve of its own.
    bank:         { v: 1,  min: 0,   max: 2.5, step: 0.01, label: 'Bank into turns' },
    bankMax:      { v: 22,   min: 0,   max: 45,  step: 1,    label: 'Max bank (deg)' },
    // Roll is a damped spring, not a value: a hull has inertia and the water
    // damps it, so the lean LAGS the wheel. rollRate is the natural frequency
    // in Hz (a small planing hull is around 1); rollDamp is the damping ratio,
    // a little under 1 so it settles fast with a hint of overshoot as the hull
    // rolls in and catches itself.
    // Bounding-box buoyancy: the sea's real height, probed at the hull's four
    // corners (GPU readback, a frame late, smoothed), rocks the hull -- heave
    // from the average, pitch bow-to-stern, roll beam-to-beam. 0 disables.
    // How fast the keel pulls the track onto the heading in a turn. Low is a
    // skidding flat-bottom; high is a deep-vee on rails. The gap between
    // heading and course during a turn is the crab angle you can see.
    // The most the track may lag the heading. Beyond this the keel bites: it
    // is what stops a hard turn sliding the hull off its own wake.
    // How much of the foam the hull's own footprint removes. 0 lets the wake
    // run right under the boat, which is what it looks like from a chase
    // camera: the water it is cutting is the water that is foaming.
    // Purely how BIG the model is drawn. The wake still follows Hull length
    // and Beam below -- those are the numbers the field does its physics
    // with -- so a model scaled far past them will out-grow its own wake.
    modelScale:   { v: 1,    min: 0.2, max: 4,   step: 0.05, label: 'Model scale' },
    hullCut:      { v: 0,    min: 0,   max: 1,   step: 0.01, label: 'Cut foam under hull' },
    crabMax:      { v: 12,   min: 0,   max: 45,  step: 1,    label: 'Max slip angle (°)' },
    grip:         { v: 0.7,  min: 0,   max: 1,   step: 0.01, label: 'Keel grip' },
    buoy:         { v: 1,  min: 0,   max: 1.5, step: 0.01, label: 'Ride the waves' },
    rollRate:     { v: 0.85, min: 0.1, max: 3,   step: 0.01, label: 'Roll rate (Hz)' },
    rollDamp:     { v: 0.72, min: 0.1, max: 2,   step: 0.01, label: 'Roll damping' },
    engines:      { v: 2,    min: 1,   max: 4,   step: 1,    label: 'Engines' },
    engineSpacing:{ v: 2.4, min: 0.2, max: 4,   step: 0.05, label: 'Engine spacing (m)' },
  },

  // The V of spray sheets. In the reference these originate at the BOW, not the
  // transom, and stay bright for a long way astern.
  arms: {
    fromWaves:    { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Foam from breaking' },
    waveFoam:     { v: 1.6, min: 0,   max: 5,   step: 0.01, label: 'Breaking foam gain' },
    // 1 = the physical angle (Kelvin 19.47 degrees while the hull is slow,
    // narrowing as atan(1/2Fr_B) once it outruns its own transverse waves).
    // 0 = whatever the slider below says, for when you want a look instead.
    autoAngle:    { v: 1,    min: 0,   max: 1,   step: 0.01, label: 'Half-angle from physics' },
    angle:        { v: 19.3, min: 4,   max: 40,  step: 0.1,  label: 'Half-angle, manual (°)' },
    width0:       { v: 1.7, min: 0.1, max: 4,   step: 0.05, label: 'Width at bow (m)' },
    widthGrow:    { v: 0.03,min: 0,   max: 0.6, step: 0.001,label: 'Width growth (m/m)' },
    foam:         { v: 0.95, min: 0,   max: 3,   step: 0.01, label: 'Foam density' },
    height:       { v: 0.42, min: 0,   max: 2,   step: 0.01, label: 'Crest height (m)' },
    innerBias:    { v: 0.38, min: 0,   max: 1,   step: 0.01, label: 'Outer-edge bias' },
    rim:          { v: 0.4, min: 0,   max: 2,   step: 0.01, label: 'Outer rim line' },
    rimWidth:     { v: 0.45, min: 0.05,max: 3,   step: 0.01, label: 'Rim thickness (m)' },
    nearBoost:    { v: 0.28, min: 0,   max: 3,   step: 0.01, label: 'Near-field boost' },
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
    width:        { v: 1.5, min: 0.2, max: 8,   step: 0.05, label: 'Width (m)' },
    widthGrow:    { v: 0.06,min: 0,   max: 0.5, step: 0.005,label: 'Width growth (m/m)' },
    foam:         { v: 0.77,  min: 0,   max: 3,   step: 0.01, label: 'Foam density' },
    length:       { v: 45, min: 2,   max: 200, step: 1,    label: 'Decay length (m)' },
    tailFoam:     { v: 0, min: 0,   max: 1,   step: 0.01, label: 'Long tail streak' },
    depth:        { v: 0.22, min: 0,   max: 1.5, step: 0.01, label: 'Trough depth (m)' },
  },

  // Water between the arms: flattened, with the transverse (following) wave
  // train arcing across it.
  // Water between the arms: flattened, and no longer carrying its own ad-hoc
  // ripple -- the Kelvin system below does that properly.
  inner: {
    flatten:      { v: 0.7,  min: 0,   max: 1,   step: 0.01, label: 'Swell flattening' , lab: 1 },
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
    width:        { v: 1.4, min: 0.2, max: 10,  step: 0.05, label: 'Plume width (m)' },
    spread:       { v: 0.028,min: 0,   max: 0.5, step: 0.001,label: 'Spread (m/m)' },
    length:       { v: 46,min: 5,   max: 400, step: 1,    label: 'Decay length (m)' },
    fromArms:     { v: 0.16, min: 0,   max: 2,   step: 0.01, label: 'Entrained by arms' },
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
    rideWaves:    { v: 0.8, min: 0,   max: 3,   step: 0.01, label: 'Foam rides the waves' , lab: 1 },
    drift:        { v: 0.55, min: 0,   max: 3,   step: 0.01, label: 'Rides the swell' , lab: 1 },
    ringAmount:   { v: 0.75, min: 0,   max: 3,   step: 0.01, label: 'Ring push (m)' , lab: 1 },
    ringScale:    { v: 3.4, min: 0.8, max: 30,  step: 0.1,  label: 'Ring spacing (m)' , lab: 1 },
    ringSpeed:    { v: 0.4, min: 0.02,max: 2,   step: 0.01, label: 'Ring speed' , lab: 1 },
    ringWidth:    { v: 0.7, min: 0.1, max: 5,   step: 0.05, label: 'Wavefront width (m)' , lab: 1 },
    cellGrowth:   { v: 0, min: 0,   max: 0.8, step: 0.005,label: 'Cells expand' , lab: 1 },
    ringRelief:   { v: 0, min: 0,   max: 3,   step: 0.01, label: 'Rings show in water' , lab: 1 },
    boil:         { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Cells burst / re-form' , lab: 1 },
    plumeSwirl:   { v: 0.45, min: 0,   max: 2,   step: 0.01, label: 'Plume swirl' , lab: 1 },
  },

  // How the foam sits on the water rather than on top of it.
  foamMix: {
    // Abyssal's foam grading expects a coverage field that saturates near 1;
    // the prototype's peaks around 0.12, so the wake needs gain before it is
    // shaded or it is drawn at a few percent opacity and reads as clean water.
    wakeGain:     { v: 3.0,  min: 0,   max: 16,  step: 0.1,  label: 'Wake foam gain' },
    // The SEA's own whitecaps, not the wake's. 1 gives them the same lace the
    // boat leaves behind -- Abyssal's own is a Worley web, and it thresholds in
    // exactly the same form, so this swaps the field and nothing else.
    seaLace:      { v: 0,    min: 0,   max: 1,   step: 0.01, label: 'Sea foam uses our lace' },
    // ...and coverage from waves actually BREAKING: steepness is amplitude
    // times wavenumber, which for a surface is the magnitude of its slope, and
    // past a critical value a crest spills. Additive, because the FFT's own
    // Jacobian fold catches where the surface folds OVER, which slope alone
    // cannot -- so this adds the steep-crest case rather than replacing it.
    seaWhitecaps: { v: 0,    min: 0,   max: 2,   step: 0.01, label: 'Sea whitecaps (not the wake)' },
    seaBreak:     { v: 0, min: 0,   max: 1.5, step: 0.01, label: 'Sea foam from breaking' },
    density:      { v: 1.75, min: 0.3, max: 8,   step: 0.05, label: 'Opacity build' },
    translucency: { v: 0.58, min: 0,   max: 1,   step: 0.01, label: 'Water shows through' , lab: 1 },
    aeration:     { v: 0.44, min: 0,   max: 1.5, step: 0.01, label: 'Aerated teal halo' , lab: 1 },
    relief:       { v: 0.94, min: 0,   max: 3,   step: 0.01, label: 'Bubble relief' , lab: 1 },
    troughBias:   { v: 0.4, min: 0,   max: 1.5, step: 0.01, label: 'Pools in troughs' , lab: 1 },
    warmth:       { v: 0.18, min: 0,   max: 1,   step: 0.01, label: 'Sunlit warmth' , lab: 1 },
  },

  // WATER & LIGHT -- all of it drives the Abyssal sea now.
  //
  // This group used to drive the lab's own analytic ocean, which is hidden
  // whenever Abyssal is on: every slider in it moved something nobody could
  // see. The ones with a real counterpart were repointed (and re-ranged, since
  // Abyssal's units are its own); the ones without were retired.
  ocean: {
    // Sea state. These three are baked into the FFT's initial spectrum, so
    // moving them rebuilds it -- once, on change, not per frame.
    waveHeight:   { v: 1,    min: 0,   max: 3,   step: 0.01, label: 'Wave height ×' },
    swellAmp:     { v: 0.14, min: 0,   max: 1,   step: 0.01, label: 'Swell amount' },
    swellLen:     { v: 5.5,  min: 3,   max: 18,  step: 0.1,  label: 'Swell period (s)' },
    chopAmp:      { v: 0.78, min: 0,   max: 1.5, step: 0.01, label: 'Choppiness' },
    // Light.
    sunElev:      { v: 72,   min: 0,   max: 88,  step: 1,    label: 'Sun elevation (°)' },
    sunAzim:      { v: 142,  min: 0,   max: 360, step: 1,    label: 'Sun azimuth (°)' },
    reflectivity: { v: 1.15, min: 0,   max: 3,   step: 0.01, label: 'Sky ambient' },
    sunGlow:      { v: 1,    min: 0.2, max: 8,   step: 0.05, label: 'Sun disc size ×' },
    hazeStart:    { v: 1,    min: 0,   max: 3,   step: 0.01, label: 'Aerial haze' },
    sheen:        { v: 1,    min: 0,   max: 4,   step: 0.01, label: 'Glitter' },
    specular:     { v: 0.55, min: 0,   max: 2,   step: 0.01, label: 'Specular' },
    exposure:     { v: 1.2,  min: 0.2, max: 3,   step: 0.01, label: 'Exposure' },
    // Retired with the analytic ocean: 'Water lightness' and 'Blue / teal'
    // duplicated Sky & weather's clarity / tint / glow, and 'Wave sheen' is
    // now Glitter above.
    deepColor:    { v: 0.021,min: 0,   max: 0.4, step: 0.001,label: 'Water lightness', lab: 1 },
    tint:         { v: 0.42, min: 0,   max: 1,   step: 0.01, label: 'Blue / teal', lab: 1 },
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
    size:      { v: 0.1, min: 0.01,max: 0.6, step: 0.01, label: 'Droplet size (m)' },
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
    preset:       { v: 4,    min: 0,   max: 9,   step: 1,    label: 'Weather preset' },
    // The prototype already has a lake bottom (the terrain). Abyssal's presets
    // carry their own procedural seafloor, and a shallow one under green lake
    // water reads as a bright green pool. 0 pushes it out of sight, 1 restores
    // exactly what the preset asked for.

    waterTint:    { v: 0,  min: 0,   max: 1,   step: 0.01, label: 'Deep-water tint' },
    // Straight down, Fresnel reflects ~2% of the sky, so a look-down view sees
    // only what the water column scatters back. This scales that, and it is
    // the reason an overhead camera can look black on a preset authored for a
    // dark lake. 1 is exactly what the preset asked for.
    // Exposure for the MESHES only -- boat, terrain, spray. The sea does its own
    // tonemapping inside its own shader, so this cannot touch it. Without it a
    // textured hull clips to white and looks untextured.
    // 0.85 was too dark once ACES was added on top of halved lights: these
    // models carry baked ambient occlusion and fairly dark albedo, so they
    // read as untextured grey long before they read as underlit.
    meshExposure: { v: 1,  min: 0.1, max: 4,   step: 0.01, label: 'Mesh exposure' },
    // Master on the sun and sky reaching the MESHES. Their ratio comes from
    // the sun's elevation, so this scales both together rather than letting
    // them drift apart.
    meshSun:      { v: 1,  min: 0,   max: 3,   step: 0.01, label: 'Mesh sun & sky' },
    // Screen-space refraction: the submerged half of the hull, seen THROUGH
    // the surface, wobbled by the surface normal and murked by depth. 0 turns
    // the extra scene pass off entirely.
    refraction:   { v: 0.9,  min: 0,   max: 2.5, step: 0.01, label: 'See-through water' },
    // How far down you can see. Divides the water's absorption, so 2 means
    // roughly twice the sight depth -- the bed, a submerged keel and the
    // bubble plume all reach the same distance, because they are all looking
    // through the same water.
    // The hull's shadow on the sea bed. Only visible where there IS a bed --
    // raise 'Bed depth' under The Lake to bring one into view.
    hullShadow:   { v: 1,    min: 0,   max: 1,   step: 0.01, label: 'Boat shadow on the bed' },
    clarity:      { v: 1,    min: 0.2, max: 3,   step: 0.05, label: 'Water clarity (see-through depth)' },
    waterGlow:    { v: 1.0,  min: 0.2, max: 10,  step: 0.05, label: 'Water glow (look-down)' },
    warmth:       { v: 1.15, min: 0,   max: 1.5, step: 0.01, label: 'Sunset warmth' },
    cloud:        { v: 0.55, min: 0,   max: 1,   step: 0.01, label: 'Cloud cover' },
    cloudScale:   { v: 0.55, min: 0.05,max: 3,   step: 0.01, label: 'Cloud scale' },
    cloudSoft:    { v: 0.3, min: 0.02,max: 1,   step: 0.01, label: 'Cloud softness' },
    treeline:     { v: 0.008, min: 0,   max: 0.08,step: 0.001,label: 'Shore height' , lab: 1 },
    treeRough:    { v: 0.45, min: 0,   max: 1.5, step: 0.01, label: 'Shore roughness' , lab: 1 },
    treeDark:     { v: 0.02, min: 0,   max: 0.6, step: 0.005,label: 'Shore lightness' , lab: 1 },
  },

  // The lake itself -- real geometry, not a painted horizon.
  lake: {
    // A shallow SAND bed, which is what a lake actually has. It also lights
    // the water from below: with no visible bottom, an overhead camera at a
    // 38 degree sun sees only what the column scatters back, which is why
    // pushing the floor away turned the look-down view black. 0 = no floor.
    // The pond the boats keep to. Read at startup (the park is built once);
    // the confinement uses it live.
    pond:         { v: 0,  min: 60,  max: 900, step: 10,   label: 'Pond radius (m)' },
    floorDepth:   { v: 0,  min: 0,   max: 60,  step: 0.5,  label: 'Bed depth (m)' },
    weed:         { v: 0.45, min: 0,   max: 1,   step: 0.01, label: 'Weed over sand' },
    // How bright the bed comes back. The scene's exposure is set for the
    // water surface, and an unscaled bottom clips to white -- which costs
    // the caustics, since a clipped surface cannot carry contrast.
    bedBright:    { v: 0.30, min: 0.02, max: 2, step: 0.01, label: 'Bed brightness' },
    // The surface's own slope, bending the view of the bottom: this is what
    // makes the sand shift under a passing wave.
    bedDistort:   { v: 0.9,  min: 0,   max: 3,   step: 0.01, label: 'Bed distortion (waves)' },
    causticSize:  { v: 3.0,  min: 0.3, max: 10, step: 0.1,  label: 'Caustic cell size' },
    caustics:     { v: 1.35, min: 0,   max: 1.5, step: 0.01, label: 'Caustics on the bed' },
    radius:       { v: 1850, min: 200, max: 4000,step: 10,   label: 'Lake radius (m)' , lab: 1 },
    depth:        { v: 14,   min: 2,   max: 60,  step: 1,    label: 'Basin depth (m)' , lab: 1 },
    rim:          { v: 70,   min: 10,  max: 400, step: 5,    label: 'Hill height (m)' , lab: 1 },
    relief:       { v: 34,   min: 0,   max: 120, step: 1,    label: 'Relief (m)' , lab: 1 },
    wobble:       { v: 0.3, min: 0,   max: 0.8, step: 0.01, label: 'Shoreline wobble' , lab: 1 },
    islands:      { v: 55,   min: 0,   max: 200, step: 1,    label: 'Islands' , lab: 1 },
    avoid:        { v: 0, min: 0,   max: 3,   step: 0.01, label: 'Shore avoidance' },
    canopy:       { v: 0.1, min: 0.01,max: 0.6, step: 0.005,label: 'Canopy lightness' , lab: 1 },
  },

  quality: {
    renderScale:  { v: 2,  min: 0.5, max: 2,   step: 0.25, label: 'Render scale' },
    oceanDetail:  { v: 560,  min: 140, max: 760, step: 20,   label: 'Ocean detail' },
  },

  field: {
    // How much the speed AT THE MOMENT OF EMISSION shapes the foam left behind.
    //
    // Density goes as v^2 -- a planing hull's drag goes as v^2, so the power
    // into the water goes as v^3, spread along a track laid at v m/s, which is
    // v^2 of energy per metre. Persistence goes as sqrt(v), deliberately much
    // weaker: a thicker raft lasts longer because there is more of it, not
    // because its bubbles rise slower. Scaling both by v^2 would give a fast
    // boat a trail with no end.
    //
    // 0 restores one flat setting for every speed.
    speedDrive:   { v: 1,    min: 0,   max: 1,   step: 0.01, label: 'Speed shapes the wake' },
    speedRef:     { v: 13,   min: 2,   max: 40,  step: 0.5,  label: 'Reference speed (m/s)' },
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
