// Procedural storybook harbor and fishing boat.
//
// The ocean renderer intentionally has no asset pipeline or scene graph. This
// module keeps the same self-contained constraint while adding the silhouettes
// that make the sea feel like a place: layered islands, a lighthouse, cottages,
// pines, docks, and a warm little working boat.

import { program, setUniforms } from './gl.js';

const VS = /* glsl */`
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aColor;
uniform mat4 uViewProj;
uniform vec3 uOrigin;
uniform float uHeading;
uniform float uDynamic;
out vec3 vWorld, vNrm;
out vec4 vColor;

void main(){
  float c = cos(uHeading), s = sin(uHeading);
  vec3 right = vec3(c, 0.0, s);
  vec3 fwd = vec3(s, 0.0, -c);
  vec3 world = mix(aPos, uOrigin + right*aPos.x + vec3(0.0,aPos.y,0.0) + fwd*aPos.z, uDynamic);
  vec3 nrm = mix(aNrm, normalize(right*aNrm.x + vec3(0.0,aNrm.y,0.0) + fwd*aNrm.z), uDynamic);
  vWorld = world;
  vNrm = nrm;
  vColor = aColor;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

const FS = /* glsl */`
in vec3 vWorld, vNrm;
in vec4 vColor;
uniform vec3 uCamPos, uSunDir, uSunColor, uMoonColor;
uniform float uSunHeight;
out vec4 fragColor;

void main(){
  vec3 N = normalize(gl_FrontFacing ? vNrm : -vNrm);
  vec3 V = normalize(uCamPos - vWorld);
  float daylight = smoothstep(-0.08, 0.08, uSunHeight);
  float ndl = max(dot(N, uSunDir), 0.0);
  float wrap = max((dot(N, uSunDir) + 0.35) / 1.35, 0.0);
  vec3 warmSun = normalize(max(uSunColor, vec3(0.001))) * (0.55 + 0.75*daylight);
  vec3 coolSky = mix(vec3(0.055,0.085,0.16), vec3(0.30,0.48,0.62), daylight);
  vec3 col = vColor.rgb * (coolSky*(0.42 + 0.38*max(N.y,0.0)) + warmSun*(0.22*wrap + 0.72*ndl));
  col += vColor.rgb * uMoonColor * max(dot(N, normalize(vec3(-0.3,0.8,0.4))),0.0) * 0.12;
  float rim = pow(1.0-max(dot(N,V),0.0), 3.0);
  col += coolSky * rim * 0.10;
  // Alpha stores emissive strength. Windows and lanterns bloom naturally in HDR.
  col += vColor.rgb * vColor.a * mix(5.0, 2.4, daylight);
  float d = length(vWorld-uCamPos);
  float haze = 1.0-exp(-d*0.00036);
  vec3 hazeCol = mix(vec3(0.055,0.11,0.20), vec3(0.38,0.56,0.68), daylight);
  col = mix(col, hazeCol, haze*0.72);
  fragColor = vec4(col,1.0);
}
`;

const C = {
  cliff: [0.23, 0.24, 0.22, 0], cliffLight: [0.36, 0.34, 0.27, 0],
  grass: [0.16, 0.30, 0.20, 0], grassLight: [0.25, 0.40, 0.24, 0],
  pine: [0.055, 0.18, 0.13, 0], pineLight: [0.08, 0.25, 0.17, 0],
  trunk: [0.19, 0.105, 0.055, 0], plaster: [0.62, 0.49, 0.33, 0],
  plasterBlue: [0.30, 0.46, 0.48, 0], roof: [0.36, 0.12, 0.07, 0],
  roofBlue: [0.09, 0.20, 0.28, 0], wood: [0.28, 0.15, 0.075, 0],
  woodLight: [0.47, 0.27, 0.12, 0], white: [0.72, 0.70, 0.62, 0],
  red: [0.52, 0.10, 0.055, 0], window: [1.0, 0.42, 0.10, 1],
  lantern: [1.0, 0.32, 0.055, 1.5], coat: [0.075, 0.16, 0.20, 0],
  cap: [0.25, 0.34, 0.10, 0], skin: [0.55, 0.28, 0.16, 0],
};

class MeshBuilder {
  constructor() { this.p=[]; this.n=[]; this.c=[]; this.i=[]; }
  v(p,n,c){ const i=this.p.length/3; this.p.push(...p); this.n.push(...n); this.c.push(...c); return i; }
  quad(a,b,c,d,color){
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const l=Math.hypot(nx,ny,nz)||1, n=[nx/l,ny/l,nz/l];
    const q=[this.v(a,n,color),this.v(b,n,color),this.v(c,n,color),this.v(d,n,color)];
    this.i.push(q[0],q[1],q[2],q[0],q[2],q[3]);
  }
  tri(a,b,c,color){
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2], vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx, l=Math.hypot(nx,ny,nz)||1;
    const n=[nx/l,ny/l,nz/l], q=[this.v(a,n,color),this.v(b,n,color),this.v(c,n,color)];
    this.i.push(...q);
  }
  box(x,y,z,w,h,d,color){
    const x0=x-w/2,x1=x+w/2,y0=y,y1=y+h,z0=z-d/2,z1=z+d/2;
    this.quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],color);
    this.quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],color);
    this.quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],color);
    this.quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],color);
    this.quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0],color);
  }
  cylinder(x,y,z,r,h,color,sides=10){
    for(let j=0;j<sides;j++){
      const a=j*Math.PI*2/sides,b=(j+1)*Math.PI*2/sides;
      const p0=[x+Math.cos(a)*r,y,z+Math.sin(a)*r],p1=[x+Math.cos(b)*r,y,z+Math.sin(b)*r];
      this.quad(p0,p1,[p1[0],y+h,p1[2]],[p0[0],y+h,p0[2]],color);
      this.tri([x,y+h,z],[p0[0],y+h,p0[2]],[p1[0],y+h,p1[2]],color);
    }
  }
  cone(x,y,z,r,h,color,sides=9){
    for(let j=0;j<sides;j++){
      const a=j*Math.PI*2/sides,b=(j+1)*Math.PI*2/sides;
      this.tri([x+Math.cos(a)*r,y,z+Math.sin(a)*r],[x+Math.cos(b)*r,y,z+Math.sin(b)*r],[x,y+h,z],color);
    }
  }
  house(x,y,z,s=1,blue=false){
    const wall=blue?C.plasterBlue:C.plaster, roof=blue?C.roofBlue:C.roof;
    const w=12*s,d=10*s,h=8*s;
    this.box(x,y,z,w,h,d,wall);
    const y0=y+h, top=y+h+5*s, x0=x-w*.58, x1=x+w*.58, z0=z-d*.62, z1=z+d*.62;
    this.quad([x0,y0,z1],[x1,y0,z1],[x,top,z1],[x,top,z1],roof);
    this.quad([x1,y0,z0],[x0,y0,z0],[x,top,z0],[x,top,z0],roof);
    this.quad([x0,y0,z0],[x0,y0,z1],[x,top,z1],[x,top,z0],roof);
    this.quad([x1,y0,z1],[x1,y0,z0],[x,top,z0],[x,top,z1],roof);
    this.box(x-w*.24,y+2.4*s,z+d*.505,2.1*s,2.5*s,.25*s,C.window);
    this.box(x+w*.24,y+2.4*s,z+d*.505,2.1*s,2.5*s,.25*s,C.window);
    this.box(x-w*.29,y+1.8*s,z-d*.505,1.7*s,2.1*s,.25*s,C.window);
    this.cylinder(x+w*.27,y+h+3.4*s,z,0.65*s,5*s,C.cliffLight,7);
  }
  pine(x,y,z,s=1){
    this.cylinder(x,y,z,.55*s,4*s,C.trunk,7);
    this.cone(x,y+2.5*s,z,4.2*s,9*s,C.pine,9);
    this.cone(x,y+6*s,z,3.3*s,8*s,C.pineLight,9);
  }
  island(cx,cz,rx,rz,peak,seed=0){
    const seg=36, rings=[
      {r:1.02,y:-5,c:C.cliff},{r:.92,y:2,c:C.cliffLight},{r:.67,y:peak*.48,c:C.grass},
      {r:.34,y:peak*.86,c:C.grassLight},{r:0,y:peak,c:C.grassLight},
    ];
    const pts=rings.map((ring,ri)=>{
      if(!ring.r) return [[cx,ring.y,cz]];
      return Array.from({length:seg},(_,j)=>{
        const a=j*Math.PI*2/seg, wob=1+.08*Math.sin(j*2.7+seed)+.05*Math.sin(j*5.1-seed);
        return [cx+Math.cos(a)*rx*ring.r*wob,ring.y+Math.sin(j*1.9+seed)*2*(ri>0),cz+Math.sin(a)*rz*ring.r*wob];
      });
    });
    for(let r=0;r<rings.length-2;r++) for(let j=0;j<seg;j++){
      const k=(j+1)%seg; this.quad(pts[r][j],pts[r][k],pts[r+1][k],pts[r+1][j],rings[r+1].c);
    }
    for(let j=0;j<seg;j++) this.tri(pts[3][j],pts[3][(j+1)%seg],pts[4][0],C.grassLight);
  }
  upload(gl){
    const vao=gl.createVertexArray(); gl.bindVertexArray(vao);
    const attr=(data,loc,size)=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,0,0);};
    attr(this.p,0,3); attr(this.n,1,3); attr(this.c,2,4);
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(this.i),gl.STATIC_DRAW);
    gl.bindVertexArray(null); return {vao,count:this.i.length};
  }
}

function buildHarbor(){
  const b=new MeshBuilder();
  b.island(-360,-690,300,225,72,1.7);
  b.island(-82,-770,82,66,27,4.1);
  // Layered village climbing the left hillside.
  const homes=[
    [-565,24,-535,1.45,0],[-505,30,-530,1.55,1],[-445,37,-535,1.35,0],[-385,45,-540,1.45,1],
    [-545,38,-585,1.25,1],[-485,47,-585,1.35,0],[-425,54,-590,1.30,1],[-365,60,-600,1.15,0],
    [-305,54,-580,1.25,0],[-260,42,-550,1.35,1],[-500,59,-635,1.10,0],[-430,65,-645,1.05,1],
  ];
  homes.forEach(([x,y,z,s,blue])=>b.house(x,y,z,s,blue));
  // Harbor piers.
  for(let j=0;j<8;j++) b.box(-490+j*13,1.5,-445,11,1.1,50,C.wood);
  for(let j=0;j<10;j++) b.cylinder(-490+j*13,-2,-422,1.0,7,C.trunk,7);
  // Pines create the dense concept-art silhouette.
  const trees=[
    [-595,43,-650,1.5],[-565,52,-710,1.3],[-535,55,-780,1.5],[-490,62,-805,1.1],
    [-435,68,-825,1.4],[-375,72,-805,1.3],[-320,65,-790,1.5],[-275,55,-740,1.2],
    [-235,43,-680,1.3],[-590,33,-570,1.0],[-335,62,-620,1.1],[-270,46,-575,1.0],
    [-470,72,-700,1.0],[-405,76,-710,1.1],
  ];
  trees.forEach(t=>b.pine(...t));
  // Lighthouse island to the right, with a warm rotating-room impression.
  b.cylinder(-82,16,-770,9,45,C.white,12);
  b.cylinder(-82,16,-770,11,7,C.red,12);
  b.cylinder(-82,41,-770,9,8,C.red,12);
  b.cylinder(-82,61,-770,12,4,C.roof,12);
  b.cylinder(-82,54,-770,8.5,7,C.window,12);
  b.cone(-82,65,-770,13,9,C.roof,12);
  b.box(-82,19,-761,4,7,.5,C.cliff);
  for(const [x,z,s] of [[-128,-770,1.2],[-37,-782,1.1],[-58,-735,.85],[-108,-805,.9]]) b.pine(x,23,z,s);
  return b;
}

function buildBoat(){
  const b=new MeshBuilder();
  // Six hull stations make the bow pointed and the stern broad.
  const sec=[[-3.2,1.25,.25],[-2.2,1.65,.05],[0,1.8,-.05],[2.4,1.45,.18],[3.8,.15,.45]];
  for(let j=0;j<sec.length-1;j++){
    const [z0,w0,y0]=sec[j],[z1,w1,y1]=sec[j+1];
    b.quad([-w0,y0,z0],[-w1,y1,z1],[-w1,1.25,z1],[-w0,1.25,z0],C.woodLight);
    b.quad([w1,y1,z1],[w0,y0,z0],[w0,1.25,z0],[w1,1.25,z1],C.wood);
    b.quad([-w0,y0,z0],[w0,y0,z0],[w1,y1,z1],[-w1,y1,z1],C.cliff);
  }
  b.box(0,1.15,-.4,3.0,.35,5.0,C.woodLight);
  b.box(-1.62,1.2,-.25,.18,.65,5.6,C.white);
  b.box(1.62,1.2,-.25,.18,.65,5.6,C.white);
  b.box(0,1.45,-1.5,2.5,1.1,1.45,C.coat);
  b.box(-.7,1.48,.05,.75,.65,.75,C.cliff);
  b.box(.72,1.48,-.05,.65,.55,.7,C.grass);
  b.cylinder(-1.25,1.52,-2.35,.18,.85,C.trunk,7);
  b.cylinder(-1.25,2.25,-2.35,.34,.42,C.lantern,8);
  // Fisher and wool cap.
  b.box(0,1.5,.7,1.25,1.65,.9,C.coat);
  b.cylinder(0,3.1,.7,.43,.58,C.skin,10);
  b.cylinder(0,3.62,.7,.51,.35,C.cap,10);
  b.cone(0,3.92,.7,.22,.32,C.cap,8);
  // Red life ring.
  b.cylinder(1.72,.65,-1.15,.48,.18,C.red,10);
  return b;
}

export class CozyScene {
  constructor(gl){
    this.gl=gl;
    this.prog=program(gl,VS,FS,'cozy-scene');
    this.harbor=buildHarbor().upload(gl);
    this.boat=buildBoat().upload(gl);
  }
  drawMesh(mesh,ctx,dynamic,origin=[0,0,0],heading=0){
    const gl=this.gl; gl.useProgram(this.prog);
    setUniforms(gl,this.prog,{
      uViewProj:ctx.viewProj,uCamPos:ctx.camPos,uSunDir:ctx.sunDir,uSunColor:ctx.sunColor,
      uMoonColor:ctx.moonColor,uSunHeight:ctx.sunDir[1],
      uOrigin:origin,uHeading:heading,uDynamic:dynamic,
    });
    gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_INT,0); gl.bindVertexArray(null);
  }
  drawHarbor(ctx){ this.drawMesh(this.harbor,ctx,0); }
  drawBoat(ctx,runner,lift=0){
    this.drawMesh(this.boat,ctx,1,[runner.pos[0],(runner.deckY??0)+lift,runner.pos[2]],runner.heading);
  }
}
