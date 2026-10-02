import { DoubleSide, Matrix4, Mesh, Ray, Vector3, type BufferGeometry, type Scene } from 'three';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';

/** Snapshot visible, transformed, skinned/morphed and instanced triangles without changing borrowed meshes. */
export function geometrySnapshot(scene: Scene) {
  scene.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  scene.traverseVisible((object) => {
    if (!(object instanceof Mesh)) return;
    const instanced = object as Mesh & {
      isInstancedMesh?: boolean;
      count: number;
      getMatrixAt(i: number, m: Matrix4): void;
    };
    if (instanced.isInstancedMesh) {
      for (let i = 0; i < instanced.count; i++) {
        const instance = new Mesh(object.geometry, object.material);
        instanced.getMatrixAt(i, instance.matrixWorld);
        instance.matrixWorld.premultiply(object.matrixWorld);
        meshes.push(instance);
      }
    } else {
      const leaf = object.clone(false);
      leaf.matrixWorld.copy(object.matrixWorld);
      meshes.push(leaf);
    }
  });
  // StaticGeometryGenerator requires uniform indexing. Add identity indices only to owned
  // copies, retaining vertex order and skin/morph attributes for its world-space snapshot.
  const indexedCopies = new Map<BufferGeometry, BufferGeometry>();
  let geometry: BufferGeometry;
  try {
    for (const mesh of meshes) {
      if (mesh.geometry.index) continue;
      const source = mesh.geometry;
      let copy = indexedCopies.get(source);
      if (!copy) {
        copy = source.clone();
        indexedCopies.set(source, copy);
        copy.setIndex(Array.from({ length: copy.attributes.position!.count }, (_, i) => i));
      }
      mesh.geometry = copy;
    }
    const generator = new StaticGeometryGenerator(meshes);
    generator.attributes = ['position'];
    generator.useGroups = false;
    geometry = generator.generate();
  } finally {
    for (const copy of indexedCopies.values()) copy.dispose();
  }
  // Positions are world space, so geometric winding normals and hit distances are world space too.
  const bvh = new MeshBVH(geometry);
  const ray = new Ray();
  return {
    trace(origin: Vector3, direction: Vector3, far: number) {
      ray.origin.copy(origin);
      ray.direction.copy(direction);
      const hit = bvh.raycastFirst(ray, DoubleSide, 1e-6, far);
      return hit ? { distance: hit.distance, backface: hit.face!.normal.dot(direction) > 0 } : null;
    },
    dispose: () => geometry.dispose(),
  };
}

export type GeometryTrace = ReturnType<typeof geometrySnapshot>['trace'];

export function sphereDirections(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const y = 1 - (2 * i + 1) / count;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    return new Vector3(r * Math.cos(phi), y, r * Math.sin(phi));
  });
}

const relocationDirections = sphereDirections(64);

/** Bounded static relocation inspired by DDGI: escape back faces, then keep clearance from front faces. */
export function relocateProbe(origin: Vector3, spacing: Vector3, trace: GeometryTrace) {
  const position = origin.clone();
  const minSpacing = Math.min(...spacing.toArray());
  const clearance = minSpacing * 0.12;
  const maxOffset = spacing.clone().multiplyScalar(0.45);
  const far = spacing.length() * 2;
  let valid = true;
  for (let iteration = 0; iteration < 5; iteration++) {
    let backfaces = 0;
    let closestBack = Infinity,
      closestFront = Infinity;
    let backDirection: Vector3 | undefined, frontDirection: Vector3 | undefined;
    for (const direction of relocationDirections) {
      const hit = trace(position, direction, far);
      if (!hit) continue;
      if (hit.backface) {
        backfaces++;
        if (hit.distance < closestBack) {
          closestBack = hit.distance;
          backDirection = direction;
        }
      } else if (hit.distance < closestFront) {
        closestFront = hit.distance;
        frontDirection = direction;
      }
    }
    const inside = backfaces / relocationDirections.length > 0.25;
    valid = !inside;
    let delta: Vector3;
    if (inside && backDirection) delta = backDirection.clone().multiplyScalar(closestBack + clearance);
    else if (closestFront < clearance && frontDirection)
      delta = frontDirection.clone().multiplyScalar(closestFront - clearance);
    else break;
    if (iteration === 4) break; // The final iteration classifies the last proposed position.
    const proposed = position.clone().add(delta).sub(origin);
    // Restrict movement to an ellipsoid inside the original cell; do not teleport through thick solids.
    if (proposed.clone().divide(maxOffset).lengthSq() > 1) {
      valid = !inside;
      break;
    }
    position.copy(origin).add(proposed);
  }
  return { position, offset: position.clone().sub(origin), valid };
}

export function octDecode(x: number, y: number) {
  let z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1);
    y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
  }
  return new Vector3(x, y, z).normalize();
}

/** Mirror octahedral edge texels (including corners) so bilinear filtering crosses spherical seams. */
export function octBorderTexel(x: number, y: number, size: number): [number, number] {
  if (x < 0) {
    x = 0;
    y = size - 1 - y;
  } else if (x >= size) {
    x = size - 1;
    y = size - 1 - y;
  }
  if (y < 0) {
    y = 0;
    x = size - 1 - x;
  } else if (y >= size) {
    y = size - 1;
    x = size - 1 - x;
  }
  return [x, y];
}

/** Normalized distance moments: receiver and moments must use the same distance scale. */
export function momentVisibility(distance: number, mean: number, secondMoment: number) {
  if (distance <= mean) return 1;
  const variance = Math.max(secondMoment - mean * mean, 1e-6);
  const delta = distance - mean;
  return (variance / (variance + delta * delta)) ** 3;
}
