import type { RendererStartupProfiler, StartupEvent, StartupShaderReport } from '@ss-fidelity/renderers';

export type StartupPhase = 'cleanup' | 'scene' | 'renderer' | 'first-render' | 'gpu-wait';
export interface StartupPass {
  name: string;
  generationMs: number;
  pipelineMs: number;
  pipelines: number;
  fragmentBytes: number;
}
export interface StartupSnapshot {
  scene: string;
  renderer: string;
  settings: Record<string, string | number>;
  state: 'loading' | 'ready' | 'failed';
  phase: string;
  totalMs: number;
  pageMs: number;
  phases: Partial<Record<StartupPhase, number>>;
  otherMs: number;
  historyWaitMs?: number;
  frames: number;
  capturing: boolean;
  shaderGenerationMs: number;
  shaderModuleMs: number;
  pipelineMs: number;
  pipelines: number;
  passes: StartupPass[];
  shaderReport?: StartupShaderReport;
  error?: string;
  errorStack?: string;
}

export function eventDuration(events: StartupEvent[]): number {
  let end = -Infinity;
  let duration = 0;
  for (const event of events.toSorted((a, b) => a.startMs - b.startMs)) {
    if (event.endMs === undefined) continue;
    duration += Math.max(0, event.endMs - Math.max(end, event.startMs));
    end = Math.max(end, event.endMs);
  }
  return duration;
}

export function shaderBreakdown(report?: StartupShaderReport) {
  const events = report?.events ?? [];
  const sources = new Map(report?.sources.map((source) => [source.id, source]) ?? []);
  const builders = new Map(report?.builders.map((builder) => [builder.id, builder]) ?? []);
  const passes = new Map<string, StartupPass>();
  for (const event of events) {
    if (event.kind !== 'builder-total' && event.kind !== 'gpu-pipeline-api') continue;
    const name = event.materialName || event.objectName || event.materialType || event.pipelineLabel || 'Unnamed pass';
    const pass = passes.get(name) ?? { name, generationMs: 0, pipelineMs: 0, pipelines: 0, fragmentBytes: 0 };
    if (event.kind === 'builder-total') {
      pass.generationMs += event.durationMs ?? 0;
      for (const build of builders.get(event.builderId ?? '')?.builds ?? []) {
        const source = sources.get(build.sourceIds.fragment ?? '');
        pass.fragmentBytes = Math.max(pass.fragmentBytes, source?.metrics.utf8Bytes ?? 0);
      }
    } else {
      pass.pipelineMs += event.durationMs ?? 0;
      pass.pipelines++;
      const source = sources.get(event.sourceIds?.fragment ?? '');
      pass.fragmentBytes = Math.max(pass.fragmentBytes, source?.metrics.utf8Bytes ?? 0);
    }
    passes.set(name, pass);
  }
  return {
    shaderGenerationMs: eventDuration(events.filter((event) => event.kind === 'builder-total')),
    shaderModuleMs: eventDuration(events.filter((event) => event.kind === 'gpu-module-api')),
    pipelineMs: eventDuration(events.filter((event) => event.kind === 'gpu-pipeline-api')),
    pipelines: events.filter((event) => event.kind === 'gpu-pipeline-api').length,
    passes: [...passes.values()].toSorted((a, b) => b.generationMs - a.generationMs),
  };
}

/** A bounded capture of the real load and its first four naturally rendered frames. */
export class LiveStartup {
  private phases: Partial<Record<StartupPhase, number>> = {};
  private state: StartupSnapshot['state'] = 'loading';
  private phase = 'scene';
  private totalMs?: number;
  private phaseStartedAt?: number;
  private historyWaitMs?: number;
  private error?: string;
  private errorStack?: string;
  private frames = 0;
  private capturing = true;
  private stopped = false;
  private shaderReport?: StartupShaderReport;

  constructor(
    private readonly scene: string,
    private readonly renderer: string,
    private readonly profiler: RendererStartupProfiler | undefined,
    private readonly update: (snapshot: StartupSnapshot) => void,
    private readonly now: () => number,
    private readonly startedAt: number,
    private readonly pageMs: number,
    cleanupMs: number,
    private readonly settings: Record<string, string | number> = {},
  ) {
    this.phases.cleanup = cleanupMs;
    this.publish();
  }

  async measure<T>(phase: StartupPhase, task: () => T | Promise<T>): Promise<T> {
    this.phase = phase;
    this.profiler?.setPhase(phase);
    const start = this.now();
    this.phaseStartedAt = start;
    this.publish();
    try {
      return await task();
    } finally {
      this.phases[phase] = this.now() - start;
      this.phaseStartedAt = undefined;
      this.publish();
    }
  }

  get isCapturing() {
    return this.capturing && !this.stopped;
  }

  rendered() {
    return ++this.frames;
  }

  ready() {
    this.totalMs = this.now() - this.startedAt;
    this.state = 'ready';
    this.phase = 'interactive';
    this.profiler?.setPhase('early-frames');
    this.shaderReport = this.profiler?.report();
    this.publish();
  }

  async finish(complete: () => Promise<void>) {
    if (this.stopped) return;
    const start = this.now();
    // Start the completion boundary before restoring hooks. Subsequent
    // interactive frames cannot grow this capture or affect that boundary.
    let completion: Promise<void>;
    try {
      completion = complete();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.profiler?.restore();
    this.stopped = true;
    try {
      await completion;
      this.historyWaitMs = this.now() - start;
      await this.profiler?.settled();
      this.shaderReport = this.profiler?.report();
    } catch (error) {
      this.error = String(error instanceof Error ? error.message : error);
    } finally {
      this.capturing = false;
      this.publish();
    }
  }

  stop() {
    if (this.stopped) return;
    this.profiler?.restore();
    this.stopped = true;
    this.capturing = false;
    this.shaderReport = this.profiler?.report();
    this.publish();
  }

  fail(error: unknown) {
    this.errorStack = error instanceof Error ? error.stack : undefined;
    this.error = String(error instanceof Error ? error.message : error);
    this.state = 'failed';
    this.totalMs = this.now() - this.startedAt;
    this.stop();
    this.publish();
  }

  snapshot(): StartupSnapshot {
    const totalMs = this.totalMs ?? this.now() - this.startedAt;
    const phases = { ...this.phases };
    if (this.phaseStartedAt !== undefined) phases[this.phase as StartupPhase] = this.now() - this.phaseStartedAt;
    const measured = Object.values(phases).reduce((sum, ms) => sum + ms, this.pageMs);
    return {
      settings: this.settings,
      scene: this.scene,
      renderer: this.renderer,
      state: this.state,
      phase: this.phase,
      totalMs,
      pageMs: this.pageMs,
      phases,
      otherMs: Math.max(0, totalMs - measured),
      historyWaitMs: this.historyWaitMs,
      frames: this.frames,
      capturing: this.capturing,
      error: this.error,
      errorStack: this.errorStack,
      shaderReport: this.shaderReport,
      ...shaderBreakdown(this.shaderReport),
    };
  }

  private publish() {
    this.update(this.snapshot());
  }
}
