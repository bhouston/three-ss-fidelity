// Isolate reconstruction and sampling biases without changing registered scenes or saved results.
// Run after pnpm build: node scripts/gi-estimator-sweep.mjs [output-directory] [scene ...]
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installShaderExperiment } from './gi-shader-experiments.mjs';
import * as headless from '../packages/cli/dist/headless/webgpu.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sharp = createRequire(new URL('../packages/cli/package.json', import.meta.url))('sharp');
const output = path.resolve(process.argv[2] ?? '/tmp/ss-fidelity-estimator');
await mkdir(output, { recursive: true });
headless.install();
installShaderExperiment(process.env.GI_SHADER);
const { Vector3 } = await import('../submodules/three.js/build/three.module.js');
const { createRenderer, createSSGIRenderer } = await import('../packages/renderers/dist/index.js');
const { getScene } = await import('../packages/scenes/dist/index.js');
const { createNodeSceneContext } = await import('../packages/scenes/dist/node.js');
const { compareImages } = await import('../packages/cli/dist/compare.js');
const ctx = createNodeSceneContext();
const rendererName = process.env.GI_RENDERER ?? 'three-new-ssgi';
// the fork's equal-angle weighting (three-current is now stock npm three.js, a different pipeline)
const ssgiWeighting = process.env.GI_SHADER === 'legacy' ? 'legacy' : undefined;
const scenes = process.argv.slice(3);
if (!scenes.length) scenes.push('gi-emitter-corner', 'gi-room-open-high-albedo', 'ssgi-animated');
const variants = JSON.parse(process.env.GI_VARIANTS ?? 'null') ?? [
  { name: 'baseline' },
  { name: 'unfiltered', temporalDenoise: false },
  { name: 'dense', ssgi: { sliceCount: 8, stepCount: 32 } },
  { name: 'dense-unfiltered', temporalDenoise: false, ssgi: { sliceCount: 8, stepCount: 32 } },
  { name: 'dense-radius32', ssgi: { sliceCount: 8, stepCount: 32, radius: 32 } },
  { name: 'dense-radius32-thickness4', ssgi: { sliceCount: 8, stepCount: 32, radius: 32, thickness: 4 } },
];
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
async function luminance(file, patch) {
  const pixels = await sharp(file).extract(patch).removeAlpha().raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 3)
    sum +=
      0.2126 * linear(pixels[i] / 255) + 0.7152 * linear(pixels[i + 1] / 255) + 0.0722 * linear(pixels[i + 2] / 255);
  return sum / (pixels.length / 3);
}
const rows = [];
for (const name of scenes) {
  const definition = getScene(name);
  const { width, height } = definition;
  const reference = path.join(root, 'results', name, 'beauty/three-gpu-pathtracer.avif');
  for (const variant of variants) {
    const setup = await definition.create(ctx);
    // Preserve the investigation's original Cornell baseline after production presets change.
    // The ordinary CLI uses the registered scene settings, including the new indoor quality preset.
    const historicalCornell = name.startsWith('ssgi-') ? { sliceCount: 2, stepCount: 8, radius: 12, thickness: 1 } : {};
    setup.effects = {
      ...setup.effects,
      ssgi: { ...setup.effects.ssgi, ...historicalCornell, ...variant.ssgi },
    };
    if (variant.temporalDenoise !== undefined) setup.effects.temporalDenoise = variant.temporalDenoise;
    if (variant.noSSR) setup.effects.ssr = undefined;
    if (variant.cameraPosition) {
      setup.camera.position.set(...variant.cameraPosition);
      setup.camera.lookAt(setup.target);
    }
    setup.camera.updateMatrixWorld(true);
    const center = new Vector3(0, 0, 0).project(setup.camera);
    const patch = {
      left: Math.floor((center.x * 0.5 + 0.5) * width) - 8,
      top: Math.floor((-center.y * 0.5 + 0.5) * height) - 8,
      width: 16,
      height: 16,
    };
    const canvas = headless.createCanvas(width, height);
    const options = { width, height, pass: 'beauty', ssgiReconstruction: variant.reconstruction };
    const renderer = ssgiWeighting
      ? await createSSGIRenderer(canvas, setup, { ...options, ssgiWeighting })
      : await createRenderer(rendererName, canvas, setup, options);
    await headless.ready();
    const frames = variant.frames ?? 128;
    const start = performance.now();
    while (renderer.frames < frames) {
      renderer.render();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const pixels = await headless.readPixels(canvas);
    const file = path.join(output, `${name}-${variant.name}.png`);
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .png()
      .toFile(file);
    const metrics = variant.cameraPosition ? {} : (await compareImages(reference, file)).metrics;
    const row = {
      scene: name,
      renderer: rendererName,
      effectiveSSGI: setup.effects.ssgi,
      shader: process.env.GI_SHADER ?? 'baseline',
      ...variant,
      frames,
      milliseconds: performance.now() - start,
      ...metrics,
    };
    if (name.startsWith('gi-')) {
      row.patch = patch;
      row.receiver = await luminance(file, patch);
      if (!variant.cameraPosition) {
        row.referenceReceiver = await luminance(reference, patch);
        row.receiverRatio = row.receiver / row.referenceReceiver;
      }
      if (name === 'gi-emitter-corner') {
        row.analyticLambertPoint =
          ((0.5 * 0.5) / Math.PI) * (Math.atan(1) - (5 / Math.sqrt(61)) * Math.atan(5 / Math.sqrt(61)));
        row.analyticPointRatio = row.receiver / row.analyticLambertPoint;
        const emitter = setup.scene.getObjectByName('emitter');
        emitter.updateMatrixWorld(true);
        row.emitterProjectedCorners = [
          [-5, -3],
          [5, -3],
          [-5, 3],
          [5, 3],
        ].map(([x, y]) => {
          const p = new Vector3(x, y, 0).applyMatrix4(emitter.matrixWorld).project(setup.camera);
          return [(p.x * 0.5 + 0.5) * width, (-p.y * 0.5 + 0.5) * height];
        });
      }
    }
    rows.push(row);
    console.log(JSON.stringify(row));
    await writeFile(path.join(output, 'metrics.json'), `${JSON.stringify(rows, null, 2)}\n`);
    renderer.dispose();
  }
}
process.exit(0); // Dawn retains the event loop.
