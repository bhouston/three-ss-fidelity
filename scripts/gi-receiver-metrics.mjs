// Compare linear-light luminance in a 16x16 patch around world-space floor center.
// The source PNGs are 8-bit sRGB; this reverses sRGB encoding, not clipping or tone mapping.
// Run after pnpm build and rendering gi-* beauty/direct: node scripts/gi-receiver-metrics.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getScene, listSceneNames } from '../packages/scenes/dist/index.js';
import { createNodeSceneContext } from '../packages/scenes/dist/node.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const sharp = require('sharp');
const { Vector3 } = await import('../submodules/three.js/build/three.module.js');
const ctx = createNodeSceneContext();
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const rows = [];
const selected = new Set(process.argv.slice(2));
for (const name of listSceneNames().filter(
  (sceneName) => sceneName.startsWith('gi-') && (selected.size === 0 || selected.has(sceneName)),
)) {
  const definition = getScene(name);
  const { camera } = await definition.create(ctx);
  camera.updateMatrixWorld(true);
  const center = new Vector3(0, 0, 0).project(camera);
  const left = Math.floor((center.x * 0.5 + 0.5) * definition.width) - 8;
  const top = Math.floor((-center.y * 0.5 + 0.5) * definition.height) - 8;
  const row = { scene: name, patch: { left, top, width: 16, height: 16 } };
  for (const pass of ['beauty', 'direct'])
    for (const renderer of ['three-ss', 'three-gpu-pathtracer']) {
      const pixels = await sharp(path.join(root, 'results', name, pass, `${renderer}.png`))
        .extract(row.patch)
        .removeAlpha()
        .raw()
        .toBuffer();
      let luminance = 0;
      for (let i = 0; i < pixels.length; i += 3) {
        luminance +=
          0.2126 * linear(pixels[i] / 255) +
          0.7152 * linear(pixels[i + 1] / 255) +
          0.0722 * linear(pixels[i + 2] / 255);
      }
      row[`${pass}/${renderer}`] = luminance / (pixels.length / 3);
    }
  row.ssgiIncrement = row['beauty/three-ss'] - row['direct/three-ss'];
  row.pathTracerIncrement = row['beauty/three-gpu-pathtracer'] - row['direct/three-gpu-pathtracer'];
  row.beautyRatio = row['beauty/three-ss'] / row['beauty/three-gpu-pathtracer'];
  rows.push(row);
}
console.log(JSON.stringify(rows, null, 2));
