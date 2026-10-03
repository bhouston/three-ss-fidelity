import { describe, expect, it } from 'vitest';
import type { Light } from 'three';
import { getScene } from './index.js';
import { createNodeSceneContext } from './node.js';

const interiors = [
  'model-bedroom',
  'model-breakfast-room',
  'model-contemporary-bathroom',
  'model-country-kitchen',
  'model-grey-and-white-room',
].flatMap((name) => [name, `${name}-w`]);

function lightNames(scene: { traverse(fn: (object: unknown) => void): void }): string[] {
  const names: string[] = [];
  scene.traverse((object) => {
    if ((object as Light).isLight) names.push((object as Light).name);
  });
  return names;
}

describe('complex model lighting', () => {
  it.each(interiors)('lights %s only through the windows, without an IBL', async (name) => {
    const { scene } = await getScene(name).create(createNodeSceneContext());
    expect(scene.environment).toBeNull();
    expect(scene.background).toBeNull();
    expect(lightNames(scene)).toEqual(['window-sun']);
  });

  it('keeps the studio IBL on product scenes', async () => {
    const { scene } = await getScene('model-coffee-maker').create(createNodeSceneContext());
    expect(scene.environment).not.toBeNull();
    expect(lightNames(scene)).not.toContain('window-sun');
  });
});

it.each(['model-bedroom', 'model-bedroom-w'])(
  'admits daylight through the translucent curtains in %s',
  async (name) => {
    const { scene } = await getScene(name).create(createNodeSceneContext());
    for (const portal of ['mesh_69', 'mesh_70']) expect(scene.getObjectByName(portal)?.visible).toBe(false);
    for (const curtain of ['Curtains_0001', 'Curtains_0002']) {
      const mesh = scene.getObjectByName(curtain) as import('three').Mesh;
      expect(mesh.visible).toBe(true);
      expect(mesh.castShadow).toBe(false);
      expect((mesh.material as import('three').Material).transparent).toBe(true);
    }
    expect(scene.getObjectByName('Window_0001')?.castShadow).toBe(true);
  },
);
