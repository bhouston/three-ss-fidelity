import { Renderer } from 'three/webgpu';
import { Renderer as StockRenderer } from 'three-r186/webgpu';
import { installShaderStartupProfiler } from './startup/ShaderStartupProfiler.js';
import type { RendererName } from './types.js';

export interface StartupEvent {
  id: string;
  kind: string;
  label: string;
  phase: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  builderId?: string;
  objectName?: string;
  materialName?: string;
  materialType?: string;
  programName?: string;
  sourceId?: string;
  pipelineLabel?: string;
  sourceIds?: { vertex: string | null; fragment: string | null; compute: string | null };
  error?: string;
}
export interface StartupSource {
  id: string;
  labels: string[];
  stages: string[];
  metrics: {
    utf8Bytes: number;
    lines: number;
    functions: number;
    loops: number;
    branches: number;
    textureCalls: number;
  };
}
export interface StartupShaderReport {
  schemaVersion: number;
  notes: string[];
  pendingObservers: number;
  events: StartupEvent[];
  builders: { id: string; builds: { sourceIds: Record<string, string> }[] }[];
  sources: StartupSource[];
}
export interface RendererStartupProfiler {
  setPhase(label: string): void;
  settled(): Promise<void>;
  report(): StartupShaderReport;
  restore(): void;
}

/** Install before createRenderer(), including environment preparation inside the factory. */
export function createRendererStartupProfiler(name: RendererName): RendererStartupProfiler | undefined {
  if (name === 'three-gpu-pathtracer') return undefined; // WebGL exposes no node-builder/WebGPU breakdown.
  return installShaderStartupProfiler({
    RendererClass: name === 'three-current' ? StockRenderer : Renderer,
  }) as unknown as RendererStartupProfiler;
}
