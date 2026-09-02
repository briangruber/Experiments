// The state of the water's surface: what is ON it, kept where it was put.
//
// Everything the wake field draws is a reconstruction -- re-derived from the
// path every frame, a function of where the boat has been and what it is
// doing now. That is fine for WAVES, which really are a function of the track.
// It is wrong for FOAM, which is a material: entrained air that surfaced into
// a raft, and from then on has a life of its own that the boat cannot reach
// back and edit. Reversing moved the whole wake because the wake had no
// existence apart from its recipe.
//
// This is where foam exists. A world-locked texture that follows the boat by
// exact integer-texel shifts (focus() snaps the centre to whole multiples of
// four texels, so nothing is ever resampled), holding per texel:
//
//   R  foam   surface raft, 0..~1 as coverage
//   G  air    bubbles still in the column, which rise into foam
//   B  fresh  decays fast; fresh / foam is how new the raft is, which is what
//             separates bright breaking white from thin old residue
//
// Every frame: shift, let air surface, let everything fade, then ADD what the
// hull is making right now. Sources are splats -- where the mesh cuts the
// water, the transom, spray landing -- each scaled by the physics it stands
// for. Nothing is a prescribed shape. The V a fast boat leaves is where its
// chine sheets landed; the band a slow boat leaves is its waterline shear and
// its transom; and both are the same code told different speeds.

import * as THREE from 'three';
import { get } from './params.js';

const MAX_SPLATS = 640;

const STEP_VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const STEP_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uPrev;
  uniform vec2  uShift;
  uniform float uScale;
  uniform float uDt;
  uniform float uFoamHalf, uAirHalf, uFreshHalf, uRise;
  // The surface's shape, for breaking: the wake field's height channel, in
  // metres, in this same window. uTexel is one of its texels in uv, uMetres
  // the window's width, so a difference over two texels is a slope.
  uniform sampler2D uHeight;
  uniform float uTexel, uMetres, uBreak, uBreakSlope;
  varying vec2 vUv;
  float hAt(vec2 o){ return texture2D(uHeight, vUv + o).g; }
  void main(){
    // Follow the boat. uShift is a whole number of texels, so this is a copy
    // -- except on the frame the window changes size, when uScale is not one
    // and the old contents are read through a resample. Once per zoom.
    vec2 uv = (vUv - 0.5) * uScale + 0.5 + uShift;
    vec4 p = (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))))
      ? vec4(0.0) : texture2D(uPrev, uv);
    float foam = p.r, air = p.g, fresh = p.b;

    // BREAKING. A crest that gets too steep spills, and a spilling crest is
    // where white water comes from on open sea -- and on the arms of a wake,
    // whose steepest crests are the ones the recipe has always painted with
    // a stripe. Now it is a source like any other: past the slope a crest
    // can hold, air goes into the water in proportion to how far past.
    if (uBreak > 0.0) {
      float d = 2.0 * uTexel * uMetres;
      vec2 g = vec2(hAt(vec2(uTexel, 0.0)) - hAt(vec2(-uTexel, 0.0)),
                    hAt(vec2(0.0, uTexel)) - hAt(vec2(0.0, -uTexel))) / d;
      float br = max(length(g) - uBreakSlope, 0.0) * uBreak * uDt;
      air   += br;
      // Some of it is white at once: the spilling face itself.
      foam  += br * 0.35;
      fresh += br * 0.35;
    }

    // Air SURFACES. A bubble rises at a rate set by its size, and a cloud of
    // them arrives at the top over a few seconds -- which is why the plume is
    // turquoise under the transom and white a boat-length behind it.
    float up = air * (1.0 - exp(-uRise * uDt));
    air  -= up;
    foam += up;
    // A raft of freshly surfaced bubbles is new white.
    fresh += up;

    // Then everything fades, as half-lives -- a number that means the same
    // thing at thirty frames a second and at a hundred and twenty.
    air   *= pow(0.5, uDt / max(uAirHalf,   0.1));
    foam  *= pow(0.5, uDt / max(uFoamHalf,  0.1));
    fresh *= pow(0.5, uDt / max(uFreshHalf, 0.1));
    fresh  = min(fresh, foam);

    gl_FragColor = vec4(foam, air, fresh, 0.0);
  }
`;

const SPLAT_VERT = /* glsl */`
  attribute vec2 aLocal;
  attribute vec3 aInject;
  varying vec2 vLocal;
  varying vec3 vInject;
  void main(){
    vLocal = aLocal;
    vInject = aInject;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SPLAT_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vLocal;
  varying vec3 vInject;
  void main(){
    // Soft in both axes, so a run of splats down a waterline overlaps into a
    // band rather than reading as a string of beads.
    float fx = 1.0 - smoothstep(0.35, 1.0, abs(vLocal.x));
    float fy = 1.0 - smoothstep(0.30, 1.0, abs(vLocal.y));
    gl_FragColor = vec4(vInject * (fx * fy), 0.0);
  }
`;

export class SurfaceState {

	/**
	 * @param renderer  the three renderer
	 * @param field     the WakeField, for its centre, extent and camera -- the
	 *                  surface lives in exactly the same window
	 * @param size      texels per side
	 */
	constructor( renderer, field, size = 1024 ) {

		this.renderer = renderer;
		this.field = field;
		this.size = size;
		const mk = () => new THREE.WebGLRenderTarget( size, size, {
			type: THREE.HalfFloatType, format: THREE.RGBAFormat,
			minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
			depthBuffer: false,
		} );
		this.rt = [ mk(), mk() ];
		this.i = 0;
		this.center = new THREE.Vector2( 0, 0 );
		this.extent = field.extent;
		this.reset = true;

		// ---- the step: shift, surface, fade ---------------------------------
		this.stepU = {
			uPrev: { value: this.rt[ 1 ].texture },
			uShift: { value: new THREE.Vector2( 0, 0 ) },
			uScale: { value: 1 },
			uDt: { value: 1 / 60 },
			uFoamHalf: { value: 22 }, uAirHalf: { value: 6 },
			uFreshHalf: { value: 3 }, uRise: { value: 0.35 },
			uHeight: { value: field.rt.texture },
			uTexel: { value: 1 / field.rt.width }, uMetres: { value: field.extent },
			uBreak: { value: 0 }, uBreakSlope: { value: 0.1 },
		};
		this.stepScene = new THREE.Scene();
		this.stepCam = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
		this.stepScene.add( new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ),
			new THREE.ShaderMaterial( {
				uniforms: this.stepU, vertexShader: STEP_VERT, fragmentShader: STEP_FRAG,
				depthTest: false, depthWrite: false,
			} ) ) );

		// ---- the sources: a pool of splats rebuilt every frame ---------------
		const n = MAX_SPLATS;
		this.pos = new Float32Array( n * 4 * 3 );
		this.loc = new Float32Array( n * 4 * 2 );
		this.inj = new Float32Array( n * 4 * 3 );
		const idx = new Uint32Array( n * 6 );
		for ( let q = 0; q < n; q ++ ) {
			const v = q * 4, o = q * 6;
			idx[ o ] = v; idx[ o + 1 ] = v + 1; idx[ o + 2 ] = v + 2;
			idx[ o + 3 ] = v; idx[ o + 4 ] = v + 2; idx[ o + 5 ] = v + 3;
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( this.pos, 3 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setAttribute( 'aLocal', new THREE.BufferAttribute( this.loc, 2 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setAttribute( 'aInject', new THREE.BufferAttribute( this.inj, 3 ).setUsage( THREE.DynamicDrawUsage ) );
		g.setIndex( new THREE.BufferAttribute( idx, 1 ) );
		g.setDrawRange( 0, 0 );
		this.splatGeo = g;
		this.nSplat = 0;
		const mesh = new THREE.Mesh( g, new THREE.ShaderMaterial( {
			vertexShader: SPLAT_VERT, fragmentShader: SPLAT_FRAG,
			transparent: true, depthTest: false, depthWrite: false,
			blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
			blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
			// BOTH SIDES, and this is the line the whole sim was missing.
			//
			// The corners are laid out (-1,-1) (1,-1) (1,1) (-1,1) in the hull's
			// along/across frame, and as seen from a camera looking straight
			// down that winds CLOCKWISE: the face normal comes out pointing -Y,
			// away from the camera, and with the default FrontSide every splat
			// was culled as a back face. Measured: two triangles drawn per
			// splat, one call, zero pixels landed, under three different blend
			// states -- the fragments never reached the blend at all.
			//
			// A splat is a stamp on the water; it has no front. And the winding
			// flips with the heading anyway, so fixing the index order would
			// only have fixed half the compass.
			side: THREE.DoubleSide,
		} ) );
		mesh.frustumCulled = false;
		this.splatScene = new THREE.Scene();
		this.splatScene.add( mesh );

	}

	/** The live face, for the water to sample. */
	texture() { return this.rt[ this.i ].texture; }

	/** Start the frame's source list. */
	begin() { this.nSplat = 0; }

	/**
	 * One patch of injection: centred at (x, z), half-sizes `ha` along the unit
	 * axis (ax, az) and `hc` across it. foam / air / fresh are amounts per
	 * SECOND -- the caller passes dt-scaled values, so a splat that lasts a
	 * frame lays down the right total whatever the frame rate.
	 */
	splat( x, z, ax, az, ha, hc, foam, air, fresh ) {

		if ( this.nSplat >= MAX_SPLATS ) return;
		const q = this.nSplat ++;
		const px = - az, pz = ax;               // across the axis
		const P = this.pos, L = this.loc, I = this.inj;
		const corners = [ [ - 1, - 1 ], [ 1, - 1 ], [ 1, 1 ], [ - 1, 1 ] ];
		for ( let c = 0; c < 4; c ++ ) {
			const [ u, v ] = corners[ c ];
			const vi = q * 4 + c;
			P[ vi * 3 ] = x + ax * ha * u + px * hc * v;
			P[ vi * 3 + 1 ] = 0;
			P[ vi * 3 + 2 ] = z + az * ha * u + pz * hc * v;
			L[ vi * 2 ] = u; L[ vi * 2 + 1 ] = v;
			I[ vi * 3 ] = foam; I[ vi * 3 + 1 ] = air; I[ vi * 3 + 2 ] = fresh;
		}

	}

	/** Shift, surface, fade, then add this frame's sources. */
	step( dt ) {

		const r = this.renderer;
		const f = this.field;
		const prevTarget = r.getRenderTarget();
		const prev = this.rt[ this.i ], next = this.rt[ this.i ^ 1 ];

		if ( this.reset ) {
			r.setClearColor( 0x000000, 0 );
			for ( const t of this.rt ) { r.setRenderTarget( t ); r.clear( true, false, false ); }
			this.center.copy( f.center );
			this.extent = f.extent;
			this.reset = false;
		}

		// The window follows the camera: zoomed in it shrinks, to put its
		// texels where you are looking. That used to start the buffer over,
		// which is exactly the foam disappearing as you zoom in. Now the old
		// contents are resampled into the new window -- one interpolated read,
		// on the frame the size changes, and exact copies again after.
		const eOld = Math.max( this.extent, 1e-3 );
		const eNew = Math.max( f.extent, 1e-3 );
		const u = this.stepU;
		u.uPrev.value = prev.texture;
		u.uScale.value = eNew / eOld;
		// v flipped: the bake camera looks down with up = (0, 0, -1), so +Z in
		// the world runs DOWN the texture. The shift is in OLD texture units.
		u.uShift.value.set( ( f.center.x - this.center.x ) / eOld, - ( f.center.y - this.center.y ) / eOld );
		this.extent = f.extent;
		u.uDt.value = dt;
		u.uFoamHalf.value = get( 'sim.foamHalf' );
		u.uAirHalf.value = get( 'sim.airHalf' );
		u.uFreshHalf.value = get( 'sim.freshHalf' );
		u.uRise.value = get( 'sim.rise' );
		u.uHeight.value = f.rt.texture;
		u.uTexel.value = 1 / f.rt.width;
		u.uMetres.value = eNew;
		u.uBreak.value = get( 'sim.breaking' );
		u.uBreakSlope.value = get( 'sim.breakSlope' );

		r.setRenderTarget( next );
		r.setClearColor( 0x000000, 0 );
		r.clear( true, false, false );
		r.render( this.stepScene, this.stepCam );

		// Sources, through the field's own camera so they land in the same
		// window at the same scale.
		if ( this.nSplat > 0 ) {
			const g = this.splatGeo;
			const n4 = this.nSplat * 4;
			g.attributes.position.addUpdateRange( 0, n4 * 3 );
			g.attributes.aLocal.addUpdateRange( 0, n4 * 2 );
			g.attributes.aInject.addUpdateRange( 0, n4 * 3 );
			g.attributes.position.needsUpdate = true;
			g.attributes.aLocal.needsUpdate = true;
			g.attributes.aInject.needsUpdate = true;
			g.setDrawRange( 0, this.nSplat * 6 );
			r.render( this.splatScene, f.camera );
		}

		r.setRenderTarget( prevTarget );
		this.i ^= 1;
		this.center.copy( f.center );

	}

}
