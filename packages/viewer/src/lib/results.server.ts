import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getScene, listSceneNames } from '@ss-fidelity/scenes';
import { SCREEN_SPACE_RENDERERS, type PassName, type SceneMetrics, type SceneSummary } from '#/lib/scenes';

export const REFERENCE_FILE = 'three-gpu-pathtracer.avif';

/** results/<scene>/<pass>/ filenames for one screen-space renderer: R.avif, delta-R.avif, metrics-R.json. */
export function rendererFiles(renderer: string) {
  return { image: `${renderer}.avif`, delta: `delta-${renderer}.avif`, metrics: `metrics-${renderer}.json` };
}

export const RESULT_FILES = [
  REFERENCE_FILE,
  ...SCREEN_SPACE_RENDERERS.flatMap((renderer) => Object.values(rendererFiles(renderer))),
];

const SCENE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function isSceneName(name: string): boolean {
  return SCENE_NAME.test(name) && !name.includes('..');
}

/** Nearest ancestor of cwd containing `pnpm-workspace.yaml` (cwd is packages/viewer in dev, /app in Docker). */
export function findRepoRoot(from = process.cwd()): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (path.dirname(dir) === dir) return from;
  }
}

export function resultsDir(): string {
  return process.env.SS_FIDELITY_RESULTS_DIR || path.join(findRepoRoot(), 'results');
}

export function threeExamplesDir(): string {
  return path.join(findRepoRoot(), 'submodules/three.js/examples');
}

async function mtime(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function readMetrics(file: string): Promise<SceneMetrics | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as SceneMetrics;
  } catch {
    return undefined;
  }
}

/** `?v=<mtime>` busts caches when the CLI rewrites a result, so the image route can serve it immutable. */
async function imageUrl(dir: string, name: string, pass: PassName, file: string): Promise<string | undefined> {
  const time = await mtime(path.join(dir, name, pass, file));
  return time === undefined ? undefined : `/api/results/${name}/${pass}/${file}?v=${Math.round(time)}`;
}

export async function readSceneResult(name: string, pass: PassName, dir = resultsDir()): Promise<SceneSummary> {
  const [reference, rendererResults] = await Promise.all([
    imageUrl(dir, name, pass, REFERENCE_FILE),
    Promise.all(
      SCREEN_SPACE_RENDERERS.map(async (renderer) => {
        const files = rendererFiles(renderer);
        const [image, delta, metrics] = await Promise.all([
          imageUrl(dir, name, pass, files.image),
          imageUrl(dir, name, pass, files.delta),
          readMetrics(path.join(dir, name, pass, files.metrics)),
        ]);
        return [renderer, { image, delta, metrics }] as const;
      }),
    ),
  ]);
  const renderers = Object.fromEntries(
    rendererResults.filter(([, result]) => result.image || result.delta || result.metrics),
  ) as SceneSummary['renderers'];
  return { name, reference, renderers };
}

export async function listResultSceneNames(dir = resultsDir()): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isSceneName(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Union of scenes with results and scenes known to the registry (which may not have been rendered yet). */
export async function listScenes(
  registry: { name: string; description?: string }[] = [],
  pass: PassName = 'beauty',
  dir = resultsDir(),
): Promise<SceneSummary[]> {
  const descriptions = new Map(registry.map((scene) => [scene.name, scene.description]));
  const names = new Set([...(await listResultSceneNames(dir)), ...descriptions.keys()]);
  return Promise.all(
    [...names].map(async (name) => ({
      ...(await readSceneResult(name, pass, dir)),
      description: descriptions.get(name),
    })),
  );
}

/** Scene names + descriptions from `@ss-fidelity/scenes`. */
export function sceneRegistry(): { name: string; description?: string }[] {
  return listSceneNames().map((name) => ({ name, description: getScene(name).description }));
}
