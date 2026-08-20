#!/usr/bin/env node
// Runs tools/capture-spectator.html and writes the before/after PNGs.
//
//   xvfb-run -a node tools/capture-spectator.mjs [--out shots]
//
// Exits non-zero if the capture's own checks fail — notably if the drawn
// frustum outline disagrees with the planes the culler tests against, which
// would make the resulting picture misleading.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

const args = process.argv.slice( 2 );
const outIndex = args.indexOf( '--out' );
const OUT_DIR = resolve( ROOT, outIndex >= 0 ? args[ outIndex + 1 ] : 'shots' );

async function loadPlaywright() {

	for ( const candidate of [
		'playwright',
		'/opt/node22/lib/node_modules/playwright/index.mjs',
		process.env.PLAYWRIGHT_PATH,
	].filter( Boolean ) ) {

		try {

			return await import( candidate );

		} catch { /* try next */ }

	}

	throw new Error( 'playwright not found; set PLAYWRIGHT_PATH' );

}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer( async ( request, response ) => {

	try {

		const url = decodeURIComponent( request.url.split( '?' )[ 0 ] );
		const path = join( ROOT, url === '/' ? 'index.html' : url );
		if ( ! path.startsWith( ROOT ) ) return void response.writeHead( 403 ).end();

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

for ( const candidate of [
	process.env.CHROMIUM_PATH,
	'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter( Boolean ) ) {

	try {

		await access( candidate );
		launchOptions.executablePath = candidate;
		launchOptions.headless = false; // run under xvfb-run
		break;

	} catch { /* try next */ }

}

const browser = await chromium.launch( launchOptions );
const page = await browser.newPage();

const pageErrors = [];
page.on( 'pageerror', ( error ) => pageErrors.push( String( error.message || error ) ) );

await page.goto( `http://127.0.0.1:${ port }/tools/capture-spectator.html`, { waitUntil: 'load' } );

await page.waitForFunction( () => globalThis.__capture && globalThis.__capture.done, null, { timeout: 180000 } )
	.catch( () => { /* report whatever exists */ } );

const results = await page.evaluate( () => globalThis.__capture || { errors: [ 'capture never ran' ] } );

await browser.close();
server.close();

for ( const line of results.log || [] ) console.log( line );
for ( const error of [ ...( results.errors || [] ), ...pageErrors ] ) console.log( 'ERROR ' + error );

await mkdir( OUT_DIR, { recursive: true } );

for ( const [ label, shot ] of Object.entries( results.shots || {} ) ) {

	const path = join( OUT_DIR, `spectator-${ label }.png` );
	await writeFile( path, Buffer.from( shot.png.split( ',' )[ 1 ], 'base64' ) );
	console.log( `wrote ${ path }` );

}

process.exit( results.ok ? 0 : 1 );
