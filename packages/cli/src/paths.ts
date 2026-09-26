import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is packages/cli/{src,dist}/paths). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** results/<scene-name>/<pass-name>/<renderer-name>.png, committed. */
export const resultsDir = path.join(repoRoot, 'results');

export const passDir = (sceneName: string, passName: string, root = resultsDir) => path.join(root, sceneName, passName);

export const renderPath = (sceneName: string, passName: string, rendererName: string, root = resultsDir) =>
  path.join(passDir(sceneName, passName, root), `${rendererName}.png`);

/** Keep corrected three-ss comparison filenames stable for existing consumers. */
export function comparisonPaths(
  sceneName: string,
  passName: string,
  rendererName: 'three-ss' | 'three-ss-legacy',
  root = resultsDir,
) {
  const suffix = rendererName === 'three-ss' ? '' : `-${rendererName}`;
  const dir = passDir(sceneName, passName, root);
  return { delta: path.join(dir, `delta${suffix}.png`), metrics: path.join(dir, `metrics${suffix}.json`) };
}
