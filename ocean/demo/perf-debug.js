// Live perf overlay: toggle the expensive stages and watch FPS / energy.
//
// The numbers a phone can actually show. Ablation (Measure) is the honest
// GPU-ish cost — JS timers only see CPU submit, not GPU execute. Energy is
// inferred: GPU-seconds per wall-second ≈ frameMs × fps / 1000. Toggle a
// stage off and that product drops if the stage was paying.

export const PERF_STAGES = [
	{ id: 'sim', label: 'Waves (FFT)',
		hint: 'Spectrum, cascades, foam fields. Off freezes the sea on the last fields.' },
	{ id: 'sea', label: 'Sea surface',
		hint: 'Water mesh and shading. Off keeps a flat depth plane so clouds stay occluded — Heat should drop if the sea was the hog.' },
	{ id: 'sky', label: 'Sky + clouds',
		hint: 'Dome plus the volumetric cloud march. Usually the fill-rate hog.' },
	{ id: 'spray', label: 'Particles',
		hint: 'Spray and splash GPU particles — update and draw.' },
	{ id: 'dragon', label: 'Sea dragon',
		hint: 'The animal and the underwater refraction pass.' },
	{ id: 'craft', label: 'Craft + wake',
		hint: 'Hull draw, wake field, buoyancy probe.' },
	{ id: 'post', label: 'Post',
		hint: 'Bloom, grain, chromatic, halation. Tonemap still runs so the canvas is not black.' },
];

export function createPerfFlags() {

	const flags = {};
	for ( const s of PERF_STAGES ) flags[ s.id ] = true;
	return flags;

}

function fmtMs( n ) {

	if ( n == null || ! Number.isFinite( n ) ) return '—';
	return n < 10 ? n.toFixed( 2 ) : n.toFixed( 1 );

}

function fmtFps( n ) {

	if ( n == null || ! Number.isFinite( n ) || n <= 0 ) return '—';
	return n >= 1 ? n.toFixed( 0 ) : '<1';

}

/**
 * @param {object} app - the boot() api (perf, perfTimes, profile, params, renderer)
 * @param {ParentNode} host
 */
export function installPerfDebug( app, host = document.body ) {

	if ( typeof document === 'undefined' ) return null;
	if ( app._perfDebug ) return app._perfDebug;

	const el = document.createElement( 'aside' );
	el.id = 'perf-debug';
	el.hidden = true;
	el.setAttribute( 'aria-label', 'Performance debug' );

	const stagesHtml = PERF_STAGES.map( ( s ) => `
		<label class="perf-row" data-id="${ s.id }" title="${ s.hint }">
			<input type="checkbox" data-id="${ s.id }" checked>
			<span class="perf-lab">${ s.label }</span>
			<span class="perf-js" data-js="${ s.id }">—</span>
			<span class="perf-ab" data-ab="${ s.id }"></span>
		</label>` ).join( '' );

	el.innerHTML = `
		<header class="perf-head">
			<strong>Perf</strong>
			<div class="perf-actions">
				<button type="button" data-act="measure" title="Ablate each stage for a few seconds">Measure</button>
				<button type="button" data-act="all" title="Turn every stage back on">All on</button>
				<button type="button" data-act="close" title="Close (P)">×</button>
			</div>
		</header>
		<div class="perf-meters">
			<div class="row"><span class="k">FPS</span><span class="v" data-m="fps">—</span></div>
			<div class="row"><span class="k">Frame</span><span class="v" data-m="frame">—</span></div>
			<div class="row"><span class="k">GPU</span><span class="v" data-m="gpu">—</span></div>
			<div class="row"><span class="k">Heat</span><span class="v" data-m="energy">—</span></div>
			<div class="row"><span class="k">CPU</span><span class="v" data-m="cpu">—</span></div>
			<div class="row"><span class="k">Heap</span><span class="v" data-m="heap">—</span></div>
			<div class="row"><span class="k">Battery</span><span class="v" data-m="batt">—</span></div>
			<div class="row"><span class="k">Cap</span><span class="v" data-m="cap">—</span></div>
		</div>
		<div class="perf-hot-wrap">
			<div class="k">Hottest GPU</div>
			<ol class="perf-hot" data-m="hot"></ol>
		</div>
		<p class="perf-warn" data-m="warn" hidden></p>
		<div class="perf-stages">
			<label class="perf-row" data-gov="adapt" title="Lets the renderer drop resolution to hold the target frame rate. Off locks the current scale so a stage toggle's saving shows up as FPS, not unused headroom.">
				<input type="checkbox" data-gov="adapt">
				<span class="perf-lab">Adaptive quality</span>
				<span class="perf-js" data-m="scale">—</span>
			</label>
			${ stagesHtml }
		</div>
		<p class="perf-note">GPU ms is one frame of GPU work, not a pile of frames. Heat is GPU ms ÷ frame ms — 100% means the GPU is busy the whole refresh. JS ms is only submit time. <b>Measure</b> ranks the stages.</p>
		<p class="perf-report" data-m="report" hidden></p>
	`;

	host.appendChild( el );

	const $ = ( sel ) => el.querySelector( sel );
	const $$ = ( sel ) => [ ...el.querySelectorAll( sel ) ];

	let open = false;
	let measuring = false;
	let frames = 0;
	let t0 = performance.now();
	let batt = null;
	let battAt = 0;
	let battLvl = null;

	navigator.getBattery?.().then( ( b ) => {

		batt = b;
		battLvl = b.level;
		battAt = performance.now();

	} ).catch( () => {} );

	const setFlag = ( id, on ) => {

		app.perf[ id ] = on;
		const box = el.querySelector( `input[data-id="${ id }"]` );
		if ( box ) box.checked = on;
		el.querySelector( `.perf-row[data-id="${ id }"]` )?.classList.toggle( 'off', ! on );

	};

	const paint = () => {

		if ( ! open ) return;
		const now = performance.now();
		const fps = frames * 1000 / Math.max( now - t0, 1 );
		frames = 0;
		t0 = now;
		const frameMs = fps > 0 ? 1000 / fps : 0;
		const cpu = app.perfTimes?.cpu ?? 0;
		const gpu = app.perfTimes?.gpu;
		const gpuOk = !! app.perfTimes?.gpuOk && gpu > 0.01;
		const mem = performance.memory?.usedJSHeapSize;

		$( '[data-m="fps"]' ).textContent = fmtFps( fps );
		$( '[data-m="frame"]' ).textContent = frameMs ? `${ fmtMs( frameMs ) } ms` : '—';
		$( '[data-m="cpu"]' ).textContent = cpu ? `${ fmtMs( cpu ) } ms` : '—';
		if ( gpuOk ) {

			$( '[data-m="gpu"]' ).textContent =
				`${ fmtMs( gpu ) } ms  ·  draw ${ fmtMs( app.perfTimes.gpuRender ) }  ·  compute ${ fmtMs( app.perfTimes.gpuCompute ) }`;
			// Not capped: a 72 ms GPU on a 16 ms present is 430% busy, and
			// turning a stage off has to be allowed to show 430 → 180. The
			// old min(2, …) left Heat stuck at 200% whenever the GPU was
			// more than two frames deep, which is exactly the laptop-on-
			// battery case this meter exists for.
			const busy = gpu / Math.max( frameMs, 0.1 );
			$( '[data-m="energy"]' ).textContent = `${ Math.round( busy * 100 ) }% busy`;
			$( '[data-m="energy"]' ).classList.toggle( 'hot', busy > 1.05 );

		} else {

			$( '[data-m="gpu"]' ).textContent = '—  (Measure to rank)';
			$( '[data-m="energy"]' ).textContent = '—';

		}
		$( '[data-m="heap"]' ).textContent = mem != null
			? `${ ( mem / 1048576 ).toFixed( 0 ) } MB`
			: '—';

		if ( batt ) {

			const dtMin = ( now - battAt ) / 60000;
			const drain = battLvl != null && dtMin > 0.15
				? ( battLvl - batt.level ) / dtMin
				: null;
			$( '[data-m="batt"]' ).textContent = batt.charging
				? `${ Math.round( batt.level * 100 ) }% · charging`
				: drain != null && drain > 0
					? `${ Math.round( batt.level * 100 ) }% · −${ ( drain * 100 ).toFixed( 1 ) }%/min`
					: `${ Math.round( batt.level * 100 ) }%`;

		} else {

			$( '[data-m="batt"]' ).textContent = '—';

		}

		const stages = app.perfTimes?.stages ?? {};
		for ( const s of PERF_STAGES ) {

			const n = stages[ s.id ];
			const node = el.querySelector( `[data-js="${ s.id }"]` );
			if ( node ) node.textContent = app.perf[ s.id ] ? `${ fmtMs( n ) } ms` : 'off';

		}

		const adaptOn = ( app.params?.adaptiveQuality ?? 0 ) > 0.5;
		const adaptBox = el.querySelector( 'input[data-gov="adapt"]' );
		if ( adaptBox ) adaptBox.checked = adaptOn;
		el.querySelector( '[data-gov="adapt"]' )?.classList.toggle( 'off', ! adaptOn );
		const scale = $( '[data-m="scale"]' );
		if ( scale ) scale.textContent = `×${ ( app.params?.renderScale ?? 1 ).toFixed( 2 ) }`;

		const liveCap = app.liveFpsCap?.() ?? ( ( app.params?.fpsCap ?? 0 ) > 0 ? app.params.fpsCap : 0 );
		const capNode = $( '[data-m="cap"]' );
		if ( capNode ) {

			if ( liveCap <= 0 ) capNode.textContent = 'off';
			else if ( batt && ! batt.charging ) capNode.textContent = `${ liveCap } · battery`;
			else if ( typeof document !== 'undefined' && ! document.hasFocus() ) capNode.textContent = `${ liveCap } · idle`;
			else capNode.textContent = String( liveCap );

		}

		const warn = $( '[data-m="warn"]' );
		const capped = liveCap > 0;
		if ( capped && ! measuring ) {

			warn.hidden = false;
			warn.textContent = `Capped at ${ liveCap } fps — same picture, GPU rests between frames. Measure turns the cap off for the run.`;

		} else {

			warn.hidden = true;

		}

		const hot = $( '[data-m="hot"]' );
		const labels = Object.fromEntries( PERF_STAGES.map( ( s ) => [ s.id, s.label ] ) );
		const ranked = ( app.lastProfile?.stages ?? [] )
			.filter( ( s ) => s.ms > 0.08 )
			.slice( 0, 5 );
		if ( ranked.length ) {

			hot.innerHTML = ranked.map( ( s ) =>
				`<li><b>${ labels[ s.stage ] ?? s.stage }</b><span>${ s.ms.toFixed( 1 ) }ms ${ s.share }%</span></li>` ).join( '' );

		} else if ( gpuOk ) {

			const draw = app.perfTimes.gpuRender ?? 0;
			const compute = app.perfTimes.gpuCompute ?? 0;
			const items = [
				{ label: 'Render — sea, sky, spray, post', ms: draw },
				{ label: 'Compute — waves (FFT)', ms: compute },
			].sort( ( a, b ) => b.ms - a.ms );
			hot.innerHTML = items.map( ( s ) =>
				`<li><b>${ s.label }</b><span>${ fmtMs( s.ms ) } ms</span></li>` ).join( '' )
				+ '<li class="hint">Measure for a per-stage split</li>';

		} else {

			hot.innerHTML = '<li class="hint">Measure ranks what is heating the GPU. Sky + clouds is usually first.</li>';

		}

	};

	const onFrame = () => {

		if ( open ) frames ++;

	};
	const prevOnFrame = app.onFrame;
	app.onFrame = () => {

		prevOnFrame?.();
		onFrame();

	};

	const tick = setInterval( paint, 500 );

	const show = () => {

		open = true;
		el.hidden = false;
		document.body.classList.add( 'perf-open' );
		frames = 0;
		t0 = performance.now();
		paint();

	};

	const hide = () => {

		open = false;
		el.hidden = true;
		document.body.classList.remove( 'perf-open' );

	};

	el.addEventListener( 'change', ( ev ) => {

		const box = ev.target;
		if ( box?.dataset?.id ) setFlag( box.dataset.id, box.checked );
		if ( box?.dataset?.gov === 'adapt' && app.params ) {

			app.params.adaptiveQuality = box.checked ? 1 : 0;
			el.querySelector( '[data-gov="adapt"]' )?.classList.toggle( 'off', ! box.checked );

		}

	} );

	el.addEventListener( 'click', async ( ev ) => {

		const act = ev.target?.closest?.( '[data-act]' )?.dataset?.act;
		if ( ! act ) return;
		if ( act === 'close' ) hide();
		if ( act === 'all' ) {

			for ( const s of PERF_STAGES ) setFlag( s.id, true );

		}
		if ( act === 'measure' ) {

			if ( measuring || ! app.profile ) return;
			measuring = true;
			$( '[data-act="measure"]' ).disabled = true;
			$( '[data-m="report"]' ).hidden = false;
			$( '[data-m="report"]' ).textContent = 'Measuring — hold still…';
			try {

				const r = await app.profile( ( msg ) => {

					$( '[data-m="report"]' ).textContent = msg;

				} );
				const by = Object.fromEntries( r.stages.map( ( s ) => [ s.stage, s ] ) );
				for ( const s of PERF_STAGES ) {

					const row = by[ s.id ];
					const node = el.querySelector( `[data-ab="${ s.id }"]` );
					if ( ! node ) continue;
					node.textContent = row
						? `${ row.ms.toFixed( 1 ) }ms ${ row.share }%`
						: '';

				}
				const top = r.stages.filter( ( s ) => s.ms > 0.08 )[ 0 ];
				$( '[data-m="report"]' ).textContent =
					( r.byGpu ? 'GPU rank' : 'Frame-time rank' )
					+ ` · ${ r.frameMs.toFixed( 1 ) } ms/frame (${ r.fps } fps) · ${ r.backend }`
					+ ( top ? ` · hottest ${ top.stage } ${ top.ms.toFixed( 1 ) }ms` : '' )
					+ ( r.trustworthy ? '' : ` · UNSTABLE ${ r.driftPct }% drift` );
				paint();

			} catch ( e ) {

				$( '[data-m="report"]' ).textContent = 'Measure failed: ' + String( e?.message || e );

			}
			measuring = false;
			$( '[data-act="measure"]' ).disabled = false;

		}

	} );

	const api = {
		el,
		isOpen: () => open,
		open: show,
		close: hide,
		toggle: () => ( open ? hide() : show() ),
		setFlag,
		dispose: () => {

			clearInterval( tick );
			app.onFrame = prevOnFrame;
			el.remove();
			delete app._perfDebug;

		},
	};
	app._perfDebug = api;
	return api;

}
