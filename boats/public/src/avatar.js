import * as THREE from 'three';
import { islandHeight } from './town.js';

// You start the game standing on a dock, not sitting in a boat. This is the
// small amount of character controller that needs -- walk the island and the
// planks, and know when you are at the rail with water in front of you.

const mat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...extra });

function buildPerson({ coat = 0x9c4b3f, trousers = 0x3a4a57 } = {}) {
  const g = new THREE.Group();

  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.78, 6), mat(trousers));
  legL.position.set(0, 0.39, 0.11);
  const legR = legL.clone();
  legR.position.z = -0.11;

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.72, 7), mat(coat));
  body.position.y = 1.1;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.1, 7), mat(0xe4dcc6));
  collar.position.y = 1.47;

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 7), mat(0xc79f7c));
  head.position.y = 1.62;
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.2, 8), mat(0x2b3b47));
  hat.position.y = 1.76;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 9), mat(0x2b3b47));
  brim.position.y = 1.68;

  // Arms are separate groups so the rod can be held in one of them.
  const armL = new THREE.Group();
  const armLimb = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.065, 0.62, 5), mat(coat));
  armLimb.position.y = -0.31;
  armL.add(armLimb);
  armL.position.set(0, 1.38, 0.28);
  const armR = armL.clone();
  armR.position.z = -0.28;

  g.add(legL, legR, body, collar, head, hat, brim, armL, armR);
  g.userData = { legL, legR, armL, armR, head };
  return g;
}

/** A fishing rod, held when it is wanted and stowed when it is not. */
function buildRod() {
  const rod = new THREE.Group();
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.32, 6), mat(0x5a4632));
  butt.position.y = 0.16;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.032, 2.5, 6), mat(0x7d5f3c));
  shaft.position.y = 1.5;
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 10), mat(0x8a8f94, { metalness: 0.6, roughness: 0.4 }));
  reel.rotation.x = Math.PI / 2;
  reel.position.set(0, 0.36, 0.1);
  rod.add(butt, shaft, reel);
  rod.userData.tip = new THREE.Vector3(0, 2.72, 0);
  return rod;
}

export class Avatar {
  constructor(scene, town) {
    this.town = town;
    this.group = new THREE.Group();
    this.person = buildPerson();
    this.rod = buildRod();
    this.rod.position.set(0.1, 1.05, -0.34);
    this.rod.rotation.set(-0.5, 0, -0.28);
    this.rod.visible = false;
    this.person.add(this.rod);
    this.group.add(this.person);
    scene.add(this.group);

    this.pos = new THREE.Vector3(0, 2.05, 62);
    this.heading = 0;          // facing, radians in the XZ plane
    this.speed = 0;
    this.bob = 0;
    this.visible = true;
    this.rodBend = 0;
  }

  /** Standing height at a world position: island ground, or a plank over it. */
  groundAt(x, z) {
    let y = islandHeight(x, z);
    for (const d of this.town.decks) {
      if (Math.abs(x - d.x) <= d.w && Math.abs(z - d.z) <= d.d && d.top > y) y = d.top;
    }
    return y;
  }

  /** Can a person stand here, or is it sea? */
  standable(x, z) {
    return this.groundAt(x, z) > 0.35;
  }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
  }

  showRod(on) { this.rod.visible = on; }

  /** World position of the rod tip, where the line leaves. */
  rodTip(out = new THREE.Vector3()) {
    this.rod.updateWorldMatrix(true, false);
    return out.copy(this.rod.userData.tip).applyMatrix4(this.rod.matrixWorld);
  }

  /**
   * @param {{x:number,y:number}} move  -1..1 strafe / forward, camera relative
   * @param {number} camYaw             where the camera is looking
   */
  update(dt, move, camYaw, { running = false } = {}) {
    const mag = Math.min(1, Math.hypot(move.x, move.y));
    const top = running ? 6.4 : 3.4;

    if (mag > 0.02) {
      // Move relative to the camera, which is what every player expects.
      const angle = Math.atan2(move.x, move.y) + camYaw;
      const wantX = Math.sin(angle), wantZ = Math.cos(angle);
      this.speed += (top * mag - this.speed) * Math.min(1, dt * 6);
      const step = this.speed * dt;
      const nx = this.pos.x + wantX * step;
      const nz = this.pos.z + wantZ * step;
      // Slide along whichever axis is still land rather than sticking on edges.
      if (this.standable(nx, nz)) { this.pos.x = nx; this.pos.z = nz; }
      else if (this.standable(nx, this.pos.z)) this.pos.x = nx;
      else if (this.standable(this.pos.x, nz)) this.pos.z = nz;
      else this.speed *= 0.3;

      const want = Math.atan2(wantX, wantZ);
      let d = ((want - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this.heading += d * Math.min(1, dt * 12);
    } else {
      this.speed *= Math.pow(0.02, dt);
    }

    const ground = this.groundAt(this.pos.x, this.pos.z);
    this.pos.y += (ground - this.pos.y) * Math.min(1, dt * 14);

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.heading;

    // Walk cycle: legs swing, arms counter-swing, body rises on each step.
    const gait = Math.min(1, this.speed / top);
    this.bob += dt * this.speed * 2.4;
    const swing = Math.sin(this.bob) * 0.5 * gait;
    const { legL, legR, armL, armR } = this.person.userData;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.7;
    armR.rotation.x = swing * 0.7;
    this.person.position.y = Math.abs(Math.sin(this.bob)) * 0.06 * gait;

    // When the rod is out, both hands come up to hold it.
    if (this.rod.visible) {
      armR.rotation.x = -0.9 - this.rodBend * 0.5;
      armL.rotation.x = -0.7 - this.rodBend * 0.3;
      this.rod.rotation.x = -0.5 - this.rodBend * 0.8;
    }
  }

  /** 0 = slack, 1 = doubled over. Drives the rod and the arms. */
  setRodBend(v) { this.rodBend = Math.max(0, Math.min(1, v)); }

  faceTowards(x, z) {
    this.heading = Math.atan2(x - this.pos.x, z - this.pos.z);
  }
}
