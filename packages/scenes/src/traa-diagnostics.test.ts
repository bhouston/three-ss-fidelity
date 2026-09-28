import { Mesh, MeshStandardMaterial } from 'three';
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

const sceneNames = ['traa-checker', 'traa-disocclusion'];

describe('TRAA diagnostic scenes', () => {
  it('registers each scene once, at 480x360, with a unique name', () => {
    const names = listSceneNames();
    for (const name of sceneNames) expect(names.filter((n) => n === name)).toHaveLength(1);
    for (const name of sceneNames) {
      const scene = getScene(name);
      expect(scene.width).toBe(480);
      expect(scene.height).toBe(360);
    }
  });

  it('has no ssgi/ssr, no temporal denoise, and NoToneMapping', async () => {
    for (const name of sceneNames) {
      const setup = await getScene(name).create(noAssets);
      expect(setup.effects.ssgi).toBeUndefined();
      expect(setup.effects.ssr).toBeUndefined();
      expect(setup.effects.temporalDenoise).toBe(false);
      expect(setup.effects.toneMapping).toBe(0); // NoToneMapping
    }
  });

  it('is fully emissive: every mesh has a black-base, roughness-1 material with no diffuse contribution', async () => {
    for (const name of sceneNames) {
      const setup = await getScene(name).create(noAssets);
      setup.scene.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        const material = child.material as MeshStandardMaterial;
        expect(material).toBeInstanceOf(MeshStandardMaterial);
        expect(material.color.getHex()).toBe(0);
        expect(material.metalness).toBe(0);
        expect(material.roughness).toBe(1);
        expect(material.emissive.r + material.emissive.g + material.emissive.b).toBeGreaterThan(0);
      });
    }
  });

  it('gives traa-disocclusion a "slider-box" object at its home position (x=0) for --motion-object', async () => {
    const setup = await getScene('traa-disocclusion').create(noAssets);
    const slider = setup.scene.getObjectByName('slider-box');
    expect(slider).toBeDefined();
    expect(slider!.position.x).toBe(0);
  });
});
