// The entry point the standalone bundle boots. three.html's inline script does
// the same job for the CDN build; this is that script as a module so the bundler
// has something to start from.
//
// Everything here is UI. The rendering lives in ./three-main.js.

import { boot, wantedBackend } from './three-main.js';
import { UI } from './ui.js';
import { defaults } from '../src/presets.js';

// ---- error capture ----------------------------------------------------------
// A phone has no console. On Safari a WGSL pipeline that fails validation draws
// nothing and logs the reason somewhere the user cannot see - which is how "no
// sky" stayed undiagnosable for a full round trip. So the first few errors are
// kept and surfaced in the panel, whatever their source.
const capturedErrors = [];
const keep = ( m ) => {

	if ( capturedErrors.length < 5 ) capturedErrors.push( String( m ).slice( 0, 300 ) );

};
const realConsoleError = console.error;
console.error = ( ...a ) => { keep( a.join( ' ' ) ); realConsoleError( ...a ); };
// Guarded so the module stays importable under node, where the loadability
// checks run and `window` does not exist.
if ( typeof window !== 'undefined' ) {

	window.addEventListener( 'error', ( e ) => keep( e.message ) );
	window.addEventListener( 'unhandledrejection', ( e ) => keep( e.reason?.message || e.reason ) );

}

const statusEl = () => document.getElementById( 'status' );
const want = wantedBackend();

// The two control schemes are different enough that showing the flying one
// while riding is just wrong - and Shift and Space in particular were doing
// something nobody had been told about.
const FLY_HINT = 'Drag to look · W A S D to move · scroll to zoom · R to ride';
const RIDE_HINT = 'W throttle · A D steer · Shift to carve · Space boost · V view · R to step off';

// One place that makes the whole panel agree about the ride, whichever of the
// four ways in was used: the HUD button, the Settings panel's own Ride button,
// the R key, or an api.toggleRide() from the console.
function syncRide( app, riding ) {

	const hint = document.getElementById( 'hint' );
	if ( hint ) hint.textContent = riding ? RIDE_HINT : FLY_HINT;
	const btn = document.getElementById( 'btn-ride' );
	if ( btn ) {

		btn.setAttribute( 'aria-pressed', String( riding ) );
		btn.textContent = riding ? 'Riding' : 'Ride';

	}

	syncView( app );

}

function syncView( app ) {

	const v = document.getElementById( 'btn-view' );
	if ( v ) v.textContent = app.params.wrView >= 0.5 ? 'Chase' : 'Rider';

}

function setStatus( text, cls ) {

	const el = statusEl();
	if ( ! el ) return;
	el.className = 'v' + ( cls ? ' ' + cls : '' );
	el.textContent = text;

}

// The amber line under the readout. Empty means no note, and CSS hides it, so
// there is never a stray gap.
function setNote( text, cls ) {

	const el = document.getElementById( 'note' );
	if ( ! el ) return;
	el.className = cls || '';
	el.textContent = text || '';

}

// The backend switch is a reload, not a hot swap. Changing backend means a new
// GPU device, new pipelines and new render targets for every one of ~90 passes a
// frame; tearing all that down live is a lot of machinery whose only job is to
// avoid a page load. The URL carries the choice instead, which also makes the
// two trivially A/B-able.
for ( const [ id, value ] of [ [ 'btn-auto', 'auto' ], [ 'btn-webgpu', 'webgpu' ], [ 'btn-webgl', 'webgl' ] ] ) {

	const b = document.getElementById( id );
	if ( ! b ) continue;
	b.setAttribute( 'aria-pressed', String( want === value ) );
	b.addEventListener( 'click', () => {

		const u = new URL( location.href );
		if ( value === 'auto' ) u.searchParams.delete( 'backend' );
		else u.searchParams.set( 'backend', value );
		location.href = u.toString();

	} );

}

// Boot, and if a WebGPU boot fails for any reason - device lost, a driver that
// advertises WebGPU and cannot present, an incompatibility no shim covers - come
// back up on WebGL2 rather than showing a dead page. "Default to WebGPU with
// WebGL as the fallback" has to mean at RUNTIME too, not only at device request:
// three's own fallback only covers the case where no adapter exists at all.
// A canvas can only ever have ONE context type. Once WebGPU has been created on
// it, getContext('webgl2') returns null and the fallback dies with "Cannot read
// properties of null (reading 'getSupportedExtensions')" - measured. So falling
// back means replacing the element, not reusing it.
function freshCanvas() {

	const old = document.getElementById( 'view' );
	const next = document.createElement( 'canvas' );
	next.id = 'view';
	old.replaceWith( next );
	return next;

}

// iOS WebKit composite nudge. On an iPhone, a FRESH page load composites the
// WebGPU canvas fine, but an in-page navigation (the backend buttons set a
// URL param) leaves it blank until any layout change touches the document -
// collapsing the panel was "fixing" it, which is how the symptom was found.
// So do programmatically what the collapse does: invalidate document layout
// with a padding change too small to see. Harmless on every other platform;
// unverifiable from where this is written, like everything iOS - stated as
// the attempt it is.
function kickCompositor() {

	document.body.style.paddingBottom = '0.02px';
	void document.body.offsetHeight;                 // force the reflow now
	requestAnimationFrame( () => { document.body.style.paddingBottom = ''; } );

}

async function bootWithFallback() {

	const canvas = document.getElementById( 'view' );
	try {

		const app = await boot( { canvas } );

		// A WebGPU device can initialise, compile every shader, raise no error -
		// and still present nothing, if the platform cannot hand the swapchain to
		// the compositor. That is not hypothetical: it is what this port's own
		// headless environment does, and a black rectangle with a cheerful
		// "running on WebGPU" underneath is the worst thing to hand someone.
		//
		// So look - INSIDE the frame callback, because a drawing buffer is
		// cleared once it composites - and on iOS WebKit, nudge the compositor
		// first (see kickCompositor): the known blank-canvas case there is the
		// compositor not picking the canvas up, and a kick before the verdict
		// gives the honest outcome a chance.
		if ( app.backend === 'webgpu' ) {

			for ( const ms of [ 300, 900, 2000 ] ) setTimeout( kickCompositor, ms );

			// The drawImage readback that used to be this watchdog's whole verdict
			// is a PROVEN LIAR on macOS Chrome: the canvas-doctor page showed every
			// canvas visibly cycling colors while every readback - WebGL2 included -
			// reported black. So a black readback is only a SUSPICION; the verdict
			// comes from measuring the tonemapped frame at its source, through the
			// GPU readback path that reliably measures the HDR bands.
			if ( await presentedNothing( app ) ) {

				let postOut = null;
				try { postOut = await app.measurePostOutput(); } catch {}
				const d = app.diag;
				let bands = ( d && d.bandA !== undefined
					? `pipeline ${ d.bandA.toFixed( 3 ) } / ${ d.bandB.toFixed( 3 ) }`
					: 'pipeline unread' )
					+ ( postOut ? `, post out ${ postOut.a.toFixed( 3 ) } / ${ postOut.b.toFixed( 3 ) }` : ', post out unread' );

				// A dark post output gets bisected on the spot, because each field
				// round-trip costs a day: the adapt state itself (metering poisoning
				// shows up as NaN or a runaway key), the same frame with the metering
				// bypassed, and again with bloom also out of the loop. The note then
				// names the guilty pass instead of the whole chain.
				if ( postOut && ( postOut.a + postOut.b ) <= 0.004 ) {

					// Pass-by-pass, through measureTexture's NaN-aware bands. The field
					// data so far: adapt converges (so LUM samples the HDR fine) while
					// exposure and bloom bypasses change nothing - and bloomIntensity 0
					// does NOT neutralise a NaN, because NaN*0 is NaN. So look INSIDE:
					// prefilter out, bloom out, composite's LDR, each with a nonfinite
					// count. A NaN factory names itself here.
					try {

						const fmt = ( t, m ) => `; ${ t } ${ m.a.toFixed( 3 ) }/${ m.b.toFixed( 3 ) }${ m.nonfinite ? ` NaN×${ m.nonfinite }` : '' }`;
						bands += fmt( 'prefilter', await app.measureTexture( app.post.chain[ 0 ].texture ) );
						bands += fmt( 'bloom', await app.measureTexture( app.post.up[ 0 ].texture ) );
						bands += fmt( 'ldr', await app.measureTexture( app.post.ldr.texture ) );

						// The field data reached the last pass: composite's LDR healthy
						// (0.258/0.515), final output black. FXAA_FS is three suspects in
						// one program - the ldr tap, filmGrain, the FXAA arithmetic - and
						// two bypasses tell them apart: fxaa=0 short-circuits to
						// tap+grain; fxaa=0 grain=0 is a pure tap passthrough. And a
						// bypass that measures HEALTHY is not just a datum, it is a
						// TREATMENT: apply it, stay on WebGPU, and say what was disabled.
						const saved = { fxaa: app.params.fxaa, grain: app.params.grain };
						let heal = null;
						try {

							app.params.fxaa = 0;
							const g = await app.measurePostOutput();
							bands += `; out(fxaa0) ${ g.a.toFixed( 3 ) }/${ g.b.toFixed( 3 ) }`;
							if ( ( g.a + g.b ) > 0.02 ) {

								heal = { fxaa: 0 };

							} else {

								app.params.grain = 0;
								const p2 = await app.measurePostOutput();
								bands += `; out(fxaa0,grain0) ${ p2.a.toFixed( 3 ) }/${ p2.b.toFixed( 3 ) }`;
								if ( ( p2.a + p2.b ) > 0.02 ) heal = { fxaa: 0, grain: 0 };

							}

						} finally {

							Object.assign( app.params, saved );

						}

						if ( heal ) {

							Object.assign( app.params, heal );
							app.presentWarning = `This GPU's shader compiler breaks the `
								+ ( heal.grain !== undefined ? 'FXAA + film-grain pass' : 'FXAA pass' )
								+ `; disabled it and staying on WebGPU (${ bands }).`;
							return app;

						}

					} catch ( e ) {

						bands += `; pass-bisect failed: ${ String( e?.message || e ).slice( 0, 60 ) }`;

					}

				}

				// The full frame reaches the end of the chain with content: the only
				// contrary evidence is the untrustworthy canvas read. Stay on WebGPU
				// and say so - with the escape hatch named, in case this machine is
				// the rarer kind where presentation itself is broken.
				if ( postOut && ( postOut.a + postOut.b ) > 0.004 ) {

					app.presentWarning = `The canvas readback reports black, but the frame is healthy `
						+ `(${ bands }) - trusting the frame. If the screen IS black, press WebGL2.`;
					return app;

				}

				// The tonemapped output is genuinely dark: something real is broken.
				if ( want === 'webgpu' ) {

					app.presentWarning = `WebGPU is running but produced a black frame (${ bands }). `
						+ 'Press Auto to allow the WebGL2 fallback.';
					return app;

				}

				app.renderer.setAnimationLoop?.( null );
				const fb = await boot( { canvas: freshCanvas(), backend: 'webgl' } );
				fb.fellBack = true;
				fb.fallbackReason = `WebGPU initialised but produced a black frame (${ bands }).`;
				return fb;

			}

		}

		return app;

	} catch ( err ) {

		if ( want === 'webgl' ) throw err;          // already the fallback
		console.warn( 'WebGPU boot failed, falling back to WebGL2:', err );
		const app = await boot( { canvas: freshCanvas(), backend: 'webgl' } );
		app.fellBack = true;
		app.fallbackReason = String( err?.message || err );
		return app;

	}

}

// Resolves true when the canvas is reading uniformly black even though frames
// are being produced.
//
// THE SCHEDULE COUNTS FRAMES, NOT WALL TIME. The first WebGPU frame pays the
// whole pipeline-compile bill - ninety-odd pipelines - and on a real MacBook
// that bill ran past the flat 5-second timeout this function used to have, so
// the watchdog condemned a healthy device for being slow to warm up and
// swapped a working WebGPU ocean for the WebGL2 one. Measured in the field:
// "WebGPU initialised but presented no pixels" on a machine that runs WebGPU
// fine. So: sample the canvas on the 8th frame and every 4th after, call it
// black only after three consecutive black samples, and use wall time for one
// thing alone - a device that cannot produce even its FIRST frame in 45
// seconds is dead, compile storm or not.
function presentedNothing( app ) {

	return new Promise( ( resolve ) => {

		const canvas = app.renderer.domElement;
		let seen = 0;
		let blackReads = 0;
		const prev = app.onFrame;
		let liveness = 0;
		const done = ( verdict ) => {

			clearInterval( liveness );
			app.onFrame = prev;
			resolve( verdict );

		};

		app.onFrame = () => {

			seen ++;
			if ( seen < 8 || ( seen - 8 ) % 4 !== 0 ) return;
			try {

				const c = document.createElement( 'canvas' );
				c.width = Math.min( canvas.width, 160 );
				c.height = Math.min( canvas.height, 100 );
				const g = c.getContext( '2d', { willReadFrequently: true } );
				g.drawImage( canvas, 0, 0, c.width, c.height );
				const d = g.getImageData( 0, 0, c.width, c.height ).data;
				let sum = 0;
				for ( let i = 0; i < d.length; i += 4 ) sum += d[ i ] + d[ i + 1 ] + d[ i + 2 ];
				if ( sum / ( d.length / 4 ) >= 3 ) return done( false );   // content - all is well
				// Three black reads is a SUSPICION, not a verdict - drawImage on a
				// presented canvas is a proven liar on macOS Chrome (canvas-doctor:
				// every square visibly cycling, every readback black, WebGL2 too).
				// The caller confirms or clears it against measurePostOutput(). The
				// speculative one-shot swapchain reconfigure that briefly lived here
				// is gone: a mid-run canvas reconfigure on a healthy device risks
				// breaking the presentation it meant to rescue, for a symptom the
				// readback may simply be inventing.
				if ( ++ blackReads >= 3 ) return done( true );

			} catch {

				done( false );                         // cannot tell; assume it is fine

			}

		};

		const t0 = performance.now();
		liveness = setInterval( () => {

			if ( seen === 0 && performance.now() - t0 > 45000 ) done( true );

		}, 5000 );

	} );

}

// The classic demo's full parameter panel (demo/ui.js + demo/schema.js),
// docked on the right behind the Settings button. Same widgets, same schema,
// same toasts - the difference is only in what the events drive.
function installSettingsPanel( app, presetSel, cloudSel ) {

	const uiRoot = document.getElementById( 'ui' );
	const btn = document.getElementById( 'settings-btn' );
	if ( ! uiRoot || ! btn ) return;

	const ui = new UI( uiRoot, app.params, ( ev ) => {

		if ( ev.type === 'preset' ) {

			app.applyPreset( ev.name );
			if ( presetSel ) presetSel.value = ev.name;
			if ( cloudSel ) cloudSel.value = 'preset';
			ui.syncAll();
			return;

		}

		if ( ev.type === 'reseed' ) {

			app.params.seed = 1 + Math.floor( Math.random() * 9998 );
			app.sim.setSeed( app.params.seed );
			ui.syncAll();
			ui.toast( 'New sea generated' );
			return;

		}

		if ( ev.type === 'reset' ) {

			app.applyPreset( ui.presetSelect.value );
			if ( cloudSel ) cloudSel.value = 'preset';
			ui.syncAll();
			return;

		}

		if ( ev.type === 'copy' ) {

			const clean = {};
			for ( const k of Object.keys( defaults ) ) clean[ k ] = app.params[ k ];
			const text = JSON.stringify( clean, null, 2 );
			Promise.resolve( navigator.clipboard?.writeText( text ) ?? Promise.reject() )
				.then( () => ui.toast( 'Settings copied to clipboard' ) )
				.catch( () => {

					console.log( text );
					ui.toast( 'Clipboard blocked — settings printed to the console' );

				} );
			return;

		}

		if ( ev.type === 'save' ) {

			// Inside the frame callback, because a presented drawing buffer reads
			// back blank - the same reason presentedNothing() samples there.
			const prev = app.onFrame;
			app.onFrame = () => {

				app.onFrame = prev;
				prev?.();
				try {

					const src = app.renderer.domElement;
					const c = document.createElement( 'canvas' );
					c.width = src.width; c.height = src.height;
					c.getContext( '2d' ).drawImage( src, 0, 0 );

					// Inside the claude.ai artifact viewer a plain <a download> click is
					// inert by design - saves go through the granted downloads capability
					// and the viewer confirms. Everywhere else the anchor still works.
					if ( window.claude?.downloads?.save ) {

						c.toBlob( ( blob ) => {

							window.claude.downloads.save( { filename: 'abyssal.png', data: blob } )
								.then( () => ui.toast( 'Saved' ) )
								.catch( ( e ) => ui.toast( e?.code === 'declined' ? 'Cancelled'
									: 'Save failed: ' + String( e?.message || e ).slice( 0, 60 ), 2600 ) );

						}, 'image/png' );

					} else {

						const a = document.createElement( 'a' );
						a.download = 'abyssal.png';
						a.href = c.toDataURL( 'image/png' );
						a.click();
						ui.toast( 'Saved' );

					}

				} catch ( e ) {

					ui.toast( 'Could not read the canvas: ' + String( e?.message || e ).slice( 0, 60 ), 3200 );

				}

			};
			return;

		}

		if ( ev.type === 'ride' ) {

			syncRide( app, app.toggleRide() );
			ui.syncAll();
			return;

		}

		if ( ev.type === 'view' ) {

			app.params.wrView = app.params.wrView >= 0.5 ? 0 : 1;
			ui.syncAll();
			syncView( app );
			ui.toast( app.params.wrView >= 0.5 ? 'Chase camera' : 'Rider view' );
			return;

		}

		if ( ev.type === 'photo' || ev.type === 'quiet' || ev.type === 'profile' ) {

			ui.toast( 'Not in the three.js demo yet — use the classic demo for this' );
			return;

		}

		const it = ev.item;
		if ( ! it ) return;
		// The wave spectrum is built from parameters, not read per frame.
		if ( it.rebuild ) app.sim.dirty = true;
		// Structural rebuilds (FFT size, grid density, spray buffers) mean new GPU
		// objects; the three drivers build them once at boot. Honest about it.
		if ( it.rebuildSim || it.rebuildGrid || it.rebuildSpray || it.rebuildWake ) {

			ui.toast( 'Takes effect after reload on the three.js demo', 2600 );

		}
		// Cheap relative to a wrong sky: the LUT re-bakes once per changed knob,
		// and only sun/moon/turbidity knobs actually move it.
		app.markSkyDirty();

	} );

	// Ride and the view switch are live now; photo accumulation and quiet mode
	// are still classic-demo-only, so they are not offered.
	for ( const b of [ ui.quietBtn ] ) if ( b ) b.style.display = 'none';

	ui.presetSelect.value = app.presetName ?? 'Golden Hour Swell';
	ui.syncAll();

	btn.addEventListener( 'click', () => {

		const open = uiRoot.classList.toggle( 'hidden' ) === false;
		btn.setAttribute( 'aria-expanded', String( open ) );
		btn.textContent = open ? 'Settings ‹' : 'Settings ›';

	} );

	// The instrument panel's own selects stay live; keep the big panel in step
	// when they change.
	presetSel?.addEventListener( 'change', () => { ui.presetSelect.value = presetSel.value; ui.syncAll(); } );
	cloudSel?.addEventListener( 'change', () => ui.syncAll() );

	return ui;

}

bootWithFallback().then( ( app ) => {

	const sel = document.getElementById( 'preset' );
	if ( sel ) {

		for ( const name of app.presets ) {

			const o = document.createElement( 'option' );
			o.value = name;
			o.textContent = name;
			sel.appendChild( o );

		}

		sel.value = app.params.preset ?? 'Golden Hour Swell';
		sel.addEventListener( 'change', () => {

			app.applyPreset( sel.value );
			// A preset brings its own sky; the cloud dropdown follows.
			const cl = document.getElementById( 'clouds' );
			if ( cl ) cl.value = 'preset';

		} );

	}

	// Real cloud genera - cirrus, cumulus, stratus, nimbus, cumulonimbus - as
	// measured recipes over whatever preset is active (src/cloud-types.js). The
	// first option restores the preset's own sky.
	const cloudSel = document.getElementById( 'clouds' );
	if ( cloudSel ) {

		for ( const name of app.cloudTypes ) {

			const o = document.createElement( 'option' );
			o.value = name;
			o.textContent = `Clouds · ${ name }`;
			cloudSel.appendChild( o );

		}

		cloudSel.addEventListener( 'change', () => app.applyClouds( cloudSel.value ) );

	}

	// The panel keeps the UI instance; the HUD's buttons need it so the two
	// Ride buttons - the one up here and the one inside Settings - never
	// disagree about whether you are aboard.
	const panelUI = installSettingsPanel( app, sel, cloudSel );

	// The HUD's own ride controls. These exist because R and V are keys: on a
	// phone the ride was reachable only by opening the full parameter panel and
	// finding a button in it, which is a long way to go for the control that
	// decides what the app is.
	document.getElementById( 'btn-ride' )?.addEventListener( 'click', () => {

		syncRide( app, app.toggleRide() );
		panelUI?.syncAll();

	} );
	document.getElementById( 'btn-view' )?.addEventListener( 'click', () => {

		app.params.wrView = app.params.wrView >= 0.5 ? 0 : 1;
		syncView( app );
		panelUI?.syncAll();

	} );
	syncRide( app, false );

	// The same keys the classic demo uses. Ignored while a control has focus, so
	// typing in the panel does not launch the craft.
	window.addEventListener( 'keydown', ( e ) => {

		const t = e.target;
		if ( t && ( t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' ) ) return;
		if ( e.code === 'KeyR' ) syncRide( app, app.toggleRide() );
		else if ( e.code === 'KeyV' ) {

			app.params.wrView = app.params.wrView >= 0.5 ? 0 : 1;
			syncView( app );

		}

	} );

	// The segmented control above says what was asked for; this says what is
	// actually running. They differ exactly when a fallback fired, and that is
	// the one piece of state this app exists to show, so it is stated plainly
	// rather than implied by a button.
	const label = app.backend === 'webgpu' ? 'WebGPU' : 'WebGL2';
	setStatus( label, app.fellBack ? 'warn' : 'live' );
	if ( app.fellBack ) {

		setNote( app.fallbackReason || 'WebGPU was unavailable, so this fell back to WebGL2.' );

	}

	// The page runs in an iframe when it is hosted as an artifact, so a console
	// opened against the top frame cannot see this. The FPS readout below is what
	// a reader actually has.
	window.abyssal = app;

	// Composite nudges again once the final app is up (see kickCompositor) -
	// the pre-watchdog kicks cover the WebGPU path, these cover a fallback's
	// fresh canvas too.
	for ( const ms of [ 300, 900, 2000 ] ) setTimeout( kickCompositor, ms );
	window.abyssalErrors = capturedErrors;

	const buildEl = document.getElementById( 'build' );
	if ( buildEl ) buildEl.textContent = ( window.abyssalBuild || '?' ).slice( 4, 13 );

	// WebGPU validation errors arrive asynchronously and outside any try/catch.
	if ( app.renderer?.backend?.device ) {

		app.renderer.backend.device.addEventListener?.( 'uncapturederror', ( e ) => {

			keep( e.error?.message || 'uncaptured GPU error' );

		} );

	}

	let frames = 0, t0 = performance.now();
	let lastApplied = 0;
	const fpsEl = document.getElementById( 'fps' );
	setInterval( () => {

		const now = performance.now();
		const fps = frames * 1000 / ( now - t0 );
		frames = 0; t0 = now;
		// The app measures its own output once a second (see three-main.js). Two
		// horizontal bands of the finished frame: a sea-and-sky frame has one
		// bright and one darker, whichever way round the backend orients it. Two
		// dark numbers means nothing was drawn.
		const bandsEl = document.getElementById( 'bands' );
		if ( bandsEl ) {

			const d = app.diag;
			// The tag after the numbers is the sky mode the self-heal ladder has
			// reached; no tag is the fast path.
			const tag = d && d.skyMode && d.skyMode !== 'behind' ? `  ·${ d.skyMode }` : '';
			bandsEl.textContent = ! d ? '—'
				: d.error ? d.error
				: `${ d.bandA.toFixed( 3 ) } / ${ d.bandB.toFixed( 3 ) }${ tag }`;

		}

		// The note recomputes every tick rather than filling once: the first build
		// wrote the ladder's message and stopped, which HID the captured WGSL
		// error behind it - the one line that says what Safari actually rejected.
		// Both are shown: the ladder's reason, then the first error. The boot
		// fallback reason keeps precedence when it exists (that path never climbs
		// the ladder, so they cannot both apply).
		const noteEl = document.getElementById( 'note' );
		if ( noteEl ) {

			const parts = [];
			if ( app.fallbackReason ) parts.push( app.fallbackReason );
			else if ( app.presentWarning ) parts.push( app.presentWarning );
			else if ( app.skyFallback ) parts.push( app.skyFallback );
			if ( capturedErrors.length ) parts.push( 'GPU: ' + capturedErrors[ 0 ] );
			const text = parts.join( ' — ' );
			if ( noteEl.textContent !== text ) {

				noteEl.className = capturedErrors.length && ! app.skyFallback ? 'err' : '';
				noteEl.textContent = text;

			}

		}

		const c = app.renderer.domElement;
		// A software rasteriser can genuinely sit under one frame a second, and
		// "0 fps" reads as broken rather than as slow.
		const shown = fps >= 1 ? fps.toFixed( 0 ) : fps > 0 ? '<1' : '—';
		if ( fpsEl ) {

			// While riding, the line carries the two numbers that matter for the
			// ride: speed, and how often a fresh surface reading actually reaches
			// the hull. The probe rate is diagnosis-by-screenshot - the hull's
			// entire feel rides on it (a starved probe is a bouncing craft, see
			// craft-probe.js), and a phone has no console to ask.
			const applied = app.craftProbe?.applied ?? 0;
			const probeRate = applied - lastApplied;
			lastApplied = applied;
			fpsEl.textContent = app.rider?.active
				? `${ app.rider.speedKts.toFixed( 0 ) } kn · ${ shown } fps · probe ${ probeRate }/s`
				: `${ shown } fps  ${ c.width }×${ c.height }`;

		}

	}, 1000 );
	app.onFrame = () => { frames ++; };

} ).catch( ( err ) => {

	window.abyssalError = err;
	const msg = String( err?.message || err );
	setStatus( 'failed', 'err' );
	setNote( msg + ( want === 'webgpu'
		? ' Press Auto to fall back to WebGL2.'
		: '' ), 'err' );
	throw err;

} );
