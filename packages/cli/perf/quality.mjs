// Quality gate: compares candidate three-ss renders (pnpm cli render --renderers three-ss --output <candidate>)
// with baseline three-ss renders and with the committed pathtracer references.
// Passes when, per scene and pass, MAE vs baseline < 1% and PSNR vs the pathtracer drops by < 1%.
// Usage: node packages/cli/perf/quality.mjs <baseline-dir> <candidate-dir> [--out file.json]
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { compareImages } from '../dist/compare.js';
import { resultsDir } from '../dist/paths.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const [baselineDir, candidateDir] = positionals;
const rows = [];
for (const scene of readdirSync(baselineDir)) {
  for (const pass of readdirSync(path.join(baselineDir, scene))) {
    const baseline = path.join(baselineDir, scene, pass, 'three-ss.png');
    const candidate = path.join(candidateDir, scene, pass, 'three-ss.png');
    const reference = path.join(resultsDir, scene, pass, 'three-gpu-pathtracer.png');
    if (!existsSync(candidate)) {
      rows.push({ scene, pass, ok: false, error: 'missing candidate' });
      continue;
    }
    const { metrics: vsBaseline } = await compareImages(baseline, candidate);
    const psnrBaseline = (await compareImages(reference, baseline)).metrics.psnr;
    const psnrCandidate = (await compareImages(reference, candidate)).metrics.psnr;
    const psnrDrop = (psnrBaseline - psnrCandidate) / psnrBaseline;
    const ok = vsBaseline.mae < 0.01 && psnrDrop < 0.01;
    rows.push({
      scene,
      pass,
      ok,
      mae: vsBaseline.mae,
      psnrVsBaseline: vsBaseline.psnr,
      psnrBaseline,
      psnrCandidate,
      psnrDrop,
    });
  }
}
for (const r of rows) {
  console.log(
    `${r.ok ? 'ok  ' : 'FAIL'} ${r.scene} | ${r.pass}: ` +
      (r.error ??
        `MAE ${(r.mae * 100).toFixed(3)}%, vs pathtracer ${r.psnrBaseline.toFixed(2)} -> ${r.psnrCandidate.toFixed(2)} dB`),
  );
}
const ok = rows.every((r) => r.ok);
console.log(ok ? 'QUALITY OK' : 'QUALITY FAIL');
if (values.out) writeFileSync(values.out, `${JSON.stringify({ ok, rows }, null, 2)}\n`);
process.exit(ok ? 0 : 1);
