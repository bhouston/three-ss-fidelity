import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { gltfExampleScenes } from './gltf-examples.js';
import { complexModelScenes } from './complex-models.js';
import { higharcScenes } from './higharc.js';
import { RGBAKTX2Loader } from './ktx2.js';
import { giDiagnosticScenes } from './gi-diagnostics.js';
import { visibleWallScenes } from './gi-visible-walls.js';
import { ssgiScenes } from './ssgi.js';
import { ssrScenes } from './ssr.js';
import { ssrDiagnosticScenes } from './ssr-diagnostics.js';
import { traaDiagnosticScenes } from './traa-diagnostics.js';
import type { SceneContext, SceneDefinition } from './types.js';

export type * from './types.js';
export * from './lifecycle.js';
export { ANIMATED_POSE_TIME } from './ssgi.js';

const scenes = new Map<string, SceneDefinition>(
  [
    ...ssgiScenes,
    ...ssrScenes,
    ...higharcScenes,
    ...gltfExampleScenes,
    ...complexModelScenes,
    ...giDiagnosticScenes,
    ...visibleWallScenes,
    ...ssrDiagnosticScenes,
    ...traaDiagnosticScenes,
  ].map((scene) => [scene.name, scene]),
);

export function listSceneNames(): string[] {
  return [...scenes.keys()];
}

export function getScene(name: string): SceneDefinition {
  const scene = scenes.get(name);
  if (!scene) throw new Error(`Unknown scene "${name}". Available: ${listSceneNames().join(', ')}`);
  return scene;
}

/** Browser context: `baseUrl` serves the contents of `submodules/three.js/examples/` (e.g. '/three-examples/'). */
export function createBrowserSceneContext(baseUrl: string, assetsBaseUrl = '/suite-assets/'): SceneContext {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const dracoLoader = new DRACOLoader().setDecoderPath(`${base}jsm/libs/draco/`);
  const loader = new GLTFLoader()
    .setDRACOLoader(dracoLoader)
    .setKTX2Loader(new RGBAKTX2Loader().setTranscoderPath(`${base}jsm/libs/basis/`))
    .setMeshoptDecoder(MeshoptDecoder);
  return {
    loadGLTF: (path) =>
      loader.loadAsync(
        path.startsWith('suite-assets/')
          ? assetsBaseUrl.replace(/\/$/, '') + '/' + path.slice('suite-assets/'.length)
          : base + path,
      ),
    loadHDR: (path) => new HDRLoader().loadAsync(base + path),
  };
}
