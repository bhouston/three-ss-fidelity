import { BufferGeometry, Float32BufferAttribute, Frustum, Matrix4, Mesh, Vector3 } from 'three';
import { ssgiScenes } from './ssgi.js';
import type { SceneDefinition } from './types.js';

/** Trim the original Cornell walls to the camera frustum, retaining the same visible surface geometry. */
export const visibleWallScenes: SceneDefinition[] = [
  {
    name: 'cornell-box-animated-visible-walls',
    description:
      'Original animated Cornell room with only its five wall/floor/ceiling planes clipped to the camera frustum; off-screen wall portions physically removed.',
    width: 640,
    height: 480,
    async create(ctx) {
      const original = ssgiScenes.find((definition) => definition.name === 'cornell-box-animated')!;
      const setup = await original.create(ctx);
      const { scene, camera } = setup;
      camera.updateMatrixWorld(true);
      scene.updateMatrixWorld(true);
      const frustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      const oldGeometries = new Set<BufferGeometry>();
      for (const object of scene.children) {
        if (!(object instanceof Mesh) || object.geometry.type !== 'PlaneGeometry') continue;
        // Cornell walls are the shared unit plane transformed by each mesh. Clip in world space.
        let polygon = [
          new Vector3(-0.5, -0.5, 0),
          new Vector3(0.5, -0.5, 0),
          new Vector3(0.5, 0.5, 0),
          new Vector3(-0.5, 0.5, 0),
        ].map((point) => point.applyMatrix4(object.matrixWorld));
        for (const plane of frustum.planes) {
          const clipped: Vector3[] = [];
          for (let i = 0; i < polygon.length; i++) {
            const a = polygon[i]!;
            const b = polygon[(i + 1) % polygon.length]!;
            const da = plane.distanceToPoint(a);
            const db = plane.distanceToPoint(b);
            if (da >= 0) clipped.push(a);
            if (da >= 0 !== db >= 0) clipped.push(a.clone().lerp(b, da / (da - db)));
          }
          polygon = clipped;
        }
        const inverse = object.matrixWorld.clone().invert();
        polygon = polygon.map((point) => point.clone().applyMatrix4(inverse));
        const vertices: number[] = [];
        for (let i = 1; i + 1 < polygon.length; i++) {
          for (const point of [polygon[0]!, polygon[i]!, polygon[i + 1]!]) vertices.push(point.x, point.y, point.z);
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
        geometry.computeVertexNormals();
        oldGeometries.add(object.geometry);
        object.geometry = geometry;
        object.name = 'frustum-clipped-wall';
      }
      for (const geometry of oldGeometries) geometry.dispose();
      return setup;
    },
  },
];
