#!/usr/bin/env node
// Runs a verification page in headless Chromium and reports the result.
//
//   node tools/verify.mjs                     # culling vs three.js Frustum
//   node tools/verify.mjs verify-render.html  # indirect draw vs uncalled render
//
// Exits non-zero if any check in the page fails.
//
// This is the real test for this prototype. It uses only compute passes and
// buffer readback, never canvas presentation, because WebGPU canvas
// presentation is broken under SwiftShader in some container images — see the
// note in the README.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

const CHROMIUM_CANDIDATES = [
	process.env.CHROMIUM_PATH,
	'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
	'/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter( Boolean );

async function loadPlaywright() {

	const candidates = [
		'playwright',
		'/opt/node22/lib/node_modules/playwright/index.mjs',
		'/usr/lib/node_modules/playwright/index.mjs',
		process.env.PLAYWRIGHT_PATH,
	].filter( Boolean );

	for ( const candidate of candidates ) {

		try {

			return await import( candidate );

		} catch { /* try next */ }

	}

	throw new Error( 'playwright not found; set PLAYWRIGHT_PATH' );

}

const MIME = {
	'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.css': 'text/css', '.json': 'application/json',
};

const server = createServer( async ( request, response ) => {

	try {

		const url = decodeURIComponent( request.url.split( '?' )[ 0 ] );
		const path = join( ROOT, url === '/' ? 'index.html' : url );
		if ( ! path.startsWith( ROOT ) ) {

			response.writeHead( 403 ).end();
			return;

		}

		const body = await readFile( path );
		response.writeHead( 200, { 'content-type': MIME[ extname( path ) ] || 'application/octet-stream' } );
		response.end( body );

	} catch {

		response.writeHead( 404 ).end( 'not found' );

	}

} );

await new Promise( ( r ) => server.listen( 0, '127.0.0.1', r ) );
const port = server.address().port;

const { chromium } = await loadPlaywright();

const launchOptions = {
	args: [
		'--enable-unsafe-webgpu',
		'--enable-features=Vulkan',
		'--ignore-gpu-blocklist',
		// Permits the SwiftShader fallback without forcing it. Where a real
		// Vulkan driver is installed (mesa-vulkan-drivers / lavapipe), leaving
		// the choice open avoids the presentation path that loses the device.
		'--enable-unsafe-swiftshader',
		'--no-sandbox',
		'--disable-gpu-sandbox',
	],
};

// Prefer the full Chromium build when present: the headless shell Playwright
// ships by default has a more limited GPU stack.
for ( const candidate of CHROMIUM_CANDIDATES ) {

	try {

		const { access } = await import( 'node:fs/promises' );
		await access( candidate );
		launchOptions.executablePath = candidate;
		launchOptions.headless = false; // needs a display; run under xvfb-run
		break;

	} catch { /* try next */ }

}

const browser = await chromium.launch( launchOptions );
const page = await browser.newPage();

const pageErrors = [];
page.on( 'pageerror', ( error ) => pageErrors.push( String( error.message || error ) ) );

const PAGE = process.argv[ 2 ] || 'verify.html';

await page.goto( `http://127.0.0.1:${ port }/tools/${ PAGE }`, { waitUntil: 'load' } );

await page.waitForFunction( () => globalThis.__verify && globalThis.__verify.done, null, { timeout: 120000 } )
	.catch( () => { /* report whatever state exists */ } );

const results = await page.evaluate( () => globalThis.__verify || { errors: [ 'verify never ran' ] } );

await browser.close();
server.close();

if ( process.env.VERBOSE && results.log ) {

	for ( const line of results.log ) console.log( '      ' + line );

}

for ( const record of results.cases || [] ) {

	// verify.html reports per-pose culling comparisons; verify-render.html
	// reports named boolean checks. Render whichever shape arrived.
	if ( record.pose !== undefined ) {

		console.log(
			`${ record.matched ? 'PASS' : 'FAIL' }  ${ record.pose.padEnd( 16 ) }` +
			` gpu=${ String( record.gpuCount ).padStart( 5 ) }` +
			` cpu=${ String( record.cpuCount ).padStart( 5 ) }` +
			` missing=${ record.missing } extra=${ record.extra }`
		);

	} else {

		console.log( `${ record.pass ? 'PASS' : 'FAIL' }  ${ record.name }` );

	}

}

if ( results.stats ) console.log( '\nstats ' + JSON.stringify( results.stats ) );

for ( const error of [ ...( results.errors || [] ), ...pageErrors ] ) {

	console.log( 'ERROR ' + error );

}

if ( results.skipped === true ) {

	// Not a pass and not a failure: the environment could not run the check.
	console.log( '\nSKIPPED — ' + results.skipReason );
	process.exit( 0 );

}

console.log( results.ok ? '\nverified' : '\nVERIFICATION FAILED' );

process.exit( results.ok ? 0 : 1 );
