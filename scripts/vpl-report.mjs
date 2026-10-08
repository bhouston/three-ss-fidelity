// Recompute the three-scene experiment from lossless browser captures and committed references.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readRgb, compareRgb } from '../packages/cli/dist/compare.js';
const root = 'docs/history/vpl-multiple-bounces';
const scenes = ['cornell-box-basic', 'cornell-box-rounded', 'cornell-box-metallic'];
const stages = [
  'before',
  'after',
  'tuned512',
  'importance-emissive',
  'importance-eight',
  'spatial-importance',
  'spatial256',
  'no-emissive',
  'no-importance',
  'final',
];
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
for (const scene of scenes) {
  const references = Object.fromEntries(
    await Promise.all(
      ['blender', 'three-gpu-pathtracer'].map(async (id) => [
        id,
        await readRgb(`fidelity-results/${scene}/beauty/${id}.avif`),
      ]),
    ),
  );
  for (const stage of stages) {
    const path = join(root, stage, scene);
    if (!existsSync(join(path, 'timing-1.json'))) continue;
    const repetitions = [];
    for (let i = 1; i <= 3; i++) {
      if (!existsSync(join(path, `timing-${i}.json`))) continue;
      const timing = JSON.parse(await readFile(join(path, `timing-${i}.json`), 'utf8'));
      const capture = await readRgb(join(path, `capture-${i}.png`));
      repetitions.push({
        ...timing,
        psnr: Object.fromEntries(
          Object.entries(references).map(([id, reference]) => [id, compareRgb(reference, capture).metrics.psnr]),
        ),
      });
    }
    rows.push({
      scene,
      stage,
      repetitions: repetitions.length,
      frameMs: median(repetitions.map((r) => r.medianFrameMs)),
      startupMs: median(repetitions.map((r) => r.setupMs + r.convergenceMs)),
      psnr: Object.fromEntries(Object.keys(references).map((id) => [id, median(repetitions.map((r) => r.psnr[id]))])),
      lighting: repetitions[0].lighting,
    });
  }
}
const settings = {
  before: {
    method: 'RIS lightmaps',
    samplesPerTexel: 2048,
    iterations: 128,
    candidatesPerReservoir: 8,
    nearFieldRayPerReservoir: true,
    visibility: 'BVH',
  },
  after: {
    method: 'original branch shadow-map VPL',
    count: 128,
    bounces: 2,
    candidateMultiplier: 1,
    minDistance: 1,
    emissive: false,
  },
  tuned512: { count: 512, bounces: 4, minDistance: 1, emissive: false },
  'importance-emissive': {
    count: 128,
    bounces: 4,
    candidateMultiplier: 4,
    minDistance: 1,
    spatialResampling: false,
    emissive: true,
  },
  'importance-eight': {
    count: 128,
    bounces: 8,
    candidateMultiplier: 16,
    minDistance: 3,
    spatialResampling: false,
    emissive: true,
  },
  'spatial-importance': {
    count: 128,
    bounces: 8,
    candidateMultiplier: 16,
    minDistance: 3,
    spatialResampling: true,
    emissive: true,
  },
  spatial256: {
    count: 256,
    bounces: 8,
    candidateMultiplier: 16,
    minDistance: 3,
    spatialResampling: true,
    emissive: true,
  },
  'no-emissive': {
    count: 128,
    bounces: 8,
    candidateMultiplier: 16,
    minDistance: 3,
    spatialResampling: true,
    emissive: false,
  },
  'no-importance': {
    count: 128,
    bounces: 8,
    candidateMultiplier: 16,
    minDistance: 3,
    spatialResampling: true,
    importanceSampling: false,
    emissive: true,
  },
  final: {
    count: 128,
    bounces: 8,
    candidateMultiplier: 16,
    minDistance: 3,
    spatialResampling: true,
    emissive: true,
    sourceImportanceSampling: true,
  },
};
const comparisons = scenes.map((scene) => {
  const find = (stage) => rows.find((r) => r.scene === scene && r.stage === stage);
  const old = find('before'),
    branch = find('after'),
    final = find('final');
  return {
    scene,
    old,
    branch,
    final,
    frameChangeVsOldPercent: 100 * (final.frameMs / old.frameMs - 1),
    startupSpeedupVsOld: old.startupMs / final.startupMs,
    qualityGainVsBranchDb: final.psnr.blender - branch.psnr.blender,
    qualityLossVsOldDb: old.psnr.blender - final.psnr.blender,
    replacementGatePassed: old.psnr.blender - final.psnr.blender <= 0.1,
  };
});
const report = {
  metric: 'PSNR over decoded sRGB8 RGB; PNG test captures and committed AVIF references',
  gpu: 'NVIDIA GeForce RTX 3060 Ti (Ampere), driver 32.0.16.1714, Chrome WebGPU on Windows',
  cpu: 'AMD Ryzen 9 5950X',
  browser: 'Chrome 154.0.8037.98',
  improvedThreeCommit: 'ae2955336b8a65373cbd850f52198c2d46a2599b',
  originalBranchCompatibility:
    "Finite point-light attenuation was supported to retain the Cornell scenes' existing distance cutoff; other original branch algorithm/default settings were retained.",
  resolution: [640, 480],
  captureFrames: 342,
  timing:
    '192 startup/warmup frames, then five 30-frame batches with a GPU fence per batch; medians of three fresh-browser repetitions for old/original/final; single-run exploratory ablations',
  visibilityResolution: 64,
  originalLocalThreeCommit: '24201509d9',
  originalProjectThreeCommit: '83c310af72715ae558beea12d169f00c62ea48eb',
  settings,
  comparisons,
  rows,
  conclusion:
    'The new method improves substantially over the branch defaults, but does not meet the old lightmap fidelity. Keep the RIS renderer as the enabled baseline and the shadow-map renderer experimental. No BVH dependency was added to the new method.',
};
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const cells = comparisons
  .map(
    ({ scene, old, branch, final }) =>
      `<tr><td>${scene}</td>${[old, branch, final].map((r) => `<td>${r.psnr.blender.toFixed(2)} dB<br>${r.frameMs.toFixed(2)} ms<br>${(r.startupMs / 1000).toFixed(2)} s startup</td>`).join('')}</tr>`,
  )
  .join('');
const galleries = scenes
  .map(
    (scene) =>
      `<h2>${scene}</h2><div class="images">${[
        ['before', 'Old RIS'],
        ['after', 'Original branch'],
        ['final', 'Improved shadow-map VPL'],
      ]
        .map(
          ([stage, label]) =>
            `<figure><figcaption>${label}</figcaption><img src="${stage}/${scene}/capture-1.png"></figure>`,
        )
        .join('')}</div>`,
  )
  .join('');
await writeFile(
  join(root, 'index.html'),
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>VPL fidelity and timing comparison</title><style>body{font:16px system-ui;background:#151a22;color:#eee;margin:32px}table{border-collapse:collapse}td,th{padding:12px;border:1px solid #566;text-align:left}.images{display:flex;gap:12px}figure{margin:0;flex:1;min-width:0}img{width:100%}figcaption{margin-bottom:8px}p{max-width:1000px}</style><h1>VPL fidelity and timing comparison</h1><p>${report.conclusion}</p><p>Three Cornell scenes · 640×480 · NVIDIA Ampere · Chrome WebGPU. Quality uses Blender reference PSNR; timings include CPU submission and GPU completion. Startup includes renderer setup and 192 frames. Main comparisons use three fresh-browser repetitions. This is a static-camera comparison on one machine, not a full-suite or cross-hardware result.</p><table><tr><th>Scene</th><th>Old RIS</th><th>Original branch</th><th>Improved VPL</th></tr>${cells}</table><p>Improved configuration: 128 GPU VPLs, up to eight diffuse reflections, 16× CPU candidate generation, source-power allocation, emissive triangles, spatially ordered flux importance resampling, 64×64 shadow faces and a three-world-unit distance clamp. The clamp is tuned for these Cornell scenes; it is not a universally optimal setting.</p><p>The old method samples every lightmap texel and explicitly handles near-field transport. The new method shares a small finite VPL set, uses approximate visibility and caps diffuse paths. Those approximations leave a fidelity gap even after including emissive surfaces. See <a href="report.json">the JSON report</a> for both references, ablations and complete settings.</p>${galleries}</html>`,
);
console.log(
  JSON.stringify(
    comparisons.map(({ scene, old, branch, final, qualityGainVsBranchDb, qualityLossVsOldDb }) => ({
      scene,
      old: old.psnr.blender,
      branch: branch.psnr.blender,
      final: final.psnr.blender,
      qualityGainVsBranchDb,
      qualityLossVsOldDb,
      oldMs: old.frameMs,
      finalMs: final.frameMs,
    })),
    null,
    2,
  ),
);
