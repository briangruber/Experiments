// Every knob the simulator exposes, plus the curated sea states.
//
// `defaults` is the single source of truth for parameter values; `SCHEMA` only
// describes how to present them. Presets are sparse overrides on top of
// `defaults`, so adding a parameter never invalidates an existing preset.

export const defaults = {
  // ---- sea state ----
  windSpeed: 7,          // U10, m/s
  windDirDeg: 42.0,
  fetch: 140,             // km
  depth: 200,            // m. Was 26 — coastal; this is deep enough that
                            // a 14 s swell no longer feels the bed.
  amplitude: 0.8,
  choppiness: 1.15,
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
  swellAmount: 0.4,        // significant height of the swell train, m
  swellPeriod: 10.5,
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

  // ---- water displacement ----
  // The one shared control over every mesh that actually pushes the sea's own
  // geometry around, not just paints foam on it - see water-surface.js's
  // waterDisplaceScale() for the whole argument. A body above the surface (the
  // ski, the seaplane, the boat - all through the one `hull` slot three-main.js
  // fills each frame) always presses a hollow DOWN and shoulders the water it
  // moved back up around itself as a bow wave; a body below the surface (the
  // sea dragon, through the separate `swell` slot) throws ripples at the
  // waterline when it cuts the sea. A dive inverts the packet so the wave
  // itself opens a hole. The splash-field body crater stays off.
  // Both directions come from the shader geometry itself, not from this
  // switch - this only scales how strongly either one is felt.
  waterDisplaceEnabled: 1,
  waterDisplaceAmount: 1.0,

  // ---- foam ----
  // Coverage is Monahan W(U10) × foamCoverage, floored below force 3. These
  // defaults are the LOOK of a raft: a fresh crest is white and sits up; the
  // film it leaves is streaky residual foam (physics.md), not a painted stamp. foamTint is
  // the cyan bubble-cloud underglow, not a dye on the white — dyeing the
  // raft the scatter colour is what turned golden-hour foam tan.
  foamCoverage: 1.0,        // gain on the Monahan whitecap fraction W(U10)
  foamSoftness: 0.28,       // width of the breaking ramp, in sigmas
  foamFace: 0.78,           // how strongly breaking is confined to forward faces
  foamBreakScale: 1.6,      // size (m) of the surface patch the fold test sees
  foamCrestAniso: 1.7,      // how far the breaking test reaches along the crest
  foamRidge: 0.85,          // confines breaking to the ridge of the fold field
  foamBreakup: 0.88,        // short-wave roughness modulation of the threshold
  foamWindMin: 4.0,         // U10 below which the sea carries no whitecaps at all
  foamDecay: 0.42,          // dissipated-raft decay rate (1/s)
  foamFreshDecay: 0.9,      // dense crest-foam decay rate (1/s)
  foamThin: 0.18,           // linear sink; the raft clears instead of filming
  foamDrift: 0.6,           // downwind slide of coverage AND the lace (m/s)
  foamInject: 4.0,        // saturates the raft: a whitecap is white, not a wash
  foamSpread: 0.40,
  foamAmount: 0,
  foamRoughness: 0.58,
  foamTint: 0.22,
  foamDetail: 1.85,
  foamLift: 0.72,
  foamSharp: 0.55,          // mild clump contrast; high values punch navy holes
  foamCrisp: 0.16,          // mostly a film; 1 resolves coverage into lace specks
  foamStreak: 0.16,
  foamFill: 0,              // 0 = walls only; 1 = chords + veil in the cells
  foamCell: 0.25,           // leftover-raft scale; higher = bigger, softer patches
  foamTextureAmount: 1,     // generated lace blended into physical coverage
  foamTextureScale: 9.0,    // metres per seamless tile
  foamTextureCarry: 0.55,   // how far FFT orbit carries the lace
  foamTextureShear: 0.30,   // slope slides the lace
  foamTextureStrain: 0.38,  // extra slide on a steep face
  foamLaceStretch: 0,       // cell elongation along the wave face (off)
  foamLaceStretchBlock: 28, // metres of parcel that stretch together
  foamLaceMorph: 0,         // breathe magnitude, metres (off)
  foamLaceMorphRate: 0,     // breathe speed (off)
  foamOpacity: 0.78,
  foamFar: 0.62,            // grazing self-hiding of distant rafts
  foamColor: [0.96, 0.975, 0.995],

  // ---- water optics ----
  scatterColor: [0.09, 0.52, 0.57],
  absorption: [0.3, 0.045, 0.03],
  scatterAmount: 0.16,
  sssStrength: 1.5,
  sssPower: 4.0,
  sssHeight: 0.75,
  sssDepth: 1.0,
  sssBias: 0.45,            // how far the exit direction leans up the wave normal
  baseRoughness: 0.055,
  roughnessGain: 1.0,
  roughnessMax: 0.30,       // alpha ceiling; Cox-Munk mss tops out near 0.06
  windAniso: 1.45,          // Cox-Munk along/cross-wind slope variance ratio
  waterIOR: 1.333,
  underwater: 1,            // camera-under look: column fog, shelf caustics, Snell's window, shafts
  // Metres of water to a virtual bed the surface can look down onto.
  // 0 = no bed (the open-ocean default). Not FFT `depth` — that is
  // wave dispersion. 4–8 m is a tropical lagoon: sand, reef, and
  // sunlight focused by the real FFT slopes. Min/max 0 fall back to
  // floorDepth (a flat shelf). A live range is sandbars and channels.
  floorDepth: 0,
  floorDepthMin: 0,
  floorDepthMax: 0,
  floorTerrainScale: 36,
  floorCaustic: 1,
  floorCausticSize: 1,      // 1 = shipped ~0.3 m cells; higher is bigger
  shoreFoamAmount: 0,
  shoreFoamRange: 3,
  skyAmbient: 1.0,
  skyBlur: 0.5,
  glitter: 0.65,
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
  sprayRate: 0.53,
  sprayFocus: 1.1,          // radial concentration of the particle budget
  sprayThreshold: 0.30,     // crest-foam fraction at which spray production saturates
  sprayFoldSoft: 0.21,      // toe of that ramp, as a fraction of the threshold
  sprayFoamBias: 0,         // how strictly droplets require actively breaking water
  sprayWindMin: 4.5,        // U10 where droplets first tear off crests
  sprayWindFull: 18.0,      // U10 where emission saturates
  sprayLifetime: 1.65,
  sprayGravity: 13.1,
  sprayDrag: 0.9,
  sprayLaunch: 12.6,
  sprayLaunchUp: 0.45,      // vertical share of the launch impulse
  sprayLaunchWind: 0.35,    // wind velocity inherited at birth
  spraySheet: 109.0,        // particles sharing one tear-off site
  spraySheetRate: 5.0,      // new tear-off sites per second
  spraySheetSpread: 2.2,    // sheet extent along the crest, m
  sprayShred: 1.6,          // downwind length of a sheet at the moment it tears
  sprayTurbulence: 2.0,
  sprayShear: 0.35,         // log wind gradient with height
  spraySizeMin: 0.01,      // billboards are parcels of spray, not single drops
  spraySizeMax: 0.22,
  spraySize: 1.23,
  sprayStretch: 0.014,      // shutter the motion smear is integrated over, s
  sprayOpacity: 1.585,
  sprayFadeNear: 2.65,      // billboards this close to the lens fade out
  sprayMinPixels: 0.9,     // sub-pixel droplets are grown and dimmed, not dropped
  sprayFarSoft: 1.6,       // extra edge softness once held at the pixel floor
  spraySurfFade: 0.67,      // soft fade as a billboard enters the water, m
  sprayAerial: 0.0025,
  sprayGrain: 1,            // how far each parcel is broken up into droplet texture
  sprayGrainScale: 6.75,    // droplet clumps across one billboard
  sprayGrainAniso: 4.95,    // that texture drawn out along the direction of flight
  splashPlateAmount: 0,     // jump-splash atlas plates are out; start over later

  // ---- spindrift & sea mist ----
  sprayMist: 0,           // spindrift removed: it read as grey smear and every
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
  sprayMistOpacity: 0,
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
  sunElevation: 68,        // degrees
  sunAzimuth: 150,
  sunIntensity: 23,
  sunTint: [1.0, 1.0, 1.0],
  turbidity: 1.2,
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
  moonIntensity: 0,
  stars: 0,
  starSize: 0.9,           // point-spread sigma, pixels
  starDensity: 0.34,        // limiting magnitude: how much of the field shows
  starColorTemp: 0.45,      // B-V spread; 0 is a field of white dots
  skyDither: 1.4,           // sub-texel jitter on the sky LUT fetch, texels

  // ---- clouds ----
  cloudCoverage: 0.36,
  cloudDensity: 1.0,
  cloudAltitude: 1500.0,
  cloudThickness: 2200.0,
  cloudSpeed: 1.0,
  cloudDetail: 0.6,
  cirrus: 0.15,
  cloudSteps: 48,
  cloudStepScale: 1.0,      // adaptive multiplier - the cloud march is the
                            // largest single item in a riding frame
  cloudStepMin: 0.4,
  cloudScale: 16000,      // weather-map cluster size, m
  cloudShape: 1300,       // base billow size, m
  cloudExtinction: 0.045,   // 1/m at full density
  cloudAnvil: 0,          // flattens and spreads the tops
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

  // ---- fishing boat (demo/boatModel.js) ----
  // A second WaveRunner instance, not a second physics model - see
  // WaveRunner's prefix: 'boat'. Every wrFoo above has a boatFoo counterpart
  // here; where they differ is the whole point: this is a nine-metre
  // displacement hull, not a jet ski, so it accelerates and turns like one
  // is heavy, never leaves the water, and does not carve.
  boatTopSpeed: 12.0,       // m/s, ~23 kn - already generous for a boat this size;
                            // the point is a fishing boat you enjoy driving, not
                            // a hull true to its rusty state
  boatAccel: 3.5,           // a hull this heavy takes its time getting there
  boatBrake: 3.0,
  boatBoost: 1.0,           // no boost - Space does nothing extra here
  boatTurnRate: 0.28,       // rad/s at speed, full lock - a long keel resists yaw
  boatSteerLag: 1.6,        // the wheel itself takes a moment to come round
  boatYawInertia: 1.1,      // and the hull is slower still to follow it
  boatGrip: 3.2,            // a keel does not let the stern step out the way a
                            // planing hull's does
  boatAirGrip: 0.25,        // unreachable in practice - see the launch block below
  boatTurnDrag: 0.12,       // turning scrubs little speed; there is no plane to lose
  boatCoastSteer: 0.5,      // a rudder still bites off the throttle, unlike a jet
                            // drive vectoring its own thrust
  boatAirSteer: 0.25,
  boatBank: 0.05,           // barely heels
  boatHover: 0.15,          // rides low and close to the surface
  boatStiffness: 10.0,      // soft: heavy enough not to skip over chop
  boatDamping: 9.0,
  boatGravity: 13.0,
  // THE LAUNCH IS DELIBERATELY UNREACHABLE, not just untuned low. A
  // displacement hull does not leave the water, and three independent guards
  // say so: 0 gain even if the trigger fires, a fall-rate threshold no wave in
  // this sea produces, and a jump-speed floor above anything the hull can
  // reach - so `fast` in WaveRunner.update() is false at every speed this hull
  // has.
  boatLaunch: 0.0,
  boatLaunchThreshold: 999.0,
  boatJumpSpeed: 999.0,
  boatLaunchG: 5.0,
  boatJumpGain: 0.0,
  boatSurfFilter: 22.0,
  boatLandingDrag: 0.35,    // dead code with the launch disabled; kept so the
                            // remap has a value for every wrFoo WaveRunner reads
  boatAttitudeRate: 3.0,    // slower to settle into a pitch/roll - more hull to move
  boatLength: 4.5,          // probe spacing bow to centre, m - half the hull's
                            // measured length at boatScale 1
  boatBeam: 1.65,           // half the hull's measured beam
  boatCamHeight: 2.6,       // eye height in the rider POV, roughly wheelhouse level
  boatCamTilt: -0.02,
  boatCamPitchFollow: 0.4,
  boatCamRollFollow: 0.3,
  boatShake: 0.4,           // a heavy hull vibrates far less than a ski does
  boatFovKick: 6.0,         // modest - this hull never gets fast enough to need
                            // the lens to do the work of selling speed
  boatBoostFov: 0.0,
  boatFovLag: 2.6,
  boatTouchSteer: 1.6,
  boatProbeSmooth: 16.0,
  boatCarveTurn: 1.0,       // Shift buys nothing extra - there is no carve to have
  boatCarveGrip: 1.0,
  boatCarveDrag: 1.0,
  boatWakeSpeed: 0.4,
  boatWakeTurn: 0.5,
  boatWakeSlip: 0.05,
  boatView: 1,              // 0 wheelhouse POV, 1 chase
  boatCamDistance: 20.0,    // further back than the ski's rig - a bigger vessel
                            // needs more of the frame to read as one
  boatCamPull: 0.4,
  boatCamRise: 6.0,
  boatCamLift: 0.3,
  boatCamLag: 4.0,
  boatCamLook: 4.0,
  boatCamLookRise: 1.2,
  boatCamMinClear: 1.0,
  boatCamChaseRoll: 0.15,
  boatScale: 1.0,
  // Reported live: the boat drove stern-first. It did - tools/glb.mjs's
  // --forward -z conversion guessed wrong for this asset, and the original
  // verification here was wrong with it (a vertex-density taper turned out
  // not to be the tell it was for other hulls; this one's actual bow tapers
  // to a point at +Z, and -Z is the flat, winch-equipped stern). Confirmed
  // unambiguously this time with an orthographic top-down render, no
  // perspective or up-vector to misread: the pointed hull half sits at +Z,
  // the working aft deck (net reels, davits) sits at -Z. Pi corrects it the
  // same way the ski's craftYawOffset does for its own reversed source
  // convention - see that comment for why a basis flip, not a mesh re-export.
  boatYawOffset: 3.14159265,
  boatPitchOffset: 0.0,
  boatRollOffset: 0.0,
  // The quantiser centres each axis on its OWN bounding box (tools/glb.mjs), so
  // local Y=0 is the midpoint of keel to masthead, not the waterline. 0.9 was
  // an assumption ("the deck edge sits near Y=0") that turned out wrong -
  // reported live, the hull rode almost entirely submerged with only the
  // cabin roof showing. Re-derived from an actual measurement instead of a
  // guess: the hull's own paint scheme marks its waterline (blue topsides
  // over a thin bottom-paint band, the ordinary convention), and finding
  // that colour boundary's pixel row in a rendered side view and mapping it
  // back through the camera to world Y put it at roughly local Y = -2.55 -
  // most of this hull's 5.4 m keel-to-masthead height is topsides freeboard,
  // only a shallow sliver is bottom paint. Still an estimate (a pixel
  // measurement off a render, not a modelled waterline), and still a live
  // knob for exactly that reason - but a measured one now, not an assumed one.
  boatLift: 2.55,

  wakeExtent: 320,          // metres across the world-space wake buffer. This is
                            // the only thing bounding how much of your own path
                            // the sea still remembers.
  wakeTexSize: 512,         // ...and how finely, at extent/size metres per texel
  wakeWidthScale: 1.0,      // multiplier on the wake width MEASURED off the
                            // mesh at the waterline (craft.js's
                            // buildWaterlineProfile). The width itself is not a
                            // setting any more - it follows whatever part of
                            // the body is actually cutting the surface - so
                            // this is only a thumb on the scale.
  wakeEdgeFade: 0.28,       // how much of the record buffer's border is
                            // feathered away, as a fraction of its width. The
                            // buffer is a square in world space and its far
                            // edge is a line of constant Z, so too small a
                            // value ends the wake on a dead-straight
                            // horizontal cut across the sea - see the note in
                            // water-common.js. Raise it when a fast craft
                            // outruns its own record (wakeExtent / speed
                            // shorter than wakeLife) and the trail is still
                            // strong when it reaches the wall.
  wakeWidth: 1.5,           // half-width of a cusp arm where it leaves the hull
  wakeSpread: 0.22,         // how much it thickens per second as it travels out
  wakeLife: 14.0,           // how long a patch of water stays disturbed
  wakeFoamDecay: 1.4,       // leftover stern-foam e-folding time, seconds.
                            // wake.persist on a body overrides this.
  wakeFoamWaveCarry: 1.25,  // leftover gravity waves carry existing foam along their faces
  // undefined: leftover-crest look follows carry (riding demo).
  // 0: leftover height stays water — carry can still move the film.
  wakeFoamWaveMax: 0.45,    // displacement-speed floor; planing film rides leftover at leftover c
  wakeFoamWaveSpread: 2.2,  // local, mass-neutral breakup on active wave faces
  wakeFoamDiverge: 0,       // scalar film has no birth heading; do not steer it from the live hull
  wakeFoamCrestGate: 0,     // wipe the film out of leftover TROUGHS. Multiplicative: it removes
                            // white, never adds it, so it cannot draw a V or punch a ring the way
                            // the additive wakeFoamCrestLook can. A real wake is mostly smooth
                            // water — the quarter-wave shoulders are glassy and only breaking
                            // crests go white.
  wakeFoamRibbonVary: 1.0,  // leftover foam: contour wobble, chew, opacity. 0 is a solid stencil.
  wakeSuds: 1,              // master: where does foam come from. 0 is the stamped-path answer
                            // (energy ribbon + physics whitewater ribbon + painted leftover-crest
                            // churn). 1 is the wave answer: coverage from where the water actually
                            // BREAKS, both ribbons suppressed. Slope magnitude is ak, so the
                            // leftover field's own steepness is the criterion — past critical a
                            // crest spills, below it there is no foam at all. That zero is what
                            // lets waves drive coverage without painting white over every
                            // disturbed square metre, and why the arms need no locus: they are
                            // simply where the field is steepest. Drives BOTH halves because the
                            // ribbons are additive into the same accumulator — swapping only the
                            // churn leaves the stamp underneath. See src/wake-suds.js.
  wakeSudsSteep: 0.08,      // critical steepness ak. The Stokes limit is 0.443, but that is where
                            // an ideal wave ceases to exist; real wake crests shed white well
                            // before it. Lower froths the transverse system too.
  wakeSudsCrest: 0.06,      // metres of leftover height that count as a full crest. Stands in for
                            // wave phase, which the leftover tile does not carry.
  wakeStrength: 1.15,
  wakeArmRate: 1.0,         // multiplier on the Kelvin half-angle spread rate
  wakeArm: 1.0,             // strength of the arms themselves
  wakeCentre: 0.5,          // aerated churn between them
  wakeDepth: 0.45,          // how far the wake actually deforms the surface, m
  wakeCalm: 0.85,           // how far the churn flattens the chop as GEOMETRY
  wakeSlick: 0.8,           // how completely the churn wipes out the sea's own
                            // ripples and wind foam inside the track
  wakePlume: 1.0,           // entrained air in the water COLUMN, not white foam
                            // on the surface. Bubbles scatter light back up
                            // before it can be absorbed, so churned water goes
                            // pale milky turquoise. In wake photography this is
                            // most of the wake's area and the white is a
                            // minority of it.
  wakeRelief: 1.0,          // ...and how much of that deformation lights up. The
                            // vertex shader moves the surface; without this the
                            // ridge would be a silhouette with a flat sea's
                            // shading normal painted on it.
  wakeProbe: 0.8,           // how much of that the hull feels when it crosses it
  craftLift: 0.46,          // rides the hull's designed waterline on the surface
  // Was 1.0. At the ski's own chase distance (wrCamDistance 12m, growing with
  // speed via wrCamPull) sprayFadeNear's <1m radius never touches this plume -
  // "blocks most of the camera" was craftSprayOpacity/craftSprayMulti below
  // reading as a genuinely solid wall at that range, not proximity. Trimmed
  // there and here together rather than gutting the emission itself, which is
  // the part that was asked to stay.
  craftSprayAmount: 0.75,
  craftShadow: 0.85,        // how dark the shadow it throws on the water is
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
  // What the sea feels. spHullPush scales the hollow the floats press into it -
  // well under the wave runner's, because a floatplane is light and its floats
  // are narrow, and the first cut of this ran at 1.6x the ski's and heaved the
  // whole sea. spContactFade is the clearance over which that hollow fades in
  // and out, so takeoff and touchdown are a release and a settle rather than a
  // switch. See WHAT IS ACTUALLY TOUCHING THE WATER in demo/seaplane.js.
  spHullPush: 0.5,
  spContactFade: 1.8,       // m of float clearance over which contact fades
  spHalfSpan: 0.66,         // half the wingspan, as a fraction of length
  spWingBite: 9.0,          // m/s^2 a fully buried wingtip scrubs
  spWingRight: 6.0,         // 1/s it rolls you back level while it bites
  spPropIdle: 12.0,         // rad/s with the lever closed - an engine still runs
  spPropRpm: 95.0,          // rad/s at full power. Past the frame rate this
                            // aliases into a slow backward crawl, which is what
                            // a real propeller does on camera too.

  // ---- the sea dragon (demo/seadragon.js, src/gpu/tsl/creature.js) ----
  // It holds a station off your shoulder rather than wandering, because a sea
  // monster you have to go looking for is one most riders never see. It is
  // rendered into the refraction pass (src/gpu/tsl/refraction-driver.js) and the
  // sea looks down through itself at it, so depth is what makes it read as UNDER
  // the water: the water column between you and it swallows it over sdFade
  // metres, and sdDepth is really "how solid is it".
  sdEnabled: 1.0,           // 0 turns the animal off entirely, draw and all
  // Visual mesh only. 'Current' is demo/dragonModel.js; 'Sea serpent' is
  // models/sea-serpent-rigged.glb (baked in demo/serpentModel.js). Named
  // presets do not override this, so existing checks keep the original
  // silhouette. Physics / swim / spray stay the SeaDragon capsule.
  sdModel: 'Current',
  sdLength: 60,           // nose to tail, metres. The mesh is unit-length.
                            // Was 22 - a live-tuned default now, a genuine
                            // leviathan rather than something ski-sized.
  sdSpeed: 80.0,            // m/s sprint at the 60 m reference length. Actual
                            // top speed is this times sqrt(length / 60), so a
                            // bigger body covers more water per beat.
  sdCruise: 45,             // m/s of water it actually covers when circling
                            // or loafing. The orbit's angular rate is this
                            // divided by the circle radius, so the slider
                            // changes distance travelled, not just a
                            // chase-speed that never caught a slow station.
  sdAccel: 0.55,            // 1/s it closes on the speed it wants
  sdTurnRate: 0.55,         // rad/s at a standstill; a long body turns slower
  sdOrbit: 0.20,            // rad/s it circles you at when you are not moving
  sdFollowRise: 6.0,        // how high the Follow camera sits above the sea, m
  sdView: 1,                // 0 on its back, 1 chase — V while piloting
  sdClimb: 0.45,            // rad/s it pitches when E/Q are held
  sdRushSpeed: 30,        // ski speed at which it is fully up and fully in
  sdOffsetClose: 17.5,       // how near it comes at that speed, m
  sdOffset: 8,           // metres off your shoulder it tries to sit
  sdLead: -8,              // ...and how far ahead, so a chase camera sees it
  sdDepth: 9,               // mean depth below the surface, m. Back of a
                            // 60 m animal sits ~7 m above the origin, so
                            // this sits just under and heaves up on the swing.
  sdDepthSwing: 11.7,        // how far it rises and sounds around that
  sdMinDepth: 1.6,          // never nearer the surface than this. It CAN breach
                            // now - the refraction pass gave it a depth buffer,
                            // so a fin above the waterline is an ordinary opaque
                            // fragment in front of the sea - this is a staging
                            // choice, not the backstop it used to be.
  sdSeaLevel: 0.0,          // the mean surface it measures depth from
  sdFade: 23,               // metres of WATER along the camera ray that swallow
                            // the shape. Measured from mean sea level to the
                            // body, not from the displaced surface and not the
                            // body's own depth: a side view through a long
                            // stretch of sea hides it sooner than looking
                            // straight down at the same depth. The COLOUR of
                            // the swallowing is the sea's own absorption; this
                            // is its scale. Was 11 - tuned down live so a 52m
                            // animal does not fade to a ghost across its own
                            // length at a grazing viewing angle.
  sdOpacity: 1.0,           // how hard the shape reads through the surface. It
                            // scales the coverage the sea mixes by, so 0 skips
                            // the lookup in the ocean shader entirely.
  // The mouth. The mesh ships with the jaw fully dropped and no rig to close it,
  // and its mandible physically ENDS at the mouth corner - there is no
  // articulation aft of it to swing about, so rotating far enough to shut the
  // teeth would pull the jaw into the skull. Measured: the gape is 1.1 m on a
  // 1.0 m mandible. So this narrows it and, more to the point, MOVES it: the
  // complaint was that the mouth was always open, and a jaw that works as the
  // animal swims reads as alive whatever its resting gape.
  sdGape: 0.30,             // radians the mandible swings up from as-modelled
  sdBow: 2.15,              // metres of the co-moving heap at the snout.
                            // 10 m was a triangular mountain, not a bow wave.
  sdBowSoft: 1.4,           // 1 = the measured heap. Higher spreads the
                            // same height over more of the water grid so
                            // the radial triangles stop reading as facets.
  sdDome: 1.25,             // metres of the dorsal pressure ellipse.
                            // A just-under loaf, not a 6 m pyramid.
  sdDomeSoft: 1.4,          // 1 = the measured loaf. Higher spreads the
                            // same height over more of the water grid so
                            // the radial triangles stop reading as facets.
  sdDomeNear: 2.4,          // metres under the sea at which bow / dome
                            // still reach full strength. Lower = only
                            // when the head or back is almost at the sea.
  sdFluke: 2,               // how hard a tail-stroke print flattens the sea
  sdFlukeSize: 8.9,         // target radius of that glassy disc, m
  sdFlukeLife: 18,          // seconds a footprint stays on the sea
  sdFlukeDebug: 0,          // 1 draws amber balls on live footprint centres
  sdRipple: 0,              // 0 = no expanding rings (the leftover compass arcs)
  sdSwell: 3.97,            // peak metres of the ripple at a waterline cut; dive inverts the packet
  sdSwellRadius: 2.9,       // starting width of that packet, m
  sdSwellFade: 9,           // depth over which the ripples die away, m
  sdSwellLife: 7,           // seconds a ripple takes to fade out (decay)
  sdSwellWave: 0,           // 0 = stay on the cut, 1 = full travel away from the cut
  sdSwellSpeedMin: 16,      // m/s floor on how fast a thrown ring runs out
  sdSwellSpeedMax: 32,      // m/s ceiling; a hard, fast break sits nearer this
  sdSwellDebug: 0,          // 1 draws the waterline cuts that throw ripples
  sdSprayDepth: 0.7,       // metres of water column still counted as "breaking" -
                            // read off the refraction pass's own depth, so the
                            // spray traces the body's true silhouette (fins and
                            // all), not the swell mound's smooth approximation
  sdSpray: 1,               // strength of that spray, fed into the sea's own
                            // foam shading - 0 turns the whole block off. Also
                            // gates the real particle spray thrown where it
                            // breaches (three-main.js's dragonSpray, reusing
                            // the vehicles' own particle system) - one slider
                            // for both.
  // The animal's own particle look. The Spray group is the sea's wind-torn
  // droplets; these drive the waterline sheet so a Spray tweak does not
  // resize the monster, and a Wave Runner tweak does not either.
  sdSpraySize: 0.72,        // parcel size. Independent of the Spray group's Size.
  sdSprayOpacity: 1.71,     // density of the animal's sheet, not sprayOpacity.
  sdSprayLife: 1.17,        // hang time. Independent of craftSprayLife.
  sdSprayPulse: 0.62,       // share of the particle budget.
  sdSprayLaunch: 0.88,      // throw-speed gain on the waterline sheet
  sdSpraySpread: 1,         // cone width. Was p.craftSpraySpread.
  sdSprayUp: 1,             // upward aim. Was p.craftSprayUp.
  sdSprayMulti: 0.15,       // sheet glow. Was p.craftSprayMulti.
  sdSprayEmitters: 40,      // how many simultaneous waterline sites a piercing
                            // mesh gets. Parked on the body where it actually
                            // cuts the sea (placeBreachEmitters), not hopped
                            // as one emitter. 1..50; 1 is the old single site.
  sdSprayDebug: 0,          // 1 draws the waterline sites (magenta) and the
                            // wake stamp (cyan) so you can see they sit on
                            // the pierce, not the mid-body origin.
  // Simple V behind a surface run. The V is height only: aerated water
  // is deposited separately into a world-space trail that drifts and dies.
  sdVWake: 1.02,            // master. 0 is no V.
  sdVWakeAmp: 1.39,         // ridge height at a short fetch, metres
  sdVWakeLen: 70,           // how far the arms travel, metres
  sdVWakeWidth: 1.3,        // arm half-width at the start, metres
  sdVWakeAngle: 15,         // half-angle of the V, degrees
  sdVWakeFoam: 0.75,        // leftover trail-foam gain. Lane churn lives on the V.
  sdVWakeMid: 0.83,         // third ridge on the centreline. 0 is the hollow V.
  sdVWakeLife: 8.2,         // seconds a written V stays after the body dives
  // Jump splash knobs are unused. The leap crown is out; waterline
  // cut spray is sdSpray*. Kept so old saved settings still load.
  sdSplashParticles: 0,
  sdSplashSize: 0.52,
  sdSplashOpacity: 0,
  sdSplashLife: 0.65,
  sdSplashPulse: 0,
  sdSplashLaunch: 1.59,
  sdSplashExit: 1.94,       // still scales throwSplash hit energy (rings / ripples)
  sdSplashLand: 2.04,
  sdThrough: 0.07,          // how much of the shape survives the surface's own
                            // glare. 0 is the pure physics and nearly invisible
                            // at the angle you ride at; this is the fudge. Was
                            // 0.85 - tuned down live, closer to the physics.
  sdRefract: 0.433,         // how hard the surface slope warps rocks, coral, and the seafloor caustics
                            // through it. This is what makes chop passing over
                            // the animal wobble and break it up. Was 0.045.
  sdWaves: 0.96,            // body waves along its length
  sdWaveAxis: 1,            // 0 sideways (eel), 1 up-and-down (whale), 2 both
  sdAmp: 0.11,              // peak tail sweep, as a fraction of length.
                            // 0.176 made 2A so large that Strouhal cadence
                            // crawled and the wave barely outran the swim.
  sdBeat: 0.45,             // loaf cadence at the 60 m reference, Hz
  sdBeatSpeed: 0.032,       // trim around St = 0.30. Cadence is computed
                            // from speed, length, sweep and wave count;
                            // this only nudges the Strouhal number.
  hullPush: 0.55,           // depth of the hollow the hull presses, m
  hullRadius: 2.6,          // along-hull extent of that footprint, m
  hullBow: 0.9,             // how much of it stands back up as bow wave
  craftPlaneSpeed: 6.0,     // m/s the hull starts to plane; below this, no spray
  craftPlaneFull: 14.0,     // m/s where shedding saturates
  craftSprayLife: 0.85,     // thrown water falls straight back; it must not hang
  craftSprayPulse: 0.22,    // overall share of the budget the hull may claim. Any
                            // higher and the plume is a white ball with the craft
                            // somewhere inside it - which is what "it blocks most
                            // of the camera" turned out to be, at a chase distance
                            // (wrCamDistance 12m+) sprayFadeNear never reaches.
                            // Was 0.30.
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
  craftSprayOpacity: 0.6,   // Was 1.0, a fully opaque sheet - dialled back so
                            // overlapping billboards read as spray you can see
                            // motion and light through, not a wall painted over
                            // the view.
  craftSprayMulti: 0.15,    // ...and a dense sheet scatters light many times
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
  exposureBias: -0.1,
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
  vignette: 0.35,
  vignetteRound: 0.7,
  grain: 0,                 // off. filmGrain early-returns; do not sprinkle sensor noise on the sea
  grainSize: 1.7,           // px per grain cell
  grainChroma: 0.22,
  grainShadow: 0.35,        // 0 = film granularity (midtones), 1 = read noise (toe)
  blackPoint: 0.0,          // scene-linear black subtraction; <0 lifts (flare)
  toeStrength: 0.45,        // stops of extra shadow density under middle grey
  toeRange: 2.6,            // how far down the toe reaches, stops
  chromaRestore: 0.18,      // steer back to scene hue after the per-channel curve
  contrast: 1.05,           // about middle grey, in log2
  saturation: 1.14,
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
  fftSize: 128,
  gridScale: 1.0,           // adaptive multiplier on both grid dimensions
  gridScaleMin: 0.45,       // how far the adaptive controller may thin it
  gridRadial: 400,
  gridAngular: 640,
  sprayTexSize: 64,
  renderScale: 1.0,
  adaptiveQuality: 1,       // trim resolution until the target frame rate is met
  // ---- duty cycle ----
  // How hard this is allowed to work the machine, as opposed to how good it is
  // allowed to look. The quality knobs below trade picture for frame rate, which
  // is not the same thing: a laptop gets hot because of work per second, and only
  // capping the frame rate or the pixel count reduces that.
  fpsCap: 60,              // skip frames so a 120 Hz panel does not draw twice
  fpsCapIdle: 10,           // ...and when the window is not in front
  fpsCapBattery: 30,        // unplugged: same picture, half the GPU·s/s. 0 = off
  dprCap: 2.0,              // ceiling on device pixel ratio. Was 1.75, which
                            // silently downscaled every plain 2x Retina panel
                            // (dpr 2 > cap 1.75) into a soft image nobody asked
                            // to trade away - a laptop or an iPad reads that as
                            // "blurry", not as a frame-rate saving. 2.0 renders
                            // those natively; a dpr-3 phone still gets capped,
                            // which is the case this number exists for.
  powerPref: 'default',     // 'high-performance' explicitly asks a switchable-
                            // graphics laptop for its discrete GPU. Reload to
                            // apply - the context cannot change it afterwards.
  targetFps: 60,
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
    sssStrength: 1.9, glitter: 0.7,
    // Force 5, W ≈ 0.8%. Coverage is the look gain, not Monahan — 0.5
    // keeps crests white without painting the whole sea.
    foamAmount: 0.5, foamTint: 0.24, foamOpacity: 0.80, foamLift: 0.78,
    foamBreakScale: 2.4, foamStreak: 0.10, foamCrisp: 0.36, foamSharp: 0.90,
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
    // Force 10, W ≈ 26%. Persistence and windrows, not a spreading white
    // blanket — foamSpread 1.8 was past the slider and turned rafts into stamps.
    foamAmount: 1.0, foamCoverage: 1.1, foamDecay: 0.22, foamSpread: 0.65,
    foamThin: 0.12, foamLift: 0.88, foamStreak: 0.36, foamFar: 0.48,
    foamTint: 0.20, foamOpacity: 0.82, foamBreakScale: 6.5, foamCrestAniso: 2.2,
    sprayOpacity: 1.1, sprayRate: 0.85, sprayThreshold: 0.26, sprayLaunch: 5.4,
    sprayDrag: 1.2, sprayLifetime: 3.0, spraySize: 1.2,
    sprayMist: 0.5, sprayMistOpacity: 0.13, sprayHaze: 0.00055,
    saturation: 0.86, contrast: 1.10, exposureBias: 0.15, vignette: 0.62,
    fov: 44, handheld: 1.1, cameraBob: 0.35, minAltitude: 3.0,
  },
  'Glassy Dawn': {
    windSpeed: 3.2, fetch: 60, amplitude: 0.85, choppiness: 0.75, shortWaveFade: 0.8,
    swellAmount: 0.42, swellPeriod: 12.0,
    sunElevation: 1.4, sunAzimuth: 92, sunIntensity: 25, turbidity: 1.1,
    cloudCoverage: 0.30, cloudAltitude: 2600, cirrus: 0.5,
    scatterColor: [0.050, 0.255, 0.360], absorption: [0.36, 0.06, 0.038],
    // U10 3.2 is below the force-3 gate (W = 0). foamAmount 0.6 used to sit
    // here as a no-op; say none, and raise the gate so a nudge of wind does
    // not speckle the glass.
    foamAmount: 0.0, foamWindMin: 5.0, glitter: 0.95, baseRoughness: 0.035,
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
    floorDepth: 28, floorDepthMin: 5, floorDepthMax: 100,
    floorTerrainScale: 72, floorCaustic: 2.2,
    sunElevation: 68, sunAzimuth: 150, sunIntensity: 23, turbidity: 1.2,
    cloudCoverage: 0.36, cloudAltitude: 900, cloudThickness: 1800, cirrus: 0.15,
    scatterColor: [0.090, 0.520, 0.570], absorption: [0.30, 0.045, 0.030],
    scatterAmount: 0.16, sssStrength: 1.5,
    // Force 4, W ≈ 0.3%. Sparse face-breaks, no dye into the turquoise.
    foamAmount: 0.7, foamCoverage: 0.9, foamTint: 0.08, foamOpacity: 0.74,
    foamCell: 1.9, foamCrisp: 0.16, foamSharp: 0.55, foamFill: 0.86,
    foamStreak: 0.26, wakeDepth: 0.58, wakeStrength: 1.22,
    foamFace: 0.84, foamBreakScale: 2.6, glitter: 0.65,
    saturation: 1.14, contrast: 1.05, exposureBias: -0.1, vignette: 0.35, fov: 42,
  },
  // Aerial lagoon: look down through a few metres of clear water at
  // sand and reef. The column is a pale sky-cyan (B > G, not a lime
  // dye) so it sits under the noon atmosphere; the bed and a light
  // caustic carry the tropical. Glitter and capillaries stay low so
  // the high sun does not speckle. Film grain stays off.
  'Tropical Lagoon': {
    windSpeed: 4.4, fetch: 12, amplitude: 0.58, choppiness: 0.78, shortWaveFade: 0.72,
    swellAmount: 0.14, swellPeriod: 5.5, depth: 6,
    floorDepth: 5.2, floorDepthMin: 0.7, floorDepthMax: 8.4,
    floorTerrainScale: 42, floorCaustic: 1.15,
    shoreFoamAmount: 0.95, shoreFoamRange: 3.0,
    sunElevation: 72, sunAzimuth: 142, sunIntensity: 24, turbidity: 1.0,
    cloudCoverage: 0.18, cloudAltitude: 1400, cloudThickness: 1200, cirrus: 0.08,
    scatterColor: [ 0.055, 0.22, 0.34 ], absorption: [ 0.19, 0.036, 0.026 ],
    scatterAmount: 0.10, sssStrength: 0.55, skyAmbient: 1.15,
    foamAmount: 0, foamWindMin: 5.8, foamCoverage: 0.55, foamTint: 0.06,
    foamTextureAmount: 1, foamTextureScale: 7.5,
    foamFill: 0, foamCell: 0.25, foamLaceMorph: 0, foamLaceMorphRate: 0,
    baseRoughness: 0.048, glitter: 0.28, capillary: 0.55, capillaryScale: 1.0,
    // Light-air lagoon: wind arrives in patches. Off (the default) is the
    // same chop everywhere. Large slicks — tens of metres of calmer water,
    // not a colour wash.
    gust: 0.46, gustScale: 50, gustDrift: 0.28,
    specAA: 1.15,
    saturation: 1.04, contrast: 1.02, exposureBias: 0.02, vignette: 0.28,
    fov: 44,
  },
  'Moonlit Passage': {
    windSpeed: 12.5, fetch: 300, amplitude: 0.85, choppiness: 1.05,
    swellAmount: 0.9, swellPeriod: 13.5,
    sunElevation: -16.0, sunAzimuth: 300, sunIntensity: 22, turbidity: 1.15,
    moonIntensity: 0.32, moonElevation: 28, moonAzimuth: 318, stars: 1.15,
    starDensity: 0.78, starSize: 0.85, starColorTemp: 0.55,
    specIntensity: 1.5,
    cloudCoverage: 0.22, cloudAltitude: 1900, cloudThickness: 1400, cirrus: 0.28,
    cloudAmbient: 1.35, cloudAmbientFloor: 0.48, cloudPowder: 0.38,
    cloudSilver: 1.55, cloudHaze: 1.25, cloudFade: 0.42,
    scatterColor: [0.035, 0.135, 0.200], absorption: [0.55, 0.16, 0.10],
    skyAmbient: 1.3, glitter: 0.35,
    // Force 6 at night. The foam is there (W ≈ 2%) but it is grey streaks,
    // not a daylight whitecap sheet — amount 1.1 read as paint under the moon.
    foamAmount: 0.85, foamOpacity: 0.62, foamTint: 0.08, foamFar: 0.72,
    foamLift: 0.55, foamStreak: 0.20,
    // The only preset with the sun below the horizon, and the only one where a
    // fully automatic iris is wrong. autoExposure blends towards
    // exposureTarget/avg, so at 1.0 it normalises *any* scene to the same average
    // brightness - which lands a moonlit sea on exactly the same mid-grey as noon
    // and gives you daylight with stars pasted over it. Trimming it to 0.3 keeps
    // enough adaptation to follow moonIntensity without erasing the night.
    autoExposure: 0.3,
    sprayOpacity: 0.6, exposureBias: 0.1, saturation: 0.9, contrast: 1.08,
    bloomIntensity: 0.16, vignette: 0.7, fov: 40,
  },
  // A calm sea under a low moon. The point of interest is the moon's glitter
  // path, so the moon sits low (24 degrees) to stretch it across the water, and
  // the sea is calm enough not to break it up.
  //
  // sunElevation is the parameter that decides whether a night reads as night.
  // At -8.5 (Moonlit Passage) the sun is in nautical twilight and still lighting
  // the sky; only past about -18, the end of astronomical twilight, is there no
  // sunlight left in the air at all and the moon becomes the only source.
  'Peaceful Moonlit Ocean': {
    windSpeed: 5.0, fetch: 160, windDirDeg: 30, amplitude: 0.62, choppiness: 0.75,
    swellAmount: 0.95, swellPeriod: 15.5, swellDirDeg: 18, spread: 0.85,
    sunElevation: -18.0, sunAzimuth: 250, sunIntensity: 22, turbidity: 0.85,
    // Azimuth matters more than it looks: the camera's default yaw of -0.6 rad
    // IS an azimuth in this convention (326 degrees), because Camera.matrices
    // builds its forward vector with the same cos/sin form derive() uses for the
    // sun and moon. A moon 80 degrees off that is simply not in the frame, and
    // its glitter path - the entire point of a moonlit sea - is off-screen with
    // it. 332 puts it just off centre.
    moonIntensity: 0.30, moonElevation: 24, moonAzimuth: 332,
    // The moon's specular lobe, not the sky's brightness. Raising moonIntensity
    // instead would light the whole atmosphere and give a brighter night rather
    // than a brighter path.
    specIntensity: 1.6,
    stars: 1.2, starDensity: 0.82, starSize: 0.8, starColorTemp: 0.58,
    cloudCoverage: 0.12, cloudAltitude: 2400, cloudThickness: 1200, cirrus: 0.24,
    cloudAmbient: 1.45, cloudAmbientFloor: 0.52, cloudPowder: 0.32,
    cloudSilver: 1.7, cloudHaze: 1.35, cloudFade: 0.38,
    // Deep, dark water: at night there is no sunlight to scatter back out of it,
    // so the sea is nearly black except where it reflects.
    scatterColor: [0.018, 0.075, 0.135], absorption: [0.62, 0.19, 0.12],
    scatterAmount: 0.055,
    skyAmbient: 1.0, glitter: 0.62,
    // U10 5 is barely force 3 (W ≈ 0.01%). A single pale streak, if that.
    foamAmount: 0.22, foamOpacity: 0.55, foamTint: 0.06, foamWindMin: 4.6,
    foamFar: 0.78, foamLift: 0.40,
    sprayOpacity: 0.5,
    // Mostly-manual iris, as for any night preset - see Moonlit Passage.
    autoExposure: 0.18, exposureBias: -0.15,
    saturation: 0.86, contrast: 1.16, bloomIntensity: 0.28,
    vignette: 0.85, fov: 42,
  },

  'Trade Winds': {
    windSpeed: 13.5, fetch: 450, windDirDeg: 75, amplitude: 0.9, choppiness: 1.15,
    swellAmount: 0.85, swellPeriod: 13.5, swellDirDeg: 68,
    sunElevation: 26, sunAzimuth: 96, sunIntensity: 22, turbidity: 1.7,
    cloudCoverage: 0.52, cloudAltitude: 1100, cloudThickness: 2100, cirrus: 0.25,
    // Force 6–7, W ≈ 2.8%. Trades make windrows, not a 1.35× foam blanket.
    foamAmount: 0.95, foamCoverage: 1.05, foamStreak: 0.30, foamDecay: 0.36,
    foamSpread: 0.52, foamTint: 0.14, foamLift: 0.80, foamBreakScale: 3.8,
    sprayOpacity: 0.95, sprayRate: 0.45,
    saturation: 1.06, exposureBias: 0.0, fov: 40,
  },
  'Hurricane Sea': {
    windSpeed: 38.0, fetch: 1000, amplitude: 0.95, choppiness: 1.3, alignment: 0.85,
    swellAmount: 1.9, swellPeriod: 17.0, spread: 1.15,
    sunElevation: 14, sunAzimuth: 190, sunIntensity: 14, turbidity: 5.0,
    cloudCoverage: 0.95, cloudDensity: 2.2, cloudAltitude: 380, cloudThickness: 4200,
    cloudSpeed: 5.0, cloudDetail: 0.9, cirrus: 0.0,
    scatterColor: [0.055, 0.160, 0.180], absorption: [0.62, 0.18, 0.13],
    // Saturated W = 42%. Streaks and a lasting film to the horizon, not
    // foamSpread 2.4 (a bath). Fresh crests stay up; the raft thins slowly.
    foamAmount: 1.05, foamCoverage: 1.15, foamDecay: 0.14, foamFreshDecay: 0.55,
    foamSpread: 0.85, foamThin: 0.08, foamLift: 0.95, foamStreak: 0.48,
    foamFar: 0.34, foamTint: 0.22, foamOpacity: 0.84, foamBreakScale: 8.0,
    foamCrestAniso: 2.6, foamColor: [0.93, 0.945, 0.96],
    sprayOpacity: 1.3, sprayRate: 1.0, sprayThreshold: 0.22, sprayLaunch: 7.5,
    sprayDrag: 1.6, sprayLifetime: 3.6, spraySize: 1.5, sprayRadius: 200,
    sprayMist: 0.6, sprayMistOpacity: 0.16, sprayMistLife: 9.0, sprayHaze: 0.0012,
    saturation: 0.72, contrast: 1.14, exposureBias: 0.25, vignette: 0.75,
    fov: 52, handheld: 2.0, cameraBob: 0.8, minAltitude: 6.0,
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
  // Inland still water. Not ocean glass (Glassy Dawn) and not a mottled
  // marina reach (Sheltered Water). A short-fetch lake: light air, no
  // swell train, freshwater olive, a mud/sand shelf you can just see.
  'Calm Lake': {
    windSpeed: 2.2, fetch: 4, windDirDeg: 18, amplitude: 0.42, choppiness: 0.48,
    shortWaveFade: 0.92,
    swellAmount: 0.02, swellPeriod: 4.5, depth: 12,
    floorDepth: 9, floorDepthMin: 3.5, floorDepthMax: 16,
    floorTerrainScale: 90, floorCaustic: 0.45,
    capillary: 0.85, capillaryScale: 1.15,
    gust: 0.18, gustScale: 70, gustDrift: 0.25,
    sunElevation: 38, sunAzimuth: 118, sunIntensity: 21, turbidity: 1.6,
    cloudCoverage: 0.28, cloudAltitude: 1600, cloudThickness: 1400, cirrus: 0.12,
    scatterColor: [ 0.055, 0.145, 0.095 ], absorption: [ 0.55, 0.22, 0.38 ],
    scatterAmount: 0.07, sssStrength: 0.65,
    baseRoughness: 0.028, skyBlur: 0.28, grazeFocus: 0.12, glitter: 0.38,
    foamAmount: 0, foamWindMin: 6.0, sprayRate: 0, sprayOpacity: 0.85,
    saturation: 1.04, contrast: 1.03, exposureBias: 0.0, vignette: 0.32, fov: 40,
  },
  'Deep Blue Afternoon': {
    windSpeed: 10.0, fetch: 600, amplitude: 0.85, choppiness: 1.05,
    swellAmount: 0.6, swellPeriod: 12.0, depth: 3500,
    sunElevation: 42, sunAzimuth: 235, sunIntensity: 23, turbidity: 1.3,
    cloudCoverage: 0.40, cloudAltitude: 2200, cirrus: 0.3,
    scatterColor: [0.028, 0.150, 0.300], absorption: [0.48, 0.085, 0.032],
    // Force 5, W ≈ 1%. Open-ocean blue, so a little more water in the veil
    // than golden hour and no extra gain on top of Monahan.
    foamAmount: 0.82, foamTint: 0.14, foamOpacity: 0.76, foamLift: 0.70,
    glitter: 0.6,
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
  // 64x64 = 4096 parcels, down from 96x96 = 9216. Spray was the largest single
  // stage of a riding frame under ablation, and it is the one a phone is worst
  // at: every parcel is a big blended billboard, and blended overdraw is what a
  // tile-based GPU pays most for. The budget is spread over the visible disc, so
  // halving it thins the plume rather than shortening it.
  sprayTexSize: 64,
  // Was 0.65 with a 0.85 ceiling - combined with dprCap this put a dpr-3 phone
  // at roughly 1.14 effective pixel ratio against a native 3, an image soft
  // enough to read as "upscaled" (because it was) rather than as a deliberate
  // frame-rate trade a visitor would notice was even happening. adaptiveQuality
  // is what protects the frame rate here - it is on by default and will pull
  // this back down live if a real device actually needs it to - so this is a
  // starting point and a ceiling for a SHORT SESSION, not a permanent
  // sight-unseen tax on every touch device regardless of what it can do.
  renderScale: 0.85,
  renderScaleMax: 1.0,
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
