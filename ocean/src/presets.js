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
  // Wind gusts arriving in patches - the "cat's paws" that dominate sheltered
  // water on a light-air day. 0 is off, which is what every preset written
  // before this existed gets.
  gust: 0.0,                // strength of the rough/smooth mottling
  gustScale: 55.0,          // patch size, m
  gustDrift: 0.35,          // how fast patches travel downwind
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
  sprayStretch: 0.014,      // shutter the motion smear is integrated over, s
  sprayOpacity: 0.85,
  sprayFadeNear: 0.95,      // billboards this close to the lens fade out: at
                            // chase range the near plume was a wall of white over
                            // the craft, and the water on the glass says the same
                            // thing without hiding what you are steering
  sprayMinPixels: 1.15,    // sub-pixel droplets are grown and dimmed, not dropped
  sprayFarSoft: 1.6,       // extra edge softness once held at the pixel floor
  spraySurfFade: 0.30,      // soft fade as a billboard enters the water, m
  sprayAerial: 0.0012,
  sprayGrain: 0.85,         // how far each parcel is broken up into droplet texture
  sprayGrainScale: 5.2,     // droplet clumps across one billboard
  sprayGrainAniso: 1.5,     // that texture drawn out along the direction of flight

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

  // ---- water on the lens ----
  // Only ever wet while riding: it is the craft's own spray hitting the glass, so
  // the free camera is a tripod on a dry day and pays nothing for any of this.
  lensWater: 1.0,           // master
  lensDrops: 0.30,          // fraction of cells holding a droplet when soaked. The
                            // lattice is four times finer than it was, so the same
                            // count needs a higher fraction of a smaller cell.
  lensSize: 0.60,           // beads, not blobs
  lensRefract: 0.8,         // how hard a droplet bends the picture behind it
  lensStreak: 0.55,         // how far it creeps downstream before drying
  lensFlowAngle: 8.0,       // degrees from vertical that the airflow drags it
  lensRim: 0.09,            // brightness of the meniscus edge
  lensBody: 0.55,           // how much the water itself darkens what it covers
  lensFilm: 0.12,           // unbroken film before it beads up
  lensSpray: 0.85,          // how much of the hull's own output reaches the glass
  lensReach: 26.0,          // how far aft the plume still reaches, m
  lensWetRate: 7.0,         // how fast it wets, 1/s
  lensDry: 0.95,            // ...and how slowly it dries. Faster now, so a hit
                            // reads as a hit and then clears rather than sitting
                            // on the glass for the whole ride.

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
  cloudStepScale: 1.0,      // adaptive multiplier - the cloud march is the
                            // largest single item in a riding frame
  cloudStepMin: 0.4,
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
  wrTopSpeed: 44.0,         // m/s, about 85 kn. Past what a real ski will do -
                            // this is the arcade end of the dial - but the field
                            // of view, the chase pull-back and the jump criterion
                            // are all normalised by it, so raising it scales all
                            // three instead of needing them retuned.
  wrAccel: 19.0,            // ...and it has to be able to get there
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
  wrLaunch: 1.0,            // overall gain on both launch triggers
  wrLaunchThreshold: 3.2,   // surface fall rate (m/s) that throws it clear
  // Jumping a wave face. v_up = v_forward * slope, so how far it flies is set by
  // how fast it hit the face - which is what makes charging a swell worthwhile.
  wrJumpSpeed: 5.0,         // forward speed (m/s) below which it never leaves
  wrLaunchG: 0.72,          // fraction of gravity the water has to beat to shake
                            // the hull off it. 1.0 is the exact physical value;
                            // a little under compensates for the probe filter
                            // flattening the peak of the acceleration.
  wrJumpGain: 1.35,         // how much of the face's lift becomes airtime
  wrSurfFilter: 22.0,       // low-pass on the surface velocity and acceleration
  wrLandingDrag: 0.35,
  wrAttitudeRate: 9.0,
  wrLength: 1.6,            // probe spacing bow to centre, m
  wrBeam: 0.6,
  wrCamHeight: 1.42,        // eye above the deck. The imported hull sits higher
                            // than the procedural one it replaced, so the rider was
                            // left looking along the deck rather than over it.
  wrCamTilt: -0.03,
  wrCamPitchFollow: 0.75,
  wrCamRollFollow: 0.6,
  wrShake: 1.0,
  wrFovKick: 18.0,          // degrees of field of view bought by speed, at the
                            // top of the range rather than at 45% of it
  wrBoostFov: 7.0,          // extra degrees the moment the boost is held
  wrFovLag: 2.6,            // how fast the lens breathes into it
  wrTouchSteer: 1.6,
  wrProbeSmooth: 16.0,      // tracks the probe readback without following its steps
  wrCarveTurn: 1.9,         // Shift: how much extra rotation a hard lean buys
  wrCarveGrip: 0.45,        // and how much grip it gives up, so the tail slides
  wrCarveDrag: 2.2,         // and how much speed it scrubs
  wrWakeSpeed: 0.55,
  wrWakeTurn: 0.8,
  wrWakeSlip: 0.10,
  wakeExtent: 320,          // metres across the world-space wake buffer. This is
                            // the only thing bounding how much of your own path
                            // the sea still remembers.
  wakeTexSize: 512,         // ...and how finely, at extent/size metres per texel
  wakeWidth: 1.5,           // half-width of a cusp arm where it leaves the hull
  wakeSpread: 0.22,         // how much it thickens per second as it travels out
  wakeLife: 14.0,           // how long a patch of water stays disturbed
  wakeStrength: 1.15,
  wakeArmRate: 1.0,         // multiplier on the Kelvin half-angle spread rate
  wakeArm: 1.0,             // strength of the arms themselves
  wakeCentre: 0.5,          // aerated churn between them
  wakeDepth: 0.45,          // how far the wake actually deforms the surface, m
  wakeSlick: 0.8,           // how completely the churn wipes out the sea's own
                            // ripples and wind foam inside the track
  wakeRelief: 1.0,          // ...and how much of that deformation lights up. The
                            // vertex shader moves the surface; without this the
                            // ridge would be a silhouette with a flat sea's
                            // shading normal painted on it.
  wakeProbe: 0.8,           // how much of that the hull feels when it crosses it
  craftLift: 0.46,          // rides the hull's designed waterline on the surface
  craftSprayAmount: 1.0,
  craftReflect: 1.0,        // strength of the craft's own image in the water
  craftReflectFade: 180.0,  // metres of altitude over which that image fades out

  // ---- the seaplane (demo/seaplane.js) ----
  // Sized on a Cessna 208 on floats: 11.5 m long, rotates around 24 m/s,
  // cruises near 60. spCgHeight is where the CG rides above the waterline at
  // rest - the mesh keel sits about 2.4 m under the CG on this hull.
  spLength: 10.5,           // metres nose to tail; the mesh is unit-length
  spScale: 1.0,
  spThrust: 5.4,            // m/s^2 at full lever, static
  spTopSpeed: 61.0,         // m/s, level flight, full throttle
  spTakeoff: 23.0,          // m/s rotation speed
  spStall: 15.0,            // m/s; below this the wing mushes
  spWaterTurn: 0.45,        // rad/s water rudder at speed
  spMaxBank: 0.78,          // rad, full lateral stick
  spMaxPitch: 0.42,         // rad, full pull
  spRollRate: 2.4,          // 1/s lag rates toward the stick
  spPitchRate: 2.0,
  spCgHeight: 2.05,         // m, CG above the waterline at rest
  spCamDistance: 26.0,      // chase rig, at rest
  spCamRise: 7.0,
  spCamLook: 40.0,          // metres ahead the chase camera leads
  spFovKick: 9.0,           // degrees of lens at full speed
  spPropIdle: 12.0,         // rad/s with the lever closed - an engine still runs
  spPropRpm: 95.0,          // rad/s at full power. Past the frame rate this
                            // aliases into a slow backward crawl, which is what
                            // a real propeller does on camera too.

  hullPush: 0.55,           // depth of the hollow the hull presses, m
  hullRadius: 2.6,          // along-hull extent of that footprint, m
  hullBow: 0.9,             // how much of it stands back up as bow wave
  craftPlaneSpeed: 6.0,     // m/s the hull starts to plane; below this, no spray
  craftPlaneFull: 14.0,     // m/s where shedding saturates
  craftSprayLife: 0.85,     // thrown water falls straight back; it must not hang
  craftSprayPulse: 0.30,    // overall share of the budget the hull may claim. Any
                            // higher and the plume is a white ball with the craft
                            // somewhere inside it.
  craftLoadFull: 22.0,      // hull load (m/s^2) at which carve spray saturates
  craftSpraySpread: 1.0,    // multiplier on every source's cone width
  craftSprayUp: 1.0,        // ...and on how much of each launch is aimed upward
  // The four hull sources. Weights are relative, so raising one steals share
  // from the others rather than adding particles on top.
  craftJet: 1.0,            // pump jet out of the steering nozzle
  craftJetSpeed: 17.0,      // nozzle exit speed, m/s
  craftJetAngle: 0.60,      // nozzle deflection at full lock, radians
  craftJetRise: 0.42,       // nozzle trim: what stands the rooster tail up
  craftSheet: 0.85,         // sheets peeling off the planing chines
  craftSheetSpeed: 0.42,    // as a fraction of hull speed
  craftCurtain: 1.15,       // the wall a sideways-sliding hull shovels up
  craftCurtainSpeed: 1.8,   // per m/s of sideslip
  craftBurst: 0.9,          // bow crown on landing or punching a crest
  craftSprayOpacity: 1.0,   // hull water is a dense sheet, not a few droplets
  craftSprayMulti: 0.28,    // ...and a dense sheet scatters light many times
                            // inside itself, which is what makes real hull spray
                            // read bright white whichever way the sun is
  wrView: 1,                // 0 rider POV, 1 chase
  wrCamDistance: 12.0,      // at rest
  wrCamPull: 1.35,          // extra chase distance at top speed, as a fraction.
                            // The rig falling back as the craft accelerates away
                            // is most of what makes speed read in a chase shot.
  wrCamRise: 4.6,
  wrCamLift: 0.75,          // ...and climbs as it falls back, so at speed it is
                            // looking down over the plume instead of straight
                            // through it
  wrCamLag: 5.0,            // the rig is pulled to its mark, not pinned to it
  wrCamLook: 3.0,           // how far ahead of the craft the rig aims
  wrCamLookRise: 0.75,
  wrCamMinClear: 0.7,       // the chase rig never sinks into the sea
  wrCamChaseRoll: 0.35,
  craftScale: 1.0,
  craftLength: 3.2,         // metres bow to transom; the mesh is unit-length
  // Imported meshes arrive in whatever convention the authoring tool used. These
  // three rotate the model into the renderer's (bow at -Z, +Y up) without
  // re-exporting anything.
  craftYawOffset: 3.1416,
  craftPitchOffset: 0.0,
  craftRollOffset: 0.0,
  craftWetDarken: 0.55,     // how much darker the permanently wet hull is
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
  gridScale: 1.0,           // adaptive multiplier on both grid dimensions
  gridScaleMin: 0.45,       // how far the adaptive controller may thin it
  gridRadial: 400,
  gridAngular: 640,
  sprayTexSize: 160,
  renderScale: 1.0,
  adaptiveQuality: 1,       // trim resolution until the target frame rate is met
  // ---- duty cycle ----
  // How hard this is allowed to work the machine, as opposed to how good it is
  // allowed to look. The quality knobs below trade picture for frame rate, which
  // is not the same thing: a laptop gets hot because of work per second, and only
  // capping the frame rate or the pixel count reduces that.
  fpsCap: 60,               // 0 = uncapped (runs at the display's refresh rate)
  fpsCapIdle: 10,           // ...and when the window is not in front
  dprCap: 1.75,             // ceiling on device pixel ratio. A Retina panel at 2
                            // is 4x the pixels of 1 for a difference you have to
                            // look for.
  powerPref: 'default',     // 'high-performance' explicitly asks a switchable-
                            // graphics laptop for its discrete GPU. Reload to
                            // apply - the context cannot change it afterwards.
  targetFps: 40,
  renderScaleMin: 0.4,
  renderScaleMax: 1.0,
  photoSamples: 24,
};

// THE WAVE-FEEL BAND, learned the hard way. A field report described six of
// these presets as "bubbling tar", and the split was exact: every preset that
// read as WAVES sat at choppiness 0.75-1.15 with amplitude 0.62-0.85, often
// swell-dominated; every preset that read as tar ran choppiness 1.25-1.7 at
// amplitude ~1.0, storms adding widened spread. High choppiness pinches
// crests into blobs that rise and collapse in place, and at full amplitude
// the surface sits past its steepness limit everywhere - churn with no
// visible travel. So: keep choppiness at or under ~1.2 (storms ~1.3), keep
// amplitude under ~0.95, and when a preset needs to feel BIG, put the height
// in a long-period swell - a 15-second swell train reads as the ocean moving;
// wind-sea chop at the same energy reads as boiling.
export const PRESETS = {
  'Golden Hour Swell': {
    windSpeed: 9.5, fetch: 320, windDirDeg: 42, amplitude: 0.85, choppiness: 1.05,
    swellAmount: 0.75, swellPeriod: 14, swellDirDeg: 24,
    sunElevation: 4.2, sunAzimuth: 48, sunIntensity: 24, turbidity: 1.5,
    cloudCoverage: 0.42, cloudAltitude: 1700, cirrus: 0.35,
    scatterColor: [0.060, 0.300, 0.335], absorption: [0.40, 0.075, 0.05],
    sssStrength: 1.9, glitter: 0.7, foamAmount: 0.85,
    exposureBias: 0.15, saturation: 1.10, chromatic: 0.7, vignette: 0.5,
    bloomIntensity: 0.06, halation: 0.010, fov: 34,
  },
  'North Atlantic Storm': {
    windSpeed: 26.0, fetch: 800, windDirDeg: 285, amplitude: 0.9, choppiness: 1.25,
    swellAmount: 1.35, swellPeriod: 15.5, swellDirDeg: 278, alignment: 0.9,
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
    // The dawn calm was first dimmed through OPACITY (0.12 over rate 0.10),
    // which also dimmed the wave runner's plume to a ghost - opacity is shared
    // with the craft's spray, rate is not. Moved to the rate side keeping the
    // product (visible ambient spray ~ rate x opacity: 0.10x0.12 = 0.02x0.6),
    // so the dawn looks the same and the rooster tail renders at full body.
    sprayOpacity: 0.6, sprayRate: 0.02,
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
    windSpeed: 12.5, fetch: 300, amplitude: 0.85, choppiness: 1.05,
    swellAmount: 0.9, swellPeriod: 13.5,
    sunElevation: -16.0, sunAzimuth: 300, sunIntensity: 22, turbidity: 0.9,
    moonIntensity: 0.28, moonElevation: 26, moonAzimuth: 318, stars: 1.0,
    specIntensity: 1.5,
    cloudCoverage: 0.34, cloudAltitude: 1900, cirrus: 0.22,
    scatterColor: [0.035, 0.135, 0.200], absorption: [0.55, 0.16, 0.10],
    skyAmbient: 1.3, glitter: 0.35, foamAmount: 1.1,
    // The only preset with the sun below the horizon, and the only one where a
    // fully automatic iris is wrong. autoExposure blends towards
    // exposureTarget/avg, so at 1.0 it normalises *any* scene to the same average
    // brightness - which lands a moonlit sea on exactly the same mid-grey as noon
    // and gives you daylight with stars pasted over it. Trimming it to 0.3 keeps
    // enough adaptation to follow moonIntensity without erasing the night.
    autoExposure: 0.3,
    sprayOpacity: 0.6, exposureBias: 0.1, saturation: 0.9, contrast: 1.08,
    bloomIntensity: 0.09, vignette: 0.7, grain: 0.022, fov: 40,
  },
  // A calm sea under a low moon. The point of interest is the moon's glitter
  // path, so the moon sits low (22 degrees) to stretch it across the water, and
  // the sea is calm enough not to break it up.
  //
  // sunElevation is the parameter that decides whether a night reads as night.
  // At -8.5 (Moonlit Passage) the sun is in nautical twilight and still lighting
  // the sky; only past about -18, the end of astronomical twilight, is there no
  // sunlight left in the air at all and the moon becomes the only source.
  'Peaceful Moonlit Ocean': {
    windSpeed: 5.0, fetch: 160, windDirDeg: 30, amplitude: 0.62, choppiness: 0.75,
    swellAmount: 0.95, swellPeriod: 15.5, swellDirDeg: 18, spread: 0.85,
    sunElevation: -18.0, sunAzimuth: 250, sunIntensity: 22, turbidity: 0.55,
    // Azimuth matters more than it looks: the camera's default yaw of -0.6 rad
    // IS an azimuth in this convention (326 degrees), because Camera.matrices
    // builds its forward vector with the same cos/sin form derive() uses for the
    // sun and moon. A moon 80 degrees off that is simply not in the frame, and
    // its glitter path - the entire point of a moonlit sea - is off-screen with
    // it. 332 puts it just off centre.
    moonIntensity: 0.30, moonElevation: 20, moonAzimuth: 332,
    // The moon's specular lobe, not the sky's brightness. Raising moonIntensity
    // instead would light the whole atmosphere and give a brighter night rather
    // than a brighter path.
    specIntensity: 1.6,
    stars: 1.0, starDensity: 0.55, starSize: 1.0, starColorTemp: 0.5,
    cloudCoverage: 0.20, cloudAltitude: 2400, cloudThickness: 1200, cirrus: 0.16,
    // Deep, dark water: at night there is no sunlight to scatter back out of it,
    // so the sea is nearly black except where it reflects.
    scatterColor: [0.018, 0.075, 0.135], absorption: [0.62, 0.19, 0.12],
    scatterAmount: 0.055,
    skyAmbient: 1.0, glitter: 0.62, foamAmount: 0.30, foamOpacity: 0.7,
    sprayOpacity: 0.5,
    // Mostly-manual iris, as for any night preset - see Moonlit Passage.
    autoExposure: 0.18, exposureBias: -0.15,
    saturation: 0.86, contrast: 1.16, bloomIntensity: 0.20,
    vignette: 0.85, grain: 0.020, fov: 42,
  },

  'Trade Winds': {
    windSpeed: 13.5, fetch: 450, windDirDeg: 75, amplitude: 0.9, choppiness: 1.15,
    swellAmount: 0.85, swellPeriod: 13.5, swellDirDeg: 68,
    sunElevation: 26, sunAzimuth: 96, sunIntensity: 22, turbidity: 1.7,
    cloudCoverage: 0.52, cloudAltitude: 1100, cloudThickness: 2100, cirrus: 0.25,
    foamAmount: 1.35, sprayOpacity: 0.95, sprayRate: 0.45,
    saturation: 1.06, exposureBias: 0.0, fov: 40,
  },
  'Hurricane Sea': {
    windSpeed: 38.0, fetch: 1000, amplitude: 0.95, choppiness: 1.3, alignment: 0.85,
    swellAmount: 1.9, swellPeriod: 17.0, spread: 1.15,
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
  // Built against photographs of sheltered water on a bright, light-air day
  // (a Florida marina reach, midday, scattered cumulus). What the reference
  // actually shows, and what each line here is for:
  //
  //   the surface is RIPPLE, not wave      windSpeed 3.4 over a 3 km fetch:
  //                                        almost no gravity wave, and swell
  //                                        0.06 m so there is a hint of heave
  //                                        rather than a flat plate
  //   fine, dense grain                    capillary 1.5 at capillaryScale 1.7,
  //                                        the finest band this model has
  //   MOTTLED into patches                 gust 0.55 over 40 m patches - the
  //                                        single most distinctive thing in the
  //                                        photos, and what the new gust field
  //                                        was written for
  //   near water dark and murky            a green-brown absorption/scatter pair
  //                                        rather than the ocean's blue, and
  //                                        scatterAmount down: sheltered water
  //                                        is turbid, so less light comes back
  //                                        up and it reads near-black up close
  //   far water a bright mirror            baseRoughness 0.02 and skyBlur 0.32:
  //                                        the smooth patches must reflect the
  //                                        far shore sharply enough to recognise
  //   reflections drawn out vertically     grazeFocus 0.10 narrows the lobe
  //                                        across the horizon, which is what
  //                                        stretches a reflection into a column
  //   no foam anywhere                     foamAmount 0
  'Sheltered Water': {
    windSpeed: 3.4, fetch: 3, amplitude: 0.5, choppiness: 0.55, shortWaveFade: 0.95,
    swellAmount: 0.06, swellPeriod: 6.0, depth: 6,
    capillary: 1.5, capillaryScale: 1.7,
    gust: 0.55, gustScale: 40, gustDrift: 0.5,
    sunElevation: 58, sunAzimuth: 135, sunIntensity: 23, turbidity: 2.2,
    cloudCoverage: 0.5, cloudAltitude: 900, cloudThickness: 1700, cloudDetail: 0.7,
    cirrus: 0.1,
    scatterColor: [0.075, 0.150, 0.105], absorption: [0.85, 0.42, 0.75],
    scatterAmount: 0.045, sssStrength: 0.5,
    baseRoughness: 0.02, skyBlur: 0.32, grazeFocus: 0.10, glitter: 0.5,
    // No AMBIENT spray on glassy water: sprayRate 0 stops the whitecap sheets
    // from ever spawning (belt and braces beside foamAmount 0). sprayOpacity
    // must stay live, and the first cut of this preset zeroed it too - the
    // draw pass early-outs when opacity is zero, and the wave runner's rooster
    // tail goes through that same draw. The craft threw its plume and nothing
    // rendered: "sheltered water has no spray from the wave runner". Opacity
    // only shows what exists, and with rate and foam at zero nothing ambient
    // exists - so this costs the glass nothing.
    foamAmount: 0.0, sprayOpacity: 0.85, sprayRate: 0.0,
    saturation: 1.02, contrast: 1.02, exposureBias: -0.05, vignette: 0.3, fov: 46,
  },
  'Deep Blue Afternoon': {
    windSpeed: 10.0, fetch: 600, amplitude: 0.85, choppiness: 1.05,
    swellAmount: 0.6, swellPeriod: 12.0, depth: 3500,
    sunElevation: 42, sunAzimuth: 235, sunIntensity: 23, turbidity: 1.3,
    cloudCoverage: 0.40, cloudAltitude: 2200, cirrus: 0.3,
    scatterColor: [0.028, 0.150, 0.300], absorption: [0.48, 0.085, 0.032],
    foamAmount: 0.95, glitter: 0.6,
    saturation: 1.08, contrast: 1.04, fov: 36,
  },
};

// A phone will happily accept a preset that asks for a 256-point FFT and a
// 400x640 grid, and then render single-digit frames per second. The device
// budget is clamped here - in the one place every preset change flows through -
// rather than trusting each preset to remember.
const MOBILE_QUALITY = {
  fftSize: 128,
  gridRadial: 200,
  gridAngular: 320,
  cloudSteps: 22,
  sprayTexSize: 96,
  renderScale: 0.65,
};

export const isHandheld = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;

// Presets are sparse: everything they do not mention comes back from `defaults`,
// so switching presets can never leave a stray value behind from the last one.
export function applyPreset(params, name) {
  // A misspelt name used to fall through to bare defaults and return a perfectly
  // valid daylight sea, so the only symptom was a preset that did not look like
  // itself. Say so instead.
  if (name && !PRESETS[name]) {
    console.warn(`Abyssal: no preset named "${name}". Known presets: ${Object.keys(PRESETS).join(', ')}`);
  }
  // A preset key that is not a real parameter is accepted by Object.assign and
  // then read by nobody, so a misspelt knob is not an error - it is a preset that
  // quietly does less than it says. Same failure as an unknown preset name, one
  // level down.
  const over = PRESETS[name];
  if (over) {
    for (const k of Object.keys(over)) {
      if (!(k in defaults)) console.warn(`Abyssal: preset "${name}" sets unknown parameter "${k}" - it will have no effect.`);
    }
  }
  Object.assign(params, structuredClone(defaults), structuredClone(PRESETS[name] || {}));
  if (isHandheld()) Object.assign(params, MOBILE_QUALITY);
  return params;
}

// A fresh parameter set. `newParams()` on its own is the default sea; pass a
// preset name to start from one of the curated ones.
export function newParams(preset) {
  return applyPreset({}, preset);
}
