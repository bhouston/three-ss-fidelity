import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is packages/cli/{src,dist}/paths). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** results/<scene-name>/<pass-name>/<renderer-name>.avif, committed. */
export const resultsDir = path.join(repoRoot, 'results');

export const passDir = (sceneName: string, passName: string, root = resultsDir) => path.join(root, sceneName, passName);

export const renderPath = (sceneName: string, passName: string, rendererName: string, root = resultsDir) =>
  path.join(passDir(sceneName, passName, root), `${rendererName}.avif`);

/**
 * Every renderer R compared against the default reference (three-gpu-pathtracer) uses delta-R.avif / metrics-R.json.
 * Comparisons against a non-default reference (e.g. blender, itself a second ground truth) are suffixed
 * `-vs-<reference>` so they don't collide with the default comparison of the same renderer.
 */
export function comparisonPaths(
  sceneName: string,
  passName: string,
  rendererName: string,
  root = resultsDir,
  reference = 'three-gpu-pathtracer',
) {
  const dir = passDir(sceneName, passName, root);
  const suffix = reference === 'three-gpu-pathtracer' ? rendererName : `${rendererName}-vs-${reference}`;
  return {
    delta: path.join(dir, `delta-${suffix}.avif`),
    metrics: path.join(dir, `metrics-${suffix}.json`),
  };
}
