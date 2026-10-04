import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is packages/cli/{src,dist}/paths). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** fidelity-results/<scene-name>/beauty/<renderer-name>.avif, committed. */
export const resultsDir = path.join(repoRoot, 'fidelity-results');

export const sceneDir = (sceneName: string, root = resultsDir) => path.join(root, sceneName, 'beauty');

export const renderPath = (sceneName: string, rendererName: string, root = resultsDir) =>
  path.join(sceneDir(sceneName, root), `${rendererName}.avif`);

/** `fidelity-kit process`'s metrics file for one renderer vs one reference. */
export const metricsPath = (sceneName: string, rendererName: string, reference: string, root = resultsDir) =>
  path.join(sceneDir(sceneName, root), `${rendererName}.vs-${reference}.metrics.json`);
