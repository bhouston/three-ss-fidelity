// A/B frame-time comparison robust to machine drift: alternates bench.mjs runs of a reference tree (a snapshot of
// the last accepted state) and the candidate tree (this one), then compares the medians of the per-run totals.
// Usage: node packages/cli/perf/ab.mjs <reference-root> [--rounds 3] [--out file.json] [bench.mjs options...]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The representative workloads: the other scenes duplicate one of these pipelines' cost. */
export const BENCH_SCENES =
  'ssgi-basic,ssgi-animated,ssr-steampunk-camera,ssr-steampunk-camera-roughness-100,higharc_dogwood';

const candidateRoot = fileURLToPath(new URL('../../../', import.meta.url));
const [referenceRoot, ...rest] = process.argv.slice(2);
const option = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const [value] = rest.splice(i, 2).slice(1);
  return value;
};
const rounds = Number(option('rounds', '3'));
const out = option('out');
const benchArgs = rest.includes('--scenes') ? rest : ['--scenes', BENCH_SCENES, ...rest];
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

function bench(root, label, round) {
  const file = path.join(candidateRoot, '.perf', `ab-${label}-${round}.json`);
  execFileSync(process.execPath, [path.join(root, 'packages/cli/perf/bench.mjs'), ...benchArgs, '--out', file], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return JSON.parse(readFileSync(file, 'utf8'));
}

const runs = { reference: [], candidate: [] };
for (let round = 0; round < rounds; round++) {
  // alternate the order so drift within a round cancels
  const order = round % 2 ? ['candidate', 'reference'] : ['reference', 'candidate'];
  for (const label of order) {
    const result = bench(label === 'reference' ? referenceRoot : candidateRoot, label, round);
    runs[label].push(result);
    console.log(`round ${round + 1} ${label}: ${result.totalMs.toFixed(2)} ms (cpu ${result.cpuMs.toFixed(2)} ms)`);
  }
}
const summarize = (list) => ({
  totalMs: median(list.map((r) => r.totalMs)),
  cpuMs: median(list.map((r) => r.cpuMs)),
  scenes: Object.fromEntries(
    Object.keys(list[0].scenes).map((name) => [
      name,
      { total: median(list.map((r) => r.scenes[name].total)), cpu: median(list.map((r) => r.scenes[name].cpu)) },
    ]),
  ),
});
const reference = summarize(runs.reference);
const candidate = summarize(runs.candidate);
const improvement = 1 - candidate.totalMs / reference.totalMs;
const cpuImprovement = 1 - candidate.cpuMs / reference.cpuMs;
for (const name of Object.keys(reference.scenes)) {
  const r = reference.scenes[name].total;
  const c = candidate.scenes[name].total;
  console.log(`${name}: ${r.toFixed(2)} -> ${c.toFixed(2)} ms (${((1 - c / r) * 100).toFixed(1)}%)`);
}
console.log(
  `overall: ${reference.totalMs.toFixed(2)} -> ${candidate.totalMs.toFixed(2)} ms, ` +
    `improvement ${(improvement * 100).toFixed(1)}% (cpu ${(cpuImprovement * 100).toFixed(1)}%)`,
);
if (out) writeFileSync(out, `${JSON.stringify({ improvement, cpuImprovement, reference, candidate }, null, 2)}\n`);
