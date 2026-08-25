// The feather-and-materials pass the bench verdict routed the remaining cast
// budget into: Rosalinda, Valentina, Don Gallo and Pollito stay procedural, so
// the procedural birds get richer plumage and a better response to the night
// grade, and the two styles sit together on screen. Everything here is
// additive on a rig makeChicken already built — no channel, no anchor and no
// silhouette the director or the camera depends on moves.

import * as THREE from '../../vendor/three/three.module.min.js';
import { featherGeometry } from '../../engine/chicken.js';
import { TAU, lerp, deg, mulberry32 } from '../../engine/util.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

// Jitter the per-instance colour of an InstancedMesh around its material's
// own colour: value and warmth vary feather to feather, which is what breaks
// the single-albedo "vinyl toy" read under a raking key.
function variegate(inst, rng, spread = 0.16) {
  if (!inst || !inst.count) return;
  const base = new THREE.Color(inst.material.color);
  for (let i = 0; i < inst.count; i++) {
    const v = 1 + (rng() - 0.5) * 2 * spread;
    const warm = (rng() - 0.5) * 0.07;
    _c.copy(base).multiplyScalar(v);
    _c.r = Math.min(1, _c.r * (1 + warm));
    _c.b = Math.min(1, _c.b * (1 - warm));
    inst.setColorAt(i, _c);
  }
  inst.instanceColor.needsUpdate = true;
  // Instance colours multiply the material colour, and the jittered colours
  // above are already absolute — so this mesh gets its own material, white.
  inst.material = inst.material.clone();
  inst.material.color.set(0xffffff);
}

// A saddle of feathers over the breast and shoulders — the region every
// medium shot looks at and the plain lathe body left smooth.
function breastFeathers(rig, rng) {
  const spec = rig.spec, s = rig.size;
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(spec.accent ?? spec.plumage).multiplyScalar(1.06),
    roughness: 0.72, metalness: spec.sheen ? 0.14 : 0.04,
  });
  const n = 22;
  const inst = new THREE.InstancedMesh(featherGeometry(0.095 * s, 0.034 * s, 0.55, 4), mat, n);
  inst.castShadow = true;
  const girth = rig.girth, bodyLen = rig.bodyLen;
  for (let i = 0; i < n; i++) {
    const u = rng(), v = rng();
    const zt = lerp(0.08, 0.42, u);                  // breast half of the hull
    const ang = (v - 0.5) * TAU * 0.42 - Math.PI / 2 + Math.PI; // wrapped low around the front
    const rad = girth * (1.02 - zt * 0.55);
    _p.set(Math.cos(ang) * rad * 0.9, Math.sin(ang) * rad * 0.85 + 0.01 * s, zt * bodyLen);
    _e.set(deg(118) + (rng() - 0.5) * 0.45, 0, ang + Math.PI / 2 + (rng() - 0.5) * 0.5, 'ZYX');
    _q.setFromEuler(_e);
    const k = 0.7 + rng() * 0.55;
    _s.set(k, k * (0.85 + rng() * 0.4), k);
    inst.setMatrixAt(i, _m.compose(_p, _q, _s));
    _c.set(0xffffff).multiplyScalar(0.86 + rng() * 0.3);
    inst.setColorAt(i, _c);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor.needsUpdate = true;
  rig.body.add(inst);
  return inst;
}

// One procedural bird, refined in place. Deterministic per character: the
// seed is the spec's own.
export function refinePlumage(rig) {
  const spec = rig.spec;
  const rng = mulberry32((spec.seed ?? 7) * 131 + 5);

  // Feather scales and hackles stop being one flat colour.
  variegate(rig.ruff, rng, 0.18);
  variegate(rig.hackle, rng, 0.14);

  // The body reads as feathers, not moulded plastic: a touch rougher, and for
  // the sheened birds the iridescence concentrates instead of glazing all of
  // it — highlights sharpen where the light rakes, the shadow side stays soft.
  for (const m of rig.materials) {
    if (!m || !m.color) continue;
    if (m === rig.bodyMesh.material) {
      m.roughness = spec.sheen ? 0.5 : 0.74;
      if (spec.sheen) m.metalness = 0.2;
    }
  }

  // Combs and wattles: bare skin, not feather. Wet-skin gloss and a faint
  // warm emissive floor so the crown still reads when the grade goes near
  // black — the amount is well under the key, invisible in a lit shot.
  const combMat = rig.combMesh.material;
  combMat.roughness = 0.32;
  combMat.emissive = new THREE.Color(spec.comb).multiplyScalar(0.05);

  breastFeathers(rig, rng);

  return rig;
}
