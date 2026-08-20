// Correct motion vectors for geometry whose world position is computed in the
// shader rather than by a model matrix.
//
// Why this file has to exist: three.js's built-in `velocity` node builds its
// motion vector from `positionLocal` and the object's model matrix —
//
//     clipCurrent  = projection * modelView * positionLocal
//
// — and it does that regardless of what the material's `positionNode` does. The
// GPU-driven path in this lab computes each instance's world position inside
// the vertex shader from a storage buffer, so `positionLocal` is just the
// unit icosahedron sitting at the origin. Feeding that to the built-in node
// gives every instance the motion of a single object at the world origin, and
// TRAA smears badly as a result.
//
// The fix is to compute velocity from the same world position the vertex stage
// actually used, against the previous frame's view-projection.
//
// The projection matrices here must be *unjittered*. TRAA jitters the camera
// via `setViewOffset`, and if that sub-pixel wobble leaked into the motion
// vectors the resolve would chase its own jitter instead of real motion.
// `update()` therefore drives a shadow camera that is never jittered.

import { Matrix4, PerspectiveCamera } from 'three/webgpu';
import { Fn, uniform, vec4 } from 'three/tsl';

export function createStaticVelocity( worldPositionNode ) {

	const currentViewProjection = uniform( new Matrix4() );
	const previousViewProjection = uniform( new Matrix4() );

	// Shadow camera: same pose and lens as the real one, but no view offset,
	// so its projection matrix is the clean one.
	const unjittered = new PerspectiveCamera();
	const _current = new Matrix4();

	let primed = false;

	const node = Fn( () => {

		const world = vec4( worldPositionNode, 1.0 );

		const current = currentViewProjection.mul( world );
		const previous = previousViewProjection.mul( world );

		// Same convention as three's VelocityNode: NDC delta, current minus
		// previous, so TRAA consumes it unchanged.
		return current.xy.div( current.w ).sub( previous.xy.div( previous.w ) );

	} )();

	function update( camera ) {

		// Roll last frame's matrix into the previous slot before recomputing.
		previousViewProjection.value.copy( _current );

		unjittered.fov = camera.fov;
		unjittered.aspect = camera.aspect;
		unjittered.near = camera.near;
		unjittered.far = camera.far;
		unjittered.zoom = camera.zoom;
		unjittered.filmGauge = camera.filmGauge;
		unjittered.filmOffset = camera.filmOffset;
		unjittered.clearViewOffset();
		unjittered.updateProjectionMatrix();

		_current.multiplyMatrices( unjittered.projectionMatrix, camera.matrixWorldInverse );

		// On the very first frame there is no history; make previous equal to
		// current so velocity is exactly zero rather than garbage.
		if ( primed === false ) {

			previousViewProjection.value.copy( _current );
			primed = true;

		}

		currentViewProjection.value.copy( _current );

	}

	return { node, update };

}
