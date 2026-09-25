import { Mesh, MeshPhysicalMaterial, Raycaster, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getScene } from './index.js';
import type { SceneContext } from './types.js';

const noAssets: SceneContext = {
  loadGLTF: async () => {
    throw new Error('Diagnostic must not load assets');
  },
  loadHDR: async () => {
    throw new Error('Diagnostic must not load assets');
  },
};

describe('GI diagnostic controls', () => {
  it('removes off-screen room geometry without changing visible primary-ray surfaces', async () => {
    const closed = await getScene('gi-room-high-albedo').create(noAssets);
    const open = await getScene('gi-room-open-high-albedo').create(noAssets);
    expect(open.scene.getObjectByName('front')).toBeUndefined();
    expect(open.scene.getObjectByName('ceiling')).toBeUndefined();
    for (const setup of [closed, open]) {
      setup.scene.updateMatrixWorld(true);
      setup.camera.updateMatrixWorld(true);
    }
    const ray = new Raycaster();
    for (let x = -0.99; x < 1; x += 0.1)
      for (let y = -0.99; y < 1; y += 0.1) {
        ray.setFromCamera(new Vector2(x, y), closed.camera);
        const a = ray.intersectObjects(closed.scene.children)[0];
        ray.setFromCamera(new Vector2(x, y), open.camera);
        const b = ray.intersectObjects(open.scene.children)[0];
        expect(a?.object.name).toBe(b?.object.name);
        expect(a?.distance).toBeCloseTo(b!.distance);
      }
  });
  it('keeps the corner emitter fully visible, black-albedo, and independent of scene lights', async () => {
    const { scene, camera, effects } = await getScene('gi-emitter-corner').create(noAssets);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const emitter = scene.getObjectByName('emitter') as Mesh;
    const material = emitter.material as MeshPhysicalMaterial;
    expect(material.color.getHex()).toBe(0);
    expect(material.emissive.r).toBe(0.5);
    expect(scene.environment).toBeNull();
    expect(effects.ssr).toBeUndefined();
    expect(scene.children.every((child) => child instanceof Mesh)).toBe(true);
    for (const x of [-5, 5])
      for (const y of [0, 6]) {
        const ndc = new Vector3(x, y, -5).project(camera);
        expect(Math.abs(ndc.x)).toBeLessThan(1);
        expect(Math.abs(ndc.y)).toBeLessThan(1);
      }
  });

  it('changes only FOV between enclosure views and excludes all emitters from the crop', async () => {
    const wide = await getScene('gi-emitter-enclosure-wide').create(noAssets);
    const crop = await getScene('gi-emitter-enclosure-crop').create(noAssets);
    expect(crop.camera.position.toArray()).toEqual(wide.camera.position.toArray());
    expect(crop.camera.quaternion.toArray()).toEqual(wide.camera.quaternion.toArray());
    expect(crop.scene.children.map((child) => child.name)).toEqual(wide.scene.children.map((child) => child.name));
    crop.scene.updateMatrixWorld(true);
    crop.camera.updateMatrixWorld(true);
    const ray = new Raycaster();
    for (const x of [-1, 0, 1])
      for (const y of [-1, 0, 1]) {
        ray.setFromCamera(new Vector2(x, y), crop.camera);
        expect(ray.intersectObjects(crop.scene.children)[0]?.object.name).toBe('receiver-floor');
      }
  });
});
