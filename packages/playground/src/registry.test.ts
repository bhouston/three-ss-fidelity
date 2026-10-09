import { describe, expect, it } from 'vitest';
import { disabledScenes } from '@three-fidelity/renderers';
import type { RendererName } from '@three-fidelity/renderers';
import { getScene, listSceneNames } from '@three-fidelity/scenes';
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
  it('covers all browser configurations on the four representative scenes except deliberate exclusions', () => {
    const suite = parseRegistry(registry);
    const entries = performanceSuite(suite, 'representative').entries;
    const scenes = ['model-breakfast-room-w', 'cornell-box-basic', 'higharc_dogwood', 'model-coffee-maker'];
    const expected = scenes.flatMap((scene) =>
      suite.renderers
        .filter(
          (renderer) =>
            renderer.kind === 'browser' &&
            renderer.id !== 'three-gpu-pathtracer-webgpu-experimental' &&
            !disabledScenes[renderer.params.renderer as RendererName]?.includes(scene),
        )
        .map((renderer) => `${scene}/${renderer.id}`),
    );
    expect(entries.map((entry) => `${entry.scene.id}/${entry.renderer.id}`).toSorted()).toEqual(expected.toSorted());
    expect(new Set(entries.map((entry) => `${entry.scene.id}/${entry.renderer.id}`)).size).toBe(entries.length);
    expect(
      entries.every(
        (entry) => entry.durationMs === 10000 && entry.params?.width === 1920 && entry.params?.height === 1080,
      ),
    ).toBe(true);
  });
});
