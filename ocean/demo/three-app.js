// The entry point the standalone bundle boots. three.html's inline script does
// the same job for the CDN build; this is that script as a module so the bundler
// has something to start from.
//
// Everything here is UI. The rendering lives in ./three-main.js.

import { boot, wantedBackend } from './three-main.js';

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
		// So look. One capture, a few frames in, read INSIDE the frame callback
		// because a drawing buffer is cleared once it composites. If nothing
		// arrived, come back up on WebGL2 and say why.
		if ( app.backend === 'webgpu' && await presentedNothing( app, canvas ) ) {

			app.renderer.setAnimationLoop?.( null );
			const fb = await boot( { canvas: freshCanvas(), backend: 'webgl' } );
			fb.fellBack = true;
			fb.fallbackReason = 'WebGPU initialised but presented no pixels on this platform.';
			return fb;

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

// Resolves true when the canvas is uniformly black after the app has had a few
// frames to draw something.
function presentedNothing( app, canvas ) {

	return new Promise( ( resolve ) => {

		let seen = 0;
		const prev = app.onFrame;
		const done = ( verdict ) => { app.onFrame = prev; resolve( verdict ); };

		app.onFrame = () => {

			if ( ++ seen < 6 ) return;               // let the iris and the sim settle
			try {

				const c = document.createElement( 'canvas' );
				c.width = Math.min( canvas.width, 160 );
				c.height = Math.min( canvas.height, 100 );
				const g = c.getContext( '2d', { willReadFrequently: true } );
				g.drawImage( canvas, 0, 0, c.width, c.height );
				const d = g.getImageData( 0, 0, c.width, c.height ).data;
				let sum = 0;
				for ( let i = 0; i < d.length; i += 4 ) sum += d[ i ] + d[ i + 1 ] + d[ i + 2 ];
				done( sum / ( d.length / 4 ) < 3 );   // essentially black

			} catch {

				done( false );                         // cannot tell; assume it is fine

			}

		};

		// If frames are not arriving at all, that is its own kind of nothing.
		setTimeout( () => done( true ), 5000 );

	} );

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
		sel.addEventListener( 'change', () => app.applyPreset( sel.value ) );

	}

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

	// iOS WebKit composite nudge. On an iPhone, a FRESH page load composites the
	// WebGPU canvas fine, but an in-page navigation (the backend buttons set a
	// URL param) leaves it blank until any layout change touches the document -
	// collapsing the panel was "fixing" it, which is how the symptom was found.
	// So do programmatically what the collapse does: invalidate document layout,
	// a few times over the first seconds, with a padding change too small to see.
	// Harmless on every other platform; unverifiable from where this is written,
	// like everything iOS - stated as the attempt it is.
	const kickCompositor = () => {

		document.body.style.paddingBottom = '0.02px';
		void document.body.offsetHeight;                 // force the reflow now
		requestAnimationFrame( () => { document.body.style.paddingBottom = ''; } );

	};
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
