#!/usr/bin/env node
// Compare the unlit right-hand receiver floor; run after the probe quality sweep.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const requireThree = createRequire(new URL('../packages/renderers/package.json', import.meta.url));
const { Raycaster, Vector2 } = await import(pathToFileURL(requireThree.resolve('three/webgpu')).href);
import { getScene, disposeSceneSetup } from '../packages/scenes/dist/index.js';
import { readRgb } from '../packages/cli/dist/compare.js';
const { values } = parseArgs({ options: { out: { type: 'string', default: '.output/ddgi-quality' } } });
const report = JSON.parse(await readFile(path.join(values.out, 'report.json'), 'utf8'));
const noAssets = {
  loadGLTF: async () => {
    throw new Error('No assets');
  },
  loadHDR: async () => {
    throw new Error('No assets');
  },
};
const linear = (byte) => {
  const x = byte / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const results = {};
for (const name of ['gi-probe-thin-wall', 'gi-probe-thick-wall']) {
  const row = report.scenes[name];
  if (!row) continue;
  const setup = await getScene(name).create(noAssets);
  const reference = await readRgb(path.join('fidelity-results', name, 'beauty', 'three-gpu-pathtracer.avif'));
  setup.scene.updateMatrixWorld(true);
  setup.camera.updateMatrixWorld(true);
  const wall = setup.scene.getObjectByName('opaque-partition');
  wall.geometry.computeBoundingBox();
  const wallRight = wall.position.x + wall.geometry.boundingBox.max.x;
  const ray = new Raycaster(),
    ndc = new Vector2(),
    mask = [];
  for (let y = 0; y < reference.height; y++)
    for (let x = 0; x < reference.width; x++) {
      ndc.set(((x + 0.5) / reference.width) * 2 - 1, 1 - ((y + 0.5) / reference.height) * 2);
      ray.setFromCamera(ndc, setup.camera);
      const hit = ray.intersectObjects(setup.scene.children)[0];
      if (hit?.object.name === 'receiver-floor' && hit.point.x > wallRight + 0.05)
        mask.push((x + y * reference.width) * 3);
    }
  const measure = (image) => {
    let mean = 0,
      squaredError = 0,
      maximum = 0;
    for (const pixel of mask) {
      const luminance =
        linear(image.data[pixel]) * 0.2126 +
        linear(image.data[pixel + 1]) * 0.7152 +
        linear(image.data[pixel + 2]) * 0.0722;
      const referenceLuminance =
        linear(reference.data[pixel]) * 0.2126 +
        linear(reference.data[pixel + 1]) * 0.7152 +
        linear(reference.data[pixel + 2]) * 0.0722;
      mean += luminance;
      squaredError += (luminance - referenceLuminance) ** 2;
      maximum = Math.max(maximum, luminance);
    }
    return {
      meanLinearLuminance: mean / mask.length,
      rmseLinearLuminance: Math.sqrt(squaredError / mask.length),
      maxLinearLuminance: maximum,
    };
  };
  const metrics = { pixels: mask.length, reference: measure(reference), renderers: {} };
  for (const variant of ['baseline', 'sh-probes', 'ddgi-probes'])
    metrics.renderers[variant] = measure(await readRgb(path.join(values.out, row.quality[variant].image)));
  metrics.leakageReductionFraction =
    1 - metrics.renderers['ddgi-probes'].meanLinearLuminance / metrics.renderers['sh-probes'].meanLinearLuminance;
  results[name] = metrics;
  disposeSceneSetup(setup);
}
await writeFile(
  path.join(values.out, 'leakage.json'),
  JSON.stringify(
    {
      method:
        'Ray-cast receiver-floor mask in the unlit chamber; sRGB8 AVIF decoded to linear luminance, not raw HDR irradiance',
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(results, null, 2));
