import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { higharcScenes } from './higharc.js';
import { giDiagnosticScenes } from './gi-diagnostics.js';
import { visibleWallScenes } from './gi-visible-walls.js';
import { ssgiScenes } from './ssgi.js';
import { ssrScenes } from './ssr.js';
import type { SceneContext, SceneDefinition } from './types.js';

export type * from './types.js';
export { ANIMATED_POSE_TIME } from './ssgi.js';

const scenes = new Map<string, SceneDefinition>(
  [...ssgiScenes, ...ssrScenes, ...higharcScenes, ...giDiagnosticScenes, ...visibleWallScenes].map((scene) => [
    scene.name,
    scene,
  ]),
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
export function createBrowserSceneContext(baseUrl: string): SceneContext {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const dracoLoader = new DRACOLoader().setDecoderPath(`${base}jsm/libs/draco/`);
  const loader = new GLTFLoader().setDRACOLoader(dracoLoader);
  return {
    loadGLTF: (path) => loader.loadAsync(base + path),
    loadHDR: (path) => new HDRLoader().loadAsync(base + path),
  };
}
