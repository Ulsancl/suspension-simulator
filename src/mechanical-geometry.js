import * as THREE from 'three';

const TAU = Math.PI * 2;
export const SPRING_DETAIL = Object.freeze({
  centerRadiusM: .057, wireRadiusM: .0075, minimumPitchM: .0165,
  lowerSeatThicknessM: .022, upperSeatThicknessM: .019,
  radialSegments: 12, longitudinalSegments: 320,
  inspectedTravelRangeM: [-.25, .25],
});

export function springLayout(lengthM, springType = 'coil', integrated = false) {
  const d = SPRING_DETAIL, turns = integrated ? 6 : springType === 'progressive' ? 10 : 8;
  const lowerSeatYM = -.26 * lengthM, upperSeatYM = .30 * lengthM;
  const bottomYM = lowerSeatYM + d.lowerSeatThicknessM / 2 + d.wireRadiusM;
  const topYM = upperSeatYM - d.upperSeatThicknessM / 2 - d.wireRadiusM;
  const spanM = topYM - bottomYM;
  return { turns, lowerSeatYM, upperSeatYM, bottomYM, topYM, spanM,
    minimumSpanM: turns * d.minimumPitchM,
    displayEnvelopeValid: spanM >= turns * d.minimumPitchM,
    progressive: springType === 'progressive' };
}

// The pitch law is a rendering convention, independent of the force solver.
// Tangents become horizontal at the two capped wire ends, which touch the
// annular seats at their lowest/highest point instead of entering a solid seat.
export function coilPoint(layout, t) {
  const d = SPRING_DETAIL, n = layout.turns, s = Math.max(0, Math.min(1, t)) * n, e = .18;
  let u = s, du = 1;
  if (s < e) { const q = s / e; u = e * (2 * q * q - q * q * q); du = 4 * q - 3 * q * q; }
  else if (s > n - e) { const q = (n - s) / e; u = n - e * (2 * q * q - q * q * q); du = 4 * q - 3 * q * q; }
  const base = Math.min(d.minimumPitchM, Math.max(0, layout.spanM / n));
  const extra = Math.max(0, layout.spanM - base * n), q = u / n;
  const f = layout.progressive ? Math.expm1(1.7 * q) / Math.expm1(1.7) : q;
  const df = layout.progressive ? 1.7 * Math.exp(1.7 * q) / Math.expm1(1.7) : 1;
  const angle = s * TAU, pitch = du * (base + extra * df / n) / TAU;
  return { x: d.centerRadiusM * Math.cos(angle), y: layout.bottomYM + base * u + extra * f,
    z: d.centerRadiusM * Math.sin(angle), angle, pitch };
}

export function createCoilGeometry() {
  const { radialSegments: sides, longitudinalSegments: steps } = SPRING_DETAIL;
  const count = (steps + 1) * sides + 2 * (sides + 1), indices = [];
  for (let i = 0; i < steps; i++) for (let j = 0; j < sides; j++) {
    const a = i * sides + j, b = i * sides + (j + 1) % sides, c = a + sides, e = b + sides;
    indices.push(a, b, c, b, e, c);
  }
  for (let end = 0; end < 2; end++) {
    const start = (steps + 1) * sides + end * (sides + 1), center = start + sides;
    for (let j = 0; j < sides; j++) {
      const a = start + j, b = start + (j + 1) % sides;
      indices.push(...(end ? [center, a, b] : [center, b, a]));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  geometry.setIndex(indices); return geometry;
}

export function updateCoilGeometry(geometry, layout) {
  const d = SPRING_DETAIL, steps = d.longitudinalSegments, sides = d.radialSegments;
  const p = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv;
  for (let i = 0; i <= steps; i++) {
    const point = coilPoint(layout, i / steps), ca = Math.cos(point.angle), sa = Math.sin(point.angle);
    const magnitude = Math.hypot(d.centerRadiusM, point.pitch);
    for (let j = 0; j < sides; j++) {
      const phi = j * TAU / sides, cp = Math.cos(phi), sp = Math.sin(phi);
      const nx = ca * cp + point.pitch * sa / magnitude * sp;
      const ny = d.centerRadiusM / magnitude * sp;
      const nz = sa * cp - point.pitch * ca / magnitude * sp;
      const index = i * sides + j;
      p.setXYZ(index, point.x + nx * d.wireRadiusM, point.y + ny * d.wireRadiusM, point.z + nz * d.wireRadiusM);
      normal.setXYZ(index, nx, ny, nz); uv.setXY(index, j / sides, i / steps);
    }
  }
  for (let end = 0; end < 2; end++) {
    const offset = (steps + 1) * sides + end * (sides + 1), source = end * steps * sides;
    const point = coilPoint(layout, end), sign = end ? 1 : -1;
    for (let j = 0; j <= sides; j++) {
      if (j < sides) p.setXYZ(offset + j, p.getX(source + j), p.getY(source + j), p.getZ(source + j));
      else p.setXYZ(offset + j, point.x, point.y, point.z);
      normal.setXYZ(offset + j, -Math.sin(point.angle) * sign, 0, Math.cos(point.angle) * sign);
    }
  }
  p.needsUpdate = true; normal.needsUpdate = true;
  geometry.computeBoundingSphere(); geometry.computeBoundingBox();
}

// A closed r/y profile revolved around Y. Each profile edge owns its vertices,
// preserving crisp machined shoulders while smoothing circumferential normals.
export function revolvedProfile(profile, segments = 64, section = false) {
  // Remove exactly collinear sampled profile points before cap triangulation;
  // otherwise a sine-profile inflection can produce float32 sliver triangles.
  profile = profile.filter((point, i, all) => {
    const previous = all[(i + all.length - 1) % all.length], next = all[(i + 1) % all.length];
    return Math.abs((point[0] - previous[0]) * (next[1] - point[1]) - (point[1] - previous[1]) * (next[0] - point[0])) > 1e-14;
  });
  const positions = [], normals = [], uvs = [], indices = [];
  for (let edge = 0; edge < profile.length; edge++) {
    const a = profile[edge], b = profile[(edge + 1) % profile.length];
    const dr = b[0] - a[0], dy = b[1] - a[1], magnitude = Math.hypot(dr, dy), start = positions.length / 3;
    for (const [r, y] of [a, b]) for (let j = 0; j <= segments; j++) {
      const angle = section ? -Math.PI / 2 + j * Math.PI / segments : j * TAU / segments, ca = Math.cos(angle), sa = Math.sin(angle);
      positions.push(r * ca, y, r * sa); normals.push(dy / magnitude * ca, -dr / magnitude, dy / magnitude * sa);
      uvs.push(j / segments, edge / profile.length);
    }
    for (let j = 0; j < segments; j++) {
      const v = start + j, w = v + segments + 1; indices.push(v, w, v + 1, v + 1, w, w + 1);
    }
  }
  if (section) {
    const triangles = THREE.ShapeUtils.triangulateShape(profile.map(([r, y]) => new THREE.Vector2(r, y)), []);
    for (const sign of [-1, 1]) {
      const start = positions.length / 3;
      for (const [r, y] of profile) { positions.push(0, y, sign * r); normals.push(-1, 0, 0); uvs.push(r, y); }
      for (const [a, b, c] of triangles) {
        const crossX = (profile[b][1] - profile[a][1]) * sign * (profile[c][0] - profile[a][0]) - sign * (profile[b][0] - profile[a][0]) * (profile[c][1] - profile[a][1]);
        indices.push(...(crossX < 0 ? [start + a, start + b, start + c] : [start + a, start + c, start + b]));
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

export function annularGeometry(inner, outer, length, bevel = .001, section = false) {
  const h = length / 2, b = Math.min(bevel, length / 4, (outer - inner) / 4);
  const geometry = revolvedProfile([[outer - b, -h], [outer, -h + b], [outer, h - b], [outer - b, h],
    [inner + b, h], [inner, h - b], [inner, -h + b], [inner + b, -h]], 64, section);
  const count = 64 * 6;
  for(let edge = 0; edge < 8; edge++) geometry.addGroup(edge * count, count, edge === 5 ? 1 : edge === 3 || edge === 7 ? 2 : 0);
  if(section) geometry.addGroup(8 * count, geometry.index.count - 8 * count, 2);
  return geometry;
}
