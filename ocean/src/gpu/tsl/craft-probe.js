// Where is the water, right here? - the buoyancy probe, in TSL.
//
// Port of PROBE_FS in demo/waverunner.js. The craft needs the surface height at
// four points around its hull every frame, and the wave field lives in GPU
// textures, so the only honest answer involves a readback. A synchronous
// readPixels would stall the pipeline behind the whole ocean sim, so this
// renders the four answers into a tiny target and reads it back ASYNC: the
// rider gets last frame's answer, which at 60 Hz is 16 ms of lag on a hull that
// is already critically damped, and nobody can feel it.
//
// ---------------------------------------------------------------------------
// THE INVERSION IS THE WHOLE TRICK
//
// Displacement is Lagrangian: the texture says where the water at reference
// point x ended up, NOT what is above world point p. Asking "how high is the
// sea at p" therefore means inverting x -> x + D_xz(x), which is the fixed
// point x <- p - D_xz(x). Three passes is well inside a centimetre at any
// choppiness the sim allows. Skipping the inversion looks almost right in calm
// water and puts the craft through the face of every steep wave.
//
// The width is 64, not 4: a WebGPU buffer copy needs a 256-byte row pitch and
// four RGBA32F texels is 64 bytes (porting rule 10). Only the first four are
// read; the rest cost one wasted quad of fragments, once a frame.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, float, int, vec2, vec3, vec4, uniform, uniformArray,
	smoothstep, distance, uv,
} from 'three/tsl';

import {
	dispTexture, foamTexture, uPatch, uCascadeCount, uHeightScale, uHorizScale,
	wakeAt,
} from './water-common.js';
import { uSeaLevel, swellLift, uSwellAmp } from './water-surface.js';


export const NPROBE = 4;

export const uProbePts = /*@__PURE__*/ uniformArray( [ 0, 0, 0, 0 ].map( () => new THREE.Vector2() ), 'vec2' );
export const uCraftXZ = /*@__PURE__*/ uniform( 'vec2' );
export const uWakeProbe = /*@__PURE__*/ uniform( 0.0 );
export const uWakeNear = /*@__PURE__*/ uniform( 6.0 );
export const uProbeWidth = /*@__PURE__*/ uniform( 64.0 );
// Per-cascade mip level for every probe fetch. NOT an optimisation - the hull's
// suspension. See THE HULL READS A MIPPED SEA below.
export const uProbeLod = /*@__PURE__*/ uniformArray( [ 0, 0, 0, 0 ], 'float' );
// The light read for the one-sided chop lift - see THE SEA IS TALLER THAN ITS
// AVERAGE below. Quarter-footprint mips: enough to stay smooth, keeps the
// local waves the deep read averages away.
export const uProbeLodLight = /*@__PURE__*/ uniformArray( [ 0, 0, 0, 0 ], 'float' );
// 0 = ride the averaged sea (planing); 1 = float on the local water (at rest).
export const uProbeChop = /*@__PURE__*/ uniform( 0.0 );

// ---------------------------------------------------------------------------
// THE HULL READS A MIPPED SEA, AND THAT IS THE SUSPENSION.
//
// The GL probe (PROBE_FS in demo/waverunner.js) samples uDisp with IMPLICIT
// LOD, and its quad is 4x1 with one PROBE PER FRAGMENT - so the screen-space
// derivatives the hardware selects mips from are the distances BETWEEN PROBE
// POINTS, metres apart. For N=256 that lands each cascade at
// log2(spacing * N / patch): the 250 m cascade near mip 0, the 60 m cascade
// near mip 3, the shortest near mip 5+ - averaged over dozens of texels,
// contributing almost nothing. The craft therefore rides the SWELL and simply
// does not see the chop, which is the correct physics by accident: a hull
// integrates the water over its waterline length, and short waves pass under
// it instead of throwing it.
//
// This port originally sampled .level(0) - the full-resolution field, every
// capillary edge of the smallest cascade, fed straight into a spring and into
// the launch detector's TWO derivatives. The craft twitched at idle and leapt
// off ripples at speed, identically on BOTH backends, while the raw-GL demo
// with the same physics floated: reported twice as "bouncing all around", and
// nailed by the report that it "bounces the same on webgl" - a shared-source
// fault, not a backend one. The one thing both TSL backends share and the GL
// demo does differently is this sampling.
//
// So the LOD is now EXPLICIT: per cascade, log2(footprint * N / patch),
// computed on the CPU (update() below) with footprint = the hull length - the
// same averaging the GL fragment derivatives produced, minus the accident. The
// mip chains are real on both backends: sim-driver.js regenerates disp mips
// after every step (its note 2), exactly as ocean.js does.

/** vec4(height + seaLevel, foam, xShift, 1) at one probe point. */
export const surfaceAt = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const x = vec2( p ).toVar();

	// x <- p - D_xz(x), three times. See the header: this is the Lagrangian
	// inversion, and it is not optional. Mipped taps here too - the GL probe's
	// derivatives applied inside this loop as well, and inverting a smoothed
	// field with full-resolution taps would converge to a different x than the
	// height read below expects.
	Loop( { start: 0, end: 3, type: 'int', condition: '<' }, () => {

		const d = vec2( 0.0 ).toVar();
		Loop( { start: 0, end: uCascadeCount, type: 'int', condition: '<' }, ( { i } ) => {

			const s = dispTexture.sample( vec3( x.div( uPatch.element( i ) ), float( i ) ) ).level( uProbeLod.element( i ) );
			d.addAssign( s.xz.mul( uHorizScale ) );

		} );
		x.assign( p.sub( d ) );

	} );

	// -----------------------------------------------------------------------
	// THE SEA IS TALLER THAN ITS AVERAGE.
	//
	// Measured on a developed Golden Hour Swell (prototypes/probe-burial.html):
	// the full-resolution surface stands up to 1.6 m ABOVE the footprint-
	// averaged one, 0.84 m at the 95th percentile. A hull riding the average
	// with ~0.35 m of hover therefore gets water over the deck whenever a real
	// crest passes - reported as "it sometimes sinks".
	//
	// So two heights are read AT THE SAME STABLE x (the inversion above ran on
	// the deep-mipped field, which is what keeps x from hopping between fixed
	// points - the instability probe-jitter.html pinned at 0.88 m per frame):
	//
	//   hDeep   footprint mips - the suspension, what the launch detector eats;
	//   hLight  quarter-footprint mips - the local water, still artifact-free.
	//
	// The lift is ONE-SIDED and faded by uProbeChop: water that stands above
	// the averaged sea pushes the hull up (buoyancy touches the hull); air
	// below a local trough does not pull it down. At rest chop=1 and the craft
	// floats on the water that is actually there; on the plane chop->0 and it
	// skims the averaged sea, which is what a planing hull really does - and
	// what keeps the launch detector reading the tuned, averaged signal at the
	// speeds where launches matter.
	const h = float( 0.0 ).toVar();
	const hLight = float( 0.0 ).toVar();
	const foam = float( 0.0 ).toVar();
	Loop( { start: 0, end: uCascadeCount, type: 'int', condition: '<' }, ( { i } ) => {

		const uvc = vec3( x.div( uPatch.element( i ) ), float( i ) );
		h.addAssign( dispTexture.sample( uvc ).level( uProbeLod.element( i ) ).y.mul( uHeightScale ) );
		hLight.addAssign( dispTexture.sample( uvc ).level( uProbeLodLight.element( i ) ).y.mul( uHeightScale ) );
		foam.addAssign( foamTexture.sample( uvc ).level( uProbeLod.element( i ) ).x );

	} );
	h.addAssign( hLight.sub( h ).max( 0.0 ).mul( uProbeChop ) );

	// Everything the hull has already done to the sea - but only beyond a few
	// hull lengths. The stamp directly under the craft is the hollow it is
	// making right now, and reading that back would be a hull sinking into a
	// trough it deepens by sinking.
	If( uWakeProbe.greaterThan( 0.001 ), () => {

		const gate = smoothstep( uWakeNear, uWakeNear.mul( 2.4 ), distance( x, uCraftXZ ) ).toVar();
		If( gate.greaterThan( 0.001 ), () => {

			h.addAssign( wakeAt( x ).y.mul( gate ).mul( uWakeProbe ) );

		} );

	} );

	// THE SEA DRAGON'S MOUND IS REAL WATER to anything floating on it. The
	// water's vertex stage lifts the surface over the animal's back
	// (water-surface.js's swellLift), but this probe read only the FFT
	// cascades, so a hull sat at the flat sea's height while the sea visibly
	// humped up under it - you could watch the wave pass and not ride it.
	// Added on the SAME undisplaced coordinate the surface uses (`x` is the
	// grid point that displaces to the sampled position, which is why the
	// Lagrangian offset below is x - p), so the hull rides the mound the eye
	// sees rather than one a metre or two off it.
	//
	// The hull's OWN hollow is deliberately still absent, for the reason the
	// wake block above gives: a body must not read back the dent it is making
	// or it sinks into a trough it deepens by sinking. The mound belongs to
	// something else, so it has no such feedback.
	If( uSwellAmp.abs().greaterThan( 0.0005 ), () => {

		h.addAssign( swellLift( x ) );

	} );

	// GLSL: vec4(h + uSeaLevel, foam, x - p) - and `x - p` is a VEC2, so the
	// last TWO channels are the Lagrangian offset, not one of them and a pad.
	// Returning only dx and a 1.0 loses dz, which is half of the correction the
	// craft needs to write into fields the water indexes by x rather than p.
	return vec4( h.add( uSeaLevel ), foam, x.x.sub( p.x ), x.y.sub( p.y ) );

} );

export const probeFragment = /*@__PURE__*/ Fn( () => {

	// Which probe this fragment answers.
	//
	// uv(), NOT a screen-space coordinate. screenUV is derived from the VIEWPORT
	// resolution, and this pass renders a 64x1 target while the renderer's
	// viewport belongs to the canvas - so in the app (though not in an isolated
	// probe, where the two happen to match) the column index came out wrong and
	// every branch below fell through, leaving the whole reading at zero. The
	// craft then flew along at exactly sea level with no error anywhere.
	// uv() spans 0..1 across the quad whatever the target is. Same lesson as
	// ./wake.js note 1, arrived at the same way: by measuring.
	const col = uv().x.mul( uProbeWidth ).floor().toVar();
	const out = vec4( 0.0 ).toVar();
	// A switch over four constants rather than a dynamic index: uniformArray
	// indexing by a computed value is the kind of thing that differs between
	// backends, and four branches costs nothing in a 64x1 pass.
	for ( let i = 0; i < NPROBE; i ++ ) {

		If( col.equal( float( i ) ), () => {

			out.assign( surfaceAt( uProbePts.element( int( i ) ) ) );

		} );

	}

	return out;

} );

/**
 * Runs the probe and hands back the four surface samples.
 *
 * Async by design - see the header. The caller uses the last completed reading
 * and never awaits inside its frame.
 */
export class TslCraftProbe {

	constructor( renderer ) {

		this.renderer = renderer;
		this.width = 64;
		uProbeWidth.value = this.width;

		// A RING of targets, one readback in flight per slot - NOT one target
		// behind a busy flag.
		//
		// The busy-gated version serialised the whole probe: render, await the
		// readback, and only then issue the next one. three's async readback
		// takes several frames to resolve, and every frame it is in flight was a
		// frame the surface data stood still - measured on the same machine and
		// harness as the raw-GL demo, the readings landed at HALF its rate. That
		// is not a smoothness nicety: the rider differentiates the probe height
		// TWICE (surfVel, then surfAcc) to decide when the water has dropped away
		// under the hull, and a stair-stepping input turns into acceleration
		// spikes that read as exactly that. Each spike below -g*launchG launches
		// the craft; each landing is an impact; the loop repeats. Reported, twice,
		// as a hull "bouncing all around" instead of floating - the physics was
		// fine, it was being fed a strip chart drawn in steps.
		//
		// With a ring, a probe is ISSUED every frame and each slot's readback
		// resolves whenever it resolves - the latency stays (readings are a few
		// frames old, which the rider's smoothing has always absorbed) but the
		// RATE becomes one reading per frame, which is what the differentiators
		// need. Three slots covers a readback latency of three frames before any
		// issue is skipped. Distinct targets per slot keep concurrent readbacks
		// from sharing a surface - whether a shared one is safe depends on the
		// backend's copy scheduling, and this way it does not have to be known.
		this.ring = Array.from( { length: 3 }, () => new THREE.RenderTarget( this.width, 1, {
			type: THREE.FloatType, format: THREE.RGBAFormat,
			minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
			depthBuffer: false, generateMipmaps: false,
		} ) );
		this.pending = this.ring.map( () => false );
		// Issue and apply sequence numbers: readbacks may resolve out of order,
		// and an old reading applied over a newer one would step the surface
		// BACKWARD - worse than the staleness this exists to fix.
		this.seq = 0;
		this.applied = 0;

		this.material = new THREE.NodeMaterial();
		this.material.name = 'abyssal.craft.probe';
		this.material.fragmentNode = probeFragment();
		this.material.depthTest = false;
		this.material.depthWrite = false;
		this.quad = new THREE.QuadMesh( this.material );

		// height, foam and the Lagrangian offset per probe - seeded flat so
		// frame 1 has an answer.
		this.result = Array.from( { length: NPROBE }, () => ( { h: 0, foam: 0, dx: 0, dz: 0 } ) );

	}

	/**
	 * @param {Array<[number,number]>} points - NPROBE world xz pairs.
	 * @param {object} o - { seaLevel, craftXZ:[x,z], wakeProbe, wakeNear }.
	 *
	 * seaLevel is passed rather than inherited. uSeaLevel belongs to
	 * ./water-surface.js and the water driver writes it every frame, so in the
	 * app it would already be right - but only if the water has run FIRST, and
	 * a probe that silently returns heights relative to zero when the call
	 * order changes is exactly the kind of bug that reads as a craft floating
	 * at the wrong altitude. Measured: on a flat sea at seaLevel 3.75 the probe
	 * returned 0.00000. Writing the same value from the same params costs
	 * nothing and removes the ordering dependency.
	 */
	async update( points, o = {} ) {

		// The GPU is more than a full ring behind; skip this frame's issue rather
		// than queueing into the past.
		const slot = this.seq % this.ring.length;
		if ( this.pending[ slot ] ) return this.result;
		this.pending[ slot ] = true;
		const mySeq = ++ this.seq;

		try {

			// _probePoints() hands back a FLAT Float32Array of xz pairs, which is
			// the contract the GL path has always used - not an array of [x, z].
			// Reading it as pairs-of-pairs silently indexes numbers, and
			// Vector2.set(undefined, undefined) is a NaN sample rather than an
			// error: measured as the four probes reporting duplicated heights,
			// which reads as a hull that pitches but will not roll. Both shapes
			// accepted, since a caller with real pairs is the obvious thing to
			// write.
			const flat = points && points.length === NPROBE * 2 && typeof points[ 0 ] === 'number';
			for ( let i = 0; i < NPROBE; i ++ ) {

				const x = flat ? points[ i * 2 ] : ( points?.[ i ]?.[ 0 ] ?? 0 );
				const z = flat ? points[ i * 2 + 1 ] : ( points?.[ i ]?.[ 1 ] ?? 0 );
				uProbePts.array[ i ].set( x, z );

			}
			if ( o.seaLevel !== undefined ) uSeaLevel.value = o.seaLevel;
			if ( o.craftXZ ) uCraftXZ.value.set( o.craftXZ[ 0 ], o.craftXZ[ 1 ] );
			uWakeProbe.value = o.wakeProbe ?? 0;
			uWakeNear.value = o.wakeNear ?? 6;

			// The suspension (see THE HULL READS A MIPPED SEA above): each cascade
			// is read at the mip whose texels average the sea over the hull's own
			// length. The relational checks in prototypes/craft-probe-tsl.html
			// hold under ANY footprint, because mip filtering is linear: a flat
			// sea is flat at every level and doubling heightScale still doubles
			// every deviation exactly. o.footprint = 0 reads the exact texel.
			const fp = o.footprint ?? 1.6;
			const N = dispTexture.value?.image?.width || 256;
			for ( let i = 0; i < 4; i ++ ) {

				const patch = uPatch.array[ i ] || 1;
				uProbeLod.array[ i ] = fp > 0
					? Math.max( 0, Math.log2( ( fp * N ) / patch ) )
					: 0;
				// The light read: a quarter of the footprint. See THE SEA IS
				// TALLER THAN ITS AVERAGE.
				uProbeLodLight.array[ i ] = fp > 0
					? Math.max( 0, Math.log2( ( fp * 0.25 * N ) / patch ) )
					: 0;

			}
			uProbeChop.value = o.chop ?? 0;

			// The render is synchronous and reads the uniforms NOW, so each slot's
			// pixels match the points this call was given even though the ring has
			// three readbacks against three uniform sets in flight - the copy for
			// each readback is enqueued on the GPU timeline before the next
			// frame's render touches anything.
			const r = this.renderer;
			const prev = r.getRenderTarget();
			const prevAuto = r.autoClear;
			r.autoClear = false;
			r.setRenderTarget( this.ring[ slot ] );
			this.quad.render( r );
			r.setRenderTarget( prev );
			r.autoClear = prevAuto;

			const raw = await r.readRenderTargetPixelsAsync( this.ring[ slot ], 0, 0, this.width, 1 );
			if ( mySeq > this.applied ) {

				this.applied = mySeq;
				const px = raw instanceof Float32Array ? raw : new Float32Array( raw.buffer ?? raw );
				for ( let i = 0; i < NPROBE; i ++ ) {

					this.result[ i ] = {
						h: px[ i * 4 ], foam: px[ i * 4 + 1 ],
						dx: px[ i * 4 + 2 ], dz: px[ i * 4 + 3 ],
					};

				}

			}

		} finally {

			this.pending[ slot ] = false;

		}

		return this.result;

	}

	dispose() {

		for ( const rt of this.ring ) rt.dispose();
		this.material.dispose?.();

	}

}
