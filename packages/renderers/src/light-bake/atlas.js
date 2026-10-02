import { BufferAttribute, Vector3 } from 'three';
import { potpack } from 'three/addons/libs/potpack.module.js';

/** Connected charts with a shared dominant projection axis. Geometry and UVs belong to each instance. */
export function prepareAtlas(scene, density = 16, maxSize = 2048) {
  scene.updateMatrixWorld(true);
  const entries = [],
    charts = [];
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    n = new Vector3();
  const meshes = [];
  scene.traverseVisible((mesh) => {
    if (mesh.isMesh) meshes.push(mesh);
  });
  try {
    for (const mesh of meshes) {
      if (mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh)
        throw new Error('Light bake needs static mesh snapshots');
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      entries.push({ mesh, originalGeometry: mesh.geometry, originalMaterial: mesh.material, geometry });
      const p = geometry.attributes.position,
        uv = new Float32Array(p.count * 2);
      const count = Math.floor(p.count / 3),
        parent = Array.from({ length: count }, (_, i) => i),
        directions = new Uint8Array(count),
        owners = new Map();
      const root = (i) => {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      };
      for (let triangle = 0; triangle < count; triangle++) {
        const i = triangle * 3;
        a.fromBufferAttribute(p, i);
        b.fromBufferAttribute(p, i + 1);
        c.fromBufferAttribute(p, i + 2);
        n.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
        const components = n.toArray(),
          axis = components.map(Math.abs).indexOf(Math.max(...components.map(Math.abs)));
        const direction = axis * 2 + (components[axis] < 0 ? 1 : 0);
        directions[triangle] = direction;
        for (let j = i; j < i + 3; j++) {
          a.fromBufferAttribute(p, j);
          const key =
            direction +
            ':' +
            a
              .toArray()
              .map((v) => Math.round(v * 100000))
              .join(',');
          if (owners.has(key)) parent[root(triangle)] = root(owners.get(key));
          else owners.set(key, triangle);
        }
      }
      const groups = new Map();
      for (let triangle = 0; triangle < count; triangle++) {
        const id = root(triangle),
          axis = Math.floor(directions[triangle] / 2);
        let chart = groups.get(id);
        if (!chart) {
          const tangent = new Vector3().setComponent((axis + 1) % 3, 1),
            bitangent = new Vector3().setComponent((axis + 2) % 3, 1);
          const elements = mesh.matrixWorld.elements;
          const scale = (v) =>
            new Vector3(
              elements[0] * v.x + elements[4] * v.y + elements[8] * v.z,
              elements[1] * v.x + elements[5] * v.y + elements[9] * v.z,
              elements[2] * v.x + elements[6] * v.y + elements[10] * v.z,
            ).length();
          chart = {
            geometry,
            uv,
            indices: [],
            tangent,
            bitangent,
            min: [Infinity, Infinity],
            max: [-Infinity, -Infinity],
            scale: scale(tangent),
            scaleY: scale(bitangent),
          };
          groups.set(id, chart);
          charts.push(chart);
        }
        for (let j = triangle * 3; j < triangle * 3 + 3; j++) {
          a.fromBufferAttribute(p, j);
          const x = a.dot(chart.tangent),
            y = a.dot(chart.bitangent);
          uv[j * 2] = x;
          uv[j * 2 + 1] = y;
          chart.indices.push(j);
          chart.min[0] = Math.min(chart.min[0], x);
          chart.min[1] = Math.min(chart.min[1], y);
          chart.max[0] = Math.max(chart.max[0], x);
          chart.max[1] = Math.max(chart.max[1], y);
        }
      }
      geometry.setAttribute('uv1', new BufferAttribute(uv, 2));
    }
    let dimensions;
    for (;;) {
      for (const chart of charts) {
        chart.innerW = Math.max(2, Math.ceil((chart.max[0] - chart.min[0]) * chart.scale * density));
        chart.innerH = Math.max(2, Math.ceil((chart.max[1] - chart.min[1]) * chart.scaleY * density));
        chart.w = chart.innerW + 6;
        chart.h = chart.innerH + 6;
      }
      dimensions = potpack(charts);
      if (Math.max(dimensions.w, dimensions.h) <= maxSize) break;
      density *= 0.75;
      if (density < 0.1) throw new Error('Light bake atlas exceeds chart budget');
    }
    const size = Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(dimensions.w, dimensions.h))));
    for (const chart of charts)
      for (const j of chart.indices) {
        chart.uv[j * 2] =
          (chart.x +
            3.5 +
            ((chart.uv[j * 2] - chart.min[0]) / Math.max(chart.max[0] - chart.min[0], 1e-9)) * (chart.innerW - 1)) /
          size;
        chart.uv[j * 2 + 1] =
          (chart.y +
            3.5 +
            ((chart.uv[j * 2 + 1] - chart.min[1]) / Math.max(chart.max[1] - chart.min[1], 1e-9)) * (chart.innerH - 1)) /
          size;
      }
    for (const entry of entries) entry.mesh.geometry = entry.geometry;
    return { size, density, entries, charts };
  } catch (error) {
    for (const entry of entries) entry.geometry.dispose();
    throw error;
  }
}
