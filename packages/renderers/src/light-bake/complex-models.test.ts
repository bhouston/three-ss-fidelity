import { describe, expect, it } from 'vitest';
import { DirectionalLight, Mesh, MeshPhysicalMaterial, PerspectiveCamera, Vector3 } from 'three';
import { complexModelScenes } from '../../../scenes/src/complex-models.js';
import { createNodeSceneContext } from '../../../scenes/src/node.js';
import { disposeSceneSetup } from '../../../scenes/src/lifecycle.js';
import { prepareAtlas } from './atlas.js';

describe('complex model assets', () => {
  it.each(complexModelScenes)(
    '$name loads with a reusable scene-wide lightmap atlas',
    async (definition) => {
      const baseName = definition.name.replace(/-w$/, '');
      const setup = await definition.create(createNodeSceneContext());
      const model = setup.scene.children.find((child) => child.userData.lightmapAtlas);
      expect(model).toBeDefined();
      expect(model!.userData.lightmapAtlas).toMatchObject({ version: 1, size: 2048 });
      const originals = new Map<Mesh, Mesh['geometry']>();
      let transmission = false;
      let embedded: PerspectiveCamera | undefined;
      model!.traverseVisible((object) => {
        if ((object as PerspectiveCamera).isPerspectiveCamera) embedded ??= object as PerspectiveCamera;
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        originals.set(mesh, mesh.geometry);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (definition.name.endsWith('-w')) {
            const surface = material as MeshPhysicalMaterial;
            expect(surface.color.toArray()).toEqual([1, 1, 1]);
            expect(surface.vertexColors).toBe(false);
            if (surface.map) {
              const pixels = (surface.map.image as { data: Uint8Array }).data;
              for (let i = 0; i < pixels.length; i += 4)
                if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255)
                  throw new Error('White scene contains tinted texture pixels');
            }
          }
          if (material instanceof MeshPhysicalMaterial && material.transmission > 0) transmission = true;
        }
      });
      if (baseName === 'khronos-transmission-test' || baseName === 'model-coffee-maker')
        expect(transmission).toBe(true);
      if (embedded) {
        expect(setup.camera.position.distanceTo(embedded.getWorldPosition(new Vector3()))).toBeLessThan(1e-6);
        expect(
          setup.camera.getWorldDirection(new Vector3()).dot(embedded.getWorldDirection(new Vector3())),
        ).toBeCloseTo(1);
      }
      const sun = setup.scene.getObjectByName('window-sun') as DirectionalLight | undefined;
      if (
        baseName !== 'model-coffee-maker' &&
        baseName !== 'model-headphone-with-stand' &&
        baseName !== 'khronos-transmission-test'
      ) {
        expect(sun).toBeDefined();
        expect(sun!.castShadow).toBe(true);
        expect(sun!.isDirectionalLight).toBe(true);
        expect(sun!.position.y).toBeGreaterThan(sun!.target.position.y);
      } else expect(sun).toBeUndefined();
      const atlas = prepareAtlas(setup.scene);
      try {
        const reused = atlas.charts.filter((chart) => chart.precomputed);
        expect(reused).toHaveLength(1);
        expect(reused[0]!.entries).toHaveLength(originals.size);
        expect(atlas.size).toBeLessThanOrEqual(2048);
        if (baseName !== 'model-headphone-with-stand') expect(atlas.charts).toHaveLength(1);
      } finally {
        for (const entry of atlas.entries) {
          entry.mesh.geometry = entry.originalGeometry;
          entry.geometry.dispose();
        }
        disposeSceneSetup(setup);
      }
    },
    30_000,
  );
});
