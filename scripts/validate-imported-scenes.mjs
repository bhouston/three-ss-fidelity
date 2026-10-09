// Explicit asset validation; CI's lightweight contracts do not download the model libraries.
import { getScene, disposeSceneInstance } from '../packages/scenes/dist/index.js';
import { createNodeSceneContext } from '../packages/scenes/dist/node.js';
import mappings from '../packages/scenes/src/pathtracer/scene-map.json' with { type: 'json' };
const selected = process.argv.slice(2);
const context = createNodeSceneContext();
let failures = 0;
for (const entry of mappings.filter((entry) => selected.length === 0 || selected.includes(entry.id))) {
  let setup;
  try {
    setup = await getScene(entry.id).create(context);
    if (Math.abs(setup.camera.aspect - entry.width / entry.height) > 1e-6) throw new Error('Camera dimensions changed');
    let meshes = 0;
    setup.scene.traverse((object) => {
      if (object.isMesh) meshes++;
    });
    if (meshes === 0) throw new Error('No model geometry');
    console.log(entry.id + ': loaded (' + meshes + ' meshes)');
  } catch (error) {
    failures++;
    console.error(entry.id, error);
  } finally {
    if (setup) disposeSceneInstance(setup);
  }
  globalThis.gc?.();
}
if (failures) process.exitCode = 1;
