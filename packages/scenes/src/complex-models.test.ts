import { describe, expect, it } from 'vitest';
import { Box3, Triangle, Vector3, type Light, type Mesh } from 'three';
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

it.each(['model-contemporary-bathroom', 'model-contemporary-bathroom-w'])(
  'faces the inverted bathroom casing pieces toward the room in %s',
  async (name) => {
    const { scene } = await getScene(name).create(createNodeSceneContext());
    scene.updateMatrixWorld(true);
    const floor = new Box3().setFromObject(scene.getObjectByName('Floor')!);
    const room = floor.getCenter(new Vector3()).add(new Vector3(0, 1, 0));
    for (const piece of ['WhiteWood_0001', 'WhiteWood_0002']) {
      const mesh = scene.getObjectByName(piece) as Mesh;
      const position = mesh.geometry.attributes.position!,
        normal = mesh.geometry.attributes.normal!,
        index = mesh.geometry.index!;
      const tri = new Triangle(),
        n = new Vector3(),
        vertexNormal = new Vector3();
      let toward = 0,
        agree = 0;
      const count = index.count / 3;
      for (let t = 0; t < count; t++) {
        (['a', 'b', 'c'] as const).forEach((k, j) =>
          tri[k].fromBufferAttribute(position, index.getX(t * 3 + j)).applyMatrix4(mesh.matrixWorld),
        );
        tri.getNormal(n);
        toward += n.dot(room.clone().sub(tri.a)) > 0 ? 1 : 0;
        vertexNormal.fromBufferAttribute(normal, index.getX(t * 3)).transformDirection(mesh.matrixWorld);
        agree += vertexNormal.dot(n) > 0 ? 1 : 0;
      }
      // Source asset: 0.13 and 0.05; the mirrored, correct WhiteWood_0003 is 0.96.
      expect(toward / count).toBeGreaterThan(0.8);
      expect(agree / count).toBe(1);
    }
  },
);
