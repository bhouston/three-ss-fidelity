import { statistics } from './stats.js';
import type { BenchmarkComparison, BenchmarkReport, ReportEntry } from './types.js';

export function primaryMetric(protocol: string): string {
  if (protocol === 'throughput') return 'throughput.frame';
  if (protocol === 'cadence') return 'cadence.frame';
  return 'profile.frame';
}

/** Compares matching repetitions only when workload and timing protocols are identical. */
export function compareEntries(baseline: ReportEntry, candidate: ReportEntry): BenchmarkComparison {
  if (baseline.scene !== candidate.scene || JSON.stringify(baseline.workload) !== JSON.stringify(candidate.workload)) {
    throw new Error('Cannot compare different workloads');
  }
  if (!baseline.runs.length || baseline.runs.length !== candidate.runs.length)
    throw new Error('Matching repetitions required');
  const metric = primaryMetric(baseline.runs[0]!.options.protocol);
  const ratios = baseline.runs.map((run, index) => {
    const other = candidate.runs[index]!;
    if (JSON.stringify(run.options) !== JSON.stringify(other.options))
      throw new Error('Cannot compare different protocols');
    const base = run.metrics.find((value) => value.descriptor.id === metric)?.statistics.mean;
    const next = other.metrics.find((value) => value.descriptor.id === metric)?.statistics.mean;
    if (!base || !next) throw new Error('Missing or zero primary timing');
    return base / next;
  });
  return {
    scene: baseline.scene,
    baseline: baseline.renderer,
    candidate: candidate.renderer,
    metric,
    speedup: statistics(ratios),
  };
}

/** Validate imported evidence before a report viewer uses it. Unknown extension metadata is preserved. */
export function parseReport(value: unknown): BenchmarkReport {
  if (!value || typeof value !== 'object') throw new Error('Expected a benchmark report');
  const report = value as BenchmarkReport;
  if (
    report.schemaVersion !== 1 ||
    typeof report.id !== 'string' ||
    typeof report.generatedAt !== 'string' ||
    !Array.isArray(report.entries)
  ) {
    throw new Error('Unsupported benchmark report (expected schemaVersion 1)');
  }
  if (!report.environment || !report.provenance) throw new Error('Missing report metadata');
  for (const entry of report.entries) {
    if (
      typeof entry.scene !== 'string' ||
      typeof entry.renderer !== 'string' ||
      !entry.workload ||
      !Array.isArray(entry.runs)
    )
      throw new Error('Invalid report entry');
    for (const run of entry.runs) {
      if (!run.options || !Array.isArray(run.metrics) || !Number.isFinite(run.fps) || !Number.isFinite(run.elapsedMs))
        throw new Error('Invalid benchmark run');
      for (const metric of run.metrics) {
        if (
          !metric.descriptor ||
          typeof metric.descriptor.id !== 'string' ||
          !['ms', 'count', 'bytes'].includes(metric.descriptor.unit) ||
          !['frame', 'batch', 'repetition'].includes(metric.sampleUnit) ||
          !Array.isArray(metric.samples)
        )
          throw new Error('Invalid report metric');
        // Recompute to prevent malformed imported statistics from influencing displayed results.
        metric.statistics = statistics(
          metric.samples.map((sample) => {
            if (
              !Number.isSafeInteger(sample.frame) ||
              sample.frame < 0 ||
              !Number.isFinite(sample.value) ||
              sample.value < 0
            )
              throw new Error('Invalid report sample');
            return sample.value;
          }),
        );
      }
    }
  }
  if (report.comparisons !== undefined) {
    if (!Array.isArray(report.comparisons)) throw new Error('Invalid comparisons');
    report.comparisons = report.comparisons.map((comparison) => {
      const baseline = report.entries.find(
        (entry) => entry.scene === comparison.scene && entry.renderer === comparison.baseline,
      );
      const candidate = report.entries.find(
        (entry) => entry.scene === comparison.scene && entry.renderer === comparison.candidate,
      );
      if (!baseline || !candidate) throw new Error('Missing comparison entries');
      return compareEntries(baseline, candidate);
    });
  }
  return report;
}
