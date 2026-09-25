// Reproduce the indoor SSGI sensitivity experiment without changing scene defaults or saved results.
// Run after pnpm build: node scripts/gi-sweep.mjs [output-directory]
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as headless from '../packages/cli/dist/headless/webgpu.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sharp = createRequire(new URL('../packages/cli/package.json', import.meta.url))('sharp');
const output = path.resolve(process.argv[2] ?? path.join(root, '.gi-investigation'));
await mkdir(output, { recursive: true });
headless.install();
const { createRenderer } = await import('../packages/renderers/dist/index.js');
const { getScene } = await import('../packages/scenes/dist/index.js');
const { createNodeSceneContext } = await import('../packages/scenes/dist/node.js');
const { compareImages } = await import('../packages/cli/dist/compare.js');
const definition = getScene('ssgi-animated');
const ctx = createNodeSceneContext();
const variants = [
  { name: 'baseline', frames: 128 },
  { name: 'frames512', frames: 512 },
  { name: 'dense', ssgi: { sliceCount: 8, stepCount: 32 } },
  { name: 'thickness4', ssgi: { thickness: 4 } },
  { name: 'gain2', ssgi: { giIntensity: Math.PI ** 2 } },
  { name: 'worldRadius25', ssgi: { useScreenSpaceSampling: false, radius: 25, stepCount: 32, sliceCount: 4 } },
  { name: 'noSSR', noSSR: true },
];
const reference = path.join(root, 'results/ssgi-animated/beauty/three-gpu-pathtracer.png');
const rows = [];
for (const variant of variants) {
  const setup = await definition.create(ctx);
  setup.effects = { ...setup.effects, ssgi: { ...setup.effects.ssgi, ...variant.ssgi } };
  if (variant.noSSR) setup.effects.ssr = undefined;
  const { width, height } = definition;
  const canvas = headless.createCanvas(width, height);
  const renderer = await createRenderer('three-ss', canvas, setup, { width, height, pass: 'beauty' });
  await headless.ready();
  const frames = variant.frames ?? 128;
  const start = performance.now();
  while (renderer.frames < frames) {
    renderer.render();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const pixels = await headless.readPixels(canvas);
  const file = path.join(output, `${variant.name}.png`);
  await sharp(pixels, { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .png()
    .toFile(file);
  const { metrics } = await compareImages(reference, file);
  const { metrics: changeFromBaseline } = await compareImages(path.join(output, 'baseline.png'), file);
  const row = { ...variant, frames, milliseconds: performance.now() - start, ...metrics, changeFromBaseline };
  rows.push(row);
  console.log(JSON.stringify(row));
  renderer.dispose();
}
await writeFile(path.join(output, 'metrics.json'), `${JSON.stringify(rows, null, 2)}\n`);
process.exit(0); // Dawn retains the event loop.
