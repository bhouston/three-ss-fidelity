// Planar mirrors for the VPL Mirror renderer: flat faces of near-perfect metal meshes are detected and shown through
// the fork's TSL ReflectorNode (a mirrored virtual camera with an oblique clip plane) instead of SSR.
import { BufferAttribute, Object3D, Quaternion, Vector3 } from 'three';
import type { Color, Mesh, MeshStandardMaterial, Scene } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, reflector } from 'three/tsl';
import { reflectedVelocity } from './velocity.js';

/** A metal this smooth reflects like silvered glass, and SSR can't show it faithfully. */
const MIN_METALNESS = 0.9;
const MAX_ROUGHNESS = 0.05;
/** Faces count as one plane within this normal dot product and this offset relative to the mesh's size. */
const SAME_NORMAL = 0.9995;
const SAME_OFFSET = 1e-3;
/** A plane is a mirror face when it holds at least this share of the mesh's surface (bevels and edges don't). */
const MIN_AREA_SHARE = 0.25;
const NAME_HINT = /mirror/i;

export interface MirrorFace {
  /** World-space unit normal of the faces' winding. */
  normal: Vector3;
  point: Vector3;
  /** Triangle indices of the mesh that lie in this plane. */
  triangles: number[];
}

const isStandard = (material: unknown): material is MeshStandardMaterial =>
  !!(material as MeshStandardMaterial | undefined)?.isMeshStandardMaterial;

/**
 * The large flat faces of a mirror-like mesh. Materials driven by metalness/roughness textures can't be judged from
 * their factors, so a "mirror" name opts them in (the bathroom's `Mirror` node, a thin slab: two big faces and bevels).
 */
export function detectMirrorFaces(mesh: Mesh): MirrorFace[] {
  const material = mesh.material;
  if (Array.isArray(material) || !isStandard(material)) return [];
  const textured = !!(material.metalnessMap || material.roughnessMap);
  const smooth = material.metalness >= MIN_METALNESS && material.roughness <= MAX_ROUGHNESS;
  if (!(textured ? NAME_HINT.test(mesh.name) || NAME_HINT.test(material.name) : smooth)) return [];
  const position = mesh.geometry.getAttribute('position');
  if (!position) return [];

  mesh.updateWorldMatrix(true, false);
  const index = mesh.geometry.index;
  const triangles = (index ? index.count : position.count) / 3;
  const vertex = (t: number, k: number) =>
    new Vector3()
      .fromBufferAttribute(position, index ? index.getX(t * 3 + k) : t * 3 + k)
      .applyMatrix4(mesh.matrixWorld);

  const size = new Vector3();
  mesh.geometry.computeBoundingBox();
  mesh.geometry.boundingBox!.getSize(size).multiply(new Vector3().setFromMatrixScale(mesh.matrixWorld));
  const tolerance = size.length() * SAME_OFFSET;

  const faces: (MirrorFace & { area: number; offset: number })[] = [];
  let total = 0;
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [vertex(t, 0), vertex(t, 1), vertex(t, 2)] as [Vector3, Vector3, Vector3];
    const normal = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    const area = normal.length() / 2;
    if (area === 0) continue;
    normal.normalize();
    total += area;
    const offset = normal.dot(a);
    let face = faces.find((f) => f.normal.dot(normal) > SAME_NORMAL && Math.abs(f.offset - offset) < tolerance);
    if (!face) faces.push((face = { normal, point: new Vector3(), triangles: [], area: 0, offset }));
    face.triangles.push(t);
    face.area += area;
    face.point.addScaledVector(a.add(b).add(c), area / 3);
  }
  return faces
    .filter((f) => f.area >= total * MIN_AREA_SHARE)
    .map(({ normal, point, triangles: tris, area }) => ({ normal, point: point.divideScalar(area), triangles: tris }));
}

export interface MirrorPlane {
  normal: Vector3;
  point: Vector3;
  /** Tint of the reflection (the mirror's metal color). */
  color: Color;
}

/** World planes of every mirror face, for transport that must bounce light off them. */
export function findMirrorPlanes(scene: Scene): MirrorPlane[] {
  scene.updateMatrixWorld(true);
  const planes: MirrorPlane[] = [];
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const { normal, point } of detectMirrorFaces(mesh))
      planes.push({ normal, point, color: (mesh.material as MeshStandardMaterial).color });
  });
  return planes;
}

export interface Mirrors {
  count: number;
  dispose(): void;
}

/** Gives every mirror face its own emissive material slot showing its reflection; dispose() restores the meshes. */
export function createMirrors(scene: Scene): Mirrors {
  const swaps: {
    mesh: Mesh;
    original: Mesh['material'];
    geometry: Mesh['geometry'];
    groups: Mesh['geometry']['groups'];
    index: Mesh['geometry']['index'];
    materials: MeshStandardNodeMaterial[];
    nodes: { dispose(): void }[];
  }[] = [];
  scene.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  scene.traverse((object) => (object as Mesh).isMesh && meshes.push(object as Mesh));
  for (const mesh of meshes) {
    const faces = detectMirrorFaces(mesh);
    if (faces.length === 0) continue;
    const original = mesh.material as MeshStandardMaterial;
    const geometry = mesh.geometry;
    const previous = { index: geometry.index, groups: geometry.groups };
    const triangleCount = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
    const source = (t: number) =>
      geometry.index ? [0, 1, 2].map((k) => geometry.index!.getX(t * 3 + k)) : [0, 1, 2].map((k) => t * 3 + k);

    // one index range per mirror face after the untouched remainder: material slot 0 stays the original surface
    const claimed = new Set(faces.flatMap((f) => f.triangles));
    const order = [
      Array.from({ length: triangleCount }, (_, t) => t).filter((t) => !claimed.has(t)),
      ...faces.map((f) => f.triangles),
    ];
    const indices = new Uint32Array(triangleCount * 3);
    geometry.clearGroups();
    let cursor = 0;
    order.forEach((triangles, slot) => {
      if (triangles.length === 0) return;
      geometry.addGroup(cursor * 3, triangles.length * 3, slot);
      for (const t of triangles) indices.set(source(t), 3 * cursor++);
    });
    geometry.setIndex(new BufferAttribute(indices, 1));

    const nodes: { dispose(): void }[] = [];
    const materials = faces.map((face) => {
      const target = new Object3D(); // ReflectorNode mirrors across this object's local XY plane
      target.position.copy(face.point);
      target.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), face.normal));
      target.updateMatrixWorld(true);
      const node = reflector({ target, bounces: false, depth: true });
      nodes.push(node);
      // black, fully rough and non-metal so no lighting or SSR shows; the reflection is the surface's own emission
      const material = new MeshStandardNodeMaterial({
        side: original.side,
        color: 0x000000,
        metalness: 0,
        roughness: 1,
      });
      material.emissiveNode = node.mul(color(original.color));
      // the pre-pass velocity of this surface is that of the reflected content (see MirrorAwareVelocityNode)
      material.userData.mirrorVelocity = reflectedVelocity(node);
      material.customProgramCacheKey = () => 'mirror';
      return material;
    });
    mesh.material = [original, ...materials];
    swaps.push({ mesh, original, geometry, ...previous, materials, nodes });
  }
  return {
    count: swaps.length,
    dispose() {
      for (const { mesh, original, geometry, index, groups, materials, nodes } of swaps) {
        mesh.material = original;
        geometry.setIndex(index);
        geometry.groups = groups;
        for (const material of materials) material.dispose();
        for (const node of nodes) node.dispose();
      }
    },
  };
}
