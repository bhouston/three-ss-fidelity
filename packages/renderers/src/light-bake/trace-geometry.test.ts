import { expect, it } from 'vitest';
import { Mesh, PlaneGeometry } from 'three';
import { createBakeTraceMeshes } from './trace-geometry.js';

it('compacts duplicated atlas vertices while preserving trace UVs, world transforms and shadow flags', () => {
  const geometry = new PlaneGeometry(2, 2).toNonIndexed();
  geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
  const mesh = new Mesh(geometry);
  mesh.position.set(3, 4, 5);
  mesh.castShadow = false;
  mesh.updateMatrixWorld(true);
  const [copy] = createBakeTraceMeshes([{ mesh, geometry }]);
  try {
    expect(copy.geometry.getAttribute('position').count).toBe(4);
    expect(Object.keys(copy.geometry.attributes).toSorted()).toEqual(['position', 'uv1']);
    expect(copy.matrixWorld.equals(mesh.matrixWorld)).toBe(true);
    expect(copy.castShadow).toBe(false);
    for (let i = 0; i < geometry.getAttribute('position').count; i++) {
      const index = copy.geometry.index!.getX(i);
      for (const name of ['position', 'uv1']) {
        const before = geometry.getAttribute(name);
        const after = copy.geometry.getAttribute(name);
        for (let component = 0; component < before.itemSize; component++)
          expect(after.getComponent(index, component)).toBe(before.getComponent(i, component));
      }
    }
    expect(mesh.geometry).toBe(geometry);
  } finally {
    copy.geometry.dispose();
    geometry.dispose();
  }
});
