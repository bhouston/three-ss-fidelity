import { Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { getScene, listSceneNames } from './index.js';
import type { SceneContext } from './types.js';

const noAssets: SceneContext = {
  loadGLTF: async () => {
    throw new Error('Diagnostic must not load assets');
  },
  loadHDR: async () => {
    throw new Error('Diagnostic must not load assets');
  },
};

const sceneNames = [
  'ssr-diag-mirror',
  'ssr-diag-rough-10',
  'ssr-diag-rough-30',
  'ssr-diag-rough-60',
  'ssr-diag-dielectric-0',
  'ssr-diag-dielectric-30',
  'ssr-diag-grazing',
  'ssr-diag-offscreen',
  'ssr-diag-occlusion',
  'ssr-diag-wall',
  'ssr-diag-sphere',
  'ssr-diag-metal-hit',
];

describe('SSR diagnostic scenes', () => {
  it('registers each scene once, at 480x360, with a unique name', () => {
    const names = listSceneNames();
    for (const name of sceneNames) expect(names.filter((n) => n === name)).toHaveLength(1);
    for (const name of sceneNames) {
      const scene = getScene(name);
      expect(scene.width).toBe(480);
      expect(scene.height).toBe(360);
    }
  });

  it('uses SSR (not SSGI) with NoToneMapping, and a dim SceneEnvironment', async () => {
    for (const name of sceneNames) {
      const setup = await getScene(name).create(noAssets);
      expect(setup.effects.ssr).toBeDefined();
      expect(setup.effects.ssgi).toBeUndefined();
      expect(setup.effects.toneMapping).toBe(0); // NoToneMapping
      expect(setup.environment).toBeDefined();
      expect(setup.gradientBackground).toBeDefined();
    }
  });

  it('makes every emitter purely emissive with a black base color', async () => {
    for (const name of sceneNames) {
      const setup = await getScene(name).create(noAssets);
      const emitters = setup.scene.children.filter(
        (child): child is Mesh => child instanceof Mesh && child.name !== '' && !child.name.startsWith('receiver-'),
      );
      expect(emitters.length).toBeGreaterThan(0);
      for (const emitter of emitters) {
        const material = emitter.material as MeshStandardMaterial;
        expect(material.color.getHex()).toBe(0);
        expect(material.metalness).toBe(0);
        expect(material.roughness).toBe(1);
        expect(material.emissive.r + material.emissive.g + material.emissive.b).toBeGreaterThan(0);
        expect(material.emissive.r).toBeLessThanOrEqual(0.9);
        expect(material.emissive.g).toBeLessThanOrEqual(0.9);
        expect(material.emissive.b).toBeLessThanOrEqual(0.9);
      }
    }
  });

  it('gives metal receivers zero diffuse contribution and dielectric receivers a black base color', async () => {
    const mirror = await getScene('ssr-diag-mirror').create(noAssets);
    const mirrorFloor = mirror.scene.getObjectByName('receiver-floor') as Mesh;
    const mirrorMaterial = mirrorFloor.material as MeshStandardMaterial;
    expect(mirrorMaterial.metalness).toBe(1);
    expect(mirrorMaterial.roughness).toBe(0);

    const dielectric = await getScene('ssr-diag-dielectric-30').create(noAssets);
    const dielectricFloor = dielectric.scene.getObjectByName('receiver-floor') as Mesh;
    const dielectricMaterial = dielectricFloor.material as MeshPhysicalMaterial;
    expect(dielectricMaterial.metalness).toBe(0);
    expect(dielectricMaterial.color.getHex()).toBe(0);
    expect(dielectricMaterial.roughness).toBe(0.3);
  });

  it('places the offscreen scene emitter behind the camera', async () => {
    const setup = await getScene('ssr-diag-offscreen').create(noAssets);
    setup.scene.updateMatrixWorld(true);
    setup.camera.updateMatrixWorld(true);
    const behind = setup.scene.getObjectByName('box-behind-camera') as Mesh;
    const local = behind.position.clone().applyMatrix4(setup.camera.matrixWorldInverse);
    expect(local.z).toBeGreaterThan(0); // positive z in view space is behind the camera
  });
});
