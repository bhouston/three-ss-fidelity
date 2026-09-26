import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is packages/cli/{src,dist}/paths). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** results/<scene-name>/<pass-name>/<renderer-name>.avif, committed. */
export const resultsDir = path.join(repoRoot, 'results');

export const passDir = (sceneName: string, passName: string, root = resultsDir) => path.join(root, sceneName, passName);

export const renderPath = (sceneName: string, passName: string, rendererName: string, root = resultsDir) =>
  path.join(passDir(sceneName, passName, root), `${rendererName}.avif`);

/** Every screen-space renderer R uses delta-R.avif / metrics-R.json (three-gpu-pathtracer is only ever the reference). */
export function comparisonPaths(sceneName: string, passName: string, rendererName: string, root = resultsDir) {
  const dir = passDir(sceneName, passName, root);
  return {
    delta: path.join(dir, `delta-${rendererName}.avif`),
    metrics: path.join(dir, `metrics-${rendererName}.json`),
  };
}
