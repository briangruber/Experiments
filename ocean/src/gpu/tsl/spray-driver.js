// The TSL spray, driven. The node-graph counterpart of src/spray.js: it owns the
// two float ping-pong targets, the instanced billboard geometry, the five
// materials, and exposes the same update / drawHaze / draw shape so a caller can
// hold either behind one interface.
//
// Runs on WebGPU and on WebGL2 from one source. See docs/tsl-porting-rules.md
// and the long header of ./spray.js; this file only documents what is the
// DRIVER's business.
//
// ---------------------------------------------------------------------------
// 1. THE PING-PONG PARITY, AND WHY THERE ARE TWO OF EVERYTHING
//
//    `this.idx` is the READABLE parity, exactly as src/spray.js's this.idx is.
//    update() renders the material that READS rt[idx] into rt[1-idx] and then
//    flips; draw() renders the scene whose material reads rt[idx].
//
//    Two materials per program, NOT one material whose TextureNode value is
//    swapped between draws. prototypes/tsl-pingpong-probe.html measured that:
//    reassigning a TextureNode's .value does not invalidate the WebGPU bind
//    group, so every pass reads whichever texture was bound first. WebGL2
//    re-resolves the sampler per draw and is unaffected - ship-green on the
//    fallback, silently stale on the backend this port is for. So there are two
//    sim materials on two QuadMeshes, and two draw materials on two Meshes
//    sharing ONE geometry, each in its own Scene. Do not try to be clever and
//    swap mesh.material instead; two meshes is what the probe verified.
//
//    Building each material from the REAL target texture is also what satisfies
//    porting rule 11 by construction: no placeholder is ever bound at graph
//    build time, so no shader can bake the wrong textureLoad-vs-
//    textureSampleLevel choice.
//
//    Both targets start as all zeros, which is P.w = 0 = "dead", so every
//    particle is a spawn candidate on frame 1 - the same state src/spray.js's
//    `data: new Float32Array(size*size*4)` gives.
//
// ---------------------------------------------------------------------------
// 2. autoClear IS TRUE BY DEFAULT AND WOULD ERASE THE FRAME (porting rule 15)
//
//    QuadMesh.render() and renderer.render() both go through renderer.render(),
//    which clears the bound target first unless autoClear is off. For the two
//    draw passes that target is the frame the sea has already been painted into.
//    It is saved and restored around every pass, and the bound render target is
//    saved and restored around update() as well, because update() binds its own.
//
// ---------------------------------------------------------------------------
// 3. RENDER STATE, PASS BY PASS
//
//    sim  : QuadMesh, depthTest false, depthWrite false, NoBlending. No
//           vertexNode override - porting rule 14 is about passes that must sit
//           BEHIND geometry, and the sim renders into its own offscreen target
//           where QuadMesh's own ortho camera is exactly right.
//    haze : QuadMesh, depthTest FALSE, depthWrite false, transparent, premultiplied
//           blend. Rule 14 does NOT apply here either: the GLSL draws this with
//           FS_VERT (z = 0) and DEPTH_TEST disabled, so the layer paints over the
//           whole frame including the sea and the sky. Do NOT add the far-plane
//           vertexNode - it would put the veil behind the water it is supposed to
//           hang in front of.
//    draw : Mesh, depthTest TRUE, depthWrite FALSE, transparent, the same blend.
//           Reproduces gl.enable(DEPTH_TEST) + gl.depthMask(false).
//
//    The blend is CustomBlending ONE / ONE_MINUS_SRC_ALPHA on both colour and
//    alpha, because both fragment programs return PREMULTIPLIED colour -
//    vec4(col*a, a) - exactly as the GLSL's gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
//    expects.
//
// ---------------------------------------------------------------------------
// 4. THE GEOMETRY
//
//    Six vertices (two triangles) as an InstancedBufferGeometry with
//    instanceCount = size*size. `aCorner` is the GLSL's
//    `layout(location=0) in vec2 aCorner`. `position` carries the SAME six
//    corners with z = 0 and is never read by the shader: NodeMaterial
//    initialises positionLocal from the `position` attribute before positionNode
//    overwrites it, and that reference is unconditional, so on WebGPU a geometry
//    without it cannot be bound at all (./water-driver.js note 1). Giving it the
//    real corners rather than zeros costs nothing and keeps the bounds
//    meaningful.
//
//    boundingSphere is infinite and frustumCulled is off, because every vertex
//    is placed in the vertex stage. matrixAutoUpdate is off and matrixWorld is
//    identity, which is what makes three's modelViewProjection equal the GLSL's
//    uViewProj (./spray.js note 5). side = DoubleSide: the GL path never enables
//    CULL_FACE, and ax/ay can flip the quad's winding.
//
// ---------------------------------------------------------------------------
// 5. THE CALLER MUST HAVE BOUND A SKY LUT *BEFORE* CONSTRUCTING THIS
//
//    Both draw programs sample ./sky-background.js's skyLutTexture - mip 3 and
//    mip 4 explicitly, so the table MUST be mipped, which TslSky's default
//    already gives. TslSky's constructor calls setSkyLut(); if nothing has, the
//    spray is drawn against the 1x1 black placeholder, which is a plausible-
//    looking unlit grey plume rather than an error.
//
//    THE ORDER MATTERS FOR A SECOND, WORSE REASON (porting rule 11). That
//    placeholder is a FloatType DataTexture, and WGSLNodeBuilder.isUnfilterable
//    is true for FloatType whenever the adapter lacks `float32-filterable`. A
//    material BUILT while the placeholder is bound therefore bakes the
//    textureLoad path in and keeps it after the real, HalfFloat, mipped table is
//    bound: measured by generating the WGSL against the placeholder, the three
//    explicit-level taps (vAmb at 4, the haze's 4 and 3) come out as
//    `tsl_biquadraticTexture(...)` - four textureLoads and a hand-rolled bilinear
//    - instead of one textureSampleLevel. Close in value, several times the cost,
//    and permanent. Construct TslSky (or call setSkyLut) before constructing
//    TslSpray. ./water-surface.js has the same dependency.
//
// ---------------------------------------------------------------------------
// 6. ONE HARMLESS THREE ARTEFACT, DOCUMENTED SO IT IS NOT RE-DIAGNOSED
//
//    Building the billboard material on the GLSL backend prints
//    `THREE.AttributeNode: Vertex attribute "uv" not found on geometry.` once,
//    and the generated fragment main opens with one dead statement,
//    `nodeVarN = ( uvTransformMatrix * vec3( vec2( 0.0, 0.0 ), 1.0 ) ).xy;`,
//    that nothing reads.
//
//    Cause, isolated in node against a two-line repro: when ONE TextureNode is
//    sampled in BOTH stages of a single material, three sets up the BASE node's
//    default uv (TextureNode.setup's `if ( ! uvNode ) uvNode = getDefaultUV()`
//    then the uv-matrix transform) and emits it into the fragment flow even
//    though both real fetches carry their own uv. Here that base node is
//    skyLutTexture, read by sprayPosition for vAmb and by sprayFragment for the
//    aerial-perspective tap. WGSL does not emit it at all.
//
//    Do NOT "fix" it by giving the geometry a uv attribute: AttributeNode in the
//    fragment stage builds a VARYING, so that would turn a folded constant into a
//    real vertex buffer plus a real interpolator, for code nothing reads. The
//    missing attribute is what makes it fold to vec2(0,0) and cost nothing.
//
// ---------------------------------------------------------------------------
// 7. EVERY UNIFORM THE STAGES READ IS SET HERE, INCLUDING OTHER MODULES'
//
//    Porting rule 13. The sim reads ./cloud-field.js's uCamPos, uTime and
//    uWindDirV (the GLSL's uCamPos, uTime and uWind); the draw programs read
//    those plus the atmosphere and sky-LUT blocks and ./sky-background.js's
//    uInvViewProj. setCloudUniforms/setAtmosphereUniforms/setSkyLutUniforms/
//    setSkyBackgroundUniforms are therefore called from every entry point, not
//    left to whatever drew first.
//
//    The one setter deliberately NOT called is setWaterCommonUniforms - see
//    ./spray.js note 11. setSprayOceanUniforms writes the narrow subset instead.

import * as THREE from 'three/webgpu';

import {
	SPRAY_STATE_RT_OPTIONS, makeStateTextureNode,
	spraySimFragment, sprayPosition, sprayFragment, sprayHazeFragment,
	setSprayParticleUniforms, setSpraySimUniforms, setSprayDrawUniforms,
	setSprayHazeUniforms, setSprayOceanUniforms, sprayHazeDensity,
} from './spray.js';

import { setAtmosphereUniforms } from './atmosphere.js';
import { setSkyLutUniforms, moonDirOf } from './sky-lut.js';
import { setSkyBackgroundUniforms } from './sky-background.js';
import { setCloudUniforms } from './cloud-field.js';

// The two triangles of the billboard, in the GLSL's vertex order
// (src/spray.js:39-41).
const CORNERS = [ - 1, - 1, 1, - 1, 1, 1, - 1, - 1, 1, 1, - 1, 1 ];

/**
 * Build the instanced billboard geometry. See note 4.
 *
 * @param {number} count - instanceCount, i.e. size*size particles.
 * @returns {THREE.InstancedBufferGeometry}
 */
export function buildSprayGeometry( count ) {

	const corners = new Float32Array( CORNERS );
	const position = new Float32Array( 18 );
	for ( let i = 0; i < 6; i ++ ) {

		position[ i * 3 + 0 ] = corners[ i * 2 + 0 ];
		position[ i * 3 + 1 ] = corners[ i * 2 + 1 ];
		position[ i * 3 + 2 ] = 0;

	}

	const geo = new THREE.InstancedBufferGeometry();
	geo.setAttribute( 'aCorner', new THREE.BufferAttribute( corners, 2 ) );
	// Unused by the shader, required by Three - note 4.
	geo.setAttribute( 'position', new THREE.BufferAttribute( position, 3 ) );
	geo.instanceCount = count;
	// Every vertex moves in the vertex stage, so the real bounds are unknowable
	// here. frustumCulled is off on the meshes; set this anyway so nothing else
	// in three tries to reason about it.
	geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), Infinity );
	return geo;

}

// gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA) - premultiplied alpha. See note 3.
function applyPremultipliedBlend( material ) {

	material.transparent = true;
	material.blending = THREE.CustomBlending;
	material.blendEquation = THREE.AddEquation;
	material.blendSrc = THREE.OneFactor;
	material.blendDst = THREE.OneMinusSrcAlphaFactor;
	material.blendEquationAlpha = THREE.AddEquation;
	material.blendSrcAlpha = THREE.OneFactor;
	material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

}

export class TslSpray {

	/**
	 * Same shape as `new Spray(gl, blit, { size })`; the demo passes
	 * p.sprayTexSize (160 on desktop, 96 on handheld).
	 *
	 * @param {THREE.WebGPURenderer} renderer - already init()ed.
	 * @param {object} [opts]
	 * @param {number} [opts.size=256] - state texture edge length.
	 */
	constructor( renderer, { size = 256 } = {} ) {

		this.renderer = renderer;
		this.size = size;
		this.frame = 0;
		// The READABLE parity - see note 1.
		this.idx = 0;

		// Two targets, each carrying BOTH attachments (count: 2), because a
		// framebuffer is built from one target's textures - exactly as
		// src/spray.js:25-28 attaches [pos[i], vel[i]] to fbo[i].
		this.rt = [
			new THREE.RenderTarget( size, size, SPRAY_STATE_RT_OPTIONS ),
			new THREE.RenderTarget( size, size, SPRAY_STATE_RT_OPTIONS ),
		];
		for ( const rt of this.rt ) {

			rt.textures[ 0 ].name = 'abyssal.sprayPos';   // xyz world, w life remaining (s)
			rt.textures[ 1 ].name = 'abyssal.sprayVel';   // xyz velocity, w birth energy (SIGNED)

		}

		// One TextureNode per attachment per target, built from the REAL texture -
		// note 1.
		this.src = this.rt.map( ( rt ) => ( {
			pos: makeStateTextureNode( rt.textures[ 0 ] ),
			vel: makeStateTextureNode( rt.textures[ 1 ] ),
		} ) );

		// ---- the simulation, one material per read-parity --------------------
		this.simMaterial = [ 0, 1 ].map( ( i ) => {

			const m = new THREE.NodeMaterial();
			m.name = `abyssal.spraySim.${ i }`;
			// The OutputStructNode itself, never wrapped in Fn - ./spray.js note 4.
			m.fragmentNode = spraySimFragment( this.src[ i ].pos, this.src[ i ].vel );
			m.depthTest = false;
			m.depthWrite = false;
			m.transparent = false;
			m.blending = THREE.NoBlending;
			return m;

		} );
		this.simQuad = this.simMaterial.map( ( m ) => new THREE.QuadMesh( m ) );

		// ---- the billboards, one material and one mesh per read-parity -------
		this.geometry = buildSprayGeometry( this.count );

		this.drawMaterial = [ 0, 1 ].map( ( i ) => {

			const m = new THREE.NodeMaterial();
			m.name = `abyssal.sprayDraw.${ i }`;
			m.positionNode = sprayPosition( this.src[ i ].pos, this.src[ i ].vel );
			m.fragmentNode = sprayFragment();
			m.depthTest = true;    // gl.enable(DEPTH_TEST)
			m.depthWrite = false;  // gl.depthMask(false)
			m.side = THREE.DoubleSide;
			applyPremultipliedBlend( m );
			return m;

		} );

		this.drawMesh = this.drawMaterial.map( ( m ) => {

			const mesh = new THREE.Mesh( this.geometry, m );
			// Note 4: positionNode returns a WORLD-space position, so the model
			// matrix must stay identity, and the bounds are meaningless.
			mesh.matrixAutoUpdate = false;
			mesh.matrixWorld.identity();
			mesh.frustumCulled = false;
			return mesh;

		} );

		this.scene = this.drawMesh.map( ( mesh ) => {

			const s = new THREE.Scene();
			s.add( mesh );
			return s;

		} );

		// ---- the haze layer --------------------------------------------------
		this.hazeMaterial = new THREE.NodeMaterial();
		this.hazeMaterial.name = 'abyssal.sprayHaze';
		this.hazeMaterial.fragmentNode = sprayHazeFragment();
		// DEPTH TEST OFF, and no far-plane vertexNode - note 3.
		this.hazeMaterial.depthTest = false;
		this.hazeMaterial.depthWrite = false;
		applyPremultipliedBlend( this.hazeMaterial );
		this.hazeQuad = new THREE.QuadMesh( this.hazeMaterial );

		this._tmpSize = new THREE.Vector2();

	}

	/** Particle count, i.e. the geometry's instanceCount. */
	get count() {

		return this.size * this.size;

	}

	// autoClear and the bound render target are GLOBAL renderer state. Saved and
	// restored around every pass - note 2.
	_begin() {

		return {
			target: this.renderer.getRenderTarget(),
			cubeFace: this.renderer.getActiveCubeFace(),
			mipLevel: this.renderer.getActiveMipmapLevel(),
			autoClear: this.renderer.autoClear,
		};

	}

	_end( saved ) {

		this.renderer.setRenderTarget( saved.target, saved.cubeFace, saved.mipLevel );
		this.renderer.autoClear = saved.autoClear;

	}

	/**
	 * One simulation step. Mirrors Spray.update(dt, p, ctx, ocean).
	 *
	 * `dt` is the RAW step; ./spray.js's setter applies the Math.min(dt, 0.05)
	 * clamp, exactly as src/spray.js:73 does.
	 *
	 * @param {number} dt - seconds since the last update.
	 * @param {object} p - the parameter set.
	 * @param {object} ctx - { camPos, windVec3, time, craft* }.
	 * @param {object} ocean - for the cascade description and the disp/foam fields.
	 */
	update( dt, p, ctx, ocean ) {

		this.frame ++;

		// Called even though the sim reads nothing from it, so the three entry
		// points have one call order and none of them can be the odd one out.
		setAtmosphereUniforms( p );
		// uCamPos, uTime and uWindDirV - the sim reads all three (porting rule 13).
		setCloudUniforms( p, ctx );
		setSprayOceanUniforms( p, ocean );
		setSprayParticleUniforms( p, this.size );
		setSpraySimUniforms( p, ctx, dt, this.frame );

		const saved = this._begin();

		try {

			this.renderer.autoClear = false;

			const next = 1 - this.idx;
			this.renderer.setRenderTarget( this.rt[ next ] );
			this.simQuad[ this.idx ].render( this.renderer );   // reads rt[idx]
			this.idx = next;

		} finally {

			this._end( saved );

		}

	}

	/**
	 * The suspended mist layer, into whatever target is bound. Mirrors
	 * Spray.drawHaze(p, ctx, skyLut, atmo) - skyLut and atmo are module-owned in
	 * TSL, so they are gone from the signature.
	 *
	 * Drawn before the particles so droplets sit in front of the haze they are
	 * feeding, and gated on wind so calm seas pay nothing.
	 */
	drawHaze( p, ctx ) {

		// src/spray.js:118-120, verbatim. At the defaults this is 0 and the pass
		// never runs.
		const density = sprayHazeDensity( p );
		if ( density <= 1e-7 ) return;

		setAtmosphereUniforms( p );
		setSkyLutUniforms( p, ctx.sunDir, Math.max( ctx.camPos[ 1 ], 1 ),
			ctx.moonDir ?? moonDirOf( p ) );
		setCloudUniforms( p, ctx );
		// This is what writes uInvViewProj, which the haze needs for its ray.
		setSkyBackgroundUniforms( p, ctx );
		setSprayHazeUniforms( p, ctx );

		const saved = this._begin();

		try {

			this.renderer.autoClear = false;
			this.hazeQuad.render( this.renderer );

		} finally {

			this._end( saved );

		}

	}

	/**
	 * The haze layer and then the billboards, into whatever target is bound.
	 * Mirrors Spray.draw(p, ctx, skyLut, atmo, ocean).
	 *
	 * @param {object} p
	 * @param {object} ctx
	 * @param {object} ocean
	 * @param {THREE.Camera} camera - must already carry ctx's view/projection.
	 *   The sub-pixel test rebuilds uViewProj from it (./spray.js note 5).
	 */
	draw( p, ctx, ocean, camera ) {

		this.drawHaze( p, ctx );

		// src/spray.js:142, verbatim - and AFTER the haze, which is a separate
		// layer with its own gate.
		if ( p.sprayOpacity <= 0.001 && p.sprayMistOpacity <= 0.001 ) return;

		setAtmosphereUniforms( p );
		setSkyLutUniforms( p, ctx.sunDir, Math.max( ctx.camPos[ 1 ], 1 ),
			ctx.moonDir ?? moonDirOf( p ) );
		setCloudUniforms( p, ctx );
		setSprayOceanUniforms( p, ocean );
		setSprayParticleUniforms( p, this.size );

		// gl.drawingBufferHeight, or the bound HDR target's height when the frame
		// is going somewhere offscreen - which is the case in the shipping demo.
		const target = this.renderer.getRenderTarget();
		const viewportH = target
			? target.height
			: this.renderer.getDrawingBufferSize( this._tmpSize ).y;
		setSprayDrawUniforms( p, ctx, viewportH );

		const saved = this._begin();

		try {

			this.renderer.autoClear = false;
			this.renderer.render( this.scene[ this.idx ], camera );

		} finally {

			this._end( saved );

		}

	}

	dispose() {

		for ( const rt of this.rt ) rt.dispose();
		for ( const m of this.simMaterial ) m.dispose();
		for ( const m of this.drawMaterial ) m.dispose();
		this.hazeMaterial.dispose();
		this.geometry.dispose();

	}

}
