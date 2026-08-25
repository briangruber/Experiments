// The wake field.
//
// Everything the boat leaves behind is baked, every frame, into one top-down
// float texture that follows the boat:
//
//   R = foam coverage       G = surface displacement (m)
//   B = swell flattening    A = (spare)
//
// The ocean shader then samples that texture — so the wake composites with the
// water with no seams, and none of the wake maths lives in the ocean shader.
//
// The wake itself is a ribbon mesh laid along the boat's recent path. Each
// vertex carries how far astern it is (arc), how far off the centreline (lat),
// and how old it is (age); the ribbon's fragment shader draws the whole wake
// procedurally from those three numbers. Because nothing accumulates between
// frames, changing any parameter re-draws the *entire* wake instantly — which
// is the whole point of the prototype.

import * as THREE from 'three';
import { get } from './params.js';
import { NOISE_GLSL } from './noise.js';

const MAX_SAMPLES = 640;   // path history points
const LAT_SEG = 20;        // lateral divisions of the ribbon
const STEP = 1.4;          // metres between path samples


const RIBBON_VERT = /* glsl */`
  attribute float aArc;
  attribute float aLat;
  attribute float aAge;
  attribute float aU;
  attribute vec2 aTan;
  varying float vArc; varying float vLat; varying float vAge; varying float vU;
  varying vec2 vWorld; varying vec2 vTan;
  void main(){
    vArc = aArc; vLat = aLat; vAge = aAge; vU = aU; vTan = aTan;
    vWorld = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIBBON_FRAG = /* glsl */`
  precision highp float;
  varying float vArc; varying float vLat; varying float vAge; varying float vU;
  varying vec2 vWorld; varying vec2 vTan;

  uniform float uMaxArc;
  uniform float uBeam, uHullLen;
  uniform float uArmTan, uArmW0, uArmWGrow, uArmFoam, uArmHeight, uInnerBias, uFadeStart, uFadeLen;
  uniform float uRim, uRimW, uNearBoost, uNearLen, uCarve;
  uniform float uFeatSpace, uFeatGrow, uFeatLean, uFeatDepth, uFeatJitter, uFeatSharp;
  uniform float uWashW, uWashWGrow, uWashFoam, uWashLen, uWashTail, uWashDepth;
  uniform float uTransAmp, uTransLen, uTransDecay, uFlatten;
  uniform float uFoamScale, uFoamContrast, uBreakup, uFoamLife, uDissolve;
  uniform float uLace, uLaceAmt, uSoftness;
  uniform float uBubPlume, uBubW, uBubSpread, uBubLen, uBubArms, uBubLife, uBubMottle;

  ${NOISE_GLSL}

  void main(){
    float arc = max(vArc, 0.0);
    float d   = vLat;
    float ad  = abs(d);
    float age = vAge;

    // Ribbon edge: never let the mesh boundary show as a hard line.
    float edge = 1.0 - smoothstep(0.80, 1.0, abs(vU));
    if (edge <= 0.0) discard;

    // ---------------------------------------------------------------- arms --
    // The V of spray sheets, springing from the bow and opening at a fixed
    // half-angle. The outer edge is a hard bright line; the inner edge is soft
    // and combed — that asymmetry is most of the read.
    float wander = (fbm(vec2(arc * 0.018, sign(d) * 3.7)) - 0.5) * (1.0 + arc * 0.045);
    float armC = uBeam * 0.5 + arc * uArmTan + wander;
    float armW = max(uArmW0 + arc * uArmWGrow, 0.05);
    float x = (ad - armC) / armW;
    float xb = (x < 0.0) ? x / (1.0 + uInnerBias * 2.6) : x;
    float armG = exp(-xb * xb * (x < 0.0 ? 1.7 : 3.4));
    float armFade = 1.0 - smoothstep(uFadeStart, uFadeStart + uFadeLen, arc);

    // Feathering: periodic crests leaning back off the arm axis, stretching out
    // as the wake ages.
    float sp = max(uFeatSpace + arc * uFeatGrow, 0.1);
    float jit = (fbm(vWorld * 0.09) - 0.5) * uFeatJitter;
    float phase = (arc + (ad - armC) * uFeatLean) / sp + jit;
    float f = pow(0.5 + 0.5 * sin(6.28318 * phase), uFeatSharp);
    float inner = smoothstep(0.25, -1.30, x);          // 0 outboard, 1 inboard
    float comb = mix(1.0, f, uFeatDepth * inner);

    // The leading edge of the spray sheet is a hard bright line; without it the
    // arm reads as a soft smudge rather than as breaking water.
    float rimD = (ad - (armC + armW * 0.85)) / max(uRimW, 0.02);
    float rim = exp(-rimD * rimD) * uRim
              * mix(0.35, 1.0, comb)                       // broken by the comb
              * (0.45 + 0.85 * fbm(vWorld * 0.55))         // and by the water itself
              * smoothstep(4.0, 26.0, arc);                // only once the sheet thins

    // Close astern the whole wake is a dense unbroken mass; the lace-like
    // structure only emerges once it has spread and started to die.
    float near = 1.0 + uNearBoost * exp(-arc / max(uNearLen, 1.0));

    float armFoam = (armG * comb + rim) * uArmFoam * armFade * near;
    float armH    = (armG * mix(0.65, 1.0, comb) + rim * 0.5) * uArmHeight * armFade;

    // ------------------------------------------------------------ prop wash --
    // Turbulent water dragged off the transom: brightest foam in the wake and
    // the shortest-lived, trailing off into a thin centreline streak.
    float astern = smoothstep(uHullLen * 0.55, uHullLen * 1.05, arc);
    float ww = max(uWashW + arc * uWashWGrow, 0.05);
    float wg = exp(-(d / ww) * (d / ww));
    float washFoam = astern * wg * (uWashFoam * exp(-arc / uWashLen) + uWashTail) * near;
    float washH   = -astern * wg * uWashDepth * exp(-arc / (uWashLen * 1.6));

    // ------------------------------------------------------- inside the V ----
    // Flattened water carrying the transverse (following) wave train. Crests
    // bow backwards towards the arms rather than running straight across.
    float insideV = 1.0 - smoothstep(armC * 0.70, armC * 1.02, ad);
    float tPhase = (arc + ad * ad * 0.016) / max(uTransLen, 0.5);
    float trans = sin(6.28318 * tPhase) * exp(-arc / uTransDecay) * uTransAmp * insideV;

    // ------------------------------------------------------------ foam look --
    // Two textures, both locked to the water rather than to the boat:
    //  · a reticulated bubble raft (open cells with bright walls), and
    //  · streaks stretched along the direction the water was thrown, which is
    //    the local path tangent frozen in at birth.
    vec2 nrm = vec2(-vTan.y, vTan.x);
    vec2 flow = vec2(dot(vWorld, vTan), dot(vWorld, nrm));
    float raft   = lattice(vWorld * uFoamScale, 0.13);
    float streak = fbm(flow * uFoamScale * vec2(0.40, 2.4));
    float blob   = fbm(vWorld * uFoamScale * 0.55);

    // One combined field, normalised to roughly [0,1] with a mean near 0.5.
    // This is MACRO variation only -- clumps and streaks a metre or two across.
    // The fine bubble lace is not baked here: this texture is 0.33 m per texel,
    // which is coarser than lace, so baking it produces visible squares up
    // close. The ocean shader adds it per-pixel instead, where it has no
    // resolution limit at all.
    float field = blob * 0.42 + raft * 0.42 + streak * 0.16;
    field = clamp((field - 0.5) * uFoamContrast + 0.5, 0.0, 1.0);
    field = clamp(field - (1.0 - comb) * uCarve * inner, 0.0, 1.0);

    float ageN = clamp(age / max(uFoamLife, 0.01), 0.0, 1.0);
    float alive = pow(1.0 - ageN, uDissolve);

    // Coverage: how much of the water here is aerated. Smooth and continuous --
    // no threshold, so nothing here can produce a hard edge. Break-up with age
    // eats into coverage, which the ocean's threshold then turns into holes.
    float cover = (armFoam + washFoam) * alive;
    cover *= mix(1.0, 0.35 + 0.95 * field, mix(0.45, 1.0, ageN * uBreakup + 0.35));

    float foam = cover;

    // Right at the bow the spray is a smooth unbroken sheet; it only breaks
    // into bubbles once it has fallen back onto the water.
    float sheet = 1.0 - smoothstep(0.5, 7.0, arc);
    foam = mix(foam, max(foam, (armFoam + washFoam) * alive * 1.1), sheet * 0.34);

    // Carve out the hull's own footprint: the boat displaces the water it is
    // sitting in, it does not float on top of its own spray.
    // Rounded, not a box -- a rectangular cut-out shows up as straight edges in
    // the foam either side of the hull.
    vec2 hp = vec2(ad / max(uBeam * 0.62, 0.1), arc / max(uHullLen * 0.98, 0.1));
    float hull = 1.0 - smoothstep(0.62, 1.05, length(hp));
    foam *= 1.0 - hull * 0.92;

    // ------------------------------------------------- subsurface bubbles --
    // The prop is underwater, so most of the air it drags in never reaches the
    // surface as foam. It stays as a plume in the water column: wider and much
    // longer-lived than the foam above it, still there long after the white has
    // gone. Seen through water it is cloudy rather than granular, so this is
    // deliberately low frequency -- and cheap to bake, unlike the lace.
    float bw = max(uBubW + arc * uBubSpread, 0.1);
    float bg = exp(-(d / bw) * (d / bw));
    float plume = astern * bg * uBubPlume * exp(-arc / max(uBubLen, 1.0));

    // Spray plunging back in entrains its own air along each arm.
    float entrain = armG * uBubArms * armFade;

    float bubAge = clamp(age / max(uBubLife, 0.01), 0.0, 1.0);
    float bub = (plume + entrain) * pow(1.0 - bubAge, 1.15);
    float cloud = fbm(vWorld * uFoamScale * 0.55) * 0.65
                + fbm(vWorld * uFoamScale * 1.45) * 0.45;
    bub *= mix(1.0, 0.18 + 1.55 * cloud, uBubMottle);

    // The oldest end of the trail is a mesh boundary, not a physical edge.
    float tailFade = 1.0 - smoothstep(uMaxArc - min(70.0, uMaxArc * 0.3), uMaxArc, arc);
    foam *= tailFade;

    float height  = (armH + washH + trans) * mix(0.35, 1.0, alive) * tailFade;
    float flatten = clamp((insideV + wg) * uFlatten * alive, 0.0, 1.0) * tailFade;

    gl_FragColor = vec4(foam * edge, height * edge, flatten * edge, max(bub, 0.0) * tailFade * edge);
  }
`;

export class WakeField {
  constructor(renderer, size = 1024) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.camera.up.set(0, 0, -1);

    this.center = new THREE.Vector2(0, 0);
    this.extent = get('field.extent');

    // --- path history -------------------------------------------------------
    // Ring of {x, z, hx, hz, t}: bow position, unit heading, birth time.
    this.path = [];
    this.arcOf = [];   // arc length from the bow back to each sample

    this._buildGeometry();
  }

  _buildGeometry() {
    const nv = MAX_SAMPLES * (LAT_SEG + 1);
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(nv * 3);
    this.arc = new Float32Array(nv);
    this.lat = new Float32Array(nv);
    this.age = new Float32Array(nv);
    this.uu = new Float32Array(nv);
    this.tan = new Float32Array(nv * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aArc', new THREE.BufferAttribute(this.arc, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLat', new THREE.BufferAttribute(this.lat, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aU', new THREE.BufferAttribute(this.uu, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTan', new THREE.BufferAttribute(this.tan, 2).setUsage(THREE.DynamicDrawUsage));

    const idx = new Uint32Array((MAX_SAMPLES - 1) * LAT_SEG * 6);
    let o = 0;
    for (let s = 0; s < MAX_SAMPLES - 1; s++) {
      for (let l = 0; l < LAT_SEG; l++) {
        const a = s * (LAT_SEG + 1) + l, b = a + 1;
        const c = a + (LAT_SEG + 1), d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;

    this.uniforms = {
      uMaxArc: { value: 1 },
      uBeam: { value: 1 }, uHullLen: { value: 1 },
      uArmTan: { value: 0 }, uArmW0: { value: 1 }, uArmWGrow: { value: 0 },
      uArmFoam: { value: 1 }, uArmHeight: { value: 0 }, uInnerBias: { value: 0 },
      uFadeStart: { value: 1 }, uFadeLen: { value: 1 },
      uRim: { value: 0 }, uRimW: { value: 1 }, uNearBoost: { value: 0 },
      uNearLen: { value: 1 }, uCarve: { value: 0 },
      uFeatSpace: { value: 1 }, uFeatGrow: { value: 0 }, uFeatLean: { value: 0 },
      uFeatDepth: { value: 0 }, uFeatJitter: { value: 0 }, uFeatSharp: { value: 1 },
      uWashW: { value: 1 }, uWashWGrow: { value: 0 }, uWashFoam: { value: 1 },
      uWashLen: { value: 1 }, uWashTail: { value: 0 }, uWashDepth: { value: 0 },
      uTransAmp: { value: 0 }, uTransLen: { value: 1 }, uTransDecay: { value: 1 }, uFlatten: { value: 0 },
      uFoamScale: { value: 1 }, uFoamContrast: { value: 1 }, uBreakup: { value: 0 },
      uFoamLife: { value: 1 }, uDissolve: { value: 1 },
      uLace: { value: 1 }, uLaceAmt: { value: 0 }, uSoftness: { value: 0.2 },
      uBubPlume: { value: 0 }, uBubW: { value: 1 }, uBubSpread: { value: 0 },
      uBubLen: { value: 1 }, uBubArms: { value: 0 }, uBubLife: { value: 1 }, uBubMottle: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** Record where the bow is now. Called every frame; samples are decimated. */
  pushSample(x, z, hx, hz, t) {
    const last = this.path[0];
    if (last) {
      const dx = x - last.x, dz = z - last.z;
      if (dx * dx + dz * dz < STEP * STEP) { this.head = { x, z, hx, hz, t }; return; }
    }
    this.path.unshift({ x, z, hx, hz, t });
    this.head = null;
    const maxArc = get('field.trailLength');
    // Trim to the requested trail length.
    let arc = 0;
    for (let i = 1; i < this.path.length; i++) {
      const a = this.path[i - 1], b = this.path[i];
      arc += Math.hypot(b.x - a.x, b.z - a.z);
      if (arc > maxArc || i >= MAX_SAMPLES - 2) { this.path.length = i + 1; break; }
    }
  }

  /** Rebuild the ribbon from the path and re-bake the field texture. */
  update(now) {
    const P = this.path;
    if (P.length < 2) return;

    // Head sample keeps the ribbon's tip glued to the bow between decimated
    // samples, so the wake doesn't visibly stutter at the boat.
    const pts = this.head ? [this.head, ...P] : P;
    const n = Math.min(pts.length, MAX_SAMPLES);

    const armTan = Math.tan(get('arms.angle') * Math.PI / 180);
    const beam = get('boat.beam');
    const w0 = get('arms.width0'), wg = get('arms.widthGrow');

    let arc = 0;
    let o = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i > 0) arc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);

      // Lateral axis: perpendicular to the local path tangent.
      const q = pts[Math.min(i + 1, n - 1)], r = pts[Math.max(i - 1, 0)];
      let tx = r.x - q.x, tz = r.z - q.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;

      // Half-width: enough to hold the arms plus their falloff, with margin.
      const halfW = beam * 0.5 + arc * armTan + (w0 + arc * wg) * 3.2 + 1.5;
      const age = now - p.t;

      for (let l = 0; l <= LAT_SEG; l++) {
        const u = (l / LAT_SEG) * 2 - 1;
        const d = u * halfW;
        const vi = o + l;
        this.pos[vi * 3] = p.x + nx * d;
        this.pos[vi * 3 + 1] = 0;
        this.pos[vi * 3 + 2] = p.z + nz * d;
        this.arc[vi] = arc;
        this.lat[vi] = d;
        this.age[vi] = age;
        this.uu[vi] = u;
        this.tan[vi * 2] = tx;
        this.tan[vi * 2 + 1] = tz;
      }
      o += LAT_SEG + 1;
    }

    const g = this.geometry;
    for (const name of ['position', 'aArc', 'aLat', 'aAge', 'aU', 'aTan']) {
      const n = name === 'position' ? o * 3 : name === 'aTan' ? o * 2 : o;
      g.getAttribute(name).addUpdateRange(0, n);
      g.getAttribute(name).needsUpdate = true;
    }
    this.maxArc = arc;
    g.setDrawRange(0, (n - 1) * LAT_SEG * 6);

    this._syncUniforms();
    this._bake();
  }

  _syncUniforms() {
    const u = this.uniforms;
    u.uMaxArc.value = Math.max(this.maxArc || 1, 1);
    u.uBeam.value = get('boat.beam');
    u.uHullLen.value = get('boat.length');
    u.uArmTan.value = Math.tan(get('arms.angle') * Math.PI / 180);
    u.uArmW0.value = get('arms.width0');
    u.uArmWGrow.value = get('arms.widthGrow');
    u.uArmFoam.value = get('arms.foam');
    u.uArmHeight.value = get('arms.height');
    u.uInnerBias.value = get('arms.innerBias');
    u.uFadeStart.value = get('arms.fadeStart');
    u.uFadeLen.value = get('arms.fadeLength');
    u.uRim.value = get('arms.rim');
    u.uRimW.value = get('arms.rimWidth');
    u.uNearBoost.value = get('arms.nearBoost');
    u.uNearLen.value = get('arms.nearLength');
    u.uCarve.value = get('feather.carve');
    u.uFeatSpace.value = get('feather.spacing');
    u.uFeatGrow.value = get('feather.spacingGrow');
    u.uFeatLean.value = get('feather.lean');
    u.uFeatDepth.value = get('feather.depth');
    u.uFeatJitter.value = get('feather.jitter');
    u.uFeatSharp.value = get('feather.sharpness');
    u.uWashW.value = get('wash.width');
    u.uWashWGrow.value = get('wash.widthGrow');
    u.uWashFoam.value = get('wash.foam');
    u.uWashLen.value = get('wash.length');
    u.uWashTail.value = get('wash.tailFoam');
    u.uWashDepth.value = get('wash.depth');
    u.uTransAmp.value = get('inner.transAmp');
    u.uTransLen.value = get('inner.transLen');
    u.uTransDecay.value = get('inner.transDecay');
    u.uFlatten.value = get('inner.flatten');
    u.uFoamScale.value = get('foamLook.scale') * 0.35;
    u.uFoamContrast.value = get('foamLook.contrast');
    u.uBreakup.value = get('foamLook.breakup');
    u.uFoamLife.value = get('foamLook.life');
    u.uDissolve.value = get('foamLook.dissolve');
    u.uLace.value = get('foamLook.lace');
    u.uLaceAmt.value = get('foamLook.laceAmount');
    u.uSoftness.value = get('foamLook.softness');
    u.uBubPlume.value = get('bubbles.plume');
    u.uBubW.value = get('bubbles.width');
    u.uBubSpread.value = get('bubbles.spread');
    u.uBubLen.value = get('bubbles.length');
    u.uBubArms.value = get('bubbles.fromArms');
    u.uBubLife.value = get('bubbles.life');
    u.uBubMottle.value = get('bubbles.mottle');
  }

  /** Point the field at a world position (snapped, so the texture doesn't crawl). */
  focus(x, z) {
    this.extent = get('field.extent');
    const snap = this.extent / this.rt.width * 4;
    this.center.set(Math.round(x / snap) * snap, Math.round(z / snap) * snap);
    const h = this.extent * 0.5;
    const c = this.camera;
    c.left = -h; c.right = h; c.top = h; c.bottom = -h;
    c.position.set(this.center.x, 120, this.center.y);
    c.lookAt(this.center.x, 0, this.center.y);
    c.updateProjectionMatrix();
  }

  _bake() {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
  }
}
