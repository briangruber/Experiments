// CPU policy for N bodies writing ONE wake field.
//
// Age once, stamp every wet wake-body. The window follows the centroid of
// those bodies (or the camera if none have started a track), and never a
// `wake: false` source — recentering on the dragon used to wipe the ski.
//
// TslWake.update / Wake.update call planWakeFrame() when handed an array.
// A single rider object still takes the historical one-source path so
// prototypes/wake-tsl.html stays texel-identical.

import { clamp } from './math.js';

function snapTexel( xz, texel ) {

	const t = Math.max( texel, 1e-6 );
	return [ Math.round( xz[ 0 ] / t ) * t, Math.round( xz[ 1 ] / t ) * t ];

}

function nearestStamp( pnt, prevs, max = 4 ) {

	let best = pnt, bestD = max;
	for ( const p of prevs ) {

		const d = Math.hypot( p[ 0 ] - pnt[ 0 ], p[ 1 ] - pnt[ 1 ] );
		if ( d < bestD ) { bestD = d; best = p; }

	}

	return best;

}

export function isWetWakeSource( src ) {

	if ( ! src ) return false;
	if ( src.wake === false ) return false;
	if ( src.wakeEnabled === false ) return false;
	if ( ! src.active ) return false;
	if ( src.airborne && ! ( src.impact > 0.01 ) ) return false;
	return true;

}

export function sourceStir( src, p ) {

	if ( src.airborne && ! ( src.impact > 0.01 ) ) return 0;
	const u = Math.abs( src.speed ?? 0 );
	// Hull-scale, not 45% of a ski top-speed. A crawl still wets the
	// track; full speed contribution by ~6 m/s. Parked stays dry.
	const crawl = u <= 0 ? 0 : Math.min( Math.max( ( u - 0.12 ) / 0.9, 0 ), 1 );
	const speedT = Math.min( u / 6, 1 );
	const wakeSpeed = src.wakeSpeed ?? p.wrWakeSpeed ?? 0.55;
	const wakeTurn = src.wakeTurn ?? p.wrWakeTurn ?? 0.35;
	const wakeSlip = src.wakeSlip ?? p.wrWakeSlip ?? 0.25;
	return Math.min(
		crawl * ( 0.22 + wakeSpeed * speedT )
		+ Math.abs( src.yawRate ?? 0 ) * wakeTurn
		+ ( src.slip ?? 0 ) * wakeSlip
		+ ( src.hullLoad ?? 0 ) * 0.035
		+ ( src.impact ?? 0 ) * 1.2,
		1.4,
	);

}

/**
 * 0…1 how hard the motor / hull is churning for foam. `foam` / `motor`
 * on the wake recipe are ceilings — this fills them with speed
 * (prop RPM / waterline work), not a constant blot.
 */
export function wakeFoamChurnK( speed, topSpeed = 14 ) {

	const u = Math.abs( speed ?? 0 );
	if ( ! ( u > 0.45 ) ) return 0;
	const ref = Math.max( Math.min( Math.abs( topSpeed ) * 0.7, 24 ), 6 );
	const t = Math.min( 1, u / ref );
	return t * t * ( 3 - 2 * t );

}

/**
 * How hard the transom jet is working this frame. Recipe `motor` / `jet.*`
 * are ceilings — this fills them from measured motion, not the throttle
 * stick (cruise-hold parks that near 0 while the hull is still flying).
 *
 * Steady cruise matches `wakeFoamChurnK`. Punch, yaw, and slip raise it;
 * a hard brake eases it.
 */
export function jetMotionOf( body = {} ) {

	const speed = Math.abs( body.speed ?? 0 );
	const top = Math.max( Math.abs( body.topSpeed ?? 14 ), 4 );
	const churnK = wakeFoamChurnK( speed, top );
	const fwdAccel = body.fwdAccel ?? 0;
	const yawRate = body.yawRate ?? 0;
	const yawAcc = body.yawAcc ?? 0;
	const slip = body.slipSigned ?? body.slip ?? 0;
	const L = Math.max( body.length ?? body.size?.z ?? 8, 0.8 );
	const accelRef = Math.max( top * 0.28, 2.5 );
	const accelK = clamp( fwdAccel / accelRef, - 1.25, 1.6 );
	const accelThrow = clamp( 1 + accelK * 0.55, 0.28, 1.7 );
	const latG = Math.abs( yawRate ) * speed / 9.81;
	const turnK = clamp( latG * 0.9 + Math.abs( yawAcc ) * L * 0.04, 0, 1.5 );
	const slipK = clamp( Math.abs( slip ) / Math.max( speed * 0.22, 1.1 ), 0, 1 );
	const work = churnK * accelThrow * ( 1 + 0.32 * turnK + 0.18 * slipK );
	const yawSteer = clamp( yawRate * L / Math.max( speed, 2.2 ), - 1, 1 );
	const slipSteer = clamp( slip / Math.max( speed * 0.32, 1.4 ), - 1, 1 );
	const stick = clamp( body.steerIn ?? body.steer ?? 0, - 1, 1 );
	const steer = clamp( yawSteer * 0.8 + slipSteer * 0.3 + stick * 0.12, - 1, 1 );
	const pump = clamp(
		churnK * ( 0.72 + 0.4 * Math.max( accelK, 0 ) ) + turnK * 0.18, 0, 1.25,
	);
	return { churnK, work, accelK, turnK, slipK, steer, pump, speed, top };

}

/**
 * Where the shared field sits this frame.
 *
 * Wet sources stamp and pull the window. An airborne hull still tracks
 * the window so leftover foam does not slide off the tile mid-jump —
 * it just does not write new material until it is wet again.
 *
 * @returns {{ origin: number[], follow: 'centroid'|'camera'|'hold', wet: object[] }}
 */
export function wakeWindowOrigin( sources, { camera, prevOrigin, texel, hadWet } = {} ) {

	const list = sources || [];
	const wet = list.filter( isWetWakeSource );
	const track = wet.length ? wet : list.filter( isWakeFollowSource );
	if ( track.length ) {

		let x = 0, z = 0, n = 0;
		for ( const s of track ) {

			const p = typeof s.surfXZ === 'function' ? s.surfXZ() : null;
			if ( ! p ) continue;
			x += p[ 0 ]; z += p[ 1 ];
			n ++;

		}
		if ( n > 0 ) {

			x /= n; z /= n;
			return {
				origin: snapTexel( [ x, z ], texel || 1 ),
				follow: wet.length ? 'centroid' : 'hold',
				wet,
			};

		}

	}

	if ( hadWet ) return { origin: prevOrigin || [ 0, 0 ], follow: 'hold', wet };
	if ( camera ) return { origin: snapTexel( camera, texel || 1 ), follow: 'camera', wet };
	return { origin: prevOrigin || [ 0, 0 ], follow: 'hold', wet };

}

/** Active wake body that should keep the field window, even mid-jump. */
export function isWakeFollowSource( src ) {

	if ( ! src ) return false;
	if ( src.wake === false ) return false;
	if ( src.wakeEnabled === false ) return false;
	if ( ! src.active ) return false;
	return typeof src.surfXZ === 'function';

}

/**
 * Age once, then one stamp per wet source (and per stampPoint on that source).
 *
 * @returns {{ origin, follow, wet, rate, stamps, nextStamps, nextPos, fwd, head, speed }}
 */
export function planWakeFrame( dt, p, sources, state = {}, opts = {} ) {

	const extent = Math.max( p.wakeExtent ?? 320, 40 );
	const size = state.size || 512;
	const texel = extent / size;
	const win = wakeWindowOrigin( sources, {
		camera: opts.camera,
		prevOrigin: state.origin || [ 0, 0 ],
		texel,
		hadWet: state.hadWet,
	} );
	const stepDt = Math.min( dt, 1 / 15 );
	const life = p.wakeLife ?? 14;
	const prevStamps = state.prevStamps || [];
	const stamps = [];
	const nextStamps = [];
	let maxSpeed = 0;
	let head = state.prevPos || win.origin;
	let fwd = state.fwd || [ 0, 1 ];
	let first = true;

	for ( const src of win.wet ) {

		const cxz = src.surfXZ();
		const srcFwd = [ Math.sin( src.heading ), - Math.cos( src.heading ) ];
		const stir = sourceStir( src, p );
		const churnK = wakeFoamChurnK( src.speed, src.topSpeed );
		const foamMax = Math.max( src.wakeCfg?.foam ?? 0.9, 0 );
		const jet = src.wakeCfg?.jet;
		const motorMax = Math.max( src.wakeCfg?.motor ?? ( jet?.on ? jet.amount : 0 ) ?? 0, 0 );
		const foamGain = foamMax * 1.8 * churnK;
		const motorGain = motorMax * Math.min( jetMotionOf( src ).work, 1.65 );
		const jetWidth = Math.min( 0.55, Math.max( jet?.width ?? 0.16, 0.04 ) );
		const jetReach = Math.min( 12, Math.max( jet?.reach ?? 4, 0.6 ) );
		const srcLife = src.life ?? life;
		const rate = 0.3536 * Math.abs( src.speed ) * ( src.wakeArmRate ?? p.wakeArmRate ?? 1 );
		const reach = Math.min( rate * srcLife * 1.15 + 4, extent * 0.45 );
		const points = src.stampPoints?.length ? src.stampPoints : null;
		maxSpeed = Math.max( maxSpeed, Math.abs( src.speed ) );
		if ( first ) {

			fwd = srcFwd;
			head = points ? points[ 0 ] : ( src.stampB || cxz );
			first = false;

		}

		if ( points ) {

			for ( let i = 0; i < points.length; i ++ ) {

				const pnt = points[ i ];
				stamps.push( {
					a: nearestStamp( pnt, prevStamps ),
					b: pnt,
					fwd: srcFwd,
					stir, reach, rate,
					beam: src.foamBeam ?? src.wakeCfg?.beam ?? src.beam ?? 1.2,
					gain: foamGain,
					motor: motorGain,
					jetWidth, jetReach,
					hullLen: src.hullLen ?? 0,
					planform: src.planform || null,
					stern: src.stern || null,
					yawRate: src.yawRate ?? 0,
					persist: src.wakeCfg?.persist ?? src.persist ?? 0,
					dt: stamps.length === 0 ? stepDt : 0,
					life: srcLife, active: true,
				} );
				nextStamps.push( [ pnt[ 0 ], pnt[ 1 ] ] );

			}

		} else {

			const b = src.stampB || [ cxz[ 0 ], cxz[ 1 ] ];
			const a = src.stampA || nearestStamp( b, prevStamps.length ? prevStamps : ( state.prevPos ? [ state.prevPos ] : [ b ] ) );
			stamps.push( {
				a, b, fwd: srcFwd, stir, reach, rate,
				beam: src.foamBeam ?? src.wakeCfg?.beam ?? src.beam ?? 1.2,
				gain: foamGain,
				motor: motorGain,
				jetWidth, jetReach,
				hullLen: src.hullLen ?? 0,
				planform: src.planform || null,
				stern: src.stern || null,
				yawRate: src.yawRate ?? 0,
				persist: src.wakeCfg?.persist ?? src.persist ?? 0,
				dt: stamps.length === 0 ? stepDt : 0,
				life: srcLife, active: true,
			} );
			nextStamps.push( [ b[ 0 ], b[ 1 ] ] );

		}

	}

	const rate = 0.3536 * maxSpeed * ( p.wakeArmRate ?? 1 );
	return {
		origin: win.origin,
		follow: win.follow,
		wet: win.wet,
		rate,
		stamps,
		nextStamps,
		nextPos: nextStamps[ 0 ] || state.prevPos || win.origin,
		fwd,
		head,
		speed: win.wet.length ? maxSpeed : 0,
		stepDt,
		life,
	};

}

/**
 * Two tracks in one aged field: sample each stamp's foam/height contribution
 * independently (the GPU adds them into the same texels). Used by
 * tools/check-wake-interact.mjs — not a second texture.
 */
export function interactTracks( planned, sampleAt ) {

	// A track is "present" if a stamp's B is near the sample and stir is live.
	const hits = [];
	for ( const s of planned.stamps ) {

		const d = Math.hypot( s.b[ 0 ] - sampleAt[ 0 ], s.b[ 1 ] - sampleAt[ 1 ] );
		hits.push( { d, stir: s.stir, dt: s.dt, active: s.active } );

	}

	return hits;

}
