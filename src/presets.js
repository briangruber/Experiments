// Every knob the simulator exposes, plus the curated sea states.
//
// `defaults` is the single source of truth for parameter values; `SCHEMA` only
// describes how to present them. Presets are sparse overrides on top of
// `defaults`, so adding a parameter never invalidates an existing preset.

export const defaults = {
  // ---- sea state ----
  windSpeed: 11.0,          // U10, m/s
  windDirDeg: 42.0,
  fetch: 180.0,             // km
  depth: 900.0,             // m
  amplitude: 1.0,
  choppiness: 1.25,
  choppyLong: 1.45,         // extra horizontal displacement on the long cascades
  crestSharpen: 1.0,        // gain on the bound second harmonic; 1 = Stokes
  spread: 1.0,
  spreadTail: 2.2,          // extra narrowing of the equilibrium range
  alignment: 0.92,
  peakEnhancement: 3.3,     // JONSWAP gamma, energy-normalised
  tailSaturation: 1.0,      // equilibrium-range floor, in units of Phillips alpha
  shortWaveFade: 0.35,      // band rolloff relative to each cascade's Nyquist
  timeScale: 1.0,
  loopPeriod: 0.0,          // 0 = never repeats
  seed: 1337,

  // ---- swell ----
  swellAmount: 0.55,        // significant height of the swell train, m
  swellPeriod: 13.0,
  swellDirDeg: 10.0,
  swellSpread: 6.0,
  swellWidth: 0.06,         // relative bandwidth of the swell peak

  // ---- surface geometry ----
  heightScale: 1.0,
  horizScale: 1.0,
  detailScale: 1.0,
  earthCurve: 1.0,
  seaLevel: 0.0,
  rMin: 0.35,
  rMax: 42000.0,

  // ---- foam ----
  foamCoverage: 1.0,        // gain on the Monahan whitecap fraction W(U10)
  foamSoftness: 0.28,       // width of the breaking ramp, in sigmas
  foamFace: 0.7,            // how strongly breaking is confined to forward faces
  foamBreakScale: 3.2,      // size (m) of the surface patch the fold test sees
  foamCrestAniso: 4.0,      // how far the breaking test reaches along the crest
  foamRidge: 0.85,          // confines breaking to the ridge of the fold field
  foamBreakup: 0.55,        // short-wave roughness modulation of the threshold
  foamWindMin: 4.0,         // U10 below which the sea carries no whitecaps at all
  foamDecay: 0.42,          // dissipated-raft decay rate (1/s)
  foamFreshDecay: 0.9,      // dense crest-foam decay rate (1/s)
  foamThin: 0.18,           // linear sink; the raft clears instead of filming
  foamDrift: 0.6,           // downwind surface drift of foam (m/s)
  foamInject: 4.0,        // saturates the raft: a whitecap is white, not a wash
  foamSpread: 0.40,
  foamAmount: 0.9,
  foamRoughness: 0.62,
  foamTint: 0.35,
  foamDetail: 1.5,
  foamLift: 0.55,
  foamSharp: 1.4,
  foamCrisp: 0.8,        // resolve coverage against the bubble field up close
  foamStreak: 0.7,
  foamOpacity: 0.92,
  foamFar: 0.55,            // grazing self-hiding of distant rafts
  foamColor: [0.94, 0.965, 0.99],

  // ---- water optics ----
  scatterColor: [0.048, 0.285, 0.360],
  absorption: [0.42, 0.075, 0.045],
  scatterAmount: 0.085,
  sssStrength: 1.2,
  sssPower: 4.0,
  sssHeight: 0.75,
  sssDepth: 1.0,
  sssBias: 0.45,            // how far the exit direction leans up the wave normal
  baseRoughness: 0.055,
  roughnessGain: 1.0,
  roughnessMax: 0.30,       // alpha ceiling; Cox-Munk mss tops out near 0.06
  windAniso: 1.45,          // Cox-Munk along/cross-wind slope variance ratio
  waterIOR: 1.333,
  skyAmbient: 1.0,
  skyBlur: 0.5,
  glitter: 0.55,
  glitterScale: 1.0,
  specIntensity: 1.0,
  // Above the mirror ceiling E/(pi r^2), so the sun's own radiance is the limit
  // that actually binds and the knee below it stays smooth.
  specClamp: 20000.0,
  specAA: 1.0,              // screen-space slope variance folded into the lobe
  grazeFocus: 0.20,         // how far the reflection lobe narrows at grazing
  horizonBend: 0.85,
  interReflect: 0.6,
  waveAO: 1.0,
  waveShadow: 0.85,         // swell-scale sun occlusion
  shadowScale: 1.2,         // march length of that occlusion, in wave scales
  capillary: 0.6,
  capillaryScale: 1.0,
  aerial: 1.0,

  // ---- spray ----
  sprayRadius: 120.0,
  sprayRate: 0.85,
  sprayFocus: 1.1,          // radial concentration of the particle budget
  sprayThreshold: 0.30,     // crest-foam fraction at which spray production saturates
  sprayFoldSoft: 0.15,      // toe of that ramp, as a fraction of the threshold
  sprayFoamBias: 0.85,      // how strictly droplets require actively breaking water
  sprayWindMin: 4.5,        // U10 where droplets first tear off crests
  sprayWindFull: 18.0,      // U10 where emission saturates
  sprayLifetime: 2.2,
  sprayGravity: 9.4,
  sprayDrag: 0.9,
  sprayLaunch: 4.6,
  sprayLaunchUp: 0.45,      // vertical share of the launch impulse
  sprayLaunchWind: 0.35,    // wind velocity inherited at birth
  spraySheet: 96.0,         // particles sharing one tear-off site
  spraySheetRate: 5.0,      // new tear-off sites per second
  spraySheetSpread: 2.2,    // sheet extent along the crest, m
  sprayShred: 1.6,          // downwind length of a sheet at the moment it tears
  sprayTurbulence: 2.0,
  sprayShear: 0.35,         // log wind gradient with height
  spraySizeMin: 0.018,     // billboards are parcels of spray, not single drops
  spraySizeMax: 0.15,
  spraySize: 1.0,
  sprayStretch: 0.030,      // shutter the motion smear is integrated over, s
  sprayOpacity: 0.85,
  sprayFadeNear: 0.4,
  sprayMinPixels: 1.15,    // sub-pixel droplets are grown and dimmed, not dropped
  sprayFarSoft: 1.6,       // extra edge softness once held at the pixel floor
  spraySurfFade: 0.30,      // soft fade as a billboard enters the water, m
  sprayAerial: 0.0012,
  sprayGrain: 0.85,         // how far each parcel is broken up into droplet texture
  sprayGrainScale: 5.2,     // droplet clumps across one billboard
  sprayGrainAniso: 3.0,     // that texture drawn out along the direction of flight

  // ---- spindrift & sea mist ----
  sprayMist: 0.0,           // spindrift removed: it read as grey smear and every
                            // mist parcel is a large, long-lived, overdraw-heavy
                            // billboard. The whole budget now goes to droplets.
  sprayMistWind: 7.0,       // U10 where a mist veil first hangs over the crests
  sprayMistLife: 7.0,
  sprayMistSize: 0.55,
  sprayMistRadius: 2.5,     // the veil works over a far larger disc than droplets do
  sprayMistDrag: 4.0,
  sprayMistFall: 0.06,      // gravity felt by mist, relative to droplets
  sprayMistRise: 0.6,
  sprayMistGrow: 2.0,
  sprayMistStretch: 0.30,   // a spindrift filament is a real object, not a blur
  sprayMistOpacity: 0.0,
  sprayMistGrain: 0.55,     // spindrift is torn into streaks, not smooth puffs

  // ---- spray optics ----
  sprayScatter: 1.0,
  sprayForwardG: 0.80,
  sprayBackG: 0.35,
  sprayAmbient: 0.6,
  sprayMulti: 0.05,

  // ---- storm haze ----
  sprayHaze: 0.00040,       // extinction at the sea surface, 1/m
  sprayHazeWind: 20.0,
  sprayHazeHeight: 12.0,
  sprayHazeScatter: 1.0,
  sprayHazeAmbient: 0.7,
  sprayHazeG: 0.6,
  sprayHazeSheets: 0.7,     // how much of the layer is torn into drifting sheets
  sprayHazeSheetSize: 260.0, // size of one of those sheets, m
  sprayHazeSteps: 12,

  // ---- sun & sky ----
  sunElevation: 7.5,        // degrees
  sunAzimuth: 55.0,
  sunIntensity: 22.0,
  sunTint: [1.0, 1.0, 1.0],
  turbidity: 1.0,
  ozone: 1.0,
  mieG: 0.76,
  atmoExposure: 1.0,
  skyMultiScatter: 1.0,     // gain on the >=2nd order scattering series
  skyMSFloor: 0.12,         // isotropic part of the multi-scatter source
  skyMSHeight: 12000.0,     // altitude the multi-scatter source is sampled at, m
  sunAngularRadius: 0.00465,
  sunDiscIntensity: 1.0,
  sunDiscCap: 20000.0,      // soft radiance ceiling on the discs (RGBA16F limit)
  sunLimbDarkening: 1.0,
  sunRefractFlatten: 0.16,  // vertical squash of a disc near the horizon
  moonElevation: -20.0,
  moonAzimuth: 240.0,
  moonIntensity: 0.0,
  stars: 0.0,
  starSize: 0.9,           // point-spread sigma, pixels
  starDensity: 0.34,        // limiting magnitude: how much of the field shows
  starColorTemp: 0.45,      // B-V spread; 0 is a field of white dots
  skyDither: 1.4,           // sub-texel jitter on the sky LUT fetch, texels

  // ---- clouds ----
  cloudCoverage: 0.46,
  cloudDensity: 1.0,
  cloudAltitude: 1500.0,
  cloudThickness: 2200.0,
  cloudSpeed: 1.0,
  cloudDetail: 0.6,
  cirrus: 0.28,
  cloudSteps: 48,
  cloudScale: 16000.0,      // weather-map cluster size, m
  cloudShape: 1300.0,       // base billow size, m
  cloudExtinction: 0.045,   // 1/m at full density
  cloudAnvil: 0.0,          // flattens and spreads the tops
  cloudMultiScatter: 0.66,  // per-octave falloff of the MS approximation
  cloudPowder: 0.7,         // dark-edge term on the shadow side
  cloudAmbient: 1.0,
  cloudAmbientFloor: 0.32,  // sky fill reaching the shadowed base vs the top
  cloudSilver: 1.0,         // backlit rim
  cloudDistance: 55000.0,   // march cutoff, m
  cloudHaze: 1.0,           // aerial perspective weight on the deck
  cloudFade: 0.55,          // fraction of the range where the deck starts to go
  cirrusAltitude: 8200.0,
  cirrusCurl: 1.0,          // domain warp that bends the fibres
  cirrusMask: 3.2,          // patchiness scale, in 9 km units

  // ---- wave runner ----
  wrTopSpeed: 24.0,         // m/s; a real ski tops out near 30
  wrAccel: 11.0,
  wrBrake: 14.0,
  wrBoost: 1.35,
  wrTurnRate: 0.85,         // rad/s at planing speed, full lock
  wrSteerLag: 5.0,          // how fast the bars themselves move
  wrYawInertia: 3.0,        // how fast the hull starts rotating once they do
  wrGrip: 2.1,              // lateral velocity bleed; lower drifts wider
  wrAirGrip: 0.25,
  wrTurnDrag: 0.30,         // speed scrubbed by hard turning
  wrCoastSteer: 0.30,       // a jet drive off the throttle barely steers
  wrAirSteer: 0.25,         // a hull in the air has almost nothing to bite on
  wrBank: 0.55,
  wrHover: 0.35,            // ride height above the surface, m
  wrStiffness: 26.0,        // suspension following the water
  wrDamping: 7.0,
  wrGravity: 13.0,
  wrLaunch: 1.0,            // how eagerly it leaves a falling crest
  wrLaunchThreshold: 3.2,   // surface fall rate (m/s) that throws it clear
  wrLandingDrag: 0.35,
  wrAttitudeRate: 9.0,
  wrLength: 1.6,            // probe spacing bow to centre, m
  wrBeam: 0.6,
  wrCamHeight: 1.05,        // eye above the deck
  wrCamTilt: -0.03,
  wrCamPitchFollow: 0.75,
  wrCamRollFollow: 0.6,
  wrShake: 1.0,
  wrFovKick: 14.0,          // degrees of field of view bought by speed
  wrTouchSteer: 1.6,
  wrProbeSmooth: 16.0,      // tracks the probe readback without following its steps
  wrCarveTurn: 1.9,         // Shift: how much extra rotation a hard lean buys
  wrCarveGrip: 0.45,        // and how much grip it gives up, so the tail slides
  wrCarveDrag: 2.2,         // and how much speed it scrubs
  wrWakeInterval: 0.07,     // seconds between trail samples
  wrWakeSpeed: 0.55,
  wrWakeTurn: 0.8,
  wrWakeSlip: 0.10,
  wakeWidth: 1.5,           // half-width of the scar at birth, m
  wakeLife: 7.0,
  wakeStrength: 1.25,
  wakeSpread: 0.28,         // how fast it widens with age
  craftSprayAmount: 1.0,
  craftSpraySpread: 2.6,
  craftSprayUp: 3.4,
  wrView: 1,                // 0 rider POV, 1 chase
  wrCamDistance: 6.4,
  wrCamRise: 2.4,
  wrCamLag: 5.0,            // the rig is pulled to its mark, not pinned to it
  wrCamLook: 2.2,           // how far ahead of the craft the rig aims
  wrCamLookRise: 0.75,
  wrCamMinClear: 0.7,       // the chase rig never sinks into the sea
  wrCamChaseRoll: 0.35,
  craftScale: 1.0,
  craftGloss: 0.45,
  craftHullColor: [0.62, 0.055, 0.045],
  craftAccentColor: [0.03, 0.035, 0.045],
  craftSeatColor: [0.05, 0.05, 0.055],

  // ---- look ----
  lookSensitivity: 1.0,
  invertLookY: 0,

  // ---- camera ----
  fov: 38,
  minAltitude: 0.6,
  handheld: 0.35,
  cameraBob: 0.0,
  moveSpeed: 12,

  // ---- post ----
  exposure: 1.0,
  exposureBias: 0.0,
  autoExposure: 1.0,
  exposureSpeed: 1.6,
  exposureSpeedUp: 2.4,     // iris stops down faster than it opens
  exposureTarget: 0.105,
  exposureMin: 0.004,
  exposureMax: 6.0,
  meterCenter: 0.65,        // 0 = full frame average, 1 = tight centre weight
  meterHighlight: 1.8,      // discount on stops above the running key
  meterShadow: 0.4,         // discount on stops below it
  meterSigma: 1.75,         // sd above the key taken as "the highlights" (~96th pct)
  meterHiTarget: 0.82,      // exposed value that percentile is held at
  tonemap: 0,               // 0 AgX, 1 ACES, 2 Reinhard
  bloomIntensity: 0.08,
  bloomThreshold: 1.1,
  bloomKnee: 0.6,
  bloomRadius: 1.0,
  bloomClamp: 120.0,
  bloomAnamorphic: 0.15,
  bloomFalloff: 0.82,       // per-octave weight; 1 = 1/r^2 lens PSF
  bloomVeil: 0.016,         // unthresholded scatter feeding the wide tail
  glareIntensity: 0.09,     // gain on the wide veiling-glare tap
  glareSpread: 3,           // octave the veiling tail is taken from; higher = wider
  bloomTint: [1.0, 0.96, 0.92],
  bloomTintAmount: 0.35,
  halation: 0.030,
  halationTint: [1.0, 0.30, 0.10],
  chromatic: 1.2,           // red-to-blue separation AT THE CORNER, in pixels
  distortion: -0.02,        // <0 barrel, >0 pincushion
  vignette: 0.5,
  vignetteRound: 0.7,
  grain: 0.016,
  grainSize: 1.7,           // px per grain cell
  grainChroma: 0.22,
  grainShadow: 0.35,        // 0 = film granularity (midtones), 1 = read noise (toe)
  blackPoint: 0.0,          // scene-linear black subtraction; <0 lifts (flare)
  toeStrength: 0.45,        // stops of extra shadow density under middle grey
  toeRange: 2.6,            // how far down the toe reaches, stops
  chromaRestore: 0.18,      // steer back to scene hue after the per-channel curve
  contrast: 1.13,           // about middle grey, in log2
  saturation: 1.02,
  postSaturation: 1.04,     // print saturation, after the tone curve
  temperature: 0.0,
  tintCC: 0.0,
  splitTone: 0.25,
  splitShadow: [0.93, 0.97, 1.08],
  splitHighlight: [1.05, 1.0, 0.95],
  lift: [0.0, 0.002, 0.006],
  gammaCC: [1.0, 1.0, 1.0],
  gain: [1.0, 1.0, 1.0],
  highlightRoll: 1.0,
  fxaa: 1.0,

  // ---- quality ----
  fftSize: 256,
  gridRadial: 400,
  gridAngular: 640,
  sprayTexSize: 160,
  renderScale: 1.0,
  photoSamples: 24,
};

const C = (key, label, opts = {}) => ({ key, label, type: 'color', ...opts });
const S = (key, label, min, max, step = 0.001, opts = {}) => ({ key, label, type: 'range', min, max, step, ...opts });
const B = (key, label) => ({ key, label, type: 'bool' });
const E = (key, label, options) => ({ key, label, type: 'enum', options });

export const SCHEMA = [
  {
    group: 'Sea State', open: true, items: [
      S('windSpeed', 'Wind speed (m/s)', 0.5, 40, 0.1, { rebuild: true }),
      S('windDirDeg', 'Wind direction', 0, 360, 1, { rebuild: true }),
      S('fetch', 'Fetch (km)', 1, 1200, 1, { rebuild: true }),
      S('depth', 'Depth (m)', 3, 4000, 1, { rebuild: true }),
      S('amplitude', 'Amplitude', 0, 3, 0.005, { rebuild: true }),
      S('choppiness', 'Choppiness', 0, 2.5, 0.005 ),
      S('choppyLong', 'Long-wave choppiness x', 0.5, 3, 0.005),
      S('crestSharpen', 'Crest sharpening', 0, 4, 0.005),
      S('spread', 'Directional spread', 0.2, 4, 0.01, { rebuild: true }),
      S('spreadTail', 'Chop long-crestedness', 0.5, 6, 0.01, { rebuild: true }),
      S('alignment', 'Wind alignment', 0, 1, 0.005, { rebuild: true }),
      S('peakEnhancement', 'Peak sharpness (gamma)', 1, 7, 0.01, { rebuild: true }),
      S('tailSaturation', 'Equilibrium tail', 0, 2, 0.005, { rebuild: true }),
      S('shortWaveFade', 'Capillary rolloff', 0, 1, 0.005, { rebuild: true }),
      S('timeScale', 'Time scale', 0, 3, 0.005),
      S('loopPeriod', 'Loop period (s, 0=off)', 0, 600, 1),
      S('seed', 'Seed', 1, 9999, 1, { rebuild: true, integer: true }),
    ],
  },
  {
    group: 'Swell', items: [
      S('swellAmount', 'Swell height', 0, 2.5, 0.005, { rebuild: true }),
      S('swellPeriod', 'Swell period (s)', 4, 25, 0.1, { rebuild: true }),
      S('swellDirDeg', 'Swell direction', 0, 360, 1, { rebuild: true }),
      S('swellSpread', 'Swell narrowness', 0.5, 40, 0.1, { rebuild: true }),
      S('swellWidth', 'Swell bandwidth', 0.01, 0.3, 0.002, { rebuild: true }),
    ],
  },
  {
    group: 'Surface', items: [
      S('heightScale', 'Vertical gain', 0, 3, 0.005),
      S('horizScale', 'Horizontal gain', 0, 2, 0.005),
      S('detailScale', 'Detail distance', 0.25, 4, 0.01),
      S('earthCurve', 'Planet curvature', 0, 1, 0.01),
      S('rMax', 'Far radius (m)', 5000, 90000, 100),
    ],
  },
  {
    group: 'Foam', items: [
      S('foamAmount', 'Coverage', 0, 3, 0.005),
      S('foamCoverage', 'Whitecap fraction x', 0, 4, 0.005),
      S('foamSoftness', 'Breaking softness', 0.05, 3, 0.005),
      S('foamFace', 'Forward-face bias', 0, 1, 0.005),
      S('foamBreakScale', 'Breaker scale (m)', 0.5, 40, 0.1),
      S('foamCrestAniso', 'Crest elongation', 1, 12, 0.05),
      S('foamRidge', 'Crest ridge gate', 0, 1, 0.005),
      S('foamBreakup', 'Raft breakup', 0, 2, 0.005),
      S('foamWindMin', 'Whitecap onset (m/s)', 0, 12, 0.1),
      S('foamInject', 'Injection', 0, 3, 0.005),
      S('foamFreshDecay', 'Fresh foam decay', 0.05, 4, 0.005),
      S('foamDecay', 'Decay rate', 0.01, 3, 0.005),
      S('foamThin', 'Raft thinning', 0, 0.6, 0.002),
      S('foamDrift', 'Downwind drift (m/s)', 0, 3, 0.005),
      S('foamSpread', 'Spread rate', 0, 8, 0.01),
      S('foamDetail', 'Bubble relief', 0, 5, 0.01),
      S('foamCrisp', 'Bubble-edge crispness', 0, 1, 0.005),
      S('foamSharp', 'Edge erosion', 0.2, 6, 0.01),
      S('foamStreak', 'Downwind streaking', 0, 1, 0.005),
      S('foamOpacity', 'Opacity', 0, 1, 0.005),
      S('foamFar', 'Distance self-hiding', 0, 1, 0.005),
      S('foamRoughness', 'Roughness', 0.05, 1, 0.005),
      S('foamTint', 'Water tint', 0, 1, 0.005),
      S('foamLift', 'Crest lift', 0, 3, 0.005),
      C('foamColor', 'Colour'),
    ],
  },
  {
    group: 'Water Optics', items: [
      C('scatterColor', 'Scattering albedo'),
      S('scatterAmount', 'Upwelling reflectance', 0, 0.6, 0.001),
      S('sssStrength', 'Subsurface', 0, 6, 0.005),
      S('sssPower', 'Subsurface focus', 1, 24, 0.05),
      S('sssHeight', 'Crest weighting', 0, 3, 0.005),
      S('sssDepth', 'Wave thickness', 0.05, 4, 0.005),
      S('sssBias', 'Subsurface exit bias', 0, 1.5, 0.005),
      S('baseRoughness', 'Base roughness', 0.001, 0.4, 0.001),
      S('roughnessGain', 'Filtered roughness', 0, 3, 0.005),
      S('roughnessMax', 'Roughness ceiling', 0.05, 1, 0.005),
      S('windAniso', 'Slope anisotropy', 0.3, 4, 0.005),
      S('capillary', 'Capillary detail', 0, 3, 0.005),
      S('capillaryScale', 'Capillary range', 0.2, 4, 0.01),
      S('waveAO', 'Wave occlusion', 0, 2, 0.005),
      S('waveShadow', 'Swell shadowing', 0, 1, 0.005),
      S('shadowScale', 'Shadow reach', 0.1, 5, 0.01),
      S('interReflect', 'Inter-reflection', 0, 1, 0.005),
      S('skyAmbient', 'Sky ambient', 0, 3, 0.005),
      S('skyBlur', 'Reflection blur', 0.1, 4, 0.005),
      S('glitter', 'Glitter', 0, 3, 0.005),
      S('glitterScale', 'Glitter scale', 0.1, 4, 0.005),
      S('specIntensity', 'Sun specular', 0, 4, 0.005),
      S('specClamp', 'Specular clamp', 20, 40000, 10),
      S('specAA', 'Specular antialiasing', 0, 4, 0.005),
      S('grazeFocus', 'Grazing lobe focus', 0.02, 1, 0.005),
      S('horizonBend', 'Horizon bend', 0, 1, 0.005),
      S('aerial', 'Aerial perspective', 0, 2, 0.005),
      S('waterIOR', 'Index of refraction', 1.0, 1.8, 0.001),
    ],
  },
  {
    group: 'Spray', items: [
      S('sprayOpacity', 'Opacity', 0, 2, 0.005),
      S('sprayRate', 'Emission rate', 0, 1, 0.005),
      S('sprayThreshold', 'Breaking foam needed', 0.02, 1, 0.005),
      S('sprayFoldSoft', 'Breaking softness', 0, 0.95, 0.005),
      S('sprayFoamBias', 'Needs active breaking', 0, 1, 0.005),
      S('sprayWindMin', 'Wind onset (m/s)', 0, 30, 0.1),
      S('sprayWindFull', 'Wind saturation (m/s)', 2, 45, 0.1),
      S('sprayRadius', 'Radius (m)', 20, 1200, 5),
      S('sprayFocus', 'Near-field focus', 0.5, 4, 0.01),
      S('sprayLifetime', 'Lifetime (s)', 0.3, 10, 0.05),
      S('sprayLaunch', 'Launch speed', 0, 14, 0.05),
      S('sprayLaunchUp', 'Launch lift', 0, 3, 0.005),
      S('sprayLaunchWind', 'Launch wind share', 0, 1.5, 0.005),
      S('spraySheet', 'Sheet size (particles)', 1, 512, 1),
      S('spraySheetRate', 'Tear-off rate (1/s)', 0.5, 30, 0.5),
      S('spraySheetSpread', 'Sheet spread (m)', 0.1, 12, 0.05),
      S('sprayShred', 'Sheet shred length (m)', 0, 10, 0.05),
      S('sprayGravity', 'Gravity', 0, 20, 0.05),
      S('sprayDrag', 'Wind drag', 0, 5, 0.01),
      S('sprayTurbulence', 'Turbulence', 0, 8, 0.01),
      S('sprayShear', 'Wind shear', 0, 1.5, 0.005),
      S('spraySizeMin', 'Parcel size min (m)', 0.02, 1, 0.005),
      S('spraySizeMax', 'Parcel size max (m)', 0.05, 4, 0.005),
      S('spraySize', 'Size', 0.1, 5, 0.01),
      S('sprayStretch', 'Shutter smear (s)', 0, 0.25, 0.001),
      S('sprayFadeNear', 'Near fade (m)', 0.05, 4, 0.01),
      S('sprayMinPixels', 'Min screen size (px)', 0.5, 8, 0.05),
      S('sprayFarSoft', 'Distant softness', 0, 6, 0.01),
      S('spraySurfFade', 'Surface soft fade (m)', 0.02, 3, 0.01),
      S('sprayAerial', 'Aerial extinction (1/m)', 0, 0.01, 0.0001),
      S('sprayGrain', 'Droplet texture', 0, 1, 0.005),
      S('sprayGrainScale', 'Droplet texture scale', 0.5, 12, 0.05),
      S('sprayGrainAniso', 'Droplet texture stretch', 1, 10, 0.05),
    ],
  },
  {
    group: 'Spindrift', items: [
      S('sprayHaze', 'Haze extinction (1/m)', 0, 0.004, 0.00002),
      S('sprayHazeWind', 'Haze onset (m/s)', 0, 45, 0.1),
      S('sprayHazeHeight', 'Haze depth (m)', 1, 80, 0.5),
      S('sprayHazeScatter', 'Haze forward glow', 0, 4, 0.01),
      S('sprayHazeAmbient', 'Haze ambient', 0, 3, 0.005),
      S('sprayHazeG', 'Haze anisotropy', 0, 0.95, 0.005),
      S('sprayHazeSheets', 'Haze sheeting', 0, 1, 0.005),
      S('sprayHazeSheetSize', 'Haze sheet size (m)', 30, 1200, 5),
      S('sprayHazeSteps', 'Haze steps', 4, 24, 1),
    ],
  },
  {
    group: 'Spray Optics', items: [
      S('sprayScatter', 'Scattering', 0, 4, 0.01),
      S('sprayForwardG', 'Forward lobe', 0.1, 0.95, 0.005),
      S('sprayBackG', 'Back lobe', 0, 0.9, 0.005),
      S('sprayAmbient', 'Sky ambient', 0, 3, 0.005),
      S('sprayMulti', 'Multiple scatter', 0, 0.5, 0.002),
    ],
  },
  {
    group: 'Sun & Sky', open: true, items: [
      S('sunElevation', 'Sun elevation', -12, 90, 0.05),
      S('sunAzimuth', 'Sun azimuth', 0, 360, 0.5),
      S('sunIntensity', 'Sun intensity', 0, 60, 0.1),
      C('sunTint', 'Sun tint'),
      S('turbidity', 'Turbidity', 0.2, 8, 0.01),
      S('ozone', 'Ozone', 0, 3, 0.01),
      S('mieG', 'Mie anisotropy', 0, 0.95, 0.005),
      S('skyMultiScatter', 'Multi-scatter', 0, 3, 0.01),
      S('skyMSFloor', 'Multi-scatter floor', 0, 0.6, 0.005),
      S('skyMSHeight', 'Multi-scatter height (m)', 2000, 40000, 250),
      S('sunDiscIntensity', 'Disc intensity', 0, 4, 0.01),
      S('sunAngularRadius', 'Disc radius', 0.001, 0.05, 0.0005),
      S('sunDiscCap', 'Disc radiance cap', 500, 60000, 100),
      S('sunLimbDarkening', 'Limb darkening', 0, 1.5, 0.01),
      S('sunRefractFlatten', 'Horizon flatten', 0, 1, 0.005),
      S('moonIntensity', 'Moon light', 0, 1, 0.005),
      S('moonElevation', 'Moon elevation', -20, 90, 0.5),
      S('moonAzimuth', 'Moon azimuth', 0, 360, 1),
      S('stars', 'Stars', 0, 2, 0.005),
      S('starSize', 'Star size (px)', 0.2, 4, 0.05),
      S('starDensity', 'Star density', 0, 1, 0.005),
      S('starColorTemp', 'Star colour spread', 0, 1, 0.005),
      S('skyDither', 'LUT dither (texels)', 0, 4, 0.05),
    ],
  },
  {
    group: 'Clouds', items: [
      S('cloudCoverage', 'Coverage', 0, 1, 0.005),
      S('cloudDensity', 'Density', 0, 3, 0.005),
      S('cloudAltitude', 'Base altitude (m)', 200, 6000, 10),
      S('cloudThickness', 'Thickness (m)', 200, 6000, 10),
      S('cloudDetail', 'Erosion', 0, 1.5, 0.005),
      S('cloudSpeed', 'Drift speed', 0, 6, 0.01),
      S('cloudScale', 'Cluster size (m)', 2000, 60000, 100),
      S('cloudShape', 'Billow size (m)', 200, 6000, 10),
      S('cloudExtinction', 'Extinction (1/m)', 0.005, 0.2, 0.001),
      S('cloudAnvil', 'Anvil flatten', 0, 1, 0.005),
      S('cloudMultiScatter', 'Multi-scatter', 0, 0.95, 0.005),
      S('cloudPowder', 'Powder / dark edge', 0, 1.5, 0.005),
      S('cloudAmbient', 'Sky ambient', 0, 3, 0.005),
      S('cloudAmbientFloor', 'Ambient at base', 0, 1, 0.005),
      S('cloudSilver', 'Silver lining', 0, 4, 0.01),
      S('cloudDistance', 'March range (m)', 8000, 140000, 500),
      S('cloudHaze', 'Deck haze', 0, 3, 0.01),
      S('cloudFade', 'Distance fade start', 0.1, 1, 0.005),
      S('cirrus', 'Cirrus veil', 0, 1, 0.005),
      S('cirrusAltitude', 'Cirrus altitude (m)', 4000, 14000, 100),
      S('cirrusCurl', 'Cirrus curl', 0, 2, 0.01),
      S('cirrusMask', 'Cirrus patchiness', 0.5, 12, 0.05),
      S('cloudSteps', 'March steps', 8, 128, 1, { integer: true }),
    ],
  },
  {
    group: 'Wave Runner', items: [
      S('wrTopSpeed', 'Top speed (m/s)', 4, 60, 0.5),
      S('wrAccel', 'Acceleration', 1, 30, 0.1),
      S('wrBoost', 'Boost multiplier', 1, 2.5, 0.01),
      E('wrView', 'View', ['Rider', 'Chase']),
      S('wrTurnRate', 'Turn rate', 0.05, 2.5, 0.01),
      S('wrSteerLag', 'Steering response', 0.5, 15, 0.05),
      S('wrYawInertia', 'Hull yaw inertia', 0.3, 12, 0.05),
      S('wrGrip', 'Grip (lower drifts)', 0.2, 8, 0.02),
      S('wrTurnDrag', 'Turn speed scrub', 0, 1.5, 0.01),
      S('wrCoastSteer', 'Off-throttle steering', 0, 1, 0.01),
      S('wrCamDistance', 'Chase distance (m)', 1.5, 16, 0.1),
      S('wrCamRise', 'Chase height (m)', 0.2, 8, 0.05),
      S('wrCamLag', 'Chase lag', 0.5, 20, 0.1),
      S('wrCamLook', 'Chase look-ahead (m)', 0, 10, 0.1),
      S('wrCamChaseRoll', 'Chase roll', 0, 1, 0.01),
      S('wrProbeSmooth', 'Ride smoothing', 2, 40, 0.5),
      S('wrCarveTurn', 'Carve turn gain (Shift)', 1, 4, 0.01),
      S('wrCarveGrip', 'Carve grip loss', 0.05, 1, 0.01),
      S('wrCarveDrag', 'Carve speed scrub', 0.5, 5, 0.01),
      S('craftSprayAmount', 'Hull spray', 0, 3, 0.01),
      S('craftSpraySpread', 'Hull spray spread', 0, 8, 0.05),
      S('craftSprayUp', 'Hull spray lift', 0, 10, 0.05),
      S('wakeStrength', 'Wake strength', 0, 3, 0.01),
      S('wakeWidth', 'Wake width (m)', 0.2, 6, 0.05),
      S('wakeLife', 'Wake lifetime (s)', 1, 30, 0.1),
      S('wakeSpread', 'Wake spreading', 0, 1.5, 0.01),
      S('craftScale', 'Craft size', 0.4, 2.5, 0.01),
      S('craftGloss', 'Craft gloss', 0, 1, 0.01),
      C('craftHullColor', 'Hull colour'),
      C('craftAccentColor', 'Hull underside'),
      S('wrBank', 'Bank into turns', 0, 2, 0.01),
      S('wrHover', 'Ride height (m)', 0, 2, 0.01),
      S('wrStiffness', 'Suspension', 4, 60, 0.5),
      S('wrDamping', 'Damping', 1, 20, 0.1),
      S('wrGravity', 'Gravity', 4, 25, 0.1),
      S('wrLaunch', 'Jump off crests', 0, 3, 0.01),
      S('wrLaunchThreshold', 'Launch threshold', 0.5, 10, 0.05),
      S('wrAirSteer', 'Air control', 0, 1, 0.01),
      S('wrCamHeight', 'Eye height (m)', 0.2, 3, 0.01),
      S('wrCamPitchFollow', 'Pitch follow', 0, 1.5, 0.01),
      S('wrCamRollFollow', 'Roll follow', 0, 1.5, 0.01),
      S('wrShake', 'Ride shake', 0, 3, 0.01),
      S('wrFovKick', 'Speed FOV kick', 0, 40, 0.5),
      S('wrTouchSteer', 'Touch steering', 0, 4, 0.01),
    ],
  },
  {
    group: 'Camera', items: [
      S('fov', 'Field of view', 8, 95, 0.5, { camera: true }),
      S('minAltitude', 'Min altitude (m)', 0.1, 400, 0.1),
      S('handheld', 'Handheld drift', 0, 3, 0.005),
      S('cameraBob', 'Sea bob', 0, 3, 0.005),
      S('moveSpeed', 'Fly speed', 0.5, 200, 0.5, { camera: true }),
      S('lookSensitivity', 'Look sensitivity', 0.2, 3, 0.01),
      S('invertLookY', 'Invert look Y', 0, 1, 1, { integer: true }),
    ],
  },
  {
    group: 'Grade & Lens', items: [
      E('tonemap', 'Tonemap', ['AgX', 'ACES', 'Reinhard']),
      S('autoExposure', 'Auto exposure', 0, 1, 0.01),
      S('exposure', 'Exposure', 0.02, 12, 0.005),
      S('exposureBias', 'EV bias', -4, 4, 0.01),
      S('exposureSpeed', 'Adaptation speed', 0.05, 8, 0.01),
      S('exposureSpeedUp', 'Stop-down speed x', 0.2, 6, 0.01),
      S('exposureTarget', 'Auto target', 0.02, 0.4, 0.002),
      S('meterCenter', 'Centre metering', 0, 1, 0.01),
      S('meterHighlight', 'Meter highlight cut', 0, 6, 0.01),
      S('meterShadow', 'Meter shadow cut', 0, 6, 0.01),
      S('meterSigma', 'Highlight percentile (sd)', 0, 4, 0.05),
      S('meterHiTarget', 'Highlight protect level', 0.2, 6, 0.01),
      S('exposureMin', 'Auto floor', 0.0005, 0.5, 0.0005),
      S('exposureMax', 'Auto ceiling', 0.1, 40, 0.05),
      S('bloomIntensity', 'Bloom', 0, 0.4, 0.001),
      S('bloomThreshold', 'Bloom threshold', 0, 8, 0.01),
      S('bloomKnee', 'Bloom knee', 0.01, 3, 0.005),
      S('bloomRadius', 'Bloom radius', 0.3, 3, 0.01),
      S('bloomFalloff', 'Bloom falloff', 0.4, 1.6, 0.005),
      S('bloomVeil', 'Veil pickup', 0, 0.08, 0.0005),
      S('bloomClamp', 'Bloom firefly clamp', 1, 400, 1),
      S('glareIntensity', 'Veiling glare', 0, 0.3, 0.001),
      S('glareSpread', 'Veiling glare spread', 1, 4, 1, { integer: true }),
      S('bloomAnamorphic', 'Anamorphic', 0, 1, 0.005),
      C('bloomTint', 'Bloom tint'),
      S('bloomTintAmount', 'Bloom tint amount', 0, 1, 0.005),
      S('halation', 'Halation', 0, 0.15, 0.0005),
      C('halationTint', 'Halation tint'),
      S('chromatic', 'Chromatic aberration (px)', 0, 8, 0.05),
      S('distortion', 'Lens distortion', -0.3, 0.3, 0.002),
      S('vignette', 'Vignette', 0, 1.5, 0.005),
      S('vignetteRound', 'Vignette oval', 0, 1, 0.005),
      S('grain', 'Film grain', 0, 0.08, 0.0005),
      S('grainSize', 'Grain size (px)', 0.5, 6, 0.05),
      S('grainChroma', 'Grain chroma', 0, 1, 0.005),
      S('grainShadow', 'Grain in shadows', 0, 1, 0.005),
      S('blackPoint', 'Black point', -1, 2, 0.005),
      S('toeStrength', 'Toe density (stops)', 0, 2.5, 0.005),
      S('toeRange', 'Toe reach (stops)', 0.5, 8, 0.05),
      S('chromaRestore', 'Hue restore', 0, 1, 0.005),
      S('contrast', 'Contrast', 0.5, 1.8, 0.005),
      S('saturation', 'Saturation', 0, 2, 0.005),
      S('postSaturation', 'Print saturation', 0, 2, 0.005),
      S('temperature', 'Temperature', -1, 1, 0.005),
      S('tintCC', 'Tint', -1, 1, 0.005),
      S('splitTone', 'Split tone', 0, 1, 0.005),
      C('splitShadow', 'Split shadows'),
      C('splitHighlight', 'Split highlights'),
      S('highlightRoll', 'Highlight bloom-out', 0, 3, 0.01),
      C('lift', 'Lift'),
      C('gammaCC', 'Gamma'),
      C('gain', 'Gain'),
      S('fxaa', 'FXAA', 0, 1, 0.01),
    ],
  },
  {
    group: 'Quality', items: [
      E('fftSize', 'FFT resolution', [64, 128, 256, 512], { rebuildSim: true }),
      S('gridRadial', 'Grid radial', 48, 900, 8, { rebuildGrid: true, integer: true }),
      S('gridAngular', 'Grid angular', 64, 1536, 16, { rebuildGrid: true, integer: true }),
      E('sprayTexSize', 'Spray particles', [64, 128, 192, 256, 384], { rebuildSpray: true }),
      S('renderScale', 'Render scale', 0.35, 2, 0.05, { resize: true }),
      S('photoSamples', 'Photo mode samples', 1, 128, 1, { integer: true }),
    ],
  },
];

export const PRESETS = {
  'Golden Hour Swell': {
    windSpeed: 9.5, fetch: 320, windDirDeg: 42, amplitude: 1.0, choppiness: 1.3,
    swellAmount: 0.75, swellPeriod: 14, swellDirDeg: 24,
    sunElevation: 4.2, sunAzimuth: 48, sunIntensity: 24, turbidity: 1.5,
    cloudCoverage: 0.42, cloudAltitude: 1700, cirrus: 0.35,
    scatterColor: [0.060, 0.300, 0.335], absorption: [0.40, 0.075, 0.05],
    sssStrength: 1.9, glitter: 0.7, foamAmount: 0.85,
    exposureBias: 0.15, saturation: 1.10, chromatic: 0.7, vignette: 0.5,
    bloomIntensity: 0.06, halation: 0.010, fov: 34,
  },
  'North Atlantic Storm': {
    windSpeed: 26.0, fetch: 800, windDirDeg: 285, amplitude: 1.05, choppiness: 1.55,
    swellAmount: 1.35, swellPeriod: 15.5, swellDirDeg: 278, alignment: 0.86,
    sunElevation: 9.0, sunAzimuth: 210, sunIntensity: 17, turbidity: 3.4, ozone: 1.2,
    cloudCoverage: 0.86, cloudDensity: 1.7, cloudAltitude: 620, cloudThickness: 3400,
    cloudDetail: 0.8, cirrus: 0.1, cloudSpeed: 3.0,
    scatterColor: [0.052, 0.185, 0.215], absorption: [0.55, 0.14, 0.10],
    foamAmount: 1.0, foamDecay: 0.26, foamSpread: 1.8, foamLift: 0.9,
    sprayOpacity: 1.1, sprayRate: 0.85, sprayThreshold: 0.26, sprayLaunch: 5.4,
    sprayDrag: 1.2, sprayLifetime: 3.0, spraySize: 1.2,
    sprayMist: 0.5, sprayMistOpacity: 0.13, sprayHaze: 0.00055,
    saturation: 0.86, contrast: 1.10, exposureBias: 0.15, vignette: 0.62,
    grain: 0.020, fov: 44, handheld: 1.1, cameraBob: 0.35, minAltitude: 3.0,
  },
  'Glassy Dawn': {
    windSpeed: 3.2, fetch: 60, amplitude: 0.85, choppiness: 0.75, shortWaveFade: 0.8,
    swellAmount: 0.42, swellPeriod: 12.0,
    sunElevation: 1.4, sunAzimuth: 92, sunIntensity: 25, turbidity: 1.1,
    cloudCoverage: 0.30, cloudAltitude: 2600, cirrus: 0.5,
    scatterColor: [0.050, 0.255, 0.360], absorption: [0.36, 0.06, 0.038],
    foamAmount: 0.6, glitter: 0.95, baseRoughness: 0.035,
    sprayOpacity: 0.12, sprayRate: 0.10,
    exposureBias: 0.05, saturation: 1.05, bloomIntensity: 0.075, halation: 0.014,
    vignette: 0.4, fov: 30,
  },
  'Tropical Noon': {
    windSpeed: 7.0, fetch: 140, amplitude: 0.8, choppiness: 1.15,
    swellAmount: 0.4, swellPeriod: 10.5, depth: 26,
    sunElevation: 68, sunAzimuth: 150, sunIntensity: 23, turbidity: 1.2,
    cloudCoverage: 0.36, cloudAltitude: 900, cloudThickness: 1800, cirrus: 0.15,
    scatterColor: [0.090, 0.520, 0.570], absorption: [0.30, 0.045, 0.030],
    scatterAmount: 0.16, sssStrength: 1.5,
    foamAmount: 0.7, glitter: 0.65,
    saturation: 1.14, contrast: 1.05, exposureBias: -0.1, vignette: 0.35, fov: 42,
  },
  'Moonlit Passage': {
    windSpeed: 12.5, fetch: 300, amplitude: 1.0, choppiness: 1.35,
    swellAmount: 0.7, swellPeriod: 12.5,
    sunElevation: -8.5, sunAzimuth: 300, sunIntensity: 22, turbidity: 0.9,
    moonIntensity: 0.30, moonElevation: 34, moonAzimuth: 118, stars: 1.0,
    cloudCoverage: 0.34, cloudAltitude: 1900, cirrus: 0.22,
    scatterColor: [0.035, 0.135, 0.200], absorption: [0.55, 0.16, 0.10],
    skyAmbient: 1.3, glitter: 0.35, foamAmount: 1.1,
    sprayOpacity: 0.6, exposureBias: 0.6, saturation: 0.9, contrast: 1.08,
    bloomIntensity: 0.09, vignette: 0.7, grain: 0.022, fov: 40,
  },
  'Trade Winds': {
    windSpeed: 13.5, fetch: 450, windDirDeg: 75, amplitude: 1.0, choppiness: 1.4,
    swellAmount: 0.85, swellPeriod: 13.5, swellDirDeg: 68,
    sunElevation: 26, sunAzimuth: 96, sunIntensity: 22, turbidity: 1.7,
    cloudCoverage: 0.52, cloudAltitude: 1100, cloudThickness: 2100, cirrus: 0.25,
    foamAmount: 1.35, sprayOpacity: 0.95, sprayRate: 0.45,
    saturation: 1.06, exposureBias: 0.0, fov: 40,
  },
  'Hurricane Sea': {
    windSpeed: 38.0, fetch: 1000, amplitude: 1.1, choppiness: 1.7, alignment: 0.75,
    swellAmount: 1.9, swellPeriod: 17.0, spread: 1.5,
    sunElevation: 14, sunAzimuth: 190, sunIntensity: 14, turbidity: 5.0,
    cloudCoverage: 0.95, cloudDensity: 2.2, cloudAltitude: 380, cloudThickness: 4200,
    cloudSpeed: 5.0, cloudDetail: 0.9, cirrus: 0.0,
    scatterColor: [0.055, 0.160, 0.180], absorption: [0.62, 0.18, 0.13],
    foamAmount: 1.1, foamDecay: 0.18, foamSpread: 2.4, foamLift: 1.2,
    sprayOpacity: 1.3, sprayRate: 1.0, sprayThreshold: 0.22, sprayLaunch: 7.5,
    sprayDrag: 1.6, sprayLifetime: 3.6, spraySize: 1.5, sprayRadius: 200,
    sprayMist: 0.6, sprayMistOpacity: 0.16, sprayMistLife: 9.0, sprayHaze: 0.0012,
    saturation: 0.72, contrast: 1.14, exposureBias: 0.25, vignette: 0.75,
    grain: 0.028, fov: 52, handheld: 2.0, cameraBob: 0.8, minAltitude: 6.0,
  },
  'Deep Blue Afternoon': {
    windSpeed: 10.0, fetch: 600, amplitude: 0.95, choppiness: 1.25,
    swellAmount: 0.6, swellPeriod: 12.0, depth: 3500,
    sunElevation: 42, sunAzimuth: 235, sunIntensity: 23, turbidity: 1.3,
    cloudCoverage: 0.40, cloudAltitude: 2200, cirrus: 0.3,
    scatterColor: [0.028, 0.150, 0.300], absorption: [0.48, 0.085, 0.032],
    foamAmount: 0.95, glitter: 0.6,
    saturation: 1.08, contrast: 1.04, fov: 36,
  },
};
