import * as THREE from 'three';
import { part, sidewallTexture } from './rig-parts.js';

const TAU = Math.PI * 2;
const PROFILE = [
  [.605, -.101], [.619, -.109], [.642, -.119], [.659, -.120], [.680, -.123],
  [.730, -.128], [.790, -.130], [.850, -.127], [.898, -.121], [.935, -.111],
  [.960, -.098], [.974, -.081], [.981, -.057], [.983, -.028], [.983, .028],
  [.981, .057], [.974, .081], [.960, .098], [.935, .111], [.898, .121],
  [.850, .127], [.790, .130], [.730, .128], [.680, .123], [.659, .120],
  [.642, .119], [.619, .109], [.605, .101], [.594, .085], [.594, -.085], [.605, -.101],
];

function lathe(profile, radius, widthScale) {
  return new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r * radius, z * widthScale)), 128)
    .rotateX(Math.PI / 2);
}

function crownAt(z) {
  for (let i = 9; i < 18; i++) {
    const [start, left] = PROFILE[i], [end, right] = PROFILE[i + 1];
    if (z <= right) return THREE.MathUtils.lerp(start, end, (z - left) / (right - left));
  }
  return PROFILE[18][0];
}

function addTreadBlock(positions, uvs, indices, radius, widthScale, angle, pitch, z, width, length, sweep) {
  const start = positions.length / 3;
  const corners = [[-.32, -.5], [.32, -.5], [.5, -.29], [.5, .29], [.32, .5], [-.32, .5], [-.5, .29], [-.5, -.29]];
  for (const [inset, rise] of [[1, -.0015], [1, .013], [.83, .017]]) {
    for (const [u, v] of corners) {
      const axial = z + v * width * inset;
      const azimuth = angle + pitch * (u * length * inset + v * sweep);
      const radial = radius * (crownAt(axial) + rise);
      positions.push(radial * Math.sin(azimuth), -radial * Math.cos(azimuth), axial * widthScale);
      uvs.push(azimuth / TAU, axial / .22 + .5);
    }
  }
  for (let ring = 0; ring < 2; ring++) for (let i = 0; i < 8; i++) {
    const a = start + ring * 8 + i, b = start + ring * 8 + (i + 1) % 8;
    indices.push(a, b, a + 8, b, b + 8, a + 8);
  }
  for (let i = 1; i < 7; i++) indices.push(start + 16, start + 16 + i, start + 17 + i, start, start + i + 1, start + i);
}

function createTread(radius, widthScale) {
  const count = Math.max(42, Math.round(radius * TAU / .034)), pitch = TAU / count;
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i < count; i++) {
    addTreadBlock(positions, uvs, indices, radius, widthScale, i * pitch, pitch, 0, .035, .88, i % 2 ? -.24 : .24);
    for (const side of [-1, 1]) {
      const angle = (i + .30 + side * .13) * pitch;
      addTreadBlock(positions, uvs, indices, radius, widthScale, angle, pitch, side * .038, .033, .72, side * .39);
      addTreadBlock(positions, uvs, indices, radius, widthScale, angle + .21 * pitch, pitch, side * .079, .042, .85, side * .46);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildTire(parent, radius, mats) {
  const widthScale = THREE.MathUtils.clamp(radius / .34, .75, 1.28);
  const carcass = part(parent, lathe(PROFILE, radius, widthScale), mats.rubber);
  carcass.name = 'curved-shoulder-radial-tire';
  const tread = part(parent, createTread(radius, widthScale), mats.tread);
  tread.name = 'directional-tread-and-shoulder-blocks';
  const coating = new THREE.MeshStandardMaterial({
    map: sidewallTexture(radius), transparent: true, roughness: .88, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1,
  });
  coating.userData.owned = true;
  const walls = [-1, 1].map(side => {
    const profile = PROFILE.slice(3, 11).map(([r, z]) => [r, (z - .0007) * -side]);
    if (side > 0) profile.reverse();
    const geometry = lathe(profile, radius, widthScale);
    const { position, uv } = geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      uv.setXY(i, .5 + side * position.getX(i) / (radius * 2), .5 + position.getY(i) / (radius * 2));
    }
    const mesh = part(parent, geometry, coating);
    mesh.name = 'molded-sidewall-markings'; mesh.castShadow = false;
    return mesh;
  });

  const buffers = [carcass, tread, ...walls].map(mesh => {
    mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
    const { position, normal } = mesh.geometry.attributes;
    position.setUsage(THREE.DynamicDrawUsage); normal.setUsage(THREE.DynamicDrawUsage);
    return { position, normal, rest: position.array.slice(), restNormal: normal.array.slice() };
  });
  const orientation = new THREE.Quaternion(), localUp = new THREE.Vector3();
  let lastCompression = 0, displayedCompression = 0;
  return {
    meshes: [carcass, tread, ...walls], widthM: .26 * widthScale,
    update(state) {
      // The model provides radial compression and the effective road support.
      // Flatten a local region in world vertical, keeping the rim and axle rigid.
      displayedCompression = THREE.MathUtils.clamp(state.tireCompression, 0, radius * .27);
      if (!displayedCompression && !lastCompression) return displayedCompression;
      lastCompression = displayedCompression;
      parent.getWorldQuaternion(orientation).invert(); localUp.set(0, 1, 0).applyQuaternion(orientation);
      const { x, y, z } = localUp;
      const limit = -radius + displayedCompression;
      const blend = Math.min(displayedCompression * .65, radius * .10);
      for (const { position, normal, rest, restNormal } of buffers) {
        position.array.set(rest); normal.array.set(restNormal);
        for (let j = 0; j < rest.length && blend > 0; j += 3) {
          const height = x * rest[j] + y * rest[j + 1] + z * rest[j + 2];
          const above = height - limit;
          if (above >= blend) continue;
          const t = Math.max(0, above / blend);
          const correction = limit + blend * t * t * (2 - t) - height;
          position.setXYZ(j / 3, rest[j] + x * correction, rest[j + 1] + y * correction, rest[j + 2] + z * correction);
          const slope = Math.max(.035, 4 * t - 3 * t * t);
          const component = (x * restNormal[j] + y * restNormal[j + 1] + z * restNormal[j + 2]) * (1 / slope - 1);
          const nx = restNormal[j] + x * component, ny = restNormal[j + 1] + y * component, nz = restNormal[j + 2] + z * component;
          const length = Math.hypot(nx, ny, nz) || 1;
          normal.setXYZ(j / 3, nx / length, ny / length, nz / length);
        }
        position.needsUpdate = true; normal.needsUpdate = true;
      }
      return displayedCompression;
    },
  };
}
