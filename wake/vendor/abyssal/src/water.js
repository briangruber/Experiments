// The sea surface itself: a radial grid centred on the camera, displaced by the
// Ocean simulation's cascades and shaded by the water BRDF.
//
// This is deliberately separate from Ocean. Ocean owns the *fields* - a set of
// displacement, slope and foam textures that describe a patch of sea and know
// nothing about a camera. WaterSurface owns the *view* of them. Anything that
// wants the sea's geometry without our shading (a physics probe, a custom
// material, a different renderer) uses Ocean alone and never touches this file.

const IDENT4 = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const CRAFT_HALF = new Float32Array([1, 1, 1]);
const CRAFT_FWD = new Float32Array([0, 1]);
const ZERO3 = new Float32Array(3);
const ONE2 = new Float32Array([1, 1]);
// A hull's mean albedo: most of them are pale. Only ever multiplies the sky the
// craft is under, so it is a tint and not a colour.
const CRAFT_TINT = new Float32Array([0.72, 0.76, 0.78]);

import { program, setUniforms, texture2D } from './gl.js';
import { clamp } from './math.js';
import { WATER_VS, WATER_FS } from './shaders/water.js';
import { LDR_OUTPUT_GLSL } from './shaders/output.js';
import { horizonPinAmount } from './horizon-pin.js';
import {
	decodeFoamLace, decodeWakeFoamPack, uploadWebGLMask, uploadWebGLRgba,
} from './water-assets.js';
import { FLOOR_CAUSTIC_SPAN, floorCausticLods } from './seafloor.js';
import { WAKE_FOAM_RIBBON_VARY } from './foam-lace.js';

// A hull that is nowhere near the water. Passing this is how you say "no boat":
// the shader's hull terms all scale by uHullPush and uHullPlane, and the
// position is far enough below the sea that nothing can reach it.
const NO_HULL = {
  pos: new Float32Array([0, -1e4, 0]),
  fwd: new Float32Array([0, 1]),
  push: 0,
  plane: 0,
  // A vec2, because that is what the cut uniform is. Falling back to `pos`
  // would hand a three-component array to a two-component uniform.
  cutPos: new Float32Array([0, -1e4]),
};

export class WaterSurface {
  // output: 'hdr' (default) writes linear radiance, for a float target with a
  // tonemapping pass after it. 'ldr' applies exposure and an ACES fit in the
  // shader, for drawing straight to a display-referred canvas.
  constructor(gl, params, { output = 'hdr' } = {}) {
    this.gl = gl;
    this.output = output;
    this.outExposure = 1.0;
    this.prog = program(gl, WATER_VS, WATER_FS, 'water', output === 'ldr' ? LDR_OUTPUT_GLSL : '');
    this.grid = null;
    // Scratch for the per-frame uniform block. A fresh Float32Array per uniform
    // per frame is a dozen short-lived objects every frame, which shows up as
    // jitter on a phone rather than as a lower average frame rate.
    this._vGrid = new Float32Array(2);
    this._vWind = new Float32Array(2);
    this._vFade = new Float32Array(4);
    this._dummyWake = null;
    // Histogram-balanced R8 mask. Coverage still comes from the FFT Jacobian
    // and terrain depth; this texture only resolves its bubble-scale edge.
    this._foamLace = texture2D(gl, {
      width: 1, height: 1,
      internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE,
      filter: gl.LINEAR, wrap: gl.REPEAT,
      data: new Uint8Array([128]), mips: true, aniso: 8,
    });
    // R = coarse cells, G = fine lace, B = sparse breakup. One packed
    // sampler lets the wake age through three looks without three bindings.
    this._wakeFoam = texture2D(gl, {
      width: 1, height: 1,
      internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
      filter: gl.LINEAR, wrap: gl.REPEAT,
      data: new Uint8Array([128, 128, 128, 255]), mips: true, aniso: 8,
    });
    void uploadWebGLMask(gl, this._foamLace, decodeFoamLace);
    void uploadWebGLRgba(gl, this._wakeFoam, decodeWakeFoamPack);
    this.buildGrid(params);
  }

  // Cascade fade distances: a patch stops contributing once its texels are far
  // smaller than a pixel, which is also where its energy becomes pure roughness.
  fadeDistances(ocean) {
    // FORKED: floor raised 200 -> 750. The pond IS the scene here: with the
    // fine cascades fading 200 m from the grid centre (the camera), a high
    // orbit showed a pale disc of ripple detail around the camera's ground
    // point and smooth blobs beyond -- the fade boundary made visible,
    // because the energy -> roughness handoff does not conserve brightness
    // under a lagoon sun. 750 m keeps every cascade live across the whole
    // pond from any camera the app allows.
    for (let i = 0; i < 4; i++) this._vFade[i] = clamp((ocean.L[i] ?? 1) * 38, 750, 60000);
    return this._vFade;
  }

  // Same story as the wake: the refraction samplers exist in the compiled
  // program whether or not a scene photo was taken this frame, and unbound
  // samplers land on unit 0 where they clash with whatever type lives there.
  _inertRefr() {
    const gl = this.gl;
    if (!this._dummyRefr) {
      this._dummyRefr = texture2D(gl, {
        width: 1, height: 1,
        internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
        filter: gl.NEAREST, wrap: gl.CLAMP_TO_EDGE,
      });
    }
    return this._dummyRefr;
  }

  // A wake texture has to be bound even when there is no wake, because the
  // sampler exists in the compiled program either way. uWakeOn = 0 makes the
  // shader ignore whatever it reads.
  _inertWake() {
    const gl = this.gl;
    if (!this._dummyWake) {
      this._dummyWake = texture2D(gl, {
        width: 1, height: 1,
        internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
        filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
      });
    }
    return {
      uWakeTex: this._dummyWake,
      uWakeOrigin: new Float32Array([0, 0]),
      uWakeHead: new Float32Array([0, 0]),
      uWakeFwd: new Float32Array([0, 1]),
      uWakeSpeed: 0,
      uWakeExtent: 1,
      uWakeOn: 0,
      uWakeLife: 1, uWakeArmW: 1, uWakeEdge: 0.22, uWakeArm: 0, uWakeChurn: 0, uWakeSpread: 1,
      uWakeBeam: 1, uWakeDepth: 0, uWakeStrength: 0,
      uWakeWidth0: 0, uWakeWidth1: 0, uWakeArms: 2, uWakeTrail: 1, uWakeTurb: 0,
      uWakeCut: 0.55,
      uWakeBow: new Float32Array([0, 0, 0, 8]),
      uFoamEnergy: this._dummyWake,
      uFoamEnergyOn: 0,
    };
  }

  // gridScale is the adaptive quality controller's coarsest lever. At full
  // quality the default is 400 x 640, a quarter of a million vertices and half a
  // million triangles submitted every frame, each doing four cascade fetches. On
  // a phone that is often the binding cost rather than fill rate, and trimming
  // pixels alone cannot touch it.
  buildGrid(p) {
    const gl = this.gl;
    if (this.grid) {
      gl.deleteVertexArray(this.grid.vao);
      gl.deleteBuffer(this.grid.vbo);
      gl.deleteBuffer(this.grid.ibo);
    }
    const g = clamp(p.gridScale ?? 1, 0.25, 1);
    const R = Math.max(24, Math.round(p.gridRadial * g));
    const A = Math.max(24, Math.round(p.gridAngular * g));
    const verts = new Float32Array((R + 1) * A * 2);
    let o = 0;
    for (let i = 0; i <= R; i++) {
      const t = i / R;
      for (let j = 0; j < A; j++) { verts[o++] = t; verts[o++] = j / A; }
    }
    const idx = new Uint32Array(R * A * 6);
    let k = 0;
    for (let i = 0; i < R; i++) {
      for (let j = 0; j < A; j++) {
        const j1 = (j + 1) % A;
        const a = i * A + j, b = i * A + j1, c = (i + 1) * A + j, d = (i + 1) * A + j1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.grid = { vao, vbo, ibo, count: idx.length, radial: R, angular: A };
  }

  // p     parameter set (see presets.js `defaults`)
  // ctx   { camPos, viewProj, sunDir, moonDir, time }
  // ocean an Ocean whose update() has already run this frame
  // sky   a Sky whose updateLUT() has already run this frame
  // opts  { wake, wakeActive, hull } - all optional
  render(p, ctx, ocean, sky, opts = {}) {
    const gl = this.gl;
    const hull = opts.hull || NO_HULL;
    const wake = opts.wake
      ? opts.wake.uniforms(p, opts.wakeActive !== false)
      : this._inertWake();

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    setUniforms(gl, this.prog, {
      ...sky.atmosphereUniforms(p),
      uDisp: ocean.disp, uSlope: ocean.slope, uFoam: ocean.foamTex,
      uPatch: ocean.patchSizes, uFade: this.fadeDistances(ocean),
      uCascadeCount: ocean.cascadeCount, uDetailScale: p.detailScale,
      uViewProj: ctx.viewProj, uCamPos: ctx.camPos,
      uGridCenter: set2(this._vGrid, ctx.camPos[0], ctx.camPos[2]),
      uRMin: p.rMin, uRMax: p.rMax,
      uGroupAmt: p.groupAmount ?? 0, uGroupScale: p.groupScale ?? 0.0022,
      uGroupLo: p.groupLo ?? 0.55, uGroupHi: p.groupHi ?? 1.8,
      uRogueH: p.rogueHeight ?? 0, uRogueLen: p.rogueLength ?? 90,
      uRoguePeriod: p.roguePeriod ?? 40, uRogueWidth: p.rogueWidth ?? 60,
      uRogueRun: p.rogueRun ?? 600, uRogueSteep: p.rogueSteep ?? 0.6,
      uHeightScale: p.heightScale, uHorizScale: p.horizScale,
      uEarthCurve: p.earthCurve, uSeaLevel: p.seaLevel,
      uHorizonPin: horizonPinAmount(ctx, p),
      uSkyLUT: sky.lut, uSunDir: ctx.sunDir, uMoonDir: ctx.moonDir,
      uSunColor: p.sunIrradiance, uMoonColor: p.moonColor,
      uTime: ctx.time,
      uScatterColor: p.scatterColor, uAbsorption: p.absorption,
      uScatterAmount: p.scatterAmount,
      uSSSStrength: p.sssStrength, uSSSPower: p.sssPower, uSSSHeight: p.sssHeight,
      uSSSDepth: p.sssDepth,
      uBaseRoughness: p.baseRoughness, uRoughnessGain: p.roughnessGain,
      uRoughnessMax: p.roughnessMax, uWindAniso: p.windAniso,
      uWindSpeed: p.windSpeed,
      uFoamAmount: p.foamAmount, uFoamRoughness: p.foamRoughness,
      uFoamTint: p.foamTint, uFoamDetail: p.foamDetail, uFoamLift: p.foamLift,
      uFoamSharp: p.foamSharp, uFoamCrisp: p.foamCrisp, uFoamStreak: p.foamStreak,
      uFoamDrift: p.foamDrift, uFoamFill: p.foamFill ?? 0.55,
      uFoamCell: p.foamCell ?? 1,
      uFoamLace: this._foamLace,
      uWakeFoamPack: this._wakeFoam,
      uFoamTextureAmount: p.foamTextureAmount ?? 0,
      uFoamTextureScale: p.foamTextureScale ?? 9,
      uFoamTextureCarry: p.foamTextureCarry ?? 0.55,
      uFoamTextureShear: p.foamTextureShear ?? 0.30,
      uFoamTextureStrain: p.foamTextureStrain ?? 0.38,
      uFoamLaceStretch: p.foamLaceStretch ?? 0,
      uFoamLaceStretchBlock: p.foamLaceStretchBlock ?? 28,
      uFoamLaceMorph: p.foamLaceMorph ?? 0,
      uFoamLaceMorphRate: p.foamLaceMorphRate ?? 0,
      uWakeFoamRibbonVary: p.wakeFoamRibbonVary ?? WAKE_FOAM_RIBBON_VARY,
      uFoamRibbon: Number.isFinite( opts.foamRibbon ) ? Math.max( opts.foamRibbon, 0 ) : 1,
      // Sea-bed colour. Upstream hard-coded these in the shader; a lake wants
      // a sandy bottom with far less weed than the reef pattern assumes.
      uBedSand: p.bedSand ?? [ 0.78, 0.68, 0.48 ],
      uBedWeed: p.bedWeed ?? [ 0.16, 0.22, 0.18 ],
      uBedWeedAmt: p.bedWeedAmount ?? 1,
      uBedGain: p.bedGain ?? 1,
      uBedCoral: p.bedCoral ?? [ 0.42, 0.34, 0.30 ],
      uBedCoralAmt: p.bedCoralAmount ?? 0,
      // The prototype's foam lace. Owned here rather than by the wake bridge
      // because the sea's own whitecaps use the same field now -- one lace for
      // the whole surface, so the boat and the water cannot wear different foam.
      uLabLace: p.labLace ?? 2.2,
      uLabSoft: p.labSoft ?? 0.58,
      uLabCoarsen: p.labCoarsen ?? 0.24,
      uLabDensity: p.labDensity ?? 1.75,
      uLabGain: p.labGain ?? 5.5,
      uLabSea: p.labSeaLace ?? 0,
      uLabSeaBreak: p.labSeaBreak ?? 0,
      uFoamOpacity: p.foamOpacity,
      uFoamColor: p.foamColor,
      uSunAngularRadius: p.sunAngularRadius, uSpecIntensity: p.specIntensity,
      uSkyAmbient: p.skyAmbient, uSkyBlur: p.skyBlur,
      uGlitter: p.glitter, uGlitterScale: p.glitterScale,
      uWaterIOR: p.waterIOR, uAerial: p.aerial,
      uFloorDepth: p.floorDepth ?? 0,
      uFloorDepthMin: p.floorDepthMin ?? 0,
      uFloorDepthMax: p.floorDepthMax ?? 0,
      uFloorTerrainScale: p.floorTerrainScale ?? 36,
      uFloorCaustic: p.floorCaustic ?? 1,
      uFloorCausticSize: p.floorCausticSize ?? 1,
      uRefractDistort: p.sdRefract ?? 0.43,
      uFloorCausticLod: floorCausticLods( ocean.patchSizes, ocean.N ?? p.fftSize ?? 128 ),
      uFloorCausticSpan: FLOOR_CAUSTIC_SPAN,
      uShoreFoamAmount: p.shoreFoamAmount ?? 0,
      // FORKED: the caller's coastline, if it has one.
      ...(opts.shore ? {
        uShoreMap: opts.shore.tex, uShoreOn: 1,
        uShoreExtent: opts.shore.extent, uSurge: opts.shore.surge ?? p.surge ?? 1,
      // SURGE COMES OFF THE PARAMS with no coast map handed over. It was only
      // ever read from the shore option, so a driver that drops the map -- and
      // the shore break does NOT need one, it runs off whatever bed
      // bedDepthAt() returns -- silently lost its sets and got a break pinned
      // to one depth, which is a static ring of foam.
      } : { uShoreMap: this._inertRefr(), uShoreOn: 0, uShoreExtent: 1,
            uSurge: p.surge ?? 0 }),
      uShoreFoamRange: p.shoreFoamRange ?? 3,
      uSurfSpan: p.surfSpan ?? 3.2, uSurfPeriod: p.surfPeriod ?? 7.0,
      uSurfDecay: p.surfDecay ?? 3.0,
      uFoamSoft: p.foamSoft ?? 0,
      uWaveDebug: p.waveDebug ?? 0, uWaveDebugScale: p.waveDebugScale ?? 0.15,
      uWindDirV: set2(this._vWind, Math.cos(p.windDir), Math.sin(p.windDir)),
      uSpecClamp: p.specClamp, uHorizonBend: p.horizonBend,
      ...wake,
      // FORKED: screen-space refraction of the caller's scene (see WATER_FS).
      ...(opts.refr ? {
        uRefrColor: opts.refr.color, uRefrDepth: opts.refr.depth,
        uRefrRes: opts.refr.res, uRefrOn: 1, uRefrAmt: opts.refr.amount,
        uRefrNear: opts.refr.near, uRefrFar: opts.refr.far, uRefrMurk: opts.refr.murk,
      } : {
        // Bind SOMETHING even when refraction is off. An unbound sampler
        // defaults to unit 0, where a sampler of another type already sits,
        // and two mismatched samplers on one unit invalidate the entire draw
        // -- the sea vanished to flat grey the moment refraction was disabled.
        uRefrColor: this._inertRefr(), uRefrDepth: this._inertRefr(),
        uRefrRes: ONE2, uRefrOn: 0, uRefrAmt: 0,
        uRefrNear: 0.5, uRefrFar: 10, uRefrMurk: 0,
      }),
      // FORKED: PLANAR REFLECTION of the caller's scene (see WATER_FS).
      //
      // Same unbound-sampler trap as the refraction above: bind something even
      // when it is off, or the sampler falls to unit 0 where a sampler of
      // another type already sits and the whole draw is invalidated.
      ...(opts.refl ? {
        uReflTex: opts.refl.color, uReflMat: opts.refl.matrix, uReflOn: 1,
        uReflAmt: opts.refl.amount, uReflDistort: opts.refl.distort,
        uReflBlur: opts.refl.blur ?? 0, uReflMaxLod: opts.refl.maxLod ?? 1,
      } : {
        uReflTex: this._inertRefr(), uReflMat: IDENT4, uReflOn: 0,
        uReflAmt: 0, uReflDistort: 0, uReflBlur: 0, uReflMaxLod: 1,
      }),
      uWakeRelief: p.wakeRelief, uWakeSlick: p.wakeSlick,
      uWakePlume: p.wakePlume ?? 1.0,
      uHullPos: hull.pos, uHullFwd: hull.fwd,
      uHullCut: hull.cut ?? 0, uHullCutPos: hull.cutPos ?? NO_HULL.cutPos,
      uHullCutLen: hull.cutLen ?? 1, uHullCutBeam: hull.cutBeam ?? 1,
      uHullPush: hull.push,
      uHullRadius: p.hullRadius, uHullBow: p.hullBow,
      uHullPlane: hull.plane,
      // The craft's image in the water (WATER_FS: THE CRAFT IN THE WATER).
      // Read off ctx, which every driver already fills, so a caller that has no
      // craft gets amount 0 and the branch costs one compare.
      uCraftReflPos: ctx.craftReflPos ?? ZERO3,
      uCraftReflTint: ctx.craftReflTint ?? CRAFT_TINT,
      uCraftReflSize: ctx.craftReflSize ?? 0,
      uCraftReflHalf: ctx.craftReflHalf ?? CRAFT_HALF,
      uCraftReflFwd: ctx.craftReflFwd ?? CRAFT_FWD,
      uCraftReflAmount: ctx.craftReflAmount ?? 0,
      uCraftShadow: ctx.craftShadow ?? 0,
      uInterReflect: p.interReflect, uWaveAO: p.waveAO,
      uWaveShadow: p.waveShadow, uShadowScale: p.shadowScale,
      uCapillary: p.capillary, uCapillaryScale: p.capillaryScale,
      uGust: p.gust ?? 0, uGustScale: p.gustScale ?? 55, uGustDrift: p.gustDrift ?? 0.35,
      uSpecAA: p.specAA, uGrazeFocus: p.grazeFocus,
      uSSSBias: p.sssBias, uFoamFar: p.foamFar,
      uOutExposure: this.outExposure,
    });
    gl.bindVertexArray(this.grid.vao);
    gl.drawElements(gl.TRIANGLES, this.grid.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    if (this.grid) {
      gl.deleteVertexArray(this.grid.vao);
      gl.deleteBuffer(this.grid.vbo);
      gl.deleteBuffer(this.grid.ibo);
      this.grid = null;
    }
    if (this._dummyWake) gl.deleteTexture(this._dummyWake.tex);
    if (this._foamLace) gl.deleteTexture(this._foamLace.tex);
    if (this._wakeFoam) gl.deleteTexture(this._wakeFoam.tex);
    gl.deleteProgram(this.prog);
  }
}

function set2(a, x, y) { a[0] = x; a[1] = y; return a; }
