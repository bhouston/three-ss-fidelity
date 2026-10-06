import { Vector3 } from 'three';
import type { Material, Mesh, Texture } from 'three';
import type { SceneInstance } from './types.js';

/** Caller owns scene assets. Pipelines own their generated targets and renderer resources. */
export function disposeSceneInstance(setup: SceneInstance): void {
  const geometries = new Set<Mesh['geometry']>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const collect = (scene: SceneInstance['scene']) => {
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value as Texture);
      }
    });
    if (scene.environment) textures.add(scene.environment);
    if (scene.background && 'isTexture' in scene.background) textures.add(scene.background);
  };
  collect(setup.scene);
  if (setup.environment) collect(setup.environment.scene);
  for (const value of textures) value.dispose();
  for (const value of materials) value.dispose();
  for (const value of geometries) value.dispose();
}

/** Replay a closed camera trajectory using frame indices, never wall-clock speed. */
export function createOrbitWorkload(
  setup: SceneInstance,
  cycleFrames: number,
  degrees: number,
): (index: number) => void {
  if (!Number.isSafeInteger(cycleFrames) || cycleFrames < 1 || !Number.isFinite(degrees))
    throw new Error('Invalid orbit workload');
  const position = setup.camera.position.clone().sub(setup.target);
  const axis = new Vector3(0, 1, 0);
  return (index) => {
    const angle = (Math.sin((2 * Math.PI * (index % cycleFrames)) / cycleFrames) * degrees * Math.PI) / 180;
    setup.camera.position.copy(position).applyAxisAngle(axis, angle).add(setup.target);
    setup.camera.lookAt(setup.target);
    setup.camera.updateMatrixWorld();
  };
}
