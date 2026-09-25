import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is packages/cli/{src,dist}/paths). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** results/<scene-name>/<renderer-name>.png, committed. */
export const resultsDir = path.join(repoRoot, 'results');

export const renderPath = (sceneName: string, rendererName: string, root = resultsDir) =>
  path.join(root, sceneName, `${rendererName}.png`);
