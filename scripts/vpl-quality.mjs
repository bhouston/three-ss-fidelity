// Recompute both-reference comparisons from decoded committed captures.
// Run after captures: node scripts/vpl-quality.mjs [report.json]
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSceneNames } from '../packages/scenes/dist/index.js';
import { compareRgb, readRgb } from '../packages/cli/dist/compare.js';
const root = fileURLToPath(new URL('../fidelity-results/', import.meta.url));
const out = process.argv[2] ?? 'docs/history/vpl/quality.json';
const rows = [];
const methods = ['three-new', 'three-new-light-bake', 'three-new-light-probe-ddgi', 'three-new-vpl'];
for (const scene of listSceneNames()) {
  const image = (method) => join(root, scene, 'beauty', `${method}.avif`);
  if (!existsSync(image('three-new-vpl'))) throw new Error(`Missing VPL capture: ${scene}`);
  for (const reference of ['blender', 'three-gpu-pathtracer']) {
    if (!existsSync(image(reference))) continue;
    const ref = await readRgb(image(reference));
    const psnr = {};
    for (const method of methods) {
      if (existsSync(image(method))) psnr[method] = compareRgb(ref, await readRgb(image(method))).metrics.psnr;
    }
    const before = psnr['three-new'] ?? Infinity;
    const after = psnr['three-new-vpl'] ?? Infinity;
    const drop = before === after ? 0 : before - after;
    rows.push({ scene, reference, psnr, dropFromSSGI: Number.isFinite(drop) ? drop : null, pass: drop <= 0.1 });
  }
}
const summary = Object.fromEntries(
  ['blender', 'three-gpu-pathtracer'].map((reference) => {
    const compared = rows.filter((row) => row.reference === reference);
    return [
      reference,
      {
        total: compared.length,
        passed: compared.filter((row) => row.pass).length,
        failures: compared.filter((row) => !row.pass).map((row) => row.scene),
      },
    ];
  }),
);
await mkdir(dirname(out), { recursive: true });
await writeFile(
  out,
  JSON.stringify(
    {
      metadata: {
        frames: 192,
        lightingIterations: 128,
        reservoirsPerTexel: 2048,
        candidatesPerReservoir: 8,
        nearRaysPerTexel: 2048,
        thresholdDb: 0.1,
        metric: 'PSNR over decoded sRGB8 AVIF RGB',
      },
      summary,
      rows,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(summary, null, 2));
