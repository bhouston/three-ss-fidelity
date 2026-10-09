import { describe, expect, it } from 'vitest';
import { pathtracerScenes } from './index.js';
import mappings from './scene-map.json' with { type: 'json' };
import { createNodeSceneContext } from '../node.js';
import { disposeSceneInstance } from '../lifecycle.js';

describe('imported scene identities', () => {
  it('maps all 200 source scenes once without collisions or dimension changes', () => {
    expect(pathtracerScenes).toHaveLength(200);
    expect(new Set(mappings.map((entry) => entry.source)).size).toBe(200);
    expect(new Set(mappings.map((entry) => entry.id)).size).toBe(200);
    for (const entry of mappings) {
      const scene = pathtracerScenes.find((scene) => scene.name === entry.id);
      expect(scene).toMatchObject({ width: entry.width, height: entry.height });
      expect(entry.id).toMatch(/^pt-[a-z0-9_-]+$/);
    }
  });
  it.each(pathtracerScenes.filter((scene) => scene.name.startsWith('pt-gi-') && scene.name !== 'pt-gi-model'))(
    'creates $name with the unified effects contract',
    async (definition) => {
      const setup = await definition.create(createNodeSceneContext());
      try {
        expect(setup.camera.aspect).toBeCloseTo(definition.width / definition.height);
        expect(setup.effects.frames).toBe(1);
        expect(setup.effects.temporalDenoise).toBe(false);
      } finally {
        disposeSceneInstance(setup);
      }
    },
  );
});
