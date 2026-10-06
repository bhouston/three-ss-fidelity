import { describe, expect, it } from 'vitest';
import { getScene, listSceneNames } from '@ss-fidelity/scenes';
import { parseRegistry, performanceSuite, rendererParams } from 'fidelity-kit/registry';
import registry from '../../../registry.json';
import { performanceConfiguration } from './performance-config';

describe('shared project registry', () => {
  it('registers every runtime scene with its canonical fidelity dimensions', () => {
    const suite = parseRegistry(registry);
    expect(suite.scenes.map((scene) => scene.id).toSorted()).toEqual(listSceneNames().toSorted());
    for (const scene of suite.scenes) {
      const definition = getScene(scene.id);
      expect(scene.fidelity).toMatchObject({ width: definition.width, height: definition.height });
    }
  });
  it('uses valid browser configurations for every live renderer and opt-in performance collection', () => {
    const suite = parseRegistry(registry);
    for (const renderer of suite.renderers.filter((renderer) => renderer.kind === 'browser'))
      expect(() => performanceConfiguration(rendererParams(suite, renderer.id, suite.scenes[0]!.id))).not.toThrow();
    for (const collection of Object.keys(suite.performance)) {
      const performance = performanceSuite(suite, collection);
      expect(performance.entries.length).toBeGreaterThan(0);
      for (const entry of performance.entries) expect(() => performanceConfiguration(entry.params ?? {})).not.toThrow();
    }
  });
});
