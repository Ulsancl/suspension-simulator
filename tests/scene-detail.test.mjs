import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFAULT_CONFIG, getGeometry } from '../src/physics.js';
import { springAssembly, destroy } from '../src/rig-parts.js';
import { SPRING_DETAIL, springLayout, coilPoint, createCoilGeometry, updateCoilGeometry, annularGeometry } from '../src/mechanical-geometry.js';

const near = (a, b, tol = 1e-7) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const mat = new THREE.MeshStandardMaterial();
const mats = Object.fromEntries(['metal','chrome','darkMetal','red','rubber','brass','spring'].map(key => [key, mat]));

function checkSurface(geometry, closed = true) {
  const p = geometry.attributes.position, n = geometry.attributes.normal, index = geometry.index.array;
  const edges = new Map(), key = i => [p.getX(i),p.getY(i),p.getZ(i)].map(x => Math.round(x * 1e7)).join(',');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    assert.ok(Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i)));
    near(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)), 1, 2e-6);
  }
  for (let i = 0; i < index.length; i += 3) {
    a.fromBufferAttribute(p,index[i]); b.fromBufferAttribute(p,index[i+1]); c.fromBufferAttribute(p,index[i+2]);
    const face = b.sub(a).cross(c.sub(a)); assert.ok(face.length() > 1e-13, `degenerate triangle ${i/3}`);
    normal.set(0,0,0);
    for(let j=0;j<3;j++) normal.add(new THREE.Vector3().fromBufferAttribute(n,index[i+j]));
    assert.ok(face.dot(normal) > 0, `inward face ${i/3}`);
    for(let j=0;j<3;j++) { const e=[key(index[i+j]),key(index[i+(j+1)%3])].sort().join('|'); edges.set(e,(edges.get(e)||0)+1); }
  }
  if(closed) for(const [edge,count] of edges) assert.equal(count,2,`open/nonmanifold edge ${edge}`);
}

test('coil winding is outward with sealed ends, unit normals and reusable bounded buffers', () => {
  const geometry=createCoilGeometry(), initial=geometry.attributes.position.array;
  for(const integrated of [false,true]) for(const type of ['coil','progressive']) {
    const layout=springLayout(integrated ? .487518461189 : .899294167667,type,integrated);
    updateCoilGeometry(geometry,layout); checkSurface(geometry);
    assert.equal(geometry.attributes.position.array,initial);
    assert.equal(geometry.attributes.position.count,3878);
    const p=geometry.attributes.position;
    for(let i=0;i<p.count;i++) near(Math.hypot(p.getX(i),p.getZ(i)) <= .06450001 ? 0 : 1,0);
  }
  geometry.dispose();
});

test('annular and true half-section meshes have closed outward surfaces and a clear shaft bore', () => {
  for(const section of [false,true]) for(const [inner,outer,height] of [[.0132,.043,.013],[.0435,.074,.022],[.025,.071,.019]]) {
    const geometry=annularGeometry(inner,outer,height,.001,section); checkSurface(geometry);
    const p=geometry.attributes.position;
    for(let i=0;i<p.count;i++) assert.ok(Math.hypot(p.getX(i),p.getZ(i)) >= inner-1e-8);
    geometry.dispose();
  }
});

test('fixed turns and wire fit all structure/radius combinations over the declared +/-250 mm observation range', () => {
  const geometry=createCoilGeometry();
  for(const structure of ['wishbone','multilink','macpherson']) for(const tireRadius of [.2,.34,.55]) for(const springType of ['coil','progressive']) {
    let fixedTurns;
    for(let step=0;step<=100;step++) {
      const travel=-.25+step*.005, g=getGeometry({...DEFAULT_CONFIG,structure,tireRadius},travel);
      const length=Math.hypot(...g.springTop.map((x,i)=>x-g.springBottom[i]));
      const layout=springLayout(length,springType,structure==='macpherson');
      fixedTurns ??= layout.turns; assert.equal(layout.turns,fixedTurns); assert.ok(layout.displayEnvelopeValid);
      // Closest points on different turns occur near one turn apart, not
      // necessarily at the same azimuth. Sample +/-1/8 turn around each turn.
      let minDistance=Infinity;
      for(let k=0;k<=80;k++) {
        const s=k/80*(layout.turns-1.125), p=coilPoint(layout,s/layout.turns);
        for(let d=.875;d<=1.125+1e-9;d+=.0125) {
          const q=coilPoint(layout,(s+d)/layout.turns);
          minDistance=Math.min(minDistance,Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z));
        }
      }
      assert.ok(minDistance>2*SPRING_DETAIL.wireRadiusM+.0007,`${structure} ${springType} ${travel} clearance ${minDistance-.015}`);
    }
  }
  geometry.dispose();
});

test('wire endpoints touch actual seat faces without entering either annulus; lower bore clears barrel', () => {
  for(const integrated of [false,true]) for(const type of ['coil','progressive']) {
    const parent=new THREE.Group(), spring=springAssembly(parent,mats,type,integrated);
    for(const length of integrated ? [.24558714675,.487518461189,.696131528118] : [.740718640146,.899294167667,1.030554871989]) {
      spring.update([0,length,0],[0,0,0]); const d=spring.getDiagnostics();
      near(d.seats.lowerTopYM,d.seats.lowerContactYM); near(d.seats.upperBottomYM,d.seats.upperContactYM);
      const p=spring.coilGeometry.attributes.position;
      let min=Infinity,max=-Infinity;
      for(let i=0;i<p.count;i++) { min=Math.min(min,p.getY(i)); max=Math.max(max,p.getY(i)); }
      near(min,d.seats.lowerTopYM); near(max,d.seats.upperBottomYM);
      assert.ok(d.seats.lowerBoreRadiusM > (integrated ? .043 : .031));
    }
    destroy(parent);
  }
});

test('damper representative bore, piston and guide remain distinct across the declared range', () => {
  for(const integrated of [false,true]) {
    const parent=new THREE.Group(), spring=springAssembly(parent,mats,'coil',integrated);
    for(const length of integrated ? [.24558714675,.487518461189,.696131528118] : [.740718640146,.899294167667,1.030554871989]) {
      spring.update([0,length,0],[0,0,0]); const {damper:d}=spring.getDiagnostics();
      near(d.guideBoreRadiusM-d.rodRadiusM,.0002);
      near(d.bodyBoreRadiusM-d.pistonRadiusM,.0005);
      assert.ok(d.pistonYM-.007>d.bodyBottomYM+.008);
      assert.ok(d.pistonYM+.007<d.guideYM-.0065);
      assert.equal(d.variableEnvelope,true); assert.equal(d.hydraulicCircuitSolved,false);
    }
    destroy(parent);
  }
});

test('inspection swaps complete section surfaces and preserves full assembly visibility metadata', () => {
  for(const type of ['coil','progressive','air']) {
    const parent=new THREE.Group(), spring=springAssembly(parent,mats,type,true);
    spring.update([.2,.6,.1],[0,0,0]);
    const original=spring.group.children.filter(n=>n.visible).map(n=>n.uuid);
    for(const id of ['spring','damper']) {
      spring.setInspection(id);
      spring.group.children.filter(n=>n.visible).forEach(n=>{
        assert.ok(n.userData.presentationOnly || n.userData.detailCategory===id);
        if(n.userData.presentationOnly) checkSurface(n.geometry);
      });
      spring.setInspection(null);
      assert.deepEqual(spring.group.children.filter(n=>n.visible).map(n=>n.uuid),original);
    }
    destroy(parent);
  }
});

test('beyond-envelope compression is explicit and does not silently alter turn count or wire radius', () => {
  const inRange=springLayout(.4875,'progressive',true), compressed=springLayout(.19,'progressive',true);
  assert.equal(inRange.displayEnvelopeValid,true); assert.equal(compressed.displayEnvelopeValid,false);
  assert.equal(inRange.turns,compressed.turns); assert.equal(SPRING_DETAIL.wireRadiusM,.0075);
});
