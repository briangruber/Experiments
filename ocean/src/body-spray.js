// Per-mesh spray recipe for any OceanBody.
//
// The sea still has one GPU emitter (TslSpray / Spray). This module is the
// CPU side — parse, waterline sites, kinematics — so a box or a boat can
// toggle spray and cap how many contact points emit at once, without a
// creature controller.
//
//   false / 0 / omitted / { on: 0 }  → off (do not drive the emitter)
//   true / 1                         → size-scaled defaults
//   a number                         → defaults × that gain
//   { amount, sites, hull, band }    → merge over defaults
//
// `sites` is the cap on simultaneous waterline locations. Default `hull`
// is 0: shed from the contact points (pierce = 1). `hull: 1` is the ski's
// jet / chine / curtain (pierce = 0). A transom rooster from `wake.jet`
// can stack on waterline cuts — it does not need hull mode.
//
// `body.accel` is the motor coefficient (SKI.accel = 19). Measured motion
// lives on `fwdAccel` / `yawAcc` / `pitchRate` / `rollRate`.

import { clamp } from './math.js';
import { MAX_BREACH_EMITTERS, placeBreachEmitters } from './breach-emitters.js';
import { parseWake, WAKE_JET_WIDTH } from './body-wake.js';
import { jetMotionOf } from './wake-interact.js';

const PARKED = [ 0, - 1e4, 0 ];

// Hull particles reserve index bit 2 for port/starboard. Pairing IDs four
// apart gives each short-lived sheet the same birth decision and source
// properties on both chines; the side bit itself remains opposite. A real
// turn can still collapse both onto the loaded rail in the shader.
export const SPRAY_SIDE_PAIR_STRIDE = 4;
// A camera-facing parcel must never become a screen-filling quad when the chase
// camera crosses old spray during a turn. This is the maximum billboard
// half-extent as a fraction of camera distance (about 4.6 degrees).
export const SPRAY_SCREEN_EXTENT = 0.08;
/**
 * Floor on waterline half-width (metres). A zero-width bin still gets a
 * cut. Do not scale this with beam — 0.35×beam on a yacht shoved the bow
 * sites a metre off the stem.
 */
export const SPRAY_WATERLINE_MIN_HALF = 0.10;
/**
 * Metres a waterline parcel may smear along the cut. The site is already
 * the mesh waterline; using `uCraftLen` (0.22×LOA) threw clouds a metre
 * ahead of a 12 m hull.
 */
export const SPRAY_WATERLINE_SMEAR = 0.16;

export function sprayBillboardExtentScale( distance, radius, elongation = 1 ) {

	const dist = Math.max( distance ?? 0, 0 );
	const extent = Math.max(
		Math.max( radius ?? 0, 0 ) * Math.max( elongation ?? 1, 1 ),
		0.02,
	);
	return clamp( dist * SPRAY_SCREEN_EXTENT / extent, 0, 1 );

}

export function sprayBalancedSourceId( id ) {

	const fid = Math.max( 0, Math.floor( id ) );
	const sideBand = Math.floor( fid / SPRAY_SIDE_PAIR_STRIDE ) % 2;
	return fid - sideBand * SPRAY_SIDE_PAIR_STRIDE;

}

export function spraySideSign( id ) {

	const fid = Math.max( 0, Math.floor( id ) );
	return ( Math.floor( fid / SPRAY_SIDE_PAIR_STRIDE ) % 2 ) * 2 - 1;

}

export function sprayDefaults( size = {}, extras = {} ) {

	return {
		amount: extras.amount ?? 1,
		sites: extras.sites ?? 4,
		band: extras.band ?? 0.22,
		// Waterline cuts. The ski opts into `hull: 1` on SKI.spray.
		hull: extras.hull ?? 0,
	};

}

function scaleGain( cfg, gain ) {

	if ( gain === 1 ) return cfg;
	return { ...cfg, amount: cfg.amount * gain };

}

/** Transom rooster from `wake.jet.spray`, or null when that recipe is off. */
export function jetSprayOf( body ) {

	const cfg = parseWake( body?.wake, body?.size, {
		length: body?.length,
		beam: body?.beam,
	} );
	const jet = cfg?.jet;
	if ( ! jet?.on || ! ( jet.spray > 0.001 ) ) return null;
	return jet;

}

/** Hull spray recipe, or a jet-tail rooster with `body.spray` off. */
export function bodyWantsSpray( body ) {

	return !! parseSpray( body?.spray, body?.size, sprayExtras( body ) )
		|| !! jetSprayOf( body );

}

/**
 * Recipe ceilings × live transom motion. Amount, throw speed, rise, and
 * sweep follow speed / accel / yaw / slip. Dials do not set a constant look.
 */
export function jetSprayLook( body, jet ) {

	const m = jetMotionOf( body );
	const amount = Math.max( jet?.spray ?? 0, 0 ) * Math.min( m.work, 2.2 );
	const speedCeil = Math.max( jet?.spraySpeed ?? 17, 2 );
	const liveSpeed = m.speed * ( 0.40 + 0.30 * m.churnK + 0.22 * Math.max( m.accelK, 0 ) );
	const riseCeil = Math.max( jet?.sprayRise ?? 0.42, 0 );
	const riseK = clamp(
		0.22 + m.churnK * 0.50 + Math.max( m.accelK, 0 ) * 0.38 - Math.max( - m.accelK, 0 ) * 0.25,
		0.10, 1.20,
	);
	const angleCeil = Math.max( jet?.sprayAngle ?? 0.35, 0 );
	return {
		amount,
		pump: m.pump,
		steer: m.steer,
		jetSpeed: clamp( liveSpeed, 2.5, speedCeil ),
		jetRise: riseCeil * riseK,
		jetAngle: angleCeil * clamp( 0.28 + m.turnK * 0.85, 0.15, 1.20 ),
		motion: m,
	};

}

/**
 * Pump-jet particles pinned to the live transom. Chines, curtain, and
 * bow burst stay off — those are `body.spray` with `hull: 1`.
 */
export function stepJetSpray( body, jet, opts = {} ) {

	if ( ! jet?.on || ! ( jet.spray > 0.001 ) ) return null;
	const onWater = !! body?.wet && ! body?.airborne;
	if ( ! onWater ) return null;
	const look = jetSprayLook( body, jet );
	if ( ! ( look.amount > 0.001 ) ) return null;
	const sea = body?._primed && Number.isFinite( body.surf )
		? body.surf
		: ( opts.seaLevel ?? 0 );
	const hx = Math.sin( body?.heading ?? 0 );
	const hz = - Math.cos( body?.heading ?? 0 );
	const xz = body?.surfXZ ? body.surfXZ() : [ body?.pos?.[ 0 ] ?? 0, body?.pos?.[ 2 ] ?? 0 ];
	const hullHalf = Math.max(
		( body?.size?.x ?? body?.beam ?? 0.6 ) * 0.5,
		( body?.beam ?? 0 ) * 0.5,
		0.2,
	);
	const widthK = clamp( ( jet.width ?? WAKE_JET_WIDTH ) / WAKE_JET_WIDTH, 0.4, 2.8 );
	return {
		craftPos: [ xz[ 0 ], sea, xz[ 1 ] ],
		craftFwd: [ hx, hz ],
		craftRight: [ - hz, hx ],
		craftSites: undefined,
		craftSiteCount: 1,
		craftPierce: 0,
		craftSpout: 0,
		craftSpeed: look.motion.speed,
		craftTurn: body?.yawRate ?? 0,
		craftAmount: look.amount,
		craftLoad: sprayLoad( body ),
		craftSteer: look.steer,
		craftThrottle: look.pump,
		craftSlip: body?.slipSigned ?? 0,
		craftAir: 0,
		craftImpact: 0,
		craftBeam: hullHalf * widthK,
		craftLen: Math.max( body?.length ?? body?.size?.z ?? 2, 0.4 ) * 0.5,
		craftEntryRadius: Math.max( hullHalf, 0.4 ),
		entryDraw: 0,
		sites: 1,
		touching: true,
		runs: 0,
		sprayBody: undefined,
		craftJetOnly: 1,
		craftJet: 1,
		craftJetSpeed: look.jetSpeed,
		craftJetRise: look.jetRise,
		craftJetAngle: look.jetAngle,
		craftSheet: 0,
		craftCurtain: 0,
		craftBurst: 0,
		craftPlane: 3,
		craftPlaneFull: 12,
	};

}

/**
 * `false` / `0` / omitted → off.
 * `true` / `1` → size-scaled defaults.
 * A number → defaults × that gain.
 * An object merges over defaults. `on: 0` is off; `on` as a number is gain.
 */
export function parseSpray( value, size = {}, extras = {} ) {

	if ( value === false || value == null || value === 0 ) return null;
	if ( value === 'impact' || value === 'waterline' ) value = true;
	const d = sprayDefaults( size, extras );
	if ( value === true || value === 1 ) return d;
	if ( typeof value === 'number' ) {

		if ( ! ( value > 0.001 ) ) return null;
		return scaleGain( d, value );

	}

	const on = value.on;
	if ( on === false || on === 0 ) return null;
	const gain = on == null || on === true ? 1 : on;
	if ( ! ( gain > 0.001 ) ) return null;
	const merged = { ...d, ...value };
	delete merged.on;
	merged.sites = Math.max( 1, Math.min( MAX_BREACH_EMITTERS, Math.round( merged.sites ?? d.sites ) ) );
	merged.hull = merged.hull > 0.5 ? 1 : 0;
	merged.band = Math.max( 0, merged.band ?? d.band );
	merged.amount = Math.max( 0, merged.amount ?? d.amount );
	return scaleGain( merged, gain );

}

/** Axis-aligned box as a breach profile: top / keel / half-beam along Z. */
export function stationsFromSize( size = {}, bins = 12 ) {

	const n = Math.max( 4, Math.min( 32, bins | 0 ) );
	const hz = Math.max( size.z ?? 2, 0.2 ) * 0.5;
	const hy = Math.max( size.y ?? 0.5, 0.05 ) * 0.5;
	const hx = Math.max( size.x ?? 0.6, 0.05 ) * 0.5;
	return {
		minZ: - hz,
		maxZ: hz,
		top: new Float32Array( n ).fill( hy ),
		low: new Float32Array( n ).fill( - hy ),
		half: new Float32Array( n ).fill( hx ),
	};

}

export function spraySiteCap( cfg ) {

	return Math.max( 1, Math.min( MAX_BREACH_EMITTERS, Math.round( cfg?.sites ?? 4 ) ) );

}

/**
 * Where this mesh would emit: waterline cuts, plus the hull-jet origin
 * when `hull` is on. Used by the GPU emitter and by the debug overlay.
 * Placement does not require the emitter to be live this frame.
 */
export function sprayContactPoints( body, opts = {} ) {

	const extras = sprayExtras( body );
	const cfg = parseSpray( body?.spray, body?.size, extras ) || sprayDefaults( body?.size, extras );
	const sea = body?._primed && Number.isFinite( body.surf )
		? body.surf
		: ( opts.seaLevel ?? 0 );
	const stations = body?.sprayStations || stationsFromSize( body?.size );
	const cap = spraySiteCap( cfg );
	const placed = placeBreachEmitters( stations, {
		origin: body?.pos ?? [ 0, 0, 0 ],
		heading: body?.heading ?? 0,
		pitch: body?.pitch ?? 0,
		seaLevel: sea,
		count: cap,
		band: cfg.band,
		minHalf: SPRAY_WATERLINE_MIN_HALF,
		swim: body?.spraySwim,
	} );
	const xz = body?.surfXZ ? body.surfXZ() : [ body?.pos?.[ 0 ] ?? 0, body?.pos?.[ 2 ] ?? 0 ];
	const live = parseSpray( body?.spray, body?.size, extras );
	const hull = live && live.hull > 0.5
		? { kind: 'spray', role: 'hull', x: xz[ 0 ], y: sea, z: xz[ 1 ] }
		: null;
	const cuts = placed.runs.length
		? placed.sites.slice( 0, cap ).map( ( s ) => ( {
			kind: 'spray', role: 'cut',
			x: s.x, y: s.y, z: s.z, side: s.side, along: s.along, half: s.half,
		} ) )
		: [];
	return { cuts, hull, sea, touching: placed.runs.length > 0 };

}

/** How many waterline cuts may write leftover foam in one frame. */
export const WAKE_CUT_MAX = 12;

/**
 * The same pierce sites spray uses, as a wake recipe. Empty when the
 * mesh is not cutting the sea — a profiled body must not invent a
 * mid-hull stamp just because the origin is near the surface.
 */
export function wakeCutPoints( body, opts = {} ) {

	if ( ! body?.sprayStations ) return [];
	const contacts = sprayContactPoints( body, opts );
	if ( ! contacts.touching ) return [];
	return contacts.cuts.slice( 0, WAKE_CUT_MAX );

}

/**
 * First waterline break along heading — the snout if it is cutting,
 * otherwise the front of the first spine / back run. Empty when the
 * mesh is fully under or fully clear. The V writes here, not at the
 * origin: leftover foam on every pierce glued a blob to the body.
 */
export function wakeLeadContact( body, opts = {} ) {

	if ( ! body?.sprayStations ) return null;
	const sea = body?._primed && Number.isFinite( body.surf )
		? body.surf
		: ( opts.seaLevel ?? 0 );
	const extras = sprayExtras( body );
	const cfg = parseSpray( body?.spray, body?.size, extras ) || sprayDefaults( body?.size, extras );
	const placed = placeBreachEmitters( body.sprayStations, {
		origin: body?.pos ?? [ 0, 0, 0 ],
		heading: body?.heading ?? 0,
		pitch: body?.pitch ?? 0,
		seaLevel: sea,
		count: 8,
		band: Math.max( opts.band ?? cfg.band ?? 0.12, 0 ),
		minHalf: SPRAY_WATERLINE_MIN_HALF,
		swim: body?.spraySwim,
	} );
	if ( ! placed.runs.length || ! placed.fore ) return null;
	const heading = body?.heading ?? 0;
	return {
		x: placed.fore.x,
		z: placed.fore.z,
		along: placed.fore.along,
		fx: Math.sin( heading ),
		fz: - Math.cos( heading ),
		top: placed.top,
		emerge: Math.max( 0, ( placed.top ?? sea ) - sea ),
	};

}

/**
 * Spray's live waterline sites, thinned to one stamp per pierce run.
 * Forty emitters would paint a foam slab; the head / spine / tail
 * the water actually feels are enough.
 */
export function wakeSpraySites( body, opts = {} ) {

	return wakeRingPoints( wakeCutPoints( body, opts ), 4, 4 );

}

/**
 * A wake lives aft of the cut, the way a hull or a surfacing back
 * leaves water behind the contact. Heading 0 is −Z.
 */
export function wakeBehindPoint( x, z, heading = 0, aft = 0.9 ) {

	const hx = Math.sin( heading );
	const hz = - Math.cos( heading );
	return [ x - hx * aft, z - hz * aft ];

}

export function wakeBehindPoints( sites, heading = 0, aft = 0.9 ) {

	const out = [];
	for ( let i = 0; i < ( sites?.length ?? 0 ); i ++ ) {

		const s = sites[ i ];
		out.push( wakeBehindPoint(
			s.x ?? s[ 0 ],
			s.z ?? s[ 2 ] ?? s[ 1 ],
			heading, aft,
		) );

	}
	return out;

}

/**
 * A short list of those cuts for expanding rings. Every spray site
 * would overflow the 16-ring field; one stamp per pierce run is the
 * head / back / tail the water actually feels.
 */
export function wakeRingPoints( cuts, gap = 4, max = 4 ) {

	const out = [];
	for ( let i = 0; i < ( cuts?.length ?? 0 ); i ++ ) {

		const s = cuts[ i ];
		const x = s.x ?? s[ 0 ];
		const z = s.z ?? s[ 2 ] ?? s[ 1 ];
		if ( out.some( ( o ) => Math.hypot( o.x - x, o.z - z ) < gap ) ) continue;
		out.push( { x, z } );
		if ( out.length >= max ) break;

	}
	return out;

}

/**
 * Leftover foam sites: the origin slider first (a stable ribbon), then
 * waterline cuts that are not already sitting on that stern. A single
 * point returns as `[stern]` so the caller can drop `stampPoints` and
 * use the A→B path.
 */
export function wakeFoamPoints( stern, cuts, gap = 3, max = WAKE_CUT_MAX ) {

	const sx = stern?.[ 0 ] ?? 0;
	const sz = stern?.[ 1 ] ?? 0;
	const out = [ [ sx, sz ] ];
	for ( let i = 0; i < ( cuts?.length ?? 0 ); i ++ ) {

		const s = cuts[ i ];
		const x = s.x ?? s[ 0 ];
		const z = s.z ?? s[ 2 ] ?? s[ 1 ];
		if ( out.some( ( o ) => Math.hypot( o[ 0 ] - x, o[ 1 ] - z ) < gap ) ) continue;
		out.push( [ x, z ] );
		if ( out.length >= max ) break;

	}
	return out;

}

export function sprayExtras( body ) {

	return {
		length: body?.length,
		beam: body?.beam,
		hover: body?.hover,
		driven: body?.throttle != null || body?.steer != null,
		planing: ( body?.hover ?? 0 ) > 0 || body?.throttle != null || body?.steer != null,
	};

}

/** How hard the hull is working the water this frame. */
export function sprayLoad( body ) {

	const speed = Math.abs( body?.speed ?? 0 );
	return ( body?.hullLoad ?? 0 )
		+ Math.abs( body?.fwdAccel ?? 0 ) * 0.4
		+ Math.abs( body?.yawRate ?? 0 ) * speed * 0.35
		+ Math.abs( body?.yawAcc ?? 0 ) * 0.2
		+ Math.abs( body?.pitchRate ?? 0 ) * 8
		+ Math.abs( body?.rollRate ?? 0 ) * 5;

}

/**
 * One frame of craft uniforms for TslSpray, or null when nothing should emit.
 * Reads measured kinematics (`fwdAccel`, `yawAcc`, `pitchRate`) — never
 * `body.accel`, which is the motor coefficient.
 */
export function stepSpray( body, dt, opts = {} ) {

	const cfg = parseSpray( body?.spray, body?.size, sprayExtras( body ) );
	if ( ! cfg ) {

		const jet = jetSprayOf( body );
		return jet ? stepJetSpray( body, jet, opts ) : null;

	}

	const sea = body?._primed && Number.isFinite( body.surf )
		? body.surf
		: ( opts.seaLevel ?? 0 );
	const stations = body?.sprayStations || stationsFromSize( body?.size );
	const cap = spraySiteCap( cfg );
	const placed = placeBreachEmitters( stations, {
		origin: body?.pos ?? [ 0, 0, 0 ],
		heading: body?.heading ?? 0,
		pitch: body?.pitch ?? 0,
		seaLevel: sea,
		count: cap,
		band: cfg.band,
		minHalf: SPRAY_WATERLINE_MIN_HALF,
		swim: body?.spraySwim,
	} );

	const touching = placed.runs.length > 0;
	const onWater = !! body?.wet && ! body?.airborne;
	const hullOn = cfg.hull > 0.5 && onWater;
	const speed = Math.abs( body?.speed ?? 0 );
	const impact = body?.impact ?? 0;
	const params = opts.params || {};
	body._sprayEntryHold = 0;
	body._sprayEntryDraw = 0;
	// Jump-out / dive-in plates are out. Spray only while a hull is
	// planing or the mesh is cutting the sea — an airborne slap must
	// not leave a crown sitting on the water after the body dives.
	if ( ! hullOn && ! touching ) {

		const jet = jetSprayOf( body );
		return jet && onWater ? stepJetSpray( body, jet, opts ) : null;

	}
	if ( cfg.amount <= 0.001 ) {

		const jet = jetSprayOf( body );
		return jet && onWater ? stepJetSpray( body, jet, opts ) : null;

	}
	const hx = Math.sin( body?.heading ?? 0 );
	const hz = - Math.cos( body?.heading ?? 0 );
	const xz = body?.surfXZ ? body.surfXZ() : [ body?.pos?.[ 0 ] ?? 0, body?.pos?.[ 2 ] ?? 0 ];
	const sites = hullOn
		? [ { x: xz[ 0 ], y: sea, z: xz[ 1 ], side: 1 } ]
		: placed.sites.slice( 0, cap );
	if ( ! sites.length ) return null;

	const first = sites[ 0 ];
	// Waterline half-beam. Pierce sites already carry `half`; a hull jet
	// must use half of body.beam / size.x — passing the full beam made
	// chine sheets birth almost a beam outboard of the mesh.
	const siteHalf = sites.reduce( ( a, s ) => a + ( s.half ?? 0 ), 0 )
		/ Math.max( sites.length, 1 );
	const hullHalf = Math.max(
		( body?.size?.x ?? body?.beam ?? 0.6 ) * 0.5,
		( body?.beam ?? 0 ) * 0.5,
		0.2,
	);
	const beam = siteHalf > 0.01 ? siteHalf : hullHalf;
	const amount = cfg.amount * ( body?.sprayLook === 'dragon'
		? 1
		: ( params.craftSprayAmount ?? 0.75 ) );

	const rig = {
		craftPos: [ first.x, first.y, first.z ],
		craftFwd: [ hx, hz ],
		craftRight: [ - hz, hx ],
		craftSites: hullOn ? undefined : sites,
		craftSiteCount: hullOn ? 1 : Math.max( 1, sites.length ),
		craftPierce: hullOn ? 0 : 1,
		craftSpout: 0,
		craftSpeed: speed,
		craftTurn: onWater || touching ? ( body?.yawRate ?? 0 ) : 0,
		craftAmount: amount,
		craftLoad: sprayLoad( body ),
		craftSteer: clamp( body?.steerIn ?? body?.steer ?? 0, - 1, 1 ),
		craftThrottle: clamp( body?.throttle ?? 0, - 1, 1 ),
		craftSlip: body?.slipSigned ?? 0,
		craftAir: body?.airborne && ! touching && impact < 0.02 ? 1 : 0,
		// Pierce spray is the waterline sheet only. Impact used to fire
		// the crown / atlas plates (wBurst + uEntry) that sat on the
		// sea after a leap. Hulls still pass impact for the ski burst.
		craftImpact: hullOn ? impact : 0,
		craftBeam: beam,
		// uCraftLen is the bow-to-centre / stern-to-centre distance (wrLength in
		// the original wave-runner path), not the full LOA. Passing a yacht's full
		// length put its jet origin another half-hull behind the transom.
		// Hull jet: half-LOA so the nozzle sits on the transom.
		// Waterline: small smear — pierce birth no longer uses this as a
		// metre-scale offset (see SPRAY_WATERLINE_SMEAR). Half-LOA remains
		// so a stacked transom rooster still aims from the stern.
		craftLen: Math.max( body?.length ?? body?.size?.z ?? 2, 0.4 )
			* ( hullOn || jetSprayOf( body ) ? 0.5 : 0.22 ),
		craftEntryRadius: Math.max( beam, 0.4 ),
		entryDraw: 0,
		sites: cap,
		touching,
		runs: placed.runs.length,
		sprayBody: body?.sprayLook || undefined,
	};
	if ( hullOn ) return rig;
	// Displacement hulls shed below ski planing speed. Pin the ski
	// jet/chine/curtain weights to 0 so preset craftJet: 1 cannot
	// fire a pump tail from a waterline body.
	rig.craftPlane = 1.6;
	rig.craftPlaneFull = 9;
	rig.craftJet = 0;
	rig.craftSheet = 0;
	rig.craftCurtain = 0;
	rig.craftBurst = 0;
	return withJetSpray( rig, body );

}

/**
 * Stack a transom rooster on a waterline (or other) spray payload.
 * No-op when `wake.jet.spray` is off.
 */
export function withJetSpray( rig, body ) {

	if ( ! rig ) return null;
	const jet = jetSprayOf( body );
	if ( ! jet ) return rig;
	const look = jetSprayLook( body, jet );
	if ( ! ( look.amount > 0.001 ) ) return rig;
	// Jet org is −fwd × half-LOA from the hull origin. Waterline
	// craftPos is a cut on the mesh — leaving it there threw the
	// rooster from a random shoulder, not the transom.
	const sea = body?._primed && Number.isFinite( body.surf )
		? body.surf
		: ( rig.craftPos?.[ 1 ] ?? 0 );
	const xz = body?.surfXZ ? body.surfXZ() : [
		body?.pos?.[ 0 ] ?? 0, body?.pos?.[ 2 ] ?? 0,
	];
	rig.craftPos = [ xz[ 0 ], sea, xz[ 1 ] ];
	rig.craftLen = Math.max( body?.length ?? body?.size?.z ?? 2, 0.4 ) * 0.5;
	rig.craftJet = Math.max( look.amount, 0.15 );
	rig.craftJetSpeed = look.jetSpeed;
	rig.craftJetRise = look.jetRise;
	rig.craftJetAngle = look.jetAngle;
	rig.craftAmount = Math.max( rig.craftAmount ?? 0, look.amount );
	rig.craftSteer = look.steer;
	rig.craftThrottle = Math.max( rig.craftThrottle ?? 0, look.pump );
	return rig;

}

/** Write the payload onto the spray ctx, or park the emitter. */
export function applySprayContext( ctx, rig ) {

	if ( ! ctx ) return;
	if ( ! rig || ! ( rig.craftAmount > 0.001 ) ) {

		ctx.craftPos = PARKED;
		ctx.craftFwd = [ 0, 1 ];
		ctx.craftRight = [ 1, 0 ];
		ctx.craftSites = undefined;
		ctx.craftSiteCount = 1;
		ctx.craftPierce = 0;
		ctx.craftSpout = 0;
		ctx.craftSpeed = 0;
		ctx.craftTurn = 0;
		ctx.craftAmount = 0;
		ctx.craftLoad = 0;
		ctx.craftSteer = 0;
		ctx.craftThrottle = 0;
		ctx.craftSlip = 0;
		ctx.craftAir = 1;
		ctx.craftImpact = 0;
		ctx.craftBeam = undefined;
		ctx.craftLen = undefined;
		ctx.craftEntryRadius = 0;
		ctx.entryDraw = 0;
		ctx.sprayBody = undefined;
		ctx.craftJetOnly = 0;
		ctx.craftJet = undefined;
		ctx.craftJetSpeed = undefined;
		ctx.craftJetRise = undefined;
		ctx.craftJetAngle = undefined;
		ctx.craftSheet = undefined;
		ctx.craftCurtain = undefined;
		ctx.craftBurst = undefined;
		ctx.craftPlane = undefined;
		ctx.craftPlaneFull = undefined;
		return;

	}

	ctx.craftPos = rig.craftPos;
	ctx.craftFwd = rig.craftFwd;
	ctx.craftRight = rig.craftRight;
	ctx.craftSites = rig.craftSites;
	ctx.craftSiteCount = rig.craftSiteCount;
	ctx.craftPierce = rig.craftPierce;
	ctx.craftSpout = rig.craftSpout;
	ctx.craftSpeed = rig.craftSpeed;
	ctx.craftTurn = rig.craftTurn;
	ctx.craftAmount = rig.craftAmount;
	ctx.craftLoad = rig.craftLoad;
	ctx.craftSteer = rig.craftSteer;
	ctx.craftThrottle = rig.craftThrottle;
	ctx.craftSlip = rig.craftSlip;
	ctx.craftAir = rig.craftAir;
	ctx.craftImpact = rig.craftImpact;
	ctx.craftBeam = rig.craftBeam;
	ctx.craftLen = rig.craftLen;
	ctx.craftEntryRadius = rig.craftEntryRadius;
	ctx.entryDraw = rig.entryDraw ?? 0;
	ctx.sprayBody = rig.sprayBody;
	ctx.craftJetOnly = rig.craftJetOnly ?? 0;
	ctx.craftJet = rig.craftJet;
	ctx.craftJetSpeed = rig.craftJetSpeed;
	ctx.craftJetRise = rig.craftJetRise;
	ctx.craftJetAngle = rig.craftJetAngle;
	ctx.craftSheet = rig.craftSheet;
	ctx.craftCurtain = rig.craftCurtain;
	ctx.craftBurst = rig.craftBurst;
	ctx.craftPlane = rig.craftPlane;
	ctx.craftPlaneFull = rig.craftPlaneFull;

}
