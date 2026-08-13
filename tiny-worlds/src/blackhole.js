// The black hole that hangs off Umbra. Three parts pretend to be one thing:
// a genuinely black sphere (the horizon), a tilted accretion disk with one
// side brighter than the other (doppler beaming, approximately and cheaply),
// and a screen-space lensing pass in engine.js that bends the image around
// it. The physics half — the pull on the keeper — lives in player.js; this
// file is only what you see.

import * as THREE from 'three';

const _v = new THREE.Vector3();

function ringTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.30, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,200,130,0)');
  g.addColorStop(0.42, 'rgba(255,214,150,0.85)');
  g.addColorStop(0.52, 'rgba(255,240,220,1)');
  g.addColorStop(0.62, 'rgba(255,190,110,0.5)');
  g.addColorStop(1.0, 'rgba(255,150,70,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class BlackHole {
  constructor(scene, def) {
    const bh = def.blackHole;
    this.radius = bh.radius;
    this.centre = new THREE.Vector3().fromArray(bh.dir).normalize()
      .multiplyScalar(bh.dist).add(new THREE.Vector3().fromArray(def.position));

    this.group = new THREE.Group();
    this.group.position.copy(this.centre);
    scene.add(this.group);

    // The horizon. MeshBasicMaterial in pure black is the one material the
    // lighting rig genuinely cannot touch.
    this.group.add(new THREE.Mesh(
      new THREE.SphereGeometry(bh.radius, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000 }),
    ));

    // Photon ring: a camera-facing sprite, so the bright rim survives from
    // every angle without any real light transport.
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.9,
    }));
    ring.scale.setScalar(bh.radius * 2.55);
    this.group.add(ring);
    this.ring = ring;

    // Accretion disk: an annulus, tilted, spinning, with the approaching side
    // hotter and brighter than the receding one.
    const disk = new THREE.RingGeometry(bh.radius * 1.35, bh.radius * 3.1, 72, 1);
    const pos = disk.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const hot = new THREE.Color(0xfff1d8);
    const cold = new THREE.Color(0xb84d18);
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(pos.getY(i), pos.getX(i));
      const beam = 0.5 + 0.5 * Math.cos(a);            // one side approaches
      const r = Math.hypot(pos.getX(i), pos.getY(i)) / (bh.radius * 3.1);
      col.copy(cold).lerp(hot, beam * 0.85).multiplyScalar((1.15 - r) * (0.35 + beam));
      cols[i * 3] = col.r; cols[i * 3 + 1] = col.g; cols[i * 3 + 2] = col.b;
    }
    disk.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.disk = new THREE.Mesh(disk, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.disk.rotation.x = Math.PI * 0.42;
    this.disk.rotation.y = 0.35;
    this.group.add(this.disk);

    // The disk is the lamp of this corner of space.
    this.light = new THREE.PointLight(0xffb46a, 65, 130, 1.7);
    this.group.add(this.light);
  }

  update(dt, time) {
    this.disk.rotation.z += dt * 0.55;
    const flicker = 0.85 + 0.15 * Math.sin(time * 5.1) * Math.sin(time * 2.3);
    this.ring.material.opacity = 0.75 + 0.2 * flicker;
    this.light.intensity = 60 + 12 * flicker;
  }

  // Screen-space position and radius for the lens pass. Returns null when the
  // hole is behind the camera or too far away to matter.
  project(camera, maxDist = 520) {
    _v.copy(this.centre);
    const dist = _v.distanceTo(camera.position);
    if (dist > maxDist) return null;
    _v.project(camera);
    if (_v.z > 1 || _v.z < -1) return null;
    const x = (_v.x + 1) / 2, y = (_v.y + 1) / 2;
    if (x < -0.4 || x > 1.4 || y < -0.4 || y > 1.4) return null;
    // Angular size, as a fraction of the viewport's half-height.
    const r = this.radius / (dist * Math.tan((camera.fov * Math.PI / 180) / 2));
    return { x, y, r: r * 0.5, dist };
  }
}
