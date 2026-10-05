import { Vector3 } from 'three';
import { expect, it } from 'vitest';
import { getScene } from './index.js';
import { disposeSceneSetup } from './lifecycle.js';
import { createNodeSceneContext } from './node.js';

// Serialization UUIDs differ between instances; their ordered values should match exactly.
function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, 'uuid');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
  }
  return value;
}

it('reproduces the oblique live-viewer camera while preserving the basic Cornell scene', async () => {
  const ctx = createNodeSceneContext();
  const basic = await getScene('cornell-box-basic').create(ctx);
  const definition = getScene('cornell-box-basic-oblique');
  const oblique = await definition.create(ctx);
  try {
    expect([definition.width, definition.height]).toEqual([960, 540]);
    expect(oblique.camera.position.toArray()).toEqual([-10.821845368481219, 22.26621572392704, 23.639592219224244]);
    expect(oblique.target.toArray()).toEqual([0, 7, 0]);
    expect(oblique.camera.aspect).toBe(960 / 540);
    expect(
      oblique.camera
        .getWorldDirection(new Vector3())
        .distanceTo(oblique.target.clone().sub(oblique.camera.position).normalize()),
    ).toBeLessThan(1e-12);
    expect(oblique.effects).toEqual(basic.effects);
    expect(normalize(oblique.scene.toJSON())).toEqual(normalize(basic.scene.toJSON()));
  } finally {
    disposeSceneSetup(basic);
    disposeSceneSetup(oblique);
  }
});
