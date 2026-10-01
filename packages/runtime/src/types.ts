/** Logical simulation time, independent of how quickly the GPU finishes. */
export interface FrameContext {
  index: number;
  timeSeconds: number;
  deltaSeconds: number;
  phase: 'warmup' | 'measure' | 'capture' | 'interactive';
}

export interface MetricDescriptor {
  id: string;
  label: string;
  unit: 'ms' | 'count' | 'bytes';
  description: string;
}

export interface MetricSample {
  frame: number;
  metric: string;
  value: number;
}

/** GPU query allocation, polling and attribution belong to the renderer adapter. */
export interface PipelineProfiler {
  readonly status: 'supported' | 'unsupported';
  readonly reason?: string;
  readonly metrics: readonly MetricDescriptor[];
  beginFrame(frame: number): void;
  endFrame(): void;
  /** May wait for GPU queries. Only the explicitly instrumented profile protocol calls this. */
  resolve(): Promise<MetricSample[]>;
  readonly invalidSamples: number;
  dispose(): void;
}

export interface LivePipeline {
  render(frame?: FrameContext): void;
  setSize(width: number, height: number): void;
  dispose(): void;
  readonly profiler?: PipelineProfiler;
}

/** Host hooks keep DOM, GPU queue APIs and scene mutation out of the runner. */
export interface RenderSession {
  pipeline: LivePipeline;
  beforeFrame?(frame: FrameContext): void;
  /** Completes all submitted work. Required for throughput and capture. */
  complete(): Promise<void>;
  dispose(): void;
}

export interface Statistics {
  n: number;
  mean: number;
  stddev: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

export interface MetricResult {
  descriptor: MetricDescriptor;
  sampleUnit: 'frame' | 'batch' | 'repetition';
  statistics: Statistics;
  samples: { frame: number; value: number }[];
}

export interface BenchmarkOptions {
  protocol: 'throughput' | 'cadence' | 'profile';
  durationMs: number;
  warmupFrames: number;
  batchSize: number;
  /** Optional exact frame budget, useful for short smoke tests and legacy --measure. */
  measureFrames?: number;
  /** Stop at a full deterministic workload cycle. */
  cycleFrames: number;
  stepSeconds: number;
}

export interface BenchmarkRun {
  options: BenchmarkOptions;
  elapsedMs: number;
  frames: number;
  fps: number;
  metrics: MetricResult[];
  profiling: { status: 'disabled' | 'supported' | 'unsupported'; reason?: string; invalidSamples: number };
}

export interface ReportEntry {
  scene: string;
  renderer: string;
  experiment: string;
  workload: {
    width: number;
    height: number;
    seed: number;
    motion: 'static' | 'orbit';
    orbitDegrees: number;
    settings: unknown;
    history: 'fresh-session-then-warmup';
  };
  runs: BenchmarkRun[];
}

export interface BenchmarkReport {
  schemaVersion: 1;
  id: string;
  generatedAt: string;
  environment: Record<string, unknown>;
  provenance: Record<string, unknown>;
  entries: ReportEntry[];
  comparisons?: BenchmarkComparison[];
}

export interface BenchmarkComparison {
  scene: string;
  baseline: string;
  candidate: string;
  metric: string;
  /** > 1 means the candidate is faster. Each ratio compares matching repetitions. */
  speedup: Statistics;
}
