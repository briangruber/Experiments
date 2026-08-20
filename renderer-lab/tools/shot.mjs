#!/usr/bin/env node
// Headless capture + validation harness for renderer-lab.
//
//   node tools/shot.mjs --out shots/gpu.png --mode gpu --count 24000 --wait 6000
//
// Exits non-zero on any JS/WebGPU error so it doubles as a smoke test. Prints a
// JSON report (backend, errors, fps, draw calls, culled instance count) on
// stdout.
//
// Note on WebGPU in headless Chromium: hardware adapters are usually absent in
// containers, so this asks Chromium for the SwiftShader (CPU) adapter. That is
// correct but slow — treat the fps number from a headless run as a smoke-test
// signal, not a benchmark. Real numbers need a real GPU.
//
// Also: WebGPU *canvas presentation* is broken under SwiftShader in some
// container images, which kills this tool before it can capture anything.
// Creating and configuring the context both succeed — the device is lost once
// frames are actually presented, and lost silently. It is not an adapter
// choice: where no GPU or Vulkan ICD is present, SwiftShader is the only
// adapter on offer regardless of flags. That is an environment limitation, not
// a fault in the lab; a plain WebGPU triangle fails the same way with no
// three.js involved. Where that is the case, use tools/verify.mjs instead: it
// exercises the same code through compute passes and offscreen render targets,
// which do work.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

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

const args = process.argv.slice( 2 );
const opt = ( name, fallback ) => {

	const index = args.indexOf( '--' + name );
	return index >= 0 ? args[ index + 1 ] : fallback;

};

const OUT = opt( 'out', '' );
const MODE = opt( 'mode', 'gpu' );
const COUNT = opt( 'count', '24000' );
const TRAA = opt( 'traa', '1' );
const WAIT = + opt( 'wait', 6000 );
const WIDTH = + opt( 'w', 1280 );
const HEIGHT = + opt( 'h', 720 );

const MIME = {
	'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
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
		'--use-webgpu-adapter=swiftshader',
		'--enable-unsafe-swiftshader',
		'--ignore-gpu-blocklist',
		'--disable-gpu-sandbox',
		'--no-sandbox',
	],
};

// Prefer the full Chromium build over Playwright's headless shell, whose GPU
// stack is more limited. It needs a display, so run this under xvfb-run.
for ( const candidate of [
	process.env.CHROMIUM_PATH,
	'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
	'/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter( Boolean ) ) {

	try {

		const { access } = await import( 'node:fs/promises' );
		await access( candidate );
		launchOptions.executablePath = candidate;
		launchOptions.headless = false;
		break;

	} catch { /* try next */ }

}

const browser = await chromium.launch( launchOptions );

const page = await browser.newPage( { viewport: { width: WIDTH, height: HEIGHT } } );

const consoleErrors = [];
page.on( 'pageerror', ( error ) => consoleErrors.push( String( error.message || error ) ) );
page.on( 'console', ( message ) => {

	if ( message.type() === 'error' ) consoleErrors.push( message.text() );

} );

const url = `http://127.0.0.1:${ port }/?mode=${ MODE }&count=${ COUNT }&traa=${ TRAA }`;
await page.goto( url, { waitUntil: 'load' } );

// Wait for the lab to report ready, or surface its boot error.
await page.waitForFunction( () => globalThis.__lab && ( globalThis.__lab.ready || globalThis.__lab.errors.length ), null, { timeout: WAIT } )
	.catch( () => { /* fall through to the report below */ } );

await page.waitForTimeout( WAIT );

const report = await page.evaluate( () => {

	const lab = globalThis.__lab || { errors: [ 'lab never initialised' ] };
	return {
		ready: !! lab.ready,
		backend: lab.backend,
		mode: lab.mode,
		frames: lab.frames,
		fps: lab.fps,
		cpuMs: lab.cpuMs,
		drawCalls: lab.drawCalls,
		visible: lab.visible,
		errors: lab.errors,
	};

} );

report.consoleErrors = consoleErrors;

if ( OUT ) {

	const outPath = resolve( ROOT, OUT );
	await mkdir( dirname( outPath ), { recursive: true } );
	await page.screenshot( { path: outPath } );
	report.screenshot = OUT;

}

await browser.close();
server.close();

console.log( JSON.stringify( report, null, 2 ) );

const failed = report.ready === false
	|| report.errors.length > 0
	|| consoleErrors.length > 0
	|| report.frames < 2;

process.exit( failed ? 1 : 0 );
