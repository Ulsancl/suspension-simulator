import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPRING_DETAIL, springLayout, createCoilGeometry, updateCoilGeometry, annularGeometry, revolvedProfile } from './mechanical-geometry.js';

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
export const vector = a => new THREE.Vector3(...a);

export function part(parent, geometry, material, position) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  if (position) mesh.position.set(...position);
  parent.add(mesh); return mesh;
}
export function block(parent, dimensions, position, material, radius = .004) {
  return part(parent, new RoundedBoxGeometry(...dimensions, 2, Math.min(radius, ...dimensions.map(v => v / 3))), material, position);
}
export function cylinder(parent, radius, length, material, position, segments = 32) {
  return part(parent, new THREE.CylinderGeometry(radius, radius, length, segments), material, position);
}
export function ring(parent, radius, tube, material, position, segments = 64) {
  return part(parent, new THREE.TorusGeometry(radius, tube, 8, segments), material, position);
}
export function align(object, a, b, stretch = false) {
  const av = vector(a), delta = vector(b).sub(av), length = delta.length();
  object.position.copy(av.addScaledVector(delta, .5));
  object.quaternion.setFromUnitVectors(UP, delta.normalize());
  if (stretch) object.scale.y = Math.max(.001, length);
  return length;
}
export function destroy(group) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  group.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material?.userData?.owned) continue;
      materials.add(material);
      for (const key of ['map', 'normalMap', 'bumpMap']) if (material[key]) textures.add(material[key]);
    }
  });
  geometries.forEach(g => g.dispose()); textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose());
  group.clear();
}

// Bake the fixture's repeated fasteners and profiles into a few material
// batches. Articulation still belongs to the enclosing group; protected wheel
// tread instances, decals and belt rollers retain their independent transforms.
export function consolidate(group, protectedObjects = []) {
  group.updateWorldMatrix(true, true);
  const inverse = group.matrixWorld.clone().invert(), keep = new Set(protectedObjects), batches = new Map(), originals = new Set(), protectedMeshes = [];
  group.traverse(object => {
    if (!object.isMesh) return;
    if (keep.has(object) || object.isInstancedMesh || object.material?.userData?.owned) {
      protectedMeshes.push(object); return;
    }
    if (Array.isArray(object.material)) return;
    const key = `${object.material.uuid}/${object.castShadow}/${object.receiveShadow}`;
    if (!batches.has(key)) batches.set(key, { material: object.material, cast: object.castShadow, receive: object.receiveShadow, geometries: [] });
    const cloned = object.geometry.clone();
    const geometry = cloned.index ? cloned.toNonIndexed() : cloned;
    if (geometry !== cloned) cloned.dispose();
    geometry.applyMatrix4(inverse.clone().multiply(object.matrixWorld));
    batches.get(key).geometries.push(geometry); originals.add(object.geometry);
  });
  group.clear();
  for (const entry of batches.values()) {
    const geometry = mergeGeometries(entry.geometries, false);
    entry.geometries.forEach(g => g.dispose());
    if (!geometry) continue;
    const mesh = part(group, geometry, entry.material); mesh.castShadow = entry.cast; mesh.receiveShadow = entry.receive; mesh.name = 'batched-engineered-components';
  }
  protectedMeshes.forEach(object => group.add(object)); originals.forEach(g => g.dispose());
}

export function fastener(parent, position, material, size = .010, axis = 'z') {
  const assembly = new THREE.Group(); parent.add(assembly); assembly.position.set(...position);
  const washer = cylinder(assembly, size * 1.65, size * .25, material, [0, 0, 0], 24);
  const bolt = cylinder(assembly, size, size * .75, material, [0, size * .36, 0], 6);
  const slot = part(assembly, new THREE.CylinderGeometry(size * .34, size * .34, size * .1, 6), material.userData.darkMaterial || material, [0, size * .76, 0]);
  washer.name = 'washer'; bolt.name = 'hex-fastener'; slot.name = 'recessed-hex';
  if (axis === 'z') assembly.rotation.x = Math.PI / 2;
  if (axis === 'x') assembly.rotation.z = Math.PI / 2;
  return assembly;
}

export function bearing(parent, position, mats, scale = 1, axis = 'x') {
  const assembly = new THREE.Group(); assembly.name = 'sealed-pivot-bearing'; parent.add(assembly); assembly.position.set(...position);
  const outer = cylinder(assembly, .035 * scale, .060 * scale, mats.metal, [0, 0, 0]);
  const seal = cylinder(assembly, .028 * scale, .062 * scale, mats.rubber, [0, 0, 0]);
  const pin = cylinder(assembly, .012 * scale, .091 * scale, mats.chrome, [0, 0, 0]);
  outer.name = 'bearing-shell'; seal.name = 'bearing-seal'; pin.name = 'pivot-pin';
  for (const y of [-.045, .045]) fastener(assembly, [0, y * scale, 0], mats.chrome, .015 * scale, 'y');
  if (axis === 'x') assembly.rotation.z = Math.PI / 2;
  if (axis === 'z') assembly.rotation.x = Math.PI / 2;
  consolidate(assembly);
  return assembly;
}

// Adjustable rod: only the central tube is stretched; joint heads, locknuts,
// threaded sleeve and hex adjuster retain their physical proportions.
export function adjustableRod(parent, mats, material = mats.metal, radius = .017, name = 'link') {
  const group = new THREE.Group(); group.name = name; parent.add(group);
  const tube = cylinder(group, radius, 1, material);
  const sleeve = cylinder(group, radius * 1.24, .085, mats.darkMetal);
  const hex = cylinder(group, radius * 1.39, .027, mats.metal, [0, 0, 0], 6);
  const ends = [];
  for (const sign of [-1, 1]) {
    const end = new THREE.Group(); end.name = 'threaded-rose-bearing-end'; group.add(end);
    const neck = cylinder(end, radius * .59, .060, mats.chrome, [0, -sign * .020, 0]);
    for (let i = 0; i < 7; i++) {
      const thread = ring(end, radius * .62, .0009, mats.chrome, [0, -sign * (.013 + i * .004), 0], 16); thread.rotation.x = Math.PI / 2;
    }
    cylinder(end, radius * 1.1, .012, mats.brass, [0, -sign * .050, 0], 6);
    const eye = ring(end, radius * 1.45, radius * .42, mats.metal, [0, 0, 0], 24);
    const ball = part(end, new THREE.SphereGeometry(radius, 16, 12), mats.chrome, [0, 0, 0]);
    const pin = cylinder(end, radius * .42, radius * 4.2, mats.chrome); pin.rotation.x = Math.PI / 2;
    eye.name = 'rose-joint'; ball.name = 'spherical-bearing'; neck.name = 'threaded-neck';
    consolidate(end);
    ends.push({ sign, group: end });
  }
  return { group, update(a, b) {
    const length = align(group, a, b);
    tube.scale.y = Math.max(.001, length - .1);
    sleeve.position.y = length * .12; hex.position.y = length * .12;
    ends.forEach(end => { end.group.position.y = end.sign * length / 2; });
  }};
}

export function armLimb(parent, mats, name = 'forged-arm') {
  const group = new THREE.Group(); group.name = name; parent.add(group);
  const arm = block(group, [.045, 1, .032], [0, 0, 0], mats.red, .010);
  const spine = block(group, [.013, 1, .040], [0, 0, 0], mats.red, .004);
  const tip = new THREE.Group(); group.add(tip);
  const joint = bearing(tip, [0, 0, 0], mats, .66, 'z');
  return { group, update(a, b) {
    const length = align(group, a, b); arm.scale.y = Math.max(.001, length - .055); spine.scale.y = Math.max(.001, length - .10);
    tip.position.y = length / 2; joint.rotation.z = -group.rotation.z;
  }};
}

// Open triangular web with a central opening and gently chamfered edges.
export function wishboneWeb(parent, mats) {
  const shape = new THREE.Shape();
  shape.moveTo(-.5, 0); shape.lineTo(.5, 0); shape.lineTo(.035, 1); shape.lineTo(-.035, 1); shape.closePath();
  const hole = new THREE.Path(); hole.moveTo(-.27, .16); hole.lineTo(-.015, .78); hole.lineTo(.015, .78); hole.lineTo(.27, .16); hole.closePath(); shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: .018, bevelEnabled: true, bevelSize: .004, bevelThickness: .003, bevelSegments: 2, steps: 1 });
  geometry.translate(0, 0, -.009);
  const web = part(parent, geometry, mats.red);
  return { mesh: web, update(a, b, tip) {
    const av = vector(a), bv = vector(b), origin = av.clone().add(bv).multiplyScalar(.5);
    const x = bv.sub(av), y = vector(tip).sub(origin), z = new THREE.Vector3().crossVectors(x, y).normalize();
    const basis = new THREE.Matrix4().makeBasis(x, y, z);
    basis.setPosition(origin); web.matrix.copy(basis); web.matrixAutoUpdate = false;
  }};
}

export function springAssembly(parent, mats, springType, integrated = false) {
  const group = new THREE.Group(); group.name = springType === 'air' ? 'air-bellows-damper' : integrated ? 'integrated-macpherson-strut' : 'coilover'; parent.add(group);
  const classified = [], sections = [], radius = integrated ? .043 : .031, bore = radius - .005;
  const classify = (mesh, category, visible = true) => {
    mesh.userData.assemblyVisible = visible; mesh.userData.detailCategory = category; mesh.visible = visible;
    classified.push(mesh); return mesh;
  };
  const annulus = (name, inner, outer, height, material, category, sectionable = false, visible = true) => {
    const mesh = classify(part(group, annularGeometry(inner, outer, height), material), category, visible); mesh.name = name;
    if (sectionable) {
      const cut = part(group, annularGeometry(inner, outer, height, .001, true), material); cut.name = `${name}-section`;
      cut.visible = false; cut.userData.presentationOnly = true; sections.push({ mesh, cut, category });
    }
    return mesh;
  };
  const body = annulus('hollow-damper-envelope', bore, radius, 1, [mats.red,mats.metal,mats.chrome], 'damper', true);
  const piston = classify(cylinder(group, .013, 1, mats.chrome), 'damper'); piston.name = 'sliding-chrome-rod';
  const head = annulus('representative-piston-head', .013, bore - .0005, .014, mats.brass, 'damper');
  const gland = annulus('machined-rod-guide', .0132, radius, .013, mats.chrome, 'damper', true);
  const seal = annulus('rod-wiper-seal', .013, .020, .004, mats.rubber, 'damper', true);
  const baseCap = classify(cylinder(group, bore, .008, mats.darkMetal), 'damper'); baseCap.name = 'damper-base-cap';
  const bootProfile = [];
  for (let i = 0; i <= 24; i++) bootProfile.push([i % 4 === 0 ? .019 : .024, -.5 + i / 24]);
  bootProfile.push([.014, .5], [.014, -.5]);
  const dustBoot = classify(part(group, revolvedProfile(bootProfile), mats.rubber), 'damper'); dustBoot.name = 'hollow-dust-bellows';
  const bootSection = part(group, revolvedProfile(bootProfile, 64, true), mats.rubber); bootSection.name = 'dust-bellows-section'; bootSection.userData.presentationOnly = true; bootSection.visible = false;
  sections.push({ mesh: dustBoot, cut: bootSection, category: 'damper' });
  const lowerEye = classify(bearing(group, [0, 0, 0], mats, integrated ? .92 : .74, 'x'), 'damper');
  const upperEye = classify(bearing(group, [0, 0, 0], mats, integrated ? 1.05 : .74, 'x'), 'damper');
  const upperSeat = annulus('upper-annular-spring-seat', .025, .071, .019, mats.darkMetal, 'spring', false, springType !== 'air');
  const lowerSeat = annulus('lower-annular-spring-seat', radius + .0005, .074, .022, mats.metal, 'spring', false, springType !== 'air');
  const adjusters = [0, 1].map((_, i) => annulus(`threaded-preload-collar-${i + 1}`, radius + .0005, .052, .011, mats.brass, 'spring', false, springType !== 'air'));
  for (const adjuster of adjusters) for (let i = 0; i < 12; i++) {
    const a = i * TAU / 12, mark = block(adjuster, [.002, .005, .003], [.052 * Math.cos(a), 0, .052 * Math.sin(a)], mats.darkMetal, .0003); mark.rotation.y = -a;
  }
  const coilGeometry = createCoilGeometry();
  const coil = classify(part(group, coilGeometry, mats.spring), 'spring', springType !== 'air'); coil.name = springType === 'progressive' ? 'variable-pitch-coil' : 'helical-coil';
  const bagProfile = [];
  for (let i = 0; i <= 80; i++) bagProfile.push([.066 + .018 * Math.sin(i / 80 * Math.PI * 5) ** 2, i / 80 - .5]);
  for (let i = 80; i >= 0; i--) bagProfile.push([.063 + .018 * Math.sin(i / 80 * Math.PI * 5) ** 2, i / 80 - .5]);
  const bag = classify(part(group, revolvedProfile(bagProfile), mats.rubber), 'spring', springType === 'air'); bag.name = 'hollow-five-convolution-bellows';
  const bagSection = part(group, revolvedProfile(bagProfile, 64, true), mats.rubber); bagSection.name = 'air-bellows-section'; bagSection.userData.presentationOnly = true; bagSection.visible = false;
  sections.push({ mesh: bag, cut: bagSection, category: 'spring' });
  const airCaps = [0, 1].map(i => annulus(`air-bellows-end-cap-${i}`, i ? .013 : radius, .079, .021, mats.metal, 'spring', false, springType === 'air'));
  const reservoir = classify(cylinder(group, .019, .18, mats.darkMetal, [.090, 0, 0]), 'damper', !integrated);
  reservoir.name = 'remote-reservoir';
  const reservoirCap = classify(cylinder(group, .021, .017, mats.brass, [.090, .089, 0]), 'damper', !integrated);
  reservoirCap.name = 'reservoir-end-cap';
  // Open-ended hose with fittings; fluid paths inside the housings are not solved.
  const hoseCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(radius, 0, 0), new THREE.Vector3(.065, -.034, 0), new THREE.Vector3(.112, -.028, 0), new THREE.Vector3(.109, .03, 0)]);
  const hose = classify(part(group, new THREE.TubeGeometry(hoseCurve, 32, .004, 8, false), mats.rubber), 'damper', !integrated); hose.name = 'reservoir-connecting-hose';
  const hoseFittings = [[radius,.0],[.109,.03]].map(([x,y])=>{
    const fitting=annulus('reservoir-hose-fitting',.004,.008,.014,mats.brass,'damper',false,!integrated);
    fitting.rotation.z=Math.PI/2; fitting.position.x=x; fitting.userData.offsetYM=y; return fitting;
  });
  const topPlate = classify(cylinder(group, .112, .028, mats.metal), 'damper', integrated);
  topPlate.name = 'macpherson-top-mount';
  const topRubber = classify(cylinder(group, .082, .035, mats.rubber), 'damper', integrated);
  topRubber.name = 'mount-isolator';
  const studs = [];
  if (integrated) for (let i = 0; i < 3; i++) {
    const angle = i * TAU / 3; studs.push(classify(fastener(group, [Math.cos(angle) * .083, 0, Math.sin(angle) * .083], mats.chrome, .012, 'y'), 'damper'));
  }
  let lastLength = -1, inspection = null, layout, minSampledTurnClearanceM = null;
  const centerBuffer=new Float64Array((SPRING_DETAIL.longitudinalSegments+1)*3);
  function applyInspection() {
    classified.forEach(mesh => { mesh.visible = mesh.userData.assemblyVisible && (!inspection || mesh.userData.detailCategory === inspection); });
    sections.forEach(({ mesh, cut, category }) => {
      cut.visible = Boolean(inspection === category && mesh.userData.assemblyVisible);
      cut.position.copy(mesh.position); cut.scale.copy(mesh.scale); if (cut.visible) mesh.visible = false;
    });
  }
  return { group, coilGeometry, setInspection(id) { inspection = id; applyInspection(); }, update(a, b) {
    const length = align(group, b, a), minY = -length / 2, maxY = length / 2;
    const bodyLength = length * .43;
    body.scale.y = bodyLength; body.position.y = minY + length * .25;
    head.position.y = minY + length * (.035 + .43 * .55);
    const rodBottom = head.position.y - .007, rodTop = minY + length * .95;
    piston.scale.y = rodTop - rodBottom; piston.position.y = (rodTop + rodBottom) / 2;
    gland.position.y = minY + length * .465 - .0065; seal.position.y = minY + length * .465 + .002;
    baseCap.position.y = minY + length * .035 + .004;
    dustBoot.scale.y = length * .16; dustBoot.position.y = minY + length * .66;
    lowerEye.position.y = minY; upperEye.position.y = maxY;
    layout = springLayout(length, springType, integrated);
    upperSeat.position.y = layout.upperSeatYM; lowerSeat.position.y = layout.lowerSeatYM;
    adjusters.forEach((adjuster, i) => { adjuster.position.y = layout.lowerSeatYM - .017 - i * .014; });
    const springLength = layout.upperSeatYM - layout.lowerSeatYM;
    bag.scale.y = springLength - .021; bag.position.y = (layout.lowerSeatYM + layout.upperSeatYM) / 2;
    airCaps[0].position.y = layout.lowerSeatYM; airCaps[1].position.y = layout.upperSeatYM;
    reservoir.position.y = minY + length * .32; reservoirCap.position.y = reservoir.position.y + .095; hose.position.y = reservoir.position.y - .078;
    hoseFittings.forEach(fitting=>{fitting.position.y=hose.position.y+fitting.userData.offsetYM;});
    topPlate.position.y = maxY - .015; topRubber.position.y = maxY - .045; studs.forEach(stud => { stud.position.y = maxY + .012; });
    if (springType !== 'air' && Math.abs(lastLength - length) > .000002) {
      updateCoilGeometry(coilGeometry, layout);
      const p=coilGeometry.attributes.position, sides=SPRING_DETAIL.radialSegments, steps=SPRING_DETAIL.longitudinalSegments;
      for(let i=0;i<=steps;i++) for(let axis=0;axis<3;axis++) centerBuffer[i*3+axis]=(p.array[i*sides*3+axis]+p.array[(i*sides+sides/2)*3+axis])*.5;
      let minDistance=Infinity;
      for(let i=0;i<=steps;i++) for(let d=Math.floor(steps/layout.turns*.875);d<=Math.ceil(steps/layout.turns*1.125)&&i+d<=steps;d++) {
        const a=i*3,b=(i+d)*3; minDistance=Math.min(minDistance,Math.hypot(centerBuffer[a]-centerBuffer[b],centerBuffer[a+1]-centerBuffer[b+1],centerBuffer[a+2]-centerBuffer[b+2]));
      }
      minSampledTurnClearanceM=minDistance-SPRING_DETAIL.wireRadiusM*2;
    }
    lastLength = length; applyInspection();
  }, getDiagnostics() {
    group.updateWorldMatrix(true, true);
    const world = mesh => mesh.getWorldPosition(new THREE.Vector3()).toArray();
    const bounds = mesh => { const box = new THREE.Box3().setFromObject(mesh); return { min: box.min.toArray(), max: box.max.toArray() }; };
    return { lengthM: lastLength, integrated, springType, turns: layout?.turns, wireRadiusM: SPRING_DETAIL.wireRadiusM,
      centerRadiusM: SPRING_DETAIL.centerRadiusM, usableSpanM: layout?.spanM, minimumSpanM: layout?.minimumSpanM,
      displayEnvelopeValid: springType === 'air' || layout?.displayEnvelopeValid, minSampledTurnClearanceM,
      coilBounds: springType === 'air' ? null : bounds(coil), lowerEye: world(lowerEye), upperEye: world(upperEye),
      seats: { lowerYM: lowerSeat.position.y, upperYM: upperSeat.position.y, lowerTopYM: lowerSeat.position.y + lowerSeat.geometry.boundingBox.max.y, upperBottomYM: upperSeat.position.y + upperSeat.geometry.boundingBox.min.y,
        lowerContactYM: springType==='air'?null:coilGeometry.boundingBox?.min.y, upperContactYM: springType==='air'?null:coilGeometry.boundingBox?.max.y, lowerBoreRadiusM: radius + .0005, upperBoreRadiusM: .025 },
      damper: { bodyLengthM: body.scale.y, bodyBoreRadiusM: bore, rodRadiusM: .013, guideBoreRadiusM: .0132, pistonRadiusM: bore - .0005,
        pistonYM: head.position.y, guideYM: gland.position.y, bodyBottomYM: body.position.y - body.scale.y / 2, bodyTopYM: body.position.y + body.scale.y / 2,
        variableEnvelope: true, hydraulicCircuitSolved: false },
      visibleMeshes: group.children.filter(o => o.visible).map(o => o.name), cutaway: sections.some(({cut})=>cut.visible) ? 'closed half-section; internal parts retain full dimensions' : null };
  }};
}

export function annotation(text, color = '#bcd0df') {
  const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(12,21,31,.80)'; ctx.beginPath(); ctx.roundRect(0, 9, 760, 76, 8); ctx.fill();
  ctx.fillStyle = color; ctx.fillRect(0, 9, 5, 76);
  ctx.font = '600 43px "Segoe UI", sans-serif'; ctx.fillText(text, 24, 62);
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map, depthTest: false, transparent: true }); material.userData.owned = true;
  const sprite = new THREE.Sprite(material); sprite.scale.set(.66, .0825, 1); sprite.renderOrder = 5; return sprite;
}

export function sidewallTexture(radius) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, 1024, 1024);
  ctx.translate(512, 512); ctx.fillStyle = '#687078';
  const writeArc = (text, centerAngle, r, size) => {
    ctx.font = `600 ${size}px "Segoe UI", sans-serif`;
    const total = [...text].reduce((n, letter) => n + ctx.measureText(letter).width + 4, 0), start = centerAngle - total / (2 * r);
    let current = start;
    for (const letter of text) {
      const width = ctx.measureText(letter).width + 4; current += width / (2 * r);
      ctx.save(); ctx.rotate(current); ctx.translate(0, -r); ctx.textAlign = 'center'; ctx.fillText(letter, 0, 0); ctx.restore(); current += width / (2 * r);
    }
  };
  writeArc('SUSPENSION LAB', 0, 405, 32);
  writeArc(`DIAMETER ${Math.round(radius * 2000)} mm   •   TEST RADIAL`, Math.PI, 402, 22);
  ctx.strokeStyle = '#343a42'; ctx.lineWidth = 1.4;
  for (const r of [360, 436, 445]) { ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke(); }
  for (let i = 0; i < 240; i++) {
    const angle = i * TAU / 240; ctx.save(); ctx.rotate(angle); ctx.fillStyle = '#383f47'; ctx.fillRect(-.9, -467, 1.8, 16); ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
