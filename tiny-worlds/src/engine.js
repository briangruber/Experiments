// Renderer, camera, post chain, and the shared sky: one sun and one starfield
// that every world hangs in, because they are all in the same scene at once.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { rng, damp } from './noise.js';

export const SUN_POSITION = new THREE.Vector3(620, 420, 900);

const _v = new THREE.Vector3();

function glowTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,238,200,0.55)');
  g.addColorStop(0.6, 'rgba(255,196,120,0.14)');
  g.addColorStop(1.0, 'rgba(255,170,90,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
    });
    // Phones render this at 3x the pixels of a laptop and have a fraction of
    // the fill rate, so they get a lower ceiling and a smaller shadow map. Read
    // from the pointer rather than the width: a narrow desktop window is not a
    // phone, and a tablet in landscape is.
    this.mobile = matchMedia('(pointer: coarse)').matches;
    this.maxPixelRatio = this.mobile ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.maxPixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070a12);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.08, 6000);
    this.camera.position.set(0, 6, 22);

    this.hemi = new THREE.HemisphereLight(0x9fc8e8, 0x6b5a44, 0.85);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0d2, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.mobile ? 1024 : 2048, this.mobile ? 1024 : 2048);
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun, this.sun.target);

    // Moonlight. Each world keeps a real terminator — half of it is genuinely
    // night — but the night half has to stay playable, so it gets a cool fill
    // from the anti-sun direction rather than falling to black.
    this.fill = new THREE.DirectionalLight(0x7d93d8, 1.0);
    // The target has to live in the scene graph, or its matrixWorld never
    // updates and every world but the one at the origin gets lit from the
    // wrong side.
    this.scene.add(this.fill, this.fill.target);

    this.buildSky();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.3, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  buildSky() {
    const rand = rng(9001);
    const count = 2600;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const d = 2200 + rand() * 1400;
      pos[i * 3] = r * Math.cos(a) * d;
      pos[i * 3 + 1] = z * d;
      pos[i * 3 + 2] = r * Math.sin(a) * d;
      const warm = rand();
      c.setHSL(warm < 0.7 ? 0.58 + rand() * 0.08 : 0.08 + rand() * 0.06, 0.5, 0.55 + rand() * 0.4);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 5.5, sizeAttenuation: true, vertexColors: true, transparent: true,
      opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(38, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0xfff3d0 }),
    );
    sunMesh.position.copy(SUN_POSITION);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xffe0a0, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.9,
    }));
    halo.scale.setScalar(560);
    halo.position.copy(SUN_POSITION);
    this.scene.add(sunMesh, halo);
    this.sunMesh = sunMesh;
  }

  // Light is re-aimed at whichever world the keeper is standing on, so the
  // shadow map spends all of its resolution where it can be seen.
  focusWorld(planet) {
    const def = planet.def;
    const centre = planet.group.position;
    _v.copy(SUN_POSITION).sub(centre).normalize();

    this.sun.color.set(def.sun.color);
    this.sun.intensity = def.sun.intensity;
    this.sun.position.copy(centre).addScaledVector(_v, def.radius * 4);
    this.sun.target.position.copy(centre);
    this.sun.target.updateMatrixWorld();

    const s = def.radius * 1.65;
    const cam = this.sun.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    cam.near = def.radius * 1.2; cam.far = def.radius * 7;
    cam.updateProjectionMatrix();

    this.fill.position.copy(centre).addScaledVector(_v, -def.radius * 4);
    this.fill.target.position.copy(centre);
    this.fill.target.updateMatrixWorld();
    this.fill.color.set(def.dark ? 0x54407a : 0x869ade);
    this.fill.intensity = def.dark ? 0.22 : 1.35;

    this.hemi.color.set(def.ambient.sky);
    this.hemi.groundColor.set(def.ambient.ground);
    this.hemiTarget = def.ambient.intensity;
    this.scene.background.set(def.space);
    this.bloom.strength = def.dark ? 0.55 : 0.45;
  }

  update(dt) {
    if (this.hemiTarget !== undefined) this.hemi.intensity = damp(this.hemi.intensity, this.hemiTarget, 2.5, dt);
    this.stars.rotation.y += dt * 0.002;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() { this.composer.render(); }
}
