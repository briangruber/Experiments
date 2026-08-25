// Persistent foam deposited by a body moving through the free surface.
//
// This is deliberately NOT the analytic V wake. The V is a travelling gravity
// wave; aerated water is material left behind at the cut. Each stamp therefore
// owns a world-space position, drifts with the surface current, shears and
// broadens, then dies on its own clock.
//
// GPU twin: wakeFoamAccum() in src/gpu/tsl/water-surface.js.

export const WAKE_FOAM_STAMPS = 16;
export const WAKE_FOAM_LIFE = 11;

const clamp01 = ( x ) => Math.min( 1, Math.max( 0, x ) );

function smooth01( lo, hi, x ) {

	const t = clamp01( ( x - lo ) / Math.max( hi - lo, 1e-6 ) );
	return t * t * ( 3 - 2 * t );

}

function phaseAt( x, z ) {

	const h = Math.sin( x * 12.9898 + z * 78.233 ) * 43758.5453;
	return ( h - Math.floor( h ) ) * Math.PI * 2;

}

export function wakeFoamAmp( stamp ) {

	if ( ! stamp || ! ( stamp.amp > 0.01 ) || stamp.age >= stamp.life ) return 0;
	const attack = smooth01( 0, Math.max( stamp.attack ?? 0.24, 0.04 ), stamp.age );
	const left = clamp01( 1 - stamp.age / Math.max( stamp.life, 1e-3 ) );
	return stamp.amp * attack * left * left;

}

export function wakeFoamRadii( stamp ) {

	if ( ! stamp ) return { along: 0, across: 0 };
	return {
		along: Math.max( 0.3, stamp.along0 + stamp.growAlong * stamp.age ),
		across: Math.max( 0.3, stamp.across0 + stamp.growAcross * stamp.age ),
	};

}

export function wakeFoamMask( px, pz, stamp ) {

	const amp = wakeFoamAmp( stamp );
	if ( amp < 0.002 ) return 0;
	const { along: ra, across: rb } = wakeFoamRadii( stamp );
	const dx = px - stamp.x, dz = pz - stamp.z;
	const along = dx * stamp.fx + dz * stamp.fz;
	const across = - dx * stamp.fz + dz * stamp.fx;
	const na = along / ra, nc = across / rb;
	const q = Math.hypot( na, nc );
	const phase = Math.sin( stamp.phase + stamp.age * 0.37 );
	// Cheap asymmetric shear. The GPU evaluates up to 16 patches per water
	// pixel, so the edge deliberately avoids per-patch trigonometry there.
	const wobble = Math.min( 1.25, Math.max( 0.75,
		1
			+ 0.10 * phase * na * nc
			+ 0.05 * ( 1 - Math.abs( phase ) ) * ( na * na - nc * nc ),
	) );
	// Soft mound from the centre. A plateau out to 0.54 was a painted disc;
	// overlapping rims read as concentric rings on the trail.
	const mound = 1 - smooth01( 0.10, 1.0, q / Math.max( wobble, 0.72 ) );
	const h = Math.sin( px * 12.9898 + pz * 78.233 + phase ) * 43758.5453;
	const chew = 0.62 + 0.38 * ( h - Math.floor( h ) );
	return mound * chew * amp;

}

export function wakeFoamAt( px, pz, field ) {

	let out = 0;
	for ( const stamp of field?.stamps ?? field ?? [] ) {

		out = Math.max( out, wakeFoamMask( px, pz, stamp ) );

	}
	return clamp01( out );

}

export class WakeFoamField {

	constructor() {

		this.stamps = [];
		this.last = null;
		this.missing = 1;

	}

	reset() {

		this.stamps.length = 0;
		this.last = null;
		this.missing = 1;

	}

	drop( source, opts = {} ) {

		const fl = Math.hypot( source.fx ?? 0, source.fz ?? - 1 ) || 1;
		const fx = ( source.fx ?? 0 ) / fl;
		const fz = ( source.fz ?? - 1 ) / fl;
		const half = Math.max( source.half ?? opts.half ?? 1.8, 0.5 );
		const phase = phaseAt( source.x, source.z );
		this.stamps.push( {
			x: source.x,
			z: source.z,
			fx,
			fz,
			along0: Math.max( opts.along ?? half * 1.45, 0.6 ),
			across0: Math.max( opts.across ?? half * 1.05, 0.5 ),
			growAlong: Math.max( opts.growAlong ?? 0.28, 0 ),
			growAcross: Math.max( opts.growAcross ?? 0.52, 0 ),
			driftScale: 0.78 + 0.38 * ( 0.5 + 0.5 * Math.sin( phase * 2.17 ) ),
			turn: Math.sin( phase * 1.71 ) * ( opts.turn ?? 0.018 ),
			phase,
			attack: opts.attack ?? 0.24,
			age: 0,
			life: Math.max( opts.life ?? WAKE_FOAM_LIFE, 0.5 ),
			amp: Math.min( Math.max( opts.gain ?? 1, 0 ), 1.4 ),
		} );
		if ( this.stamps.length > WAKE_FOAM_STAMPS ) this.stamps.shift();

	}

	/**
	 * Age and advect existing foam, then deposit along the source's travelled
	 * path. Existing stamps are never moved to the source: that would make the
	 * trail follow the body, the defect this field exists to prevent.
	 */
	step( dt, source, opts = {} ) {

		const d = Math.min( Math.max( dt ?? 0, 0 ), 0.1 );
		const driftX = opts.driftX ?? 0;
		const driftZ = opts.driftZ ?? 0;
		const live = [];
		for ( const stamp of this.stamps ) {

			stamp.age += d;
			if ( stamp.age >= stamp.life || stamp.amp < 0.01 ) continue;
			stamp.x += driftX * stamp.driftScale * d;
			stamp.z += driftZ * stamp.driftScale * d;
			const a = stamp.turn * d;
			const ca = Math.cos( a ), sa = Math.sin( a );
			const fx = stamp.fx * ca - stamp.fz * sa;
			stamp.fz = stamp.fx * sa + stamp.fz * ca;
			stamp.fx = fx;
			live.push( stamp );

		}
		this.stamps = live;

		const gain = Math.min( Math.max( opts.gain ?? 1, 0 ), 1.4 );
		if ( ! source || ! Number.isFinite( source.x ) || ! Number.isFinite( source.z ) || gain <= 0.02 ) {

			this.missing += d;
			if ( this.missing > 0.35 ) this.last = null;
			return;

		}
		this.missing = 0;
		const spacing = Math.max( opts.spacing ?? 3.2, 0.8 );
		if ( ! this.last ) {

			this.drop( source, { ...opts, gain } );
			this.last = { ...source };
			return;

		}

		const dx = source.x - this.last.x;
		const dz = source.z - this.last.z;
		const dist = Math.hypot( dx, dz );
		if ( dist < spacing ) return;
		const count = Math.min( 6, Math.floor( dist / spacing ) );
		for ( let i = 1; i <= count; i ++ ) {

			const t = Math.min( i * spacing / dist, 1 );
			const p = {
				x: this.last.x + dx * t,
				z: this.last.z + dz * t,
				fx: ( this.last.fx ?? source.fx ) * ( 1 - t ) + source.fx * t,
				fz: ( this.last.fz ?? source.fz ) * ( 1 - t ) + source.fz * t,
				half: ( this.last.half ?? source.half ) * ( 1 - t ) + source.half * t,
			};
			this.drop( p, { ...opts, gain } );

		}
		const t = Math.min( count * spacing / dist, 1 );
		this.last = {
			x: this.last.x + dx * t,
			z: this.last.z + dz * t,
			fx: source.fx,
			fz: source.fz,
			half: source.half,
		};

	}

	/** Shader-ready persistent patches. */
	sites( cap = WAKE_FOAM_STAMPS ) {

		const out = [];
		const start = Math.max( 0, this.stamps.length - cap );
		for ( let i = start; i < this.stamps.length; i ++ ) {

			const stamp = this.stamps[ i ];
			const amp = wakeFoamAmp( stamp );
			if ( amp <= 0.002 ) continue;
			const radii = wakeFoamRadii( stamp );
			out.push( {
				x: stamp.x,
				z: stamp.z,
				phase: Math.sin( stamp.phase + stamp.age * 0.37 ),
				amp,
				fx: stamp.fx,
				fz: stamp.fz,
				along: radii.along,
				across: radii.across,
			} );

		}
		return out;

	}

}
