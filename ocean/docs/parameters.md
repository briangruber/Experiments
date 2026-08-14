# Parameter reference

Every knob, with its default and its useful range. Generated from the
parameter set by `npm run docs:params` — do not edit by hand.

A parameter set is a plain object. Read and write it directly:

```js
import { newParams } from 'abyssal-ocean';

const params = newParams('Storm Front');
params.windSpeed = 18;
water.rebuild();          // sea-state changes need the spectrum rebuilt
```

Parameters marked **rebuild** describe the sea itself rather than how it is
shaded, so changing one needs `water.rebuild()`. Parameters marked **grid**
need `water.rebuildGrid()`.

## Sea State

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `windSpeed` | Wind speed (m/s) | `11` | 0.5 … 40 | **rebuild** |
| `windDirDeg` | Wind direction | `42` | 0 … 360 | **rebuild** |
| `fetch` | Fetch (km) | `180` | 1 … 1200 | **rebuild** |
| `depth` | Depth (m) | `900` | 3 … 4000 | **rebuild** |
| `amplitude` | Amplitude | `1` | 0 … 3 | **rebuild** |
| `choppiness` | Choppiness | `1.25` | 0 … 2.5 |  |
| `choppyLong` | Long-wave choppiness x | `1.45` | 0.5 … 3 |  |
| `crestSharpen` | Crest sharpening | `1` | 0 … 4 |  |
| `spread` | Directional spread | `1` | 0.2 … 4 | **rebuild** |
| `spreadTail` | Chop long-crestedness | `2.2` | 0.5 … 6 | **rebuild** |
| `alignment` | Wind alignment | `0.92` | 0 … 1 | **rebuild** |
| `peakEnhancement` | Peak sharpness (gamma) | `3.3` | 1 … 7 | **rebuild** |
| `tailSaturation` | Equilibrium tail | `1` | 0 … 2 | **rebuild** |
| `shortWaveFade` | Capillary rolloff | `0.35` | 0 … 1 | **rebuild** |
| `timeScale` | Time scale | `1` | 0 … 3 |  |
| `loopPeriod` | Loop period (s, 0=off) | `0` | 0 … 600 |  |
| `seed` | Seed | `1337` | 1 … 9999 | **rebuild** |

## Swell

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `swellAmount` | Swell height | `0.55` | 0 … 2.5 | **rebuild** |
| `swellPeriod` | Swell period (s) | `13` | 4 … 25 | **rebuild** |
| `swellDirDeg` | Swell direction | `10` | 0 … 360 | **rebuild** |
| `swellSpread` | Swell narrowness | `6` | 0.5 … 40 | **rebuild** |
| `swellWidth` | Swell bandwidth | `0.06` | 0.01 … 0.3 | **rebuild** |

## Surface

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `heightScale` | Vertical gain | `1` | 0 … 3 |  |
| `horizScale` | Horizontal gain | `1` | 0 … 2 |  |
| `detailScale` | Detail distance | `1` | 0.25 … 4 |  |
| `earthCurve` | Planet curvature | `1` | 0 … 1 |  |
| `rMax` | Far radius (m) | `42000` | 5000 … 90000 |  |

## Water Displacement

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `waterDisplaceEnabled` | Meshes displace water | `1` | 0 … 1 |  |
| `waterDisplaceAmount` | Displacement strength | `1` | 0 … 2 |  |

## Foam

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `foamAmount` | Coverage | `0.9` | 0 … 3 |  |
| `foamCoverage` | Whitecap fraction x | `1` | 0 … 4 |  |
| `foamSoftness` | Breaking softness | `0.28` | 0.05 … 3 |  |
| `foamFace` | Forward-face bias | `0.7` | 0 … 1 |  |
| `foamBreakScale` | Breaker scale (m) | `3.2` | 0.5 … 40 |  |
| `foamCrestAniso` | Crest elongation | `4` | 1 … 12 |  |
| `foamRidge` | Crest ridge gate | `0.85` | 0 … 1 |  |
| `foamBreakup` | Raft breakup | `0.55` | 0 … 2 |  |
| `foamWindMin` | Whitecap onset (m/s) | `4` | 0 … 12 |  |
| `foamInject` | Injection | `4` | 0 … 3 |  |
| `foamFreshDecay` | Fresh foam decay | `0.9` | 0.05 … 4 |  |
| `foamDecay` | Decay rate | `0.42` | 0.01 … 3 |  |
| `foamThin` | Raft thinning | `0.18` | 0 … 0.6 |  |
| `foamDrift` | Downwind drift (m/s) | `0.6` | 0 … 3 |  |
| `foamSpread` | Spread rate | `0.4` | 0 … 1.5 |  |
| `foamDetail` | Bubble relief | `1.5` | 0 … 5 |  |
| `foamCrisp` | Bubble-edge crispness | `0.8` | 0 … 1 |  |
| `foamSharp` | Edge erosion | `1.4` | 0.2 … 6 |  |
| `foamStreak` | Downwind streaking | `0.7` | 0 … 1 |  |
| `foamOpacity` | Opacity | `0.92` | 0 … 1 |  |
| `foamFar` | Distance self-hiding | `0.55` | 0 … 1 |  |
| `foamRoughness` | Roughness | `0.62` | 0.05 … 1 |  |
| `foamTint` | Water tint | `0.35` | 0 … 1 |  |
| `foamLift` | Crest lift | `0.55` | 0 … 3 |  |
| `foamColor` | Colour | `[0.94, 0.965, 0.99]` | linear RGB |  |

## Water Optics

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `scatterColor` | Scattering albedo | `[0.048, 0.285, 0.36]` | linear RGB |  |
| `scatterAmount` | Upwelling reflectance | `0.085` | 0 … 0.6 |  |
| `sssStrength` | Subsurface | `1.2` | 0 … 6 |  |
| `sssPower` | Subsurface focus | `4` | 1 … 24 |  |
| `sssHeight` | Crest weighting | `0.75` | 0 … 3 |  |
| `sssDepth` | Wave thickness | `1` | 0.05 … 4 |  |
| `sssBias` | Subsurface exit bias | `0.45` | 0 … 1.5 |  |
| `baseRoughness` | Base roughness | `0.055` | 0.001 … 0.4 |  |
| `roughnessGain` | Filtered roughness | `1` | 0 … 3 |  |
| `roughnessMax` | Roughness ceiling | `0.3` | 0.05 … 1 |  |
| `windAniso` | Slope anisotropy | `1.45` | 0.3 … 4 |  |
| `capillary` | Capillary detail | `0.6` | 0 … 3 |  |
| `capillaryScale` | Capillary range | `1` | 0.2 … 4 |  |
| `gust` | Gust mottling | `0` | 0 … 1 |  |
| `gustScale` | Gust patch size | `55` | 8 … 300 |  |
| `gustDrift` | Gust drift | `0.35` | 0 … 3 |  |
| `waveAO` | Wave occlusion | `1` | 0 … 2 |  |
| `waveShadow` | Swell shadowing | `0.85` | 0 … 1 |  |
| `shadowScale` | Shadow reach | `1.2` | 0.1 … 5 |  |
| `interReflect` | Inter-reflection | `0.6` | 0 … 1 |  |
| `skyAmbient` | Sky ambient | `1` | 0 … 3 |  |
| `skyBlur` | Reflection blur | `0.5` | 0.1 … 4 |  |
| `glitter` | Glitter | `0.55` | 0 … 3 |  |
| `glitterScale` | Glitter scale | `1` | 0.1 … 4 |  |
| `specIntensity` | Sun specular | `1` | 0 … 4 |  |
| `specClamp` | Specular clamp | `20000` | 20 … 40000 |  |
| `specAA` | Specular antialiasing | `1` | 0 … 4 |  |
| `grazeFocus` | Grazing lobe focus | `0.2` | 0.02 … 1 |  |
| `horizonBend` | Horizon bend | `0.85` | 0 … 1 |  |
| `aerial` | Aerial perspective | `1` | 0 … 2 |  |
| `waterIOR` | Index of refraction | `1.333` | 1 … 1.8 |  |

## Spray

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `sprayOpacity` | Opacity | `0.85` | 0 … 2 |  |
| `sprayRate` | Emission rate | `0.85` | 0 … 1 |  |
| `sprayThreshold` | Breaking foam needed | `0.3` | 0.02 … 1 |  |
| `sprayFoldSoft` | Breaking softness | `0.15` | 0 … 0.95 |  |
| `sprayFoamBias` | Needs active breaking | `0.85` | 0 … 1 |  |
| `sprayWindMin` | Wind onset (m/s) | `4.5` | 0 … 30 |  |
| `sprayWindFull` | Wind saturation (m/s) | `18` | 2 … 45 |  |
| `sprayRadius` | Radius (m) | `120` | 20 … 1200 |  |
| `sprayFocus` | Near-field focus | `1.1` | 0.5 … 4 |  |
| `sprayLifetime` | Lifetime (s) | `2.2` | 0.3 … 10 |  |
| `sprayLaunch` | Launch speed | `4.6` | 0 … 14 |  |
| `sprayLaunchUp` | Launch lift | `0.45` | 0 … 3 |  |
| `sprayLaunchWind` | Launch wind share | `0.35` | 0 … 1.5 |  |
| `spraySheet` | Sheet size (particles) | `96` | 1 … 512 |  |
| `spraySheetRate` | Tear-off rate (1/s) | `5` | 0.5 … 30 |  |
| `spraySheetSpread` | Sheet spread (m) | `2.2` | 0.1 … 12 |  |
| `sprayShred` | Sheet shred length (m) | `1.6` | 0 … 10 |  |
| `sprayGravity` | Gravity | `9.4` | 0 … 20 |  |
| `sprayDrag` | Wind drag | `0.9` | 0 … 5 |  |
| `sprayTurbulence` | Turbulence | `2` | 0 … 8 |  |
| `sprayShear` | Wind shear | `0.35` | 0 … 1.5 |  |
| `spraySizeMin` | Parcel size min (m) | `0.018` | 0.02 … 1 |  |
| `spraySizeMax` | Parcel size max (m) | `0.15` | 0.05 … 4 |  |
| `spraySize` | Size | `1` | 0.1 … 5 |  |
| `sprayStretch` | Shutter smear (s) | `0.014` | 0 … 0.25 |  |
| `sprayFadeNear` | Near fade (m) | `1.6` | 0.05 … 4 |  |
| `sprayMinPixels` | Min screen size (px) | `1.15` | 0.5 … 8 |  |
| `sprayFarSoft` | Distant softness | `1.6` | 0 … 6 |  |
| `spraySurfFade` | Surface soft fade (m) | `0.3` | 0.02 … 3 |  |
| `sprayAerial` | Aerial extinction (1/m) | `0.0012` | 0 … 0.01 |  |
| `sprayGrain` | Droplet texture | `0.85` | 0 … 1 |  |
| `sprayGrainScale` | Droplet texture scale | `5.2` | 0.5 … 12 |  |
| `sprayGrainAniso` | Droplet texture stretch | `1.5` | 1 … 10 |  |

## Spindrift

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `sprayHaze` | Haze extinction (1/m) | `0.0004` | 0 … 0.004 |  |
| `sprayHazeWind` | Haze onset (m/s) | `20` | 0 … 45 |  |
| `sprayHazeHeight` | Haze depth (m) | `12` | 1 … 80 |  |
| `sprayHazeScatter` | Haze forward glow | `1` | 0 … 4 |  |
| `sprayHazeAmbient` | Haze ambient | `0.7` | 0 … 3 |  |
| `sprayHazeG` | Haze anisotropy | `0.6` | 0 … 0.95 |  |
| `sprayHazeSheets` | Haze sheeting | `0.7` | 0 … 1 |  |
| `sprayHazeSheetSize` | Haze sheet size (m) | `260` | 30 … 1200 |  |
| `sprayHazeSteps` | Haze steps | `12` | 4 … 24 |  |

## Spray Optics

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `sprayScatter` | Scattering | `1` | 0 … 4 |  |
| `sprayForwardG` | Forward lobe | `0.8` | 0.1 … 0.95 |  |
| `sprayBackG` | Back lobe | `0.35` | 0 … 0.9 |  |
| `sprayAmbient` | Sky ambient | `0.6` | 0 … 3 |  |
| `sprayMulti` | Multiple scatter | `0.05` | 0 … 0.5 |  |

## Sun & Sky

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `sunElevation` | Sun elevation | `7.5` | -12 … 90 |  |
| `sunAzimuth` | Sun azimuth | `55` | 0 … 360 |  |
| `sunIntensity` | Sun intensity | `22` | 0 … 60 |  |
| `sunTint` | Sun tint | `[1, 1, 1]` | linear RGB |  |
| `turbidity` | Turbidity | `1` | 0.2 … 8 |  |
| `ozone` | Ozone | `1` | 0 … 3 |  |
| `mieG` | Mie anisotropy | `0.76` | 0 … 0.95 |  |
| `skyMultiScatter` | Multi-scatter | `1` | 0 … 3 |  |
| `skyMSFloor` | Multi-scatter floor | `0.12` | 0 … 0.6 |  |
| `skyMSHeight` | Multi-scatter height (m) | `12000` | 2000 … 40000 |  |
| `sunDiscIntensity` | Disc intensity | `1` | 0 … 4 |  |
| `sunAngularRadius` | Disc radius | `0.0046` | 0.001 … 0.05 |  |
| `sunDiscCap` | Disc radiance cap | `20000` | 500 … 60000 |  |
| `sunLimbDarkening` | Limb darkening | `1` | 0 … 1.5 |  |
| `sunRefractFlatten` | Horizon flatten | `0.16` | 0 … 1 |  |
| `moonIntensity` | Moon light | `0` | 0 … 1 |  |
| `moonElevation` | Moon elevation | `-20` | -20 … 90 |  |
| `moonAzimuth` | Moon azimuth | `240` | 0 … 360 |  |
| `stars` | Stars | `0` | 0 … 2 |  |
| `starSize` | Star size (px) | `0.9` | 0.2 … 4 |  |
| `starDensity` | Star density | `0.34` | 0 … 1 |  |
| `starColorTemp` | Star colour spread | `0.45` | 0 … 1 |  |
| `skyDither` | LUT dither (texels) | `1.4` | 0 … 4 |  |

## Clouds

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `cloudCoverage` | Coverage | `0.46` | 0 … 1 |  |
| `cloudDensity` | Density | `1` | 0 … 3 |  |
| `cloudAltitude` | Base altitude (m) | `1500` | 200 … 6000 |  |
| `cloudThickness` | Thickness (m) | `2200` | 200 … 6000 |  |
| `cloudDetail` | Erosion | `0.6` | 0 … 1.5 |  |
| `cloudSpeed` | Drift speed | `1` | 0 … 6 |  |
| `cloudScale` | Cluster size (m) | `16000` | 2000 … 60000 |  |
| `cloudShape` | Billow size (m) | `1300` | 200 … 6000 |  |
| `cloudExtinction` | Extinction (1/m) | `0.045` | 0.005 … 0.2 |  |
| `cloudAnvil` | Anvil flatten | `0` | 0 … 1 |  |
| `cloudMultiScatter` | Multi-scatter | `0.66` | 0 … 0.95 |  |
| `cloudPowder` | Powder / dark edge | `0.7` | 0 … 1.5 |  |
| `cloudAmbient` | Sky ambient | `1` | 0 … 3 |  |
| `cloudAmbientFloor` | Ambient at base | `0.32` | 0 … 1 |  |
| `cloudSilver` | Silver lining | `1` | 0 … 4 |  |
| `cloudDistance` | March range (m) | `55000` | 8000 … 140000 |  |
| `cloudHaze` | Deck haze | `1` | 0 … 3 |  |
| `cloudFade` | Distance fade start | `0.55` | 0.1 … 1 |  |
| `cirrus` | Cirrus veil | `0.28` | 0 … 1 |  |
| `cirrusAltitude` | Cirrus altitude (m) | `8200` | 4000 … 14000 |  |
| `cirrusCurl` | Cirrus curl | `1` | 0 … 2 |  |
| `cirrusMask` | Cirrus patchiness | `3.2` | 0.5 … 12 |  |
| `cloudSteps` | March steps | `48` | 8 … 128 |  |
| `cloudStepMin` | Min march scale | `0.4` | 0.2 … 1 |  |

## Sea Dragon

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `sdEnabled` | Sea dragon | `1` | 0 … 1 |  |
| `sdDepth` | Dragon depth (m) | `7` | 1.6 … 25 |  |
| `sdSwell` | Sea lifts over its back (m) | `2.88` | 0 … 3 |  |
| `sdSwellRadius` | Lift footprint (m) | `2.5` | 1 … 25 |  |
| `sdSwellFade` | Lift dies by depth (m) | `9` | 1 … 20 |  |
| `sdSpray` | Spray where it breaks the surface | `1` | 0 … 1 |  |
| `sdSprayDepth` | Spray band (m) | `1.25` | 0.05 … 2 |  |
| `sdDepthSwing` | Dragon rise and sound (m) | `11.7` | 0 … 12 |  |
| `sdRushSpeed` | Speed it comes up at (m/s) | `26.5` | 5 … 30 |  |
| `sdOffsetClose` | Closes to (m) at speed | `9` | 3 … 40 |  |
| `sdOffset` | Dragon station off your shoulder (m) | `16` | 5 … 60 |  |
| `sdLead` | Dragon station ahead (m) | `6` | -20 … 40 |  |
| `sdFollowRise` | Follow camera height (m) | `6` | 1 … 40 |  |
| `sdFade` | Water that swallows it (m) | `3.5` | 2 … 30 |  |
| `sdOpacity` | Dragon strength | `1` | 0 … 1 |  |
| `sdLength` | Dragon length (m) | `52.5` | 6 … 60 |  |
| `sdSpeed` | Dragon top speed (m/s) | `50` | 4 … 50 |  |
| `sdWaves` | Dragon body waves | `1.25` | 0.3 … 3 |  |
| `sdAmp` | Dragon tail sweep | `0.055` | 0 … 0.2 |  |
| `sdBeat` | Dragon tail beat (Hz) | `0.35` | 0 … 3 |  |
| `sdBeatSpeed` | Dragon beat per m/s | `0.03` | 0 … 0.15 |  |
| `sdTurnRate` | Dragon turn rate (rad/s) | `0.55` | 0.1 … 2 |  |
| `sdOrbit` | Dragon circles you at (rad/s) | `0.2` | 0 … 1 |  |
| `sdGape` | Jaw shut angle (rad) | `0.3` | 0 … 1.4 |  |
| `sdThrough` | Shows through the glare | `0.07` | 0 … 1 |  |
| `sdRefract` | Refraction through the surface | `0.2` | 0 … 0.2 |  |

## Wave Runner

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `wrTopSpeed` | Top speed (m/s) | `44` | 4 … 60 |  |
| `wrAccel` | Acceleration | `19` | 1 … 30 |  |
| `wrBoost` | Boost multiplier | `1.35` | 1 … 2.5 |  |
| `wrView` | View | `1` | `Rider`, `Chase` |  |
| `wrTurnRate` | Turn rate | `0.85` | 0.05 … 2.5 |  |
| `wrSteerLag` | Steering response | `5` | 0.5 … 15 |  |
| `wrYawInertia` | Hull yaw inertia | `3` | 0.3 … 12 |  |
| `wrGrip` | Grip (lower drifts) | `2.1` | 0.2 … 8 |  |
| `wrTurnDrag` | Turn speed scrub | `0.3` | 0 … 1.5 |  |
| `wrCoastSteer` | Off-throttle steering | `0.3` | 0 … 1 |  |
| `wrCamDistance` | Chase distance (m) | `12` | 1.5 … 16 |  |
| `wrCamPull` | Chase pull-back at speed | `1.35` | 0 … 3 |  |
| `wrCamRise` | Chase height (m) | `4.6` | 0.2 … 8 |  |
| `wrCamLift` | Chase climbs at speed | `0.75` | 0 … 3 |  |
| `wrCamLag` | Chase lag | `5` | 0.5 … 20 |  |
| `wrCamLook` | Chase look-ahead (m) | `3` | 0 … 10 |  |
| `wrCamChaseRoll` | Chase roll | `0.35` | 0 … 1 |  |
| `wrProbeSmooth` | Ride smoothing | `16` | 2 … 40 |  |
| `wrCarveTurn` | Carve turn gain (Shift) | `1.9` | 1 … 4 |  |
| `wrCarveGrip` | Carve grip loss | `0.45` | 0.05 … 1 |  |
| `wrCarveDrag` | Carve speed scrub | `2.2` | 0.5 … 5 |  |
| `craftSprayAmount` | Hull spray | `0.75` | 0 … 3 |  |
| `hullPush` | Hull displaces water (m) | `0.55` | 0 … 2 |  |
| `hullRadius` | Hull footprint (m) | `2.6` | 0.5 … 10 |  |
| `hullBow` | Bow wave | `0.9` | 0 … 3 |  |
| `craftPlaneSpeed` | Planing speed (m/s) | `6` | 0 … 20 |  |
| `craftPlaneFull` | Full shedding (m/s) | `14` | 2 … 30 |  |
| `craftSprayLife` | Hull spray lifetime (s) | `0.85` | 0.1 … 4 |  |
| `craftSprayPulse` | Hull spray density | `0.22` | 0 … 1.5 |  |
| `craftLoadFull` | Carve spray saturation | `22` | 4 … 60 |  |
| `craftSpraySpread` | Hull spray spread | `1` | 0 … 3 |  |
| `craftSprayUp` | Hull spray lift | `1` | 0 … 3 |  |
| `craftJet` | Jet: rooster tail | `1` | 0 … 3 |  |
| `craftJetSpeed` | Jet: nozzle speed (m/s) | `17` | 0 … 40 |  |
| `craftJetAngle` | Jet: nozzle deflection | `0.6` | 0 … 1.4 |  |
| `craftJetRise` | Jet: nozzle trim | `0.42` | 0 … 1.5 |  |
| `craftSheet` | Chine sheets | `0.85` | 0 … 3 |  |
| `craftSheetSpeed` | Chine sheet speed | `0.42` | 0 … 1.5 |  |
| `craftCurtain` | Carve curtain | `1.15` | 0 … 3 |  |
| `craftCurtainSpeed` | Carve curtain speed | `1.8` | 0 … 6 |  |
| `craftBurst` | Bow burst | `0.9` | 0 … 3 |  |
| `craftSprayOpacity` | Hull spray density | `0.6` | 0 … 3 |  |
| `craftSprayMulti` | Hull spray glow | `0.15` | 0 … 2 |  |
| `wakeStrength` | Wake strength | `1.15` | 0 … 3 |  |
| `wakeWidth` | Wake arm width (m) | `1.5` | 0.2 … 6 |  |
| `wakeLife` | Wake lifetime (s) | `14` | 1 … 40 |  |
| `wakeSpread` | Wake arm thickening | `0.22` | 0 … 1.5 |  |
| `wakeDepth` | Wake surface relief (m) | `0.45` | 0 … 2 |  |
| `wakeRelief` | Wake relief shading | `1` | 0 … 3 |  |
| `wakeSlick` | Wake slick | `0.8` | 0 … 1 |  |
| `wakeExtent` | Wake memory (m) | `320` | 80 … 800 |  |
| `wakeProbe` | Ride your own wake | `0.8` | 0 … 2 |  |
| `wakeArmRate` | Wake V spread | `1` | 0 … 3 |  |
| `wakeArm` | Wake arm strength | `1` | 0 … 3 |  |
| `wakeCentre` | Wake churn | `0.5` | 0 … 2 |  |
| `craftLift` | Craft ride height (m) | `0.46` | -0.3 … 1.2 |  |
| `craftLength` | Craft length (m) | `3.2` | 1 … 6 |  |
| `craftYawOffset` | Model yaw offset | `3.1416` | -3.15 … 3.15 |  |
| `craftPitchOffset` | Model pitch offset | `0` | -3.15 … 3.15 |  |
| `craftRollOffset` | Model roll offset | `0` | -3.15 … 3.15 |  |
| `craftWetDarken` | Wet hull darkening | `0.55` | 0.2 … 1 |  |
| `craftGloss` | Craft gloss | `0.45` | 0 … 1 |  |
| `craftHullColor` | Hull colour | `[0.62, 0.055, 0.045]` | linear RGB |  |
| `craftAccentColor` | Hull underside | `[0.03, 0.035, 0.045]` | linear RGB |  |
| `wrBank` | Bank into turns | `0.55` | 0 … 2 |  |
| `wrHover` | Ride height (m) | `0.35` | 0 … 2 |  |
| `wrStiffness` | Suspension | `26` | 4 … 60 |  |
| `wrDamping` | Damping | `7` | 1 … 20 |  |
| `wrGravity` | Gravity | `13` | 4 … 25 |  |
| `wrLaunch` | Jump off crests | `1` | 0 … 3 |  |
| `wrLaunchThreshold` | Launch threshold | `3.2` | 0.5 … 10 |  |
| `wrJumpSpeed` | Jump: min speed (m/s) | `5` | 0 … 25 |  |
| `wrLaunchG` | Jump: separation (g) | `0.72` | 0.2 … 2 |  |
| `wrJumpGain` | Jump: airtime | `1.35` | 0 … 3 |  |
| `wrSurfFilter` | Jump: surface filter | `22` | 4 … 60 |  |
| `wrAirSteer` | Air control | `0.25` | 0 … 1 |  |
| `wrCamHeight` | Eye height (m) | `1.42` | 0.2 … 3 |  |
| `wrCamPitchFollow` | Pitch follow | `0.75` | 0 … 1.5 |  |
| `wrCamRollFollow` | Roll follow | `0.6` | 0 … 1.5 |  |
| `wrShake` | Ride shake | `1` | 0 … 3 |  |
| `wrFovKick` | Speed FOV kick | `18` | 0 … 40 |  |
| `wrBoostFov` | Boost FOV punch | `7` | 0 … 30 |  |
| `wrFovLag` | FOV response | `2.6` | 0.3 … 12 |  |
| `wrTouchSteer` | Touch steering | `1.6` | 0 … 4 |  |

## Seaplane

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `spThrust` | Engine thrust | `5.4` | 1 … 12 |  |
| `spTopSpeed` | Top speed (m/s) | `61` | 20 … 120 |  |
| `spTakeoff` | Rotation speed (m/s) | `23` | 10 … 45 |  |
| `spStall` | Stall speed (m/s) | `15` | 6 … 30 |  |
| `spMaxBank` | Max bank (rad) | `0.78` | 0.2 … 1.2 |  |
| `spMaxPitch` | Max pitch (rad) | `0.42` | 0.1 … 0.8 |  |
| `spRollRate` | Roll response | `2.4` | 0.5 … 6 |  |
| `spPitchRate` | Pitch response | `2` | 0.5 … 6 |  |
| `spWaterTurn` | Water rudder | `0.45` | 0.05 … 1.5 |  |
| `spLength` | Length (m) | `10.5` | 6 … 16 |  |
| `spCgHeight` | Waterline height (m) | `2.05` | 1 … 3.5 |  |
| `spCamDistance` | Chase distance | `26` | 10 … 60 |  |
| `spCamRise` | Chase rise | `7` | 2 … 20 |  |
| `spFovKick` | Speed FOV | `9` | 0 … 25 |  |
| `craftReflect` | Reflection in the water | `1` | 0 … 2 |  |
| `craftShadow` | Shadow on the water | `0.85` | 0 … 1 |  |
| `craftReflectFade` | Reflection fade (m) | `180` | 20 … 600 |  |
| `spHullPush` | Float hollow x | `0.5` | 0 … 2 |  |
| `spContactFade` | Contact fade (m) | `1.8` | 0.2 … 6 |  |
| `spHalfSpan` | Half span / length | `0.66` | 0.3 … 1.2 |  |
| `spWingBite` | Wing drag in water | `9` | 0 … 30 |  |
| `spWingRight` | Wing righting | `6` | 0 … 20 |  |
| `spPropIdle` | Prop idle (rad/s) | `12` | 0 … 40 |  |
| `spPropRpm` | Prop full power (rad/s) | `95` | 10 … 200 |  |

## Fishing Boat

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `boatTopSpeed` | Top speed (m/s) | `12` | 2 … 30 |  |
| `boatAccel` | Acceleration | `3.5` | 0.5 … 15 |  |
| `boatTurnRate` | Turn rate | `0.28` | 0.02 … 1 |  |
| `boatSteerLag` | Steering response | `1.6` | 0.2 … 8 |  |
| `boatYawInertia` | Hull yaw inertia | `1.1` | 0.2 … 6 |  |
| `boatGrip` | Grip (lower drifts) | `3.2` | 0.5 … 8 |  |
| `boatCoastSteer` | Off-throttle steering | `0.5` | 0 … 1 |  |
| `boatView` | View | `1` | `Wheelhouse`, `Chase` |  |
| `boatCamDistance` | Chase distance (m) | `20` | 4 … 40 |  |
| `boatCamRise` | Chase height (m) | `6` | 0.5 … 15 |  |
| `boatCamLag` | Chase lag | `4` | 0.5 … 20 |  |
| `boatLength` | Half-length (m) | `4.5` | 1 … 12 |  |
| `boatBeam` | Half-beam (m) | `1.65` | 0.5 … 5 |  |
| `boatLift` | Ride height offset (m) | `2.55` | -1.5 … 3.5 |  |
| `boatScale` | Hull scale | `1` | 0.3 … 3 |  |
| `boatYawOffset` | Model yaw offset | `3.1416` | -3.15 … 3.15 |  |
| `boatPitchOffset` | Model pitch offset | `0` | -3.15 … 3.15 |  |
| `boatRollOffset` | Model roll offset | `0` | -3.15 … 3.15 |  |
| `boatCamHeight` | Wheelhouse eye height (m) | `2.6` | 0.5 … 5 |  |
| `boatShake` | Ride shake | `0.4` | 0 … 2 |  |

## Camera

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `fov` | Field of view | `38` | 8 … 95 |  |
| `minAltitude` | Min altitude (m) | `0.6` | 0.1 … 400 |  |
| `handheld` | Handheld drift | `0.35` | 0 … 3 |  |
| `cameraBob` | Sea bob | `0` | 0 … 3 |  |
| `moveSpeed` | Fly speed | `12` | 0.5 … 200 |  |
| `lookSensitivity` | Look sensitivity | `1` | 0.2 … 3 |  |
| `invertLookY` | Invert look Y | `0` | 0 … 1 |  |

## Grade & Lens

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `tonemap` | Tonemap | `0` | `AgX`, `ACES`, `Reinhard` |  |
| `autoExposure` | Auto exposure | `1` | 0 … 1 |  |
| `exposure` | Exposure | `1` | 0.02 … 12 |  |
| `exposureBias` | EV bias | `0` | -4 … 4 |  |
| `exposureSpeed` | Adaptation speed | `1.6` | 0.05 … 8 |  |
| `exposureSpeedUp` | Stop-down speed x | `2.4` | 0.2 … 6 |  |
| `exposureTarget` | Auto target | `0.105` | 0.02 … 0.4 |  |
| `meterCenter` | Centre metering | `0.65` | 0 … 1 |  |
| `meterHighlight` | Meter highlight cut | `1.8` | 0 … 6 |  |
| `meterShadow` | Meter shadow cut | `0.4` | 0 … 6 |  |
| `meterSigma` | Highlight percentile (sd) | `1.75` | 0 … 4 |  |
| `meterHiTarget` | Highlight protect level | `0.82` | 0.2 … 6 |  |
| `exposureMin` | Auto floor | `0.004` | 0.0005 … 0.5 |  |
| `exposureMax` | Auto ceiling | `6` | 0.1 … 40 |  |
| `bloomIntensity` | Bloom | `0.08` | 0 … 0.4 |  |
| `bloomThreshold` | Bloom threshold | `1.1` | 0 … 8 |  |
| `bloomKnee` | Bloom knee | `0.6` | 0.01 … 3 |  |
| `bloomRadius` | Bloom radius | `1` | 0.3 … 3 |  |
| `bloomFalloff` | Bloom falloff | `0.82` | 0.4 … 1.6 |  |
| `bloomVeil` | Veil pickup | `0.016` | 0 … 0.08 |  |
| `bloomClamp` | Bloom firefly clamp | `120` | 1 … 400 |  |
| `glareIntensity` | Veiling glare | `0.09` | 0 … 0.3 |  |
| `glareSpread` | Veiling glare spread | `3` | 1 … 4 |  |
| `bloomAnamorphic` | Anamorphic | `0.15` | 0 … 1 |  |
| `bloomTint` | Bloom tint | `[1, 0.96, 0.92]` | linear RGB |  |
| `bloomTintAmount` | Bloom tint amount | `0.35` | 0 … 1 |  |
| `halation` | Halation | `0.03` | 0 … 0.15 |  |
| `halationTint` | Halation tint | `[1, 0.3, 0.1]` | linear RGB |  |
| `chromatic` | Chromatic aberration (px) | `1.2` | 0 … 8 |  |
| `distortion` | Lens distortion | `-0.02` | -0.3 … 0.3 |  |
| `vignette` | Vignette | `0.5` | 0 … 1.5 |  |
| `lensWater` | Lens water | `1` | 0 … 2 |  |
| `lensDrops` | Lens droplet density | `0.3` | 0 … 1 |  |
| `lensSize` | Lens droplet size | `0.6` | 0.2 … 3 |  |
| `lensRefract` | Lens refraction | `0.8` | 0 … 5 |  |
| `lensStreak` | Lens streaking | `0.55` | 0 … 2 |  |
| `lensFlowAngle` | Lens flow angle | `8` | -180 … 180 |  |
| `lensRim` | Lens droplet rim | `0.09` | 0 … 1.5 |  |
| `lensBody` | Lens droplet body | `0.55` | 0 … 2 |  |
| `lensFilm` | Lens film | `0.12` | 0 … 2 |  |
| `lensSpray` | Lens hit rate | `0.85` | 0 … 3 |  |
| `lensReach` | Plume reach (m) | `26` | 2 … 80 |  |
| `lensDry` | Lens dry-off (1/s) | `0.95` | 0.05 … 4 |  |
| `vignetteRound` | Vignette oval | `0.7` | 0 … 1 |  |
| `grain` | Film grain | `0.016` | 0 … 0.08 |  |
| `grainSize` | Grain size (px) | `1.7` | 0.5 … 6 |  |
| `grainChroma` | Grain chroma | `0.22` | 0 … 1 |  |
| `grainShadow` | Grain in shadows | `0.35` | 0 … 1 |  |
| `blackPoint` | Black point | `0` | -1 … 2 |  |
| `toeStrength` | Toe density (stops) | `0.45` | 0 … 2.5 |  |
| `toeRange` | Toe reach (stops) | `2.6` | 0.5 … 8 |  |
| `chromaRestore` | Hue restore | `0.18` | 0 … 1 |  |
| `contrast` | Contrast | `1.13` | 0.5 … 1.8 |  |
| `saturation` | Saturation | `1.02` | 0 … 2 |  |
| `postSaturation` | Print saturation | `1.04` | 0 … 2 |  |
| `temperature` | Temperature | `0` | -1 … 1 |  |
| `tintCC` | Tint | `0` | -1 … 1 |  |
| `splitTone` | Split tone | `0.25` | 0 … 1 |  |
| `splitShadow` | Split shadows | `[0.93, 0.97, 1.08]` | linear RGB |  |
| `splitHighlight` | Split highlights | `[1.05, 1, 0.95]` | linear RGB |  |
| `highlightRoll` | Highlight bloom-out | `1` | 0 … 3 |  |
| `lift` | Lift | `[0, 0.002, 0.006]` | linear RGB |  |
| `gammaCC` | Gamma | `[1, 1, 1]` | linear RGB |  |
| `gain` | Gain | `[1, 1, 1]` | linear RGB |  |
| `fxaa` | FXAA | `1` | 0 … 1 |  |

## Quality

| parameter | meaning | default | range | |
| --- | --- | --- | --- | --- |
| `fftSize` | FFT resolution | `256` | `64`, `128`, `256`, `512` | **rebuild** |
| `gridScaleMin` | Min grid scale | `0.45` | 0.25 … 1 |  |
| `gridRadial` | Grid radial | `400` | 48 … 900 | **grid** |
| `gridAngular` | Grid angular | `640` | 64 … 1536 | **grid** |
| `sprayTexSize` | Spray particles | `160` | `64`, `128`, `192`, `256`, `384` |  |
| `renderScale` | Render scale | `1` | 0.35 … 2 | **resize** |
| `adaptiveQuality` | Adaptive resolution | `1` | 0 … 1 |  |
| `fpsCap` | Frame rate cap (0 = off) | `60` | 0 … 144 |  |
| `fpsCapIdle` | Cap when not in front | `10` | 1 … 60 |  |
| `dprCap` | Pixel ratio cap | `2` | 0.5 … 3 | **resize** |
| `targetFps` | Target frame rate | `40` | 20 … 120 |  |
| `renderScaleMin` | Min render scale | `0.4` | 0.25 … 1 |  |
| `photoSamples` | Photo mode samples | `24` | 1 … 128 |  |

## Not exposed in the demo UI

Settable, but with no control panel entry — mostly internals and
derived values.

| parameter | default |
| --- | --- |
| `seaLevel` | `0` |
| `rMin` | `0.35` |
| `absorption` | `[0.42, 0.075, 0.045]` |
| `sprayMist` | `0` |
| `sprayMistWind` | `7` |
| `sprayMistLife` | `7` |
| `sprayMistSize` | `0.55` |
| `sprayMistRadius` | `2.5` |
| `sprayMistDrag` | `4` |
| `sprayMistFall` | `0.06` |
| `sprayMistRise` | `0.6` |
| `sprayMistGrow` | `2` |
| `sprayMistStretch` | `0.3` |
| `sprayMistOpacity` | `0` |
| `sprayMistGrain` | `0.55` |
| `lensWetRate` | `7` |
| `atmoExposure` | `1` |
| `cloudStepScale` | `1` |
| `wrBrake` | `14` |
| `wrAirGrip` | `0.25` |
| `wrLandingDrag` | `0.35` |
| `wrAttitudeRate` | `9` |
| `wrLength` | `1.6` |
| `wrBeam` | `0.6` |
| `wrCamTilt` | `-0.03` |
| `wrWakeSpeed` | `0.55` |
| `wrWakeTurn` | `0.8` |
| `wrWakeSlip` | `0.1` |
| `boatBrake` | `3` |
| `boatBoost` | `1` |
| `boatAirGrip` | `0.25` |
| `boatTurnDrag` | `0.12` |
| `boatAirSteer` | `0.25` |
| `boatBank` | `0.05` |
| `boatHover` | `0.15` |
| `boatStiffness` | `10` |
| `boatDamping` | `9` |
| `boatGravity` | `13` |
| `boatLaunch` | `0` |
| `boatLaunchThreshold` | `999` |
| `boatJumpSpeed` | `999` |
| `boatLaunchG` | `5` |
| `boatJumpGain` | `0` |
| `boatSurfFilter` | `22` |
| `boatLandingDrag` | `0.35` |
| `boatAttitudeRate` | `3` |
| `boatCamTilt` | `-0.02` |
| `boatCamPitchFollow` | `0.4` |
| `boatCamRollFollow` | `0.3` |
| `boatFovKick` | `6` |
| `boatBoostFov` | `0` |
| `boatFovLag` | `2.6` |
| `boatTouchSteer` | `1.6` |
| `boatProbeSmooth` | `16` |
| `boatCarveTurn` | `1` |
| `boatCarveGrip` | `1` |
| `boatCarveDrag` | `1` |
| `boatWakeSpeed` | `0.4` |
| `boatWakeTurn` | `0.5` |
| `boatWakeSlip` | `0.05` |
| `boatCamPull` | `0.4` |
| `boatCamLift` | `0.3` |
| `boatCamLook` | `4` |
| `boatCamLookRise` | `1.2` |
| `boatCamMinClear` | `1` |
| `boatCamChaseRoll` | `0.15` |
| `wakeTexSize` | `512` |
| `spScale` | `1` |
| `spCamLook` | `40` |
| `sdAccel` | `0.55` |
| `sdMinDepth` | `1.6` |
| `sdSeaLevel` | `0` |
| `wrCamLookRise` | `0.75` |
| `wrCamMinClear` | `0.7` |
| `craftScale` | `1` |
| `craftSeatColor` | `[0.05, 0.05, 0.055]` |
| `gridScale` | `1` |
| `powerPref` | `default` |
| `renderScaleMax` | `1` |

## Presets

Sparse overrides on top of `defaults`. Anything a preset does not mention
comes back from the defaults, so switching presets never leaves a stray
value behind.

| preset | overrides |
| --- | --- |
| `Golden Hour Swell` | 27 |
| `North Atlantic Storm` | 46 |
| `Glassy Dawn` | 27 |
| `Tropical Noon` | 26 |
| `Moonlit Passage` | 32 |
| `Peaceful Moonlit Ocean` | 41 |
| `Trade Winds` | 22 |
| `Hurricane Sea` | 46 |
| `Sheltered Water` | 38 |
| `Deep Blue Afternoon` | 21 |

