// Expanding rings left where the hull puts energy into the sea.
//
// How hard and at what angle the mesh hits the water decides whether a
// ring is born and how tall it is — not a constant “wet and moving”
// recipe. A belly-flat slam is a big pulse; a knife entry is quiet; a
// parked hull writes nothing. Each centre stays in world XZ. The ring
// is a full circle. Radius grows. Amplitude decays with age and 1/√r.
// Overlapping rings add. Twin: src/gpu/tsl/wake-wave.js. A change here
// is not done until tools/check-wake-wave.mjs passes.

export const WAKE_WAVE_STAMPS = 16;
export const WAKE_WAVE_LIFE = 5.0;
export const WAKE_WAVE_SPACING = 2.6;
export const WAKE_WAVE_WIDTH0 = 1.4;
/** How fast the ring thickens as it opens, m per metre of radius. */
export const WAKE_WAVE_SPREAD = 0.12;
/** Newborn self-waves are visible immediately, but do not drive suspension yet. */
export const WAKE_WAVE_PROBE_DELAY = 0.65;
export const WAKE_WAVE_PROBE_FADE = 0.25;

function clamp( x, a, b ) {

	return Math.min( b, Math.max( a, x ) );

}

function smoothstep( a, b, x ) {

	const t = clamp( ( x - a ) / Math.max( b - a, 1e-6 ), 0, 1 );
	return t * t * ( 3 - 2 * t );

}

/** Length-based Froude number: Fr_L = v / √(g L). */
export function froudeLength( speed, length ) {

	return Math.abs( speed ?? 0 ) / Math.sqrt( 9.81 * Math.max( length ?? 3.0, 0.5 ) );

}

/** Depth-based Froude number: Fr_h = v / √(g h). */
export function froudeDepth( speed, depth ) {

	return Math.abs( speed ?? 0 ) / Math.sqrt( 9.81 * Math.max( depth ?? 10.0, 0.2 ) );

}

/**
 * Froude transition factor (physics of displacement -> transition/hump -> planing):
 * - Below hull speed (Fr_L < 0.35), wavemaking rises quadratically with speed.
 * - At transition / hump speed (Fr_L ~ 0.45 - 0.55), wavemaking resistance and wake height peak.
 * - On plane (Fr_L > 0.8), dynamic lift raises the hull and straight-line wake height decreases.
 */
export function froudeHumpFactor( Fr_L ) {

	const Fr = Math.max( Fr_L ?? 0, 0 );
	const disp = smoothstep( 0.06, 0.42, Fr );
	const hump = Math.exp( - 4.0 * Math.pow( Fr - 0.5, 2 ) );
	const planeRelief = Math.max( 0.82, 1.15 - 0.33 * smoothstep( 0.55, 1.5, Fr ) );
	return ( 0.85 * disp + 0.55 * hump ) * planeRelief;

}

/** Shallow-water resonance amplification near critical depth (Fr_h -> 1.0). */
export function froudeShallowResonance( Fr_h, depth ) {

	if ( ! ( depth < 30.0 ) ) return 1.0;
	const dFr = ( Fr_h ?? 0 ) - 1.0;
	const resonance = 0.60 / ( 1.0 + 8.0 * dFr * dFr );
	const weight = clamp( ( 30.0 - depth ) / 25.0, 0, 1 );
	return 1.0 + resonance * weight;

}

export function wakeWaveAmp( s ) {

	if ( ! s || ! ( s.amp > 0.001 ) || s.age >= s.life ) return 0;
	const u = 1 - s.age / Math.max( s.life, 1e-3 );
	const r = Math.max( s.radius ?? 0.6, 0.6 );
	return s.amp * u * u * Math.sqrt( 0.8 / r );

}

export function wakeWaveWidth( s ) {

	return Math.max( s.width ?? WAKE_WAVE_WIDTH0, 0.45 )
		+ Math.max( s.radius ?? 0, 0 ) * WAKE_WAVE_SPREAD;

}

/**
 * Height (m) of one ring at a world XZ point. Full circle.
 */
export function wakeWaveAt( px, pz, s ) {

	const amp = wakeWaveAmp( s );
	if ( ! ( amp > 0.001 ) ) return { h: 0 };
	const dx = px - s.x;
	const dz = pz - s.z;
	const r = Math.hypot( dx, dz );
	const width = wakeWaveWidth( s );
	const d = r - ( s.radius ?? 0 );
	const env = Math.exp( - ( d * d ) / ( width * width ) );
	return { h: env * amp };

}

/**
 * |∇h| of one ring. Zero on the exact crest (the peak is flat in r),
 * largest on the shoulders — that is where breaking foam is born.
 * Twin: wakeWaveSlopeAt in gpu/tsl/wake-wave.js.
 */
export function wakeWaveSlopeAt( px, pz, s ) {

	const amp = wakeWaveAmp( s );
	if ( ! ( amp > 0.001 ) ) return { slope: 0 };
	const r = Math.hypot( px - s.x, pz - s.z );
	const width = wakeWaveWidth( s );
	const d = r - ( s.radius ?? 0 );
	const env = Math.exp( - ( d * d ) / ( width * width ) );
	return { slope: Math.abs( amp * env * ( 2 * d ) / ( width * width ) ) };

}

/**
 * A ring belongs to the rendered sea from birth, but feeding its first few
 * frames back into the emitting hull creates a positive suspension loop:
 * crest lifts hull -> hull lands -> another crest. Once the ring has cleared
 * the hull it becomes probe-visible, so turning around can still hit it.
 */
export function wakeWaveProbeWeight( s ) {

	return smoothstep(
		WAKE_WAVE_PROBE_DELAY,
		WAKE_WAVE_PROBE_DELAY + WAKE_WAVE_PROBE_FADE,
		s?.age ?? 0,
	);

}

export function wakeWaveProbeAt( px, pz, s ) {

	return { h: wakeWaveAt( px, pz, s ).h * wakeWaveProbeWeight( s ) };

}

export function wakeWaveFieldAt( px, pz, field ) {

	let h = 0;
	const stamps = field?.stamps ?? [];
	for ( let i = 0; i < stamps.length; i ++ ) {

		h += wakeWaveAt( px, pz, stamps[ i ] ).h;

	}
	return { h };

}

export function wakeWaveSlopeFieldAt( px, pz, field ) {

	let slope = 0;
	const stamps = field?.stamps ?? [];
	for ( let i = 0; i < stamps.length; i ++ ) {

		slope += wakeWaveSlopeAt( px, pz, stamps[ i ] ).slope;

	}
	return { slope };

}

export function wakeWaveProbeFieldAt( px, pz, field ) {

	let h = 0;
	const stamps = field?.stamps ?? [];
	for ( let i = 0; i < stamps.length; i ++ ) {

		h += wakeWaveProbeAt( px, pz, stamps[ i ] ).h;

	}
	return { h };

}

/**
 * Rings left along the path while the hull is wet and moving.
 */
export class WakeWaveField {

	constructor() {

		this.stamps = [];
		this.spawnX = 0;
		this.spawnZ = 0;
		this.hasSpawn = false;
		this.spawnAt = new Map();
		this.impactSeq = new Map();

	}

	reset() {

		this.stamps.length = 0;
		this.hasSpawn = false;
		this.spawnAt.clear();
		this.impactSeq.clear();

	}

	get wave() {

		return this.stamps[ this.stamps.length - 1 ] ?? null;

	}

	get live() {

		for ( let i = 0; i < this.stamps.length; i ++ ) {

			if ( wakeWaveAmp( this.stamps[ i ] ) > 0.001 ) return true;

		}
		return false;

	}

	/**
	 * @param {number} dt
	 * @param {object|object[]|null} contact
	 * @param {{life?:number,spacing?:number}} [opts]
	 */
	step( dt, contact, opts ) {

		const d = clamp( dt ?? 0, 0, 0.1 );
		const life = Math.max( opts?.life ?? WAKE_WAVE_LIFE, 0.8 );
		const spacing = Math.max( opts?.spacing ?? WAKE_WAVE_SPACING, 1.0 );
		const keep = [];
		for ( let i = 0; i < this.stamps.length; i ++ ) {

			const s = this.stamps[ i ];
			s.age += d;
			s.radius += Math.max( s.speed, 0 ) * d;
			if ( s.age < s.life && s.amp > 0.02 ) keep.push( s );

		}
		this.stamps = keep;

		const list = ! contact ? [] : ( Array.isArray( contact ) ? contact : [ contact ] );
		for ( let i = 0; i < list.length; i ++ ) this._spawn( list[ i ], life, spacing );

	}

	/**
	 * `life` / `spacing` are the field's defaults. A contact carrying its
	 * own (from the body's wake recipe) wins, so one animal can hold a
	 * long slow swell while a ski keeps short ripples in the same field.
	 */
	_spawn( contact, fieldLife, fieldSpacing ) {

		if ( ! contact || ! ( contact.amp > 0.02 ) ) return;
		if ( ! Number.isFinite( contact.x ) || ! Number.isFinite( contact.z ) ) return;
		const life = contact.life > 0 ? Math.max( contact.life, 0.8 ) : fieldLife;
		const spacing = contact.spacing > 0
			? Math.max( contact.spacing, 1 )
			: fieldSpacing;
		let slam = ( contact.impact ?? 0 ) > 0.12 || contact.force;
		if ( slam && contact.id != null && Number.isFinite( contact.impactSeq ) ) {

			const previous = this.impactSeq.get( contact.id );
			slam = previous !== contact.impactSeq;
			if ( slam ) this.impactSeq.set( contact.id, contact.impactSeq );

		}
		const lane = contact.lane ?? 0;
		const last = this.spawnAt.get( lane );
		if ( ! slam && last
			&& Math.hypot( contact.x - last.x, contact.z - last.z ) < spacing ) {

			return;

		}
		this.hasSpawn = true;
		this.spawnX = contact.x;
		this.spawnZ = contact.z;
		this.spawnAt.set( lane, { x: contact.x, z: contact.z } );
		const fl = Math.hypot( contact.fx, contact.fz ) || 1;
		const expand = Number.isFinite( contact.expand )
			? contact.expand
			: Math.max( Math.abs( contact.speed ) * 0.55, 3.2 );
		this.stamps.push( {
			x: contact.x,
			z: contact.z,
			fx: contact.fx / fl,
			fz: contact.fz / fl,
			radius: Math.max( contact.radius ?? 0.55, 0.45 ),
			speed: Math.max( expand, 2.4 ),
			amp: contact.amp,
			age: 0,
			life,
			width: contact.width ?? WAKE_WAVE_WIDTH0,
		} );
		if ( this.stamps.length > WAKE_WAVE_STAMPS ) this.stamps.shift();

	}

}

/**
 * How hard this hull is putting energy into the sea this frame.
 * `depth` / `strength` are a look gain, not the wave.
 *
 * Hard: downward speed into the water, leftover slam, planing load.
 * Angle: a flat belly (pitch/roll near 0) dumps more; a knife is quiet;
 * a bow-down cut is quieter at the stern than a stern plant.
 * Null when there is not enough hit to write a wave.
 */
export function wakeWaveImpulse( src ) {

	if ( ! src ) return null;
	if ( src.airborne && ! ( src.impact > 0.04 ) ) return null;
	const cfg = src.wakeCfg;
	if ( ! cfg ) return null;
	const gain = Math.max( cfg.depth ?? 0.28, 0 )
		* Math.max( cfg.strength ?? 1, 0 )
		* Math.max( cfg.wave ?? 1, 0 );
	if ( ! ( gain > 0.001 ) ) return null;

	const speed = Math.abs( src.speed ?? 0 );
	const impact = Math.max( src.impact ?? 0, 0 );
	// Dragon splash energy runs to ~4. Raw impact here used to build a
	// 2 m filled hill that sat for seconds. Ski slaps stay under 1.2.
	const hit = Math.min( impact, 1.2 );
	const vy = Number.isFinite( src.vy ) ? src.vy : ( src.vel?.[ 1 ] ?? 0 );
	const into = Math.max( 0, ( src.surfVel ?? 0 ) - vy );
	const pitch = src.pitch ?? 0;
	const roll = src.roll ?? 0;
	const flat = clamp( Math.cos( pitch ) * Math.cos( roll ), 0, 1 );
	const sternPlant = clamp( pitch, 0, 0.85 );
	const bowCut = clamp( - pitch, 0, 0.85 );
	const slap = Math.max( 0, - ( src.pitchRate ?? 0 ) );

	const L = Math.max( src.length ?? src.size?.z ?? 3.0, 0.5 );
	const Fr_L = froudeLength( speed, L );
	const froudeFactor = froudeHumpFactor( Fr_L );

	const plane = speed
		* ( 0.22 + 0.16 * sternPlant )
		* ( 0.42 + 0.58 * flat )
		* ( 1 - 0.48 * bowCut )
		* froudeFactor;
	const slam = hit * ( 1.1 + 0.9 * flat ) * 4.2;
	const punch = Math.min( into, 16 ) * ( 0.04 + 0.03 * flat );
	const yawTurn = Math.abs( src.yawRate ?? 0 ) * speed * 0.14;
	const slipTurn = Math.abs( src.slip ?? 0 ) * speed * 0.18;
	const load = clamp( src.hullLoad ?? 0, 0, 50 ) * 0.008;
	const dynamicCarve = load + yawTurn + slipTurn;

	const depth = src.waterDepth ?? src.depth;
	const shallowResonance = Number.isFinite( depth ) && depth > 0.1
		? froudeShallowResonance( froudeDepth( speed, depth ), depth )
		: 1.0;

	const drive = ( plane + slam + punch + dynamicCarve + slap * 0.35 ) * shallowResonance;
	const planing = ( src.hover ?? 0 ) > 0 || ( src.hullLoad ?? 0 ) > 1;
	const minDrive = planing || ! ( cfg.wave > 0 ) ? 0.38 : 0.10;
	if ( drive < minDrive && impact < 0.05 ) return null;

	const raw = drive * gain * 0.22;
	const amp = hit > 0.12 ? Math.min( raw, 0.55 ) : raw;
	if ( ! ( amp > 0.025 ) ) return null;

	return {
		amp,
		expand: Math.max( 3.0, Math.min( 8.5, speed * 0.42 + into * 0.28 + hit * 3.2 ) ),
		width: WAKE_WAVE_WIDTH0 * ( 0.72 + 0.45 * flat + 0.18 * hit )
			* Math.max( cfg.waveWidth ?? 1, 0.1 ),
		radius: hit > 0.12 ? Math.min( 4.4, 2.2 + hit * 1.4 ) : 0.55,
		impact,
		flat,
		drive,
		froude: Fr_L,
		shallowResonance,
	};

}

/**
 * Metres of travel between rings. A ski keeps the 2.6 m default; on a
 * 60 m animal that spends all sixteen stamps inside its own length, so
 * an unset `waveGap` scales with the body.
 */
export function wakeWaveGapOf( cfg, length ) {

	if ( cfg?.waveGap > 0 ) return Math.max( cfg.waveGap, 1 );
	return Math.max( WAKE_WAVE_SPACING, Math.max( length ?? 0, 0 ) * 0.12 );

}

/** Seconds a ring from this recipe lives. 0 = the field default. */
export function wakeWaveLifeOf( cfg ) {

	return cfg?.waveLife > 0 ? clamp( cfg.waveLife, 0.8, 24 ) : 0;

}

/**
 * Stern contact for WakeWaveField.step. Heading 0 is −Z.
 * Null when the hull is not hitting the water hard enough to write a wave.
 */
export function wakeWaveContactFrom( src ) {

	return wakeWaveContactsFrom( src )[ 0 ] ?? null;

}

/**
 * One expanding ring per waterline cut (or the single stern station).
 * Amplitude is split so four pierce sites are not a four-high pile-up.
 */
export function wakeWaveContactsFrom( src ) {

	const hit = wakeWaveImpulse( src );
	if ( ! hit ) return [];
	const points = src.stampRings?.length
		? src.stampRings
		: ( src.stampPoints?.length ? src.stampPoints : ( src.stampB ? [ src.stampB ] : [] ) );
	if ( ! points.length ) return [];
	const heading = src.heading ?? 0;
	const life = wakeWaveLifeOf( src.wakeCfg );
	const spacing = wakeWaveGapOf( src.wakeCfg, src.length );
	// A landing is one crown at the hit, not a dome under every pierce.
	if ( hit.impact > 0.12 ) {

		const pt = src.stampB || points[ 0 ];
		return [ {
			x: pt[ 0 ],
			z: pt[ 1 ],
			fx: Math.sin( heading ),
			fz: - Math.cos( heading ),
			amp: hit.amp,
			speed: Math.abs( src.speed ?? 0 ),
			expand: hit.expand,
			width: hit.width,
			radius: hit.radius,
			impact: hit.impact,
			force: true,
			life, spacing,
			id: src.id,
			impactSeq: src.impactSeq,
			lane: `${ src.id ?? 'b' }:land`,
		} ];

	}
	const n = points.length;
	const amp = hit.amp / Math.sqrt( n );
	const width = hit.width * ( 0.72 + 0.28 / Math.sqrt( n ) );
	const list = [];
	for ( let i = 0; i < n; i ++ ) {

		const pt = points[ i ];
		list.push( {
			x: pt[ 0 ],
			z: pt[ 1 ],
			fx: Math.sin( heading ),
			fz: - Math.cos( heading ),
			amp,
			speed: Math.abs( src.speed ?? 0 ),
			expand: hit.expand,
			width,
			radius: hit.radius,
			impact: hit.impact,
			force: false,
			life, spacing,
			id: src.id,
			impactSeq: src.impactSeq,
			lane: `${ src.id ?? 'b' }:${ i }`,
		} );

	}
	return list;

}
