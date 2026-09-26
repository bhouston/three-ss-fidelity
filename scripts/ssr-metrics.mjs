#!/usr/bin/env node
// Prints a table of beauty RMSE/PSNR per ssr-* scene for given renderers, plus mean RMSE overall and
// separately over the ssr-diag-* and ssr-steampunk-* groups.
// Usage: node scripts/ssr-metrics.mjs [renderer1,renderer2,...]
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resultsDir = path.join(repoRoot, 'results');

const renderers = (process.argv[2] ?? 'three-new-ssgi,three-new-ssr').split(',');

const scenes = readdirSync(resultsDir)
  .filter((name) => name.startsWith('ssr-'))
  .sort();

function group(scene) {
  return scene.startsWith('ssr-diag-') ? 'diag' : 'steampunk';
}

const rows = [];
for (const scene of scenes) {
  const row = { scene, group: group(scene) };
  for (const renderer of renderers) {
    const file = path.join(resultsDir, scene, 'beauty', `metrics-${renderer}.json`);
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      row[renderer] = { rmse: data.rmse, psnr: data.psnr };
    } catch {
      row[renderer] = null;
    }
  }
  rows.push(row);
}

const header = ['scene', ...renderers.flatMap((r) => [`${r} RMSE`, `${r} PSNR`])];
console.log(header.join(' | '));
for (const row of rows) {
  const cells = [row.scene];
  for (const renderer of renderers) {
    const m = row[renderer];
    cells.push(m ? m.rmse.toFixed(4) : 'n/a', m ? (m.psnr?.toFixed(2) ?? '∞') : 'n/a');
  }
  console.log(cells.join(' | '));
}

console.log('\nMean RMSE:');
for (const renderer of renderers) {
  const all = rows.map((r) => r[renderer]?.rmse).filter((v) => v !== undefined && v !== null);
  const diag = rows
    .filter((r) => r.group === 'diag')
    .map((r) => r[renderer]?.rmse)
    .filter((v) => v != null);
  const steampunk = rows
    .filter((r) => r.group === 'steampunk')
    .map((r) => r[renderer]?.rmse)
    .filter((v) => v != null);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log(
    `  ${renderer}: overall ${mean(all).toFixed(4)}, diag ${mean(diag).toFixed(4)}, steampunk ${mean(steampunk).toFixed(4)}`,
  );
}
