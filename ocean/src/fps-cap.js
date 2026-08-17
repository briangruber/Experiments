// How hard the demo is allowed to work the machine, as a frame-rate ceiling.
// Uncapped (`fpsCap` 0) the loop runs at the display refresh and adaptive
// quality then spends every leftover watt. A cap SKIPS frames: same picture,
// fewer GPU-seconds per wall-second. That is the only duty-cycle lever that
// does not trade the look.
//
// Live ceiling is the tightest of the knobs that apply right now:
//   focused + plugged in  → fpsCap
//   window not in front   → min(fpsCap, fpsCapIdle)
//   unplugged             → min(of those, fpsCapBattery)
// A lower fpsCap is never raised. Battery 0 means "no extra unplugged limit".

export function liveFpsCap( params, { focused = true, charging = true } = {} ) {

	const cap = params?.fpsCap ?? 0;
	if ( cap <= 0 ) return 0;
	let live = cap;
	if ( ! focused ) live = Math.min( live, params.fpsCapIdle ?? 10 );
	const battery = params.fpsCapBattery ?? 30;
	if ( ! charging && battery > 0 ) live = Math.min( live, battery );
	return live;

}

/** True when the measured fps is the cap holding the rate, not the GPU. */
export function fpsCappedOut( fps, cap ) {

	return cap > 0 && fps >= cap * 0.92;

}

/**
 * Skip this rAF if it arrived too soon after the last presented frame.
 * The 1.2 ms hair under the period stops a cap equal to the refresh from
 * landing just the wrong side of every other vsync and halving the rate.
 */
export function shouldSkipFrame( now, lastPresent, cap ) {

	if ( cap <= 0 ) return false;
	return now - lastPresent < 1000 / cap - 1.2;

}
