import { expect, it } from 'vitest';
import { DirectionalLight, Group, Scene, SpotLight, Vector3 } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { getScene } from '@three-fidelity/scenes';
import { createNodeSceneContext } from '@three-fidelity/scenes/node';
import type { SceneInstance } from '@three-fidelity/scenes';
import { cloneScene } from 'fidelity-kit-three-gpu-pathtracer';

function direction(light: DirectionalLight | SpotLight): Vector3 {
  return new Vector3()
    .setFromMatrixPosition(light.matrixWorld)
    .sub(new Vector3().setFromMatrixPosition(light.target.matrixWorld))
    .normalize();
}

it.each([
  'model-grey-and-white-room',
  'model-grey-and-white-room-w',
  'model-contemporary-bathroom',
  'model-contemporary-bathroom-w',
])('preserves the window sunlight direction in %s', async (name) => {
  const setup = await getScene(name).create(createNodeSceneContext());
  const sun = setup.scene.getObjectByName('window-sun') as DirectionalLight;
  const expected = sun.position.clone().sub(sun.target.position).normalize();
  const before = clone(setup.scene) as Scene;
  before.updateMatrixWorld(true);
  expect(direction(before.getObjectByName('window-sun') as DirectionalLight).distanceTo(expected)).toBeGreaterThan(
    0.01,
  );
  const after = cloneScene(setup.scene);
  expect(direction(after.getObjectByName('window-sun') as DirectionalLight).distanceTo(expected)).toBeLessThan(1e-12);
});

it.each([DirectionalLight, SpotLight])('resolves parented targets for %s', (Light) => {
  const scene = new Scene();
  const parent = new Group();
  parent.position.set(7, 3, -2);
  parent.rotation.y = Math.PI / 3;
  const light = new Light();
  light.name = 'parented-light';
  light.position.set(-10, 8, 4);
  light.target.position.set(1, 2, 3);
  parent.add(light.target);
  scene.add(light, parent);
  const expectedTarget = light.target.position
    .clone()
    .applyAxisAngle(new Vector3(0, 1, 0), parent.rotation.y)
    .add(parent.position);
  const expected = light.position.clone().sub(expectedTarget).normalize();
  const setup = { scene, effects: {} } as SceneInstance;
  const after = cloneScene(setup.scene);
  expect(
    direction(after.getObjectByName(light.name) as DirectionalLight | SpotLight).distanceTo(expected),
  ).toBeLessThan(1e-12);
  expect(light.target.parent).toBe(parent);
  expect(light.target.position.toArray()).toEqual([1, 2, 3]);
});
