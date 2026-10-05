import { Mesh, Raycaster, Vector2, Vector3 } from 'three';
import { expect, it } from 'vitest';
import { getScene } from './index.js';
import { createNodeSceneContext } from './node.js';

it('clips Cornell wall vertices to the frustum without changing interior primary-ray wall hits', async () => {
  const ctx = createNodeSceneContext();
  const original = await getScene('cornell-box-animated').create(ctx);
  const clipped = await getScene('cornell-box-animated-visible-walls').create(ctx);
  original.scene.updateMatrixWorld(true);
  original.camera.updateMatrixWorld(true);
  clipped.scene.updateMatrixWorld(true);
  const originalWalls = original.scene.children.filter(
    (object) => object instanceof Mesh && object.geometry.type === 'PlaneGeometry',
  );
  const clippedWalls = clipped.scene.children.filter((object) => object.name === 'frustum-clipped-wall') as Mesh[];
  expect(clippedWalls).toHaveLength(5);
  for (const wall of clippedWalls) {
    const positions = wall.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const ndc = new Vector3()
        .fromBufferAttribute(positions, i)
        .applyMatrix4(wall.matrixWorld)
        .project(clipped.camera);
      expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1.00001);
      expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1.00001);
    }
  }
  const ray = new Raycaster();
  for (let x = -0.95; x < 1; x += 0.2)
    for (let y = -0.95; y < 1; y += 0.2) {
      ray.setFromCamera(new Vector2(x, y), original.camera);
      const a = ray.intersectObjects(originalWalls)[0];
      const b = ray.intersectObjects(clippedWalls)[0];
      expect(Boolean(a)).toBe(Boolean(b));
      if (a) expect(b!.distance).toBeCloseTo(a.distance, 4);
    }
}, 30_000);
