// Builds the scene: shell geometry, dressing, and every light in the level.
//
// The lighting is the game. There is effectively no ambient term — what the
// player can see is what the torch is pointed at, plus a handful of failing
// practicals that exist to give the eye something to walk toward. That is a
// deliberate constraint rather than an aesthetic one: if the room were lit,
// the mannequins would not work, because you would never lose sight of one.

import * as THREE from 'three';
import { CEILING, TILE } from './level.js';
import { createGlowTexture, createShellMaterials } from './materials.js';

/** Practical lights placed around the level. Kept low — each one is a shadow
 *  caster the torch has to share a budget with. */
const PRACTICAL_COUNT = 7;

// three uses physical light units: intensity is candela and illuminance falls
// off as 1/d². These are the values that make a concrete corridor readable at
// four metres without washing out at one, and they are far larger than the
// pre-r155 numbers most three code carries around.
const TORCH_CANDELA = 46;
const PRACTICAL_CANDELA = 9.5;

export class World {
  constructor(level, rng, quality = {}) {
    this.level = level;
    this.rng = rng.fork('world');
    this.quality = quality;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    // Exponential fog is what stops the corridors reading as infinite, and
    // what hides the far wall of a long sight-line so the creature can be
    // heard before it can be seen.
    // Denser fog on weaker devices does double duty: it hides the shorter
    // draw distance and it buys back fill rate by darkening what is left.
    this.scene.fog = new THREE.FogExp2(0x05070a, quality.fogDensity ?? 0.075);

    this.practicals = [];
    this.props = [];
    this._flicker = [];
    /** GPU resources this world created, and is therefore allowed to free. */
    this._owned = [];
  }

  build(assets) {
    this.#buildShell();
    this.#buildTorch();
    this.#buildPracticals(assets);
    this.#dress(assets);
    return this;
  }

  // ----------------------------------------------------------------- shell

  #buildShell() {
    const geo = this.level.build();
    const mats = createShellMaterials(1);
    this.shellMaterials = mats;
    this.#own(geo.floor, geo.ceiling, geo.walls, mats.floor, mats.walls, mats.ceiling);
    for (const m of [mats.floor, mats.walls, mats.ceiling]) {
      this.#own(m.map, m.normalMap, m.roughnessMap);
    }

    const floor = new THREE.Mesh(geo.floor, mats.floor);
    floor.receiveShadow = true;

    const ceiling = new THREE.Mesh(geo.ceiling, mats.ceiling);
    ceiling.receiveShadow = true;

    const walls = new THREE.Mesh(geo.walls, mats.walls);
    walls.receiveShadow = true;
    walls.castShadow = true;

    for (const mesh of [floor, ceiling, walls]) {
      // The shell is static and enormous; skipping the per-frame matrix
      // recompute is free and the culler still has the bounding sphere.
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
    }

    // A trace of bounce so unlit surfaces are near-black rather than pure
    // black. Pure black reads as a hole in the world, not as darkness.
    const ambient = new THREE.AmbientLight(0x2a3948, 0.055);
    this.scene.add(ambient);
    this.ambient = ambient;

    // Faint cold key from above, so silhouettes exist even with the torch off.
    const moon = new THREE.HemisphereLight(0x10202e, 0x05070a, 0.09);
    this.scene.add(moon);
  }

  // ----------------------------------------------------------------- torch

  /**
   * The torch: a shadow-casting spot, plus a cone of additive geometry
   * standing in for volumetric scattering.
   *
   * A true raymarch through the shadow map would be more correct, but this is
   * a fragment-bound scene already and the cone is convincing for the same
   * reason a fog machine is: the eye is judging the shaft, not the physics.
   * The cone is rendered without depth write and back-faces only, so props
   * inside the beam still occlude it plausibly.
   */
  #buildTorch() {
    const far = this.quality.shadowDistance ?? 30;
    const shadowSize = this.quality.shadowMapSize ?? 1024;
    const torch = new THREE.SpotLight(0xffe9c4, 0, 30, Math.PI * 0.19, 0.46, 1.25);
    torch.castShadow = true;
    torch.shadow.mapSize.set(shadowSize, shadowSize);
    torch.shadow.camera.near = 0.15;
    torch.shadow.camera.far = far;
    torch.shadow.bias = -0.0016;
    torch.shadow.normalBias = 0.022;
    // The light and its target are parented to the camera holder so the beam
    // is rigid with the view; the game moves the holder, not the light.
    torch.position.set(0, 0, 0);

    const holder = new THREE.Group();
    holder.add(torch);
    holder.add(torch.target);
    torch.target.position.set(0, 0, -1);
    this.scene.add(holder);

    const coneLength = 11;
    const coneGeo = new THREE.ConeGeometry(coneLength * 0.3, coneLength, 24, 12, true);
    // Cone points +Y by default; stand it up along -Z and push the apex to
    // the origin so it grows out of the lens.
    coneGeo.translate(0, -coneLength / 2, 0);
    coneGeo.rotateX(-Math.PI / 2);

    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xffe4bb,
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      fog: true,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.renderOrder = 2;
    this.#own(coneGeo, coneMat);
    holder.add(cone);

    // Dust in the beam. Motes are parked in a fixed cloud in front of the
    // lens and re-randomised as they fall out of it, so a handful of sprites
    // reads as a whole room's worth of air.
    const moteCount = this.quality.motes ?? 130;
    const positions = new Float32Array(moteCount * 3);
    for (let i = 0; i < moteCount; i++) {
      positions[i * 3] = this.rng.float(-1.6, 1.6);
      positions[i * 3 + 1] = this.rng.float(-1.4, 1.4);
      positions[i * 3 + 2] = this.rng.float(-9, -0.6);
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const moteTexture = this.#own(createGlowTexture());
    const motes = new THREE.Points(
      moteGeo,
      new THREE.PointsMaterial({
        size: 0.035,
        map: moteTexture,
        color: 0xfff0d8,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    holder.add(motes);
    this.#own(moteGeo, motes.material);

    this.torch = torch;
    this._torchLevel = 0;
    this.torchHolder = holder;
    this.torchCone = cone;
    this.motes = motes;
    this._moteDrift = new Float32Array(moteCount).map(() => this.rng.float(0.02, 0.09));
  }

  /** Follow the camera, and animate intensity/flicker from battery level. */
  updateTorch(dt, camera, { on, battery, boost = 1 }) {
    const holder = this.torchHolder;
    holder.position.copy(camera.position);
    holder.quaternion.copy(camera.quaternion);

    // A dying battery does not dim smoothly, it stutters. The flicker only
    // starts below a quarter, which makes the gauge worth watching.
    const dying = battery < 0.25 ? (0.25 - battery) / 0.25 : 0;
    const stutter = dying > 0
      ? 1 - dying * (0.55 + 0.45 * Math.sin(performance.now() * 0.019)) * (this.rng.bool(0.06) ? 1 : 0.35)
      : 1;

    const target = on ? (0.45 + battery * 0.55) * stutter * boost : 0;
    this._torchLevel += (target - this._torchLevel) * Math.min(1, dt * 14);
    this.torch.intensity = this._torchLevel * TORCH_CANDELA;
    // Cone and motes track the normalised level, not the candela figure, so
    // retuning the light does not silently blow out the volumetrics.
    this.torchCone.material.opacity = this._torchLevel * 0.075;
    this.motes.material.opacity = this._torchLevel * 0.42;
    this.motes.visible = this._torchLevel > 0.02;

    // Drift the motes downward and recycle them through the near plane.
    if (this.motes.visible) {
      const pos = this.motes.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) - this._moteDrift[i] * dt;
        if (y < -1.4) y = 1.4;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ practicals

  /**
   * Failing ceiling lamps. Each is a Tripo lamp mesh, a small point light and
   * a glow sprite; the light flickers on an irregular schedule so no two are
   * ever in phase.
   */
  #buildPracticals(assets) {
    const hasLamp = assets.has('lamp');
    const rooms = this.rng.shuffle([...this.level.rooms]);

    const wanted = this.quality.practicals ?? PRACTICAL_COUNT;
    for (let i = 0; i < Math.min(wanted, rooms.length); i++) {
      const room = rooms[i];
      const at = this.level.tileToWorld(room.cx, room.cy, CEILING - 0.16);

      const light = new THREE.PointLight(0xffd9a0, PRACTICAL_CANDELA, 11, 1.9);
      light.position.copy(at);
      light.position.y -= 0.35;
      // Practicals do not cast shadows: seven shadow-casting points would
      // cost more than the entire rest of the frame, and their job is to give
      // the eye a landmark, not to define form. The torch does form.
      light.castShadow = false;
      this.scene.add(light);

      if (hasLamp) {
        const lamp = assets.instance('lamp');
        lamp.position.copy(at);
        // The lamp asset is modelled hanging, so its origin is its base.
        lamp.position.y -= lamp.userData.height;
        lamp.castShadow = false;
        this.scene.add(lamp);
      }

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.#own(createGlowTexture()),
          color: 0xffd9a0,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: true,
        }),
      );
      glow.scale.setScalar(1.1);
      glow.position.copy(light.position);
      this.scene.add(glow);
      this.#own(glow.material);

      this.practicals.push({ light, glow, base: PRACTICAL_CANDELA, room });
      this._flicker.push({
        next: this.rng.float(0, 6),
        level: 1,
        // Some fixtures are simply worse than others.
        instability: this.rng.float(0.15, 1),
      });
    }
  }

  updatePracticals(dt, tension = 0) {
    for (let i = 0; i < this.practicals.length; i++) {
      const p = this.practicals[i];
      const f = this._flicker[i];

      f.next -= dt;
      if (f.next <= 0) {
        // Bursts of flicker, not continuous noise: a lamp is either behaving
        // or having an episode. Tension shortens the gaps between episodes.
        const settling = f.level < 0.6;
        f.level = settling ? this.rng.float(0.75, 1) : this.rng.float(0.05, 0.5);
        f.next = settling
          ? this.rng.float(0.8, 5.5) * (1 - tension * 0.55)
          : this.rng.float(0.02, 0.16) * f.instability;
      }

      const want = p.base * f.level;
      p.light.intensity += (want - p.light.intensity) * Math.min(1, dt * 22);
      const level = p.light.intensity / p.base;
      p.glow.material.opacity = 0.1 + level * 0.5;
      p.glow.scale.setScalar(0.7 + level * 0.55);
    }
  }

  /** Kill every practical for `seconds`. The director's blackout. */
  blackout(seconds) {
    for (let i = 0; i < this._flicker.length; i++) {
      this._flicker[i].level = 0;
      this._flicker[i].next = seconds + this.rng.float(0, 0.6);
      this.practicals[i].light.intensity = 0;
    }
  }

  // -------------------------------------------------------------- dressing

  /**
   * Scatter props.
   *
   * Large items hug walls (they are furniture, and furniture goes against
   * walls); small items sit anywhere. The rule matters for readability more
   * than for realism — a corridor with clear middle ground is a corridor the
   * player can run down, and every prop in the middle of one is a place the
   * player will get stuck while something is chasing them.
   */
  #dress(assets) {
    const large = assets.byTag('large');
    const medium = assets.byTag('medium');
    const small = assets.byTag('small');
    const wallProps = assets.byTag('wall');

    const wallTiles = this.rng.shuffle(this.level.wallTiles());
    const openTiles = this.rng.shuffle(this.level.openTiles());
    const used = new Set();
    const keyOf = (t) => `${t.tx},${t.ty}`;

    const place = (keys, tile, { hugWall, yaw }) => {
      if (!keys.length || !tile || used.has(keyOf(tile))) return false;
      used.add(keyOf(tile));

      const object = assets.instance(this.rng.pick(keys));
      const p = this.level.tileToWorld(tile.tx, tile.ty);
      if (hugWall) {
        // Push it back against the wall it was chosen for.
        const facing = this.level.wallFacing(tile.tx, tile.ty);
        const depth = TILE / 2 - object.userData.footprint.y / 2 - 0.06;
        p.x -= Math.sin(facing) * depth;
        p.z -= Math.cos(facing) * depth;
        object.rotation.y = facing + this.rng.float(-0.14, 0.14);
      } else {
        object.rotation.y = yaw ?? this.rng.float(0, Math.PI * 2);
        p.x += this.rng.float(-0.7, 0.7);
        p.z += this.rng.float(-0.7, 0.7);
      }
      object.position.copy(p);
      this.scene.add(object);
      this.props.push(object);
      return true;
    };

    // Keep the spawn room clear enough to get oriented in.
    const spawn = this.level.startRoom;
    const nearSpawn = (t) => Math.abs(t.tx - spawn.cx) < 3 && Math.abs(t.ty - spawn.cy) < 3;

    let wallCursor = 0;
    const nextWallTile = () => {
      while (wallCursor < wallTiles.length) {
        const t = wallTiles[wallCursor++];
        if (!used.has(keyOf(t)) && !nearSpawn(t)) return t;
      }
      return null;
    };

    const counts = this.quality.dressing ?? { large: 22, wall: 10, medium: 16, small: 12 };
    for (let i = 0; i < counts.large; i++) place(large, nextWallTile(), { hugWall: true });
    for (let i = 0; i < counts.wall; i++) place(wallProps, nextWallTile(), { hugWall: true });
    for (let i = 0; i < counts.medium; i++) place(medium, nextWallTile(), { hugWall: true });

    let openCursor = 0;
    for (let i = 0; i < counts.small; i++) {
      while (openCursor < openTiles.length && (used.has(keyOf(openTiles[openCursor])) || nearSpawn(openTiles[openCursor]))) {
        openCursor++;
      }
      place(small, openTiles[openCursor], { hugWall: false });
    }
  }

  /**
   * Release only what this world built.
   *
   * Deliberately *not* a traverse-and-dispose-everything. Props are clones
   * from the AssetLibrary and share their geometry and materials with the
   * library and with each other, so disposing them here would free resources
   * the next run still expects to exist — "run it back" would come up with
   * missing meshes and no error to explain it. The library outlives runs; the
   * shell, the torch and the practicals do not, and those are tracked in
   * `_owned` as they are created.
   */
  dispose() {
    for (const resource of this._owned) resource.dispose();
    this._owned.length = 0;
    this.scene.clear();
    this.props.length = 0;
    this.practicals.length = 0;
  }

  /** Register a geometry, material or texture this world owns. */
  #own(...resources) {
    this._owned.push(...resources);
    return resources[0];
  }
}
