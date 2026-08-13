// The way out of a world you have woken.
//
// It opens where you caught the last spark rather than back at the beacon,
// because that is where you are standing when the world blooms — the reward
// should not begin with a walk back across the map. Walk into it and it takes
// you; there is nothing to press.

import * as THREE from 'three';
import { clamp } from './noise.js';

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class Portal {
  constructor(planet, dir, { color = 0xbfe8ff, facing = null } = {}) {
    this.planet = planet;
    this.dir = dir.clone().normalize();
    this.radius = 1.5 * (planet.def.radius / 11);
    this.open = 0;
    this.spin = 0;
    this.emit = 0;
    this.color = new THREE.Color(color);

    this.group = new THREE.Group();
    planet.group.add(this.group);

    const rimMat = new THREE.MeshStandardMaterial({
      color: this.color, emissive: this.color, emissiveIntensity: 2.4,
      roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0,
    });
    this.rim = new THREE.Mesh(
      new THREE.TorusGeometry(this.radius, this.radius * 0.11, 14, 48), rimMat,
    );

    // The mouth: a spiral pulled inward, so it reads as somewhere to step into
    // rather than a disc painted on the air.
    this.mouthUniforms = { uTime: { value: 0 }, uOpen: { value: 0 }, uColor: { value: this.color } };
    this.mouth = new THREE.Mesh(
      new THREE.CircleGeometry(this.radius * 0.96, 48),
      new THREE.ShaderMaterial({
        uniforms: this.mouthUniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv * 2.0 - 1.0;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform float uTime; uniform float uOpen; uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            float r = length(vUv);
            if (r > 1.0) discard;
            float a = atan(vUv.y, vUv.x);
            // Arms wound into the centre, turning slowly.
            float arms = sin(a * 3.0 + 1.0 / max(r, 0.12) * 2.2 - uTime * 2.4);
            float swirl = smoothstep(0.1, 0.9, arms * 0.5 + 0.5);
            float core = smoothstep(0.85, 0.0, r);
            float edge = smoothstep(1.0, 0.78, r);
            float v = (swirl * 0.55 + core * 0.9) * edge * uOpen;
            gl_FragColor = vec4(uColor * (0.6 + core * 1.4), v);
          }`,
      }),
    );

    this.light = new THREE.PointLight(this.color, 0, 14, 1.8);
    this.group.add(this.rim, this.mouth, this.light);

    // Stand it upright on the surface, its face turned along the surface so you
    // walk through it rather than onto it.
    planet.normalAt(this.dir, _v);
    _f.copy(facing ?? planet.landingDir).addScaledVector(_v, -(facing ?? planet.landingDir).dot(_v));
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1).cross(_v);
    _f.normalize();
    _r.crossVectors(_v, _f).normalize();
    // Local +Z is the ring's axis, so the face looks along `_f`.
    _m.makeBasis(_r, _v, _f);
    this.group.quaternion.setFromRotationMatrix(_m);
    this.group.position.copy(this.dir).multiplyScalar(planet.groundRadius(this.dir) + this.radius * 0.92);
    this.centre = this.group.position.clone();
  }

  // `ctx` gives us the shared particle pool; the sparks spiral in toward the
  // mouth, which is the clearest signal that it is a way through.
  update(dt, time, ctx) {
    this.open = Math.min(1, this.open + dt * 0.9);
    this.spin += dt * 0.6;
    const pulse = 0.9 + 0.1 * Math.sin(time * 2.6);

    this.rim.material.opacity = this.open;
    this.rim.material.emissiveIntensity = 2.4 * pulse * this.open;
    this.rim.rotation.z = this.spin;
    this.mouthUniforms.uTime.value = time;
    this.mouthUniforms.uOpen.value = this.open * pulse;
    this.light.intensity = 12 * this.open * pulse;

    if (!ctx?.particles || !ctx.active) return;
    this.emit += dt;
    while (this.emit > 0.05) {
      this.emit -= 0.05;
      const a = Math.random() * Math.PI * 2;
      const rr = this.radius * (1.15 + Math.random() * 0.5);
      _v.set(Math.cos(a) * rr, Math.sin(a) * rr, (Math.random() - 0.5) * 0.4);
      this.group.localToWorld(_v);
      this.planet.group.localToWorld(_f.copy(this.centre));
      // Drift toward the mouth rather than away from it.
      _r.copy(_f).sub(_v).multiplyScalar(1.6);
      ctx.particles.spawn(_v, _r, this.color, 0.34, 0.9, { drag: 0.3 });
    }
  }

  // True once the keeper has stepped into the mouth.
  reached(localPos) {
    return this.open > 0.5 && localPos.distanceTo(this.centre) < this.radius * 1.15;
  }

  dispose() {
    this.planet.group.remove(this.group);
    this.rim.geometry.dispose();
    this.rim.material.dispose();
    this.mouth.geometry.dispose();
    this.mouth.material.dispose();
  }
}
