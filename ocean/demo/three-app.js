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

			if ( await presentedNothing( app ) ) {

				// What the panel should say depends on what the pipeline itself did:
				// bands with content mean the frames RENDERED and only presentation
				// failed, which is a very different bug report from nothing drawing.
				const d = app.diag;
				const bands = d && d.bandA !== undefined
					? `pipeline bands ${ d.bandA.toFixed( 3 ) } / ${ d.bandB.toFixed( 3 ) }`
					: 'pipeline output unread';

				// An EXPLICIT WebGPU request is not permission to switch: stay, and
				// say what was measured. Auto is where falling back is the contract.
				if ( want === 'webgpu' ) {

					app.presentWarning = `WebGPU is running but the canvas reads black (${ bands }). `
						+ 'Press Auto to allow the WebGL2 fallback.';
					return app;

				}

				app.renderer.setAnimationLoop?.( null );
				const fb = await boot( { canvas: freshCanvas(), backend: 'webgl' } );
				fb.fellBack = true;
				fb.fallbackReason = `WebGPU initialised but the canvas stayed black (${ bands }).`;
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
		let kicked = false;
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
				if ( ++ blackReads >= 3 ) {

					// Before condemning: one attempt to un-stick the swapchain. A
					// field report (macOS Chrome, in the artifact iframe) showed the
					// PIPELINE rendering perfectly - bands 0.172/0.415 - with the
					// canvas reading black, which is either a swapchain that never
					// composited or a readback that lies. Nudging the canvas size by
					// one device pixel forces the app's own per-frame resize() to run
					// renderer.setSize, which reconfigures the canvas context - a
					// fresh swapchain. Once; if three more samples still read black,
					// the verdict stands.
					if ( ! kicked ) {

						kicked = true;
						blackReads = 0;
						canvas.width = canvas.width + 1;
						return;

					}

					return done( true );

				}

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

		if ( ev.type === 'photo' || ev.type === 'ride' || ev.type === 'view'
			|| ev.type === 'quiet' || ev.type === 'profile' ) {

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

	// What is not ported is not offered: the craft (and its ride/view buttons)
	// and photo accumulation are still classic-demo-only.
	for ( const b of [ ui.rideBtn, ui.viewBtn, ui.quietBtn ] ) if ( b ) b.style.display = 'none';

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

	installSettingsPanel( app, sel, cloudSel );

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
		if ( fpsEl ) fpsEl.textContent = `${ shown } fps  ${ c.width }×${ c.height }`;

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
