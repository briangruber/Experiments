// Four-point wave-height probe, so a hull can feel the sea it is drawn on.
//
// The surface only exists on the GPU — the FFT cascades are textures — so the
// boat cannot ask "how high is the water here?" without a readback, and a
// synchronous readPixels would stall the frame behind the whole ocean sim.
// This is the WaveRunner's answer, trimmed: a 4-texel fragment pass samples
// the displacement cascades at the hull's contact points, and the result
// comes back through a pixel buffer object guarded by a fence. The CPU reads
// a frame or two late and smooths toward it; the GPU never waits.
//
// The one subtlety worth keeping from the original: displacement is
// LAGRANGIAN. The texture says where the water that started at reference
// point x ended up, not what is above world point p. Inverting that is a
// fixed-point iteration — x <- p - D_xz(x) — and three passes is inside a
// centimetre for any choppiness the sim allows.

import { program, setUniforms, texture2D, framebuffer, FS_VERT, Blitter } from '../vendor/abyssal/src/gl.js';

export const NPROBE = 4;

const PROBE_FS = /* glsl */`
uniform sampler2DArray uDisp;
uniform float uPatch[4];
uniform int   uCascadeCount;
uniform vec2  uProbe[${NPROBE}];
uniform float uHeightScale, uHorizScale, uSeaLevel;
out vec4 fragColor;

float surfaceAt(vec2 p){
  vec2 x = p;
  for (int it = 0; it < 3; it++){
    vec2 d = vec2(0.0);
    for (int c = 0; c < 4; c++){
      if (c >= uCascadeCount) break;
      vec4 s = texture(uDisp, vec3(x / uPatch[c], float(c)));
      d += s.xz * uHorizScale;
    }
    x = p - d;
  }
  float h = 0.0;
  for (int c = 0; c < 4; c++){
    if (c >= uCascadeCount) break;
    h += texture(uDisp, vec3(x / uPatch[c], float(c))).y;
  }
  return uSeaLevel + h * uHeightScale;
}

void main(){
  int i = int(gl_FragCoord.x);
  fragColor = vec4(surfaceAt(uProbe[i]), 0.0, 0.0, 1.0);
}
`;

export class WaveProbe {

	constructor( gl ) {

		this.gl = gl;
		this.tex = texture2D( gl, {
			width: NPROBE, height: 1,
			internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT,
			filter: gl.NEAREST,
		} );
		this.fbo = framebuffer( gl, [ this.tex ] );
		this.blit = new Blitter( gl );
		this.prog = program( gl, FS_VERT, PROBE_FS, 'wake.waveprobe' );
		this.pbo = gl.createBuffer();
		gl.bindBuffer( gl.PIXEL_PACK_BUFFER, this.pbo );
		gl.bufferData( gl.PIXEL_PACK_BUFFER, NPROBE * 4 * 4, gl.STREAM_READ );
		gl.bindBuffer( gl.PIXEL_PACK_BUFFER, null );
		this.readBuf = new Float32Array( NPROBE * 4 );
		this.fence = null;
		this.h = [ 0, 0, 0, 0 ];          // smoothed, what callers read
		this.target = [ 0, 0, 0, 0 ];     // last value the GPU reported
		this._primed = false;

	}

	/**
	 * Sample the sea at four world XZ points. Call once per frame, between the
	 * ocean sim update and the water draw (the cascades are current then).
	 *
	 * `p` is the live parameter set — heightScale and seaLevel move with the
	 * preset, and reading them per call keeps the probe honest across a scene
	 * switch. `dt` drives the smoothing toward the (late) GPU reading.
	 */
	update( p, ocean, points, dt ) {

		const gl = this.gl;

		// Collect the previous reading if its fence has signalled. Never wait:
		// a probe that stalls the pipeline costs more than being a frame late.
		if ( this.fence ) {
			const st = gl.clientWaitSync( this.fence, 0, 0 );
			if ( st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED ) {
				gl.deleteSync( this.fence );
				this.fence = null;
				gl.bindBuffer( gl.PIXEL_PACK_BUFFER, this.pbo );
				gl.getBufferSubData( gl.PIXEL_PACK_BUFFER, 0, this.readBuf );
				gl.bindBuffer( gl.PIXEL_PACK_BUFFER, null );
				for ( let i = 0; i < NPROBE; i ++ ) this.target[ i ] = this.readBuf[ i * 4 ];
				if ( ! this._primed ) {
					// First reading lands whole, or the boat starts at sea level
					// and slides up to the first swell it was already on.
					for ( let i = 0; i < NPROBE; i ++ ) this.h[ i ] = this.target[ i ];
					this._primed = true;
				}
			}
		}

		// Issue this frame's sample.
		if ( ! this.fence ) {
			const flat = new Float32Array( NPROBE * 2 );
			for ( let i = 0; i < NPROBE; i ++ ) {
				flat[ i * 2 ] = points[ i ][ 0 ];
				flat[ i * 2 + 1 ] = points[ i ][ 1 ];
			}
			gl.bindFramebuffer( gl.FRAMEBUFFER, this.fbo );
			gl.viewport( 0, 0, NPROBE, 1 );
			gl.disable( gl.DEPTH_TEST );
			gl.disable( gl.BLEND );
			gl.useProgram( this.prog );
			setUniforms( gl, this.prog, {
				uDisp: ocean.disp,
				uPatch: ocean.patchSizes,
				uCascadeCount: ocean.cascadeCount ?? 4,
				uProbe: flat,
				uHeightScale: p.heightScale, uHorizScale: p.horizScale,
				uSeaLevel: p.seaLevel ?? 0,
			} );
			this.blit.draw();
			gl.bindBuffer( gl.PIXEL_PACK_BUFFER, this.pbo );
			gl.readPixels( 0, 0, NPROBE, 1, gl.RGBA, gl.FLOAT, 0 );
			gl.bindBuffer( gl.PIXEL_PACK_BUFFER, null );
			this.fence = gl.fenceSync( gl.SYNC_GPU_COMMANDS_COMPLETE, 0 );
			gl.bindFramebuffer( gl.FRAMEBUFFER, null );
			// Put the viewport back. Nothing downstream re-asserts it -- the sea
			// render assumes the canvas viewport it left -- so without this the
			// next frame of ocean draws into four pixels in the corner.
			gl.viewport( 0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight );
		}

		// Smooth toward the last report. The reading is late and quantised to
		// frames; tracking it directly puts a stair-step into the hull.
		const k = 1 - Math.exp( - ( dt || 1 / 60 ) / 0.12 );
		for ( let i = 0; i < NPROBE; i ++ ) this.h[ i ] += ( this.target[ i ] - this.h[ i ] ) * k;

	}

}
