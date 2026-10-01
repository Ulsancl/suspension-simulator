import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
  const body = cylinder(group, integrated ? .043 : .031, 1, mats.red);
  const piston = cylinder(group, .013, 1, mats.chrome);
  const dustBoot = cylinder(group, .024, 1, mats.rubber);
  const lowerEye = bearing(group, [0, 0, 0], mats, integrated ? .92 : .74, 'x');
  const upperEye = bearing(group, [0, 0, 0], mats, integrated ? 1.05 : .74, 'x');
  const upperSeat = cylinder(group, .071, .019, mats.darkMetal);
  const lowerSeat = cylinder(group, .074, .022, mats.metal);
  const adjusters = [-.006, .011].map(y => cylinder(group, .052, .011, mats.brass, [0, y, 0], 32));
  const springStart = new THREE.Group(), springEnd = new THREE.Group(); group.add(springStart, springEnd);
  const coilSegments = 240, sides = 8, positions = new Float32Array((coilSegments + 1) * sides * 3), normals = positions.slice(), indices = [];
  for (let i = 0; i < coilSegments; i++) for (let s = 0; s < sides; s++) {
    const a = i * sides + s, b = i * sides + (s + 1) % sides, c = (i + 1) * sides + s, d = (i + 1) * sides + (s + 1) % sides; indices.push(a, c, b, b, c, d);
  }
  const coilGeometry = new THREE.BufferGeometry();
  coilGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); coilGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3)); coilGeometry.setIndex(indices);
  coilGeometry.boundingSphere = new THREE.Sphere();
  const coil = part(group, coilGeometry, mats.spring); coil.name = springType === 'progressive' ? 'variable-pitch-coil' : 'helical-coil';
  coil.visible = springType !== 'air';
  const bagProfile = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80, bellows = Math.pow(Math.sin(t * Math.PI * 5), 2);
    bagProfile.push(new THREE.Vector2(.066 + .018 * bellows, t - .5));
  }
  const bag = part(group, new THREE.LatheGeometry(bagProfile, 64), mats.rubber); bag.visible = springType === 'air'; bag.name = 'five-convolution-bellows';
  const airCaps = [-1, 1].map(sign => cylinder(group, .079, .021, mats.metal)); airCaps.forEach(o => { o.visible = springType === 'air'; });
  const reservoir = cylinder(group, .019, .18, mats.darkMetal, [.090, 0, 0]); reservoir.visible = !integrated;
  const reservoirCap = cylinder(group, .021, .017, mats.brass, [.090, .089, 0]); reservoirCap.visible = !integrated;
  const hose = ring(group, .059, .004, mats.rubber, [.045, -.03, 0], 32); hose.scale.set(.8, 1.3, 1); hose.visible = !integrated;
  const topPlate = cylinder(group, .112, .028, mats.metal); topPlate.visible = integrated;
  const topRubber = cylinder(group, .082, .035, mats.rubber); topRubber.visible = integrated;
  const studs = [];
  if (integrated) for (let i = 0; i < 3; i++) {
    const angle = i * TAU / 3; studs.push(fastener(group, [Math.cos(angle) * .083, 0, Math.sin(angle) * .083], mats.chrome, .012, 'y'));
  }
  let lastLength = -1;
  return { group, coilGeometry, update(a, b) {
    const length = align(group, b, a), minY = -length / 2, maxY = length / 2;
    const bodyLength = length * .43;
    body.scale.y = bodyLength; body.position.y = minY + length * .25;
    piston.scale.y = length * .56; piston.position.y = minY + length * .67;
    dustBoot.scale.y = length * .16; dustBoot.position.y = minY + length * .66;
    lowerEye.position.y = minY; upperEye.position.y = maxY;
    const springBottom = minY + length * .24, springTop = minY + length * .80, springLength = springTop - springBottom;
    upperSeat.position.y = springTop; lowerSeat.position.y = springBottom;
    adjusters.forEach((adjuster, i) => { adjuster.position.y = springBottom - .024 - i * .017; });
    bag.scale.y = springLength; bag.position.y = (springBottom + springTop) / 2;
    airCaps[0].position.y = springBottom; airCaps[1].position.y = springTop;
    reservoir.position.y = minY + length * .32; reservoirCap.position.y = reservoir.position.y + .095; hose.position.y = reservoir.position.y - .078;
    topPlate.position.y = maxY - .015; topRubber.position.y = maxY - .045; studs.forEach(stud => { stud.position.y = maxY + .012; });
    if (springType !== 'air' && Math.abs(lastLength - length) > .000002) {
      const turns = springType === 'progressive' ? 10 : 8, radius = .057, wire = .0075;
      for (let i = 0; i <= coilSegments; i++) {
        const t = i / coilSegments, rise = springType === 'progressive' ? (Math.exp(t * 1.7) - 1) / (Math.exp(1.7) - 1) : t;
        const angle = t * turns * TAU, ca = Math.cos(angle), sa = Math.sin(angle);
        const pitch = springLength * (springType === 'progressive' ? 1.7 * Math.exp(t * 1.7) / (Math.exp(1.7) - 1) : 1) / (turns * TAU);
        const magnitude = Math.hypot(radius, pitch), cx = pitch * sa / magnitude, cy = radius / magnitude, cz = -pitch * ca / magnitude;
        for (let s = 0; s < sides; s++) {
          const phase = s * TAU / sides, cp = Math.cos(phase), sp = Math.sin(phase), nx = ca * cp + cx * sp, ny = cy * sp, nz = sa * cp + cz * sp, index = (i * sides + s) * 3;
          positions[index] = ca * radius + nx * wire;
          positions[index + 1] = springBottom + rise * springLength + ny * wire;
          positions[index + 2] = sa * radius + nz * wire;
          normals[index] = nx; normals[index + 1] = ny; normals[index + 2] = nz;
        }
      }
      coilGeometry.attributes.position.needsUpdate = true; coilGeometry.attributes.normal.needsUpdate = true;
      coilGeometry.boundingSphere.center.set(0, (springBottom + springTop) / 2, 0); coilGeometry.boundingSphere.radius = Math.hypot(springLength / 2 + wire, radius + wire);
      lastLength = length;
    }
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
