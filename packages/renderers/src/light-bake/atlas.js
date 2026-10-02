import { BufferAttribute, Vector3 } from 'three';
import { potpack } from 'three/addons/libs/potpack.module.js';

// Only explicit scene/node extras identify a lightmap atlas. TEXCOORD_1 alone may be material UVs.
function atlasOwner(mesh) {
  for (let node = mesh; node; node = node.parent) {
    const metadata = node.userData.lightmapAtlas;
    if (metadata) return metadata.version === 1 && Number.isInteger(metadata.size) && metadata.size >= 8 ? node : null;
  }
  return null;
}

function validAtlasUVs(geometry) {
  const position = geometry.attributes.position,
    uv = geometry.attributes.uv1;
  if (!position || !uv || uv.itemSize !== 2 || uv.count !== position.count) return false;
  for (let i = 0; i < uv.count; i++)
    if (![uv.getX(i), uv.getY(i)].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
  const index = geometry.index,
    count = index ? index.count : position.count;
  if (!count || count % 3 !== 0) return false;
  for (let i = 0; i < count; i += 3) {
    const a = index ? index.getX(i) : i,
      b = index ? index.getX(i + 1) : i + 1,
      c = index ? index.getX(i + 2) : i + 2;
    if (![a, b, c].every((vertex) => Number.isInteger(vertex) && vertex >= 0 && vertex < uv.count)) return false;
    const area =
      (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) - (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a));
    if (!Number.isFinite(area)) return false;
    if (area === 0) {
      const abX = position.getX(b) - position.getX(a),
        abY = position.getY(b) - position.getY(a),
        abZ = position.getZ(b) - position.getZ(a),
        acX = position.getX(c) - position.getX(a),
        acY = position.getY(c) - position.getY(a),
        acZ = position.getZ(c) - position.getZ(a);
      // Zero-area source faces rasterize no surface and need no UV coverage.
      if (abY * acZ - abZ * acY !== 0 || abZ * acX - abX * acZ !== 0 || abX * acY - abY * acX !== 0) return false;
    }
  }
  return true;
}

/** Connected projection charts and explicitly marked precomputed atlases, packed per instance. */
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
  const initialDensity = density,
    precomputed = new Map(),
    atlasGroups = new Map();
  for (const mesh of meshes) {
    const owner = atlasOwner(mesh);
    if (owner) {
      if (!atlasGroups.has(owner)) atlasGroups.set(owner, []);
      atlasGroups.get(owner).push(mesh);
    }
  }
  for (const [owner, members] of atlasGroups) {
    // Shared mesh instances repeat UV islands. Fall back for the whole group so those
    // instances get independent charts. The offline unwrap should clone per-node meshes.
    if (
      new Set(members.map((mesh) => mesh.geometry)).size !== members.length ||
      !members.every((mesh) => validAtlasUVs(mesh.geometry))
    )
      continue;
    const chart = {
      precomputed: true,
      resolution: owner.userData.lightmapAtlas.size,
      padding: owner.userData.lightmapAtlas.padding,
      entries: [],
    };
    charts.push(chart);
    for (const mesh of members) precomputed.set(mesh, chart);
  }
  try {
    for (const mesh of meshes) {
      if (mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh)
        throw new Error('Light bake needs static mesh snapshots');
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      entries.push({ mesh, originalGeometry: mesh.geometry, originalMaterial: mesh.material, geometry });
      const existing = precomputed.get(mesh);
      if (existing) {
        existing.entries.push(entries[entries.length - 1]);
        continue;
      }
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
    const sole = charts.length === 1 && charts[0].precomputed ? charts[0] : null;
    if (
      sole &&
      Number.isFinite(sole.padding) &&
      sole.padding >= 3 &&
      sole.resolution >= 32 &&
      sole.resolution <= maxSize &&
      Number.isInteger(Math.log2(sole.resolution))
    ) {
      // A complete atlas can retain its original pixel grid and guaranteed padding.
      sole.x = sole.y = 0;
      sole.w = sole.h = sole.innerW = sole.innerH = sole.resolution;
      for (const entry of entries) entry.mesh.geometry = entry.geometry;
      return { size: sole.resolution, density, entries, charts };
    }
    let dimensions;
    for (;;) {
      for (const chart of charts) {
        if (chart.precomputed) {
          // Uniformly scale the entire shared atlas, preserving island proportions.
          chart.innerW = chart.innerH = Math.max(2, Math.ceil((chart.resolution * density) / initialDensity));
          chart.w = chart.h = chart.innerW + 6;
          if (
            chart.padding !== undefined &&
            (!Number.isFinite(chart.padding) || (chart.padding * (chart.innerW - 1)) / chart.resolution < 3)
          )
            throw new Error('Light bake atlas budget cannot preserve precomputed UV padding (minimum 3 pixels)');
          continue;
        }
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
    for (const chart of charts) {
      if (chart.precomputed) {
        for (const entry of chart.entries) {
          const source = entry.geometry.attributes.uv1,
            uv = new Float32Array(source.count * 2);
          for (let j = 0; j < source.count; j++) {
            uv[j * 2] = (chart.x + 3.5 + source.getX(j) * (chart.innerW - 1)) / size;
            uv[j * 2 + 1] = (chart.y + 3.5 + source.getY(j) * (chart.innerH - 1)) / size;
          }
          entry.geometry.setAttribute('uv1', new BufferAttribute(uv, 2));
        }
        continue;
      }
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
    }
    for (const entry of entries) entry.mesh.geometry = entry.geometry;
    return { size, density, entries, charts };
  } catch (error) {
    for (const entry of entries) entry.geometry.dispose();
    throw error;
  }
}
