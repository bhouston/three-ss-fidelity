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
  it('isolates radiance filtering with black emissive stripes and a thin unlit blocker', async () => {
    const { scene, effects } = await getScene('gi-hierarchy-discontinuity').create(noAssets);
    expect(effects.ssr).toBeUndefined();
    expect(effects.ssgi?.stepCount).toBe(32);
    const stripes = scene.children.filter((mesh) => mesh.name.startsWith('emitter-stripe-')) as Mesh[];
    expect(stripes).toHaveLength(16);
    for (const mesh of stripes) {
      const material = mesh.material as MeshPhysicalMaterial;
      expect(material.color.getHex()).toBe(0);
      expect(material.emissive.r + material.emissive.g).toBe(0.8);
      expect(material.emissive.r * material.emissive.g).toBe(0);
    }
    const blocker = scene.getObjectByName('thin-blocker') as Mesh;
    expect((blocker.material as MeshPhysicalMaterial).emissive.getHex()).toBe(0);
  });
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

it('seals the probe-leakage partition across floor, ceiling and both end walls', async () => {
  for (const [name, thickness] of [
    ['gi-probe-thin-wall', 0.06],
    ['gi-probe-thick-wall', 0.6],
  ] as const) {
    const setup = await getScene(name).create(noAssets);
    const wall = setup.scene.getObjectByName('opaque-partition') as Mesh;
    wall.geometry.computeBoundingBox();
    const size = wall.geometry.boundingBox!.getSize(new Vector3());
    expect(size.x).toBeCloseTo(thickness);
    expect(size.y).toBe(6);
    expect(size.z).toBe(10);
    expect(setup.scene.environment).toBeNull();
    expect(setup.effects.ssr).toBeUndefined();
    const emitter = setup.scene.getObjectByName('partition-emitter') as Mesh;
    expect((emitter.material as MeshPhysicalMaterial).color.getHex()).toBe(0);
  }
});
