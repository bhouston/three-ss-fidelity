import type { MetricDescriptor, MetricSample, PipelineProfiler } from '@three-fidelity/runtime';

interface TimestampRenderer {
  backend: {
    updateTimeStampUID(context: unknown): void;
    getTimestampUID(context: unknown): string;
    timestampQueryPool: Record<'render' | 'compute', { timestamps: Map<string, number> } | null>;
  };
  render(scene: unknown, camera: unknown): void;
  compute(nodes: unknown, dispatchSize?: unknown): unknown;
  hasFeature(name: string): boolean;
  resolveTimestampsAsync(type: 'render' | 'compute'): Promise<number | undefined>;
}

function unsupported(reason: string): PipelineProfiler {
  return {
    status: 'unsupported',
    reason,
    metrics: [],
    invalidSamples: 0,
    beginFrame() {},
    endFrame() {},
    async resolve() {
      return [];
    },
    dispose() {},
  };
}

/** Version-specific three.js internals are isolated here, never in the generic runner. */
export function createWebGPUProfiler(renderer: TimestampRenderer): PipelineProfiler {
  if (!renderer.hasFeature('timestamp-query')) return unsupported('Adapter does not expose timestamp-query');
  const descriptor: MetricDescriptor = {
    id: 'gpu.pass-sum',
    label: 'GPU pass duration sum',
    unit: 'ms',
    description: 'Sum of render/compute query intervals; not a whole-frame GPU span or a serial time budget.',
  };
  const metrics = new Map<string, MetricDescriptor>([[descriptor.id, descriptor]]);
  const attribution = new Map<string, { frame: number; metric: string }>();
  let frame = -1;
  let name = '';
  let invalidSamples = 0;
  const backend = renderer.backend;
  const originalUpdate = backend.updateTimeStampUID;
  const originalRender = renderer.render;
  const originalCompute = renderer.compute;
  backend.updateTimeStampUID = function (context) {
    originalUpdate.call(backend, context);
    const uid = backend.getTimestampUID(context);
    const label = name || uid.replace(/:f\d+$/, '');
    const id = `gpu.pass.${label}`;
    metrics.set(id, {
      id,
      label,
      unit: 'ms',
      description: 'GPU query duration, summed over all invocations of this pass within the frame.',
    });
    attribution.set(uid, { frame, metric: id });
  };
  renderer.render = function (scene, camera) {
    const previous = name;
    name = (scene as { name?: string } | null)?.name ?? '';
    try {
      originalRender.call(renderer, scene, camera);
    } finally {
      name = previous;
    }
  };
  renderer.compute = function (nodes, dispatchSize) {
    const previous = name;
    name =
      (Array.isArray(nodes) ? nodes : [nodes])
        .map((node) => (node as { name?: string })?.name)
        .filter(Boolean)
        .join(', ') || 'Compute';
    try {
      return originalCompute.call(renderer, nodes, dispatchSize);
    } finally {
      name = previous;
    }
  };
  return {
    status: 'supported',
    get metrics() {
      return [...metrics.values()];
    },
    get invalidSamples() {
      return invalidSamples;
    },
    beginFrame(index) {
      frame = index;
    },
    endFrame() {
      frame = -1;
    },
    async resolve() {
      const perFrame = new Map<number, Map<string, number>>();
      for (const type of ['render', 'compute'] as const) {
        await renderer.resolveTimestampsAsync(type);
        for (const [uid, duration] of backend.timestampQueryPool[type]?.timestamps ?? []) {
          const source = attribution.get(uid);
          attribution.delete(uid); // a resolve may return stale pool data; consume each query once
          if (!source || source.frame < 0) continue;
          if (!Number.isFinite(duration) || duration < 0) {
            invalidSamples++;
            continue;
          }
          const values = perFrame.get(source.frame) ?? new Map<string, number>();
          values.set(source.metric, (values.get(source.metric) ?? 0) + duration);
          values.set(descriptor.id, (values.get(descriptor.id) ?? 0) + duration);
          perFrame.set(source.frame, values);
        }
      }
      return [...perFrame].flatMap(([index, values]) =>
        [...values].map(([metric, value]) => ({ frame: index, metric, value })),
      );
    },
    dispose() {
      backend.updateTimeStampUID = originalUpdate;
      renderer.render = originalRender;
      renderer.compute = originalCompute;
      attribution.clear();
    },
  };
}

interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** One whole-frame elapsed query. Per-pass queries require renderer-owned, non-nested scopes. */
export function createWebGLProfiler(gl: WebGL2RenderingContext): PipelineProfiler {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
  if (!ext) return unsupported('WebGL context does not expose EXT_disjoint_timer_query_webgl2');
  const pending: { frame: number; query: WebGLQuery }[] = [];
  let current: { frame: number; query: WebGLQuery } | undefined;
  let invalidSamples = 0;
  return {
    status: 'supported',
    metrics: [
      {
        id: 'gpu.frame',
        label: 'GPU frame elapsed',
        unit: 'ms',
        description: 'WebGL elapsed query around all commands submitted for this frame.',
      },
    ],
    beginFrame(frame) {
      const query = gl.createQuery();
      if (!query) {
        invalidSamples++;
        return;
      }
      gl.getParameter(ext.GPU_DISJOINT_EXT);
      current = { frame, query };
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    },
    endFrame() {
      if (current) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push(current);
        current = undefined;
      }
    },
    async resolve() {
      const result: MetricSample[] = [];
      const deadline = performance.now() + 10000;
      while (pending.length) {
        if (gl.isContextLost() || gl.getParameter(ext.GPU_DISJOINT_EXT) || performance.now() > deadline) {
          invalidSamples += pending.length;
          for (const sample of pending.splice(0)) gl.deleteQuery(sample.query);
          break;
        }
        const sample = pending[0]!;
        if (!gl.getQueryParameter(sample.query, gl.QUERY_RESULT_AVAILABLE)) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          continue;
        }
        const value = Number(gl.getQueryParameter(sample.query, gl.QUERY_RESULT)) / 1e6;
        if (Number.isFinite(value) && value >= 0) result.push({ frame: sample.frame, metric: 'gpu.frame', value });
        else invalidSamples++;
        gl.deleteQuery(sample.query);
        pending.shift();
      }
      return result;
    },
    dispose() {
      if (current) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.deleteQuery(current.query);
      }
      for (const sample of pending.splice(0)) gl.deleteQuery(sample.query);
      current = undefined;
    },
    get invalidSamples() {
      return invalidSamples;
    },
  };
}

/** GPU completion without pixel copying, at explicit batch boundaries. */
export async function completeRenderer(renderer: unknown): Promise<void> {
  const gpu = renderer as {
    backend?: { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } };
    getContext?: () => WebGL2RenderingContext;
  };
  if (gpu.backend?.device) await gpu.backend.device.queue.onSubmittedWorkDone();
  else if (gpu.getContext) {
    const context = gpu.getContext();
    if (context.isContextLost()) throw new Error('WebGL context lost before GPU completion');
    const sync = context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) throw new Error('Could not create WebGL GPU completion fence');
    try {
      context.flush();
      for (;;) {
        if (context.isContextLost()) throw new Error('WebGL context lost during GPU completion');
        const status = context.clientWaitSync(sync, 0, 0);
        if (status === context.ALREADY_SIGNALED || status === context.CONDITION_SATISFIED) break;
        if (status === context.WAIT_FAILED) throw new Error('WebGL GPU completion wait failed');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      context.deleteSync(sync);
    }
    if (context.isContextLost()) throw new Error('WebGL context lost during GPU completion');
  } else throw new Error('Renderer needs a GPU completion adapter');
}

export function createRendererProfiler(renderer: unknown): PipelineProfiler {
  const gpu = renderer as TimestampRenderer & { getContext?: () => WebGL2RenderingContext };
  if (gpu.backend && typeof gpu.resolveTimestampsAsync === 'function') return createWebGPUProfiler(gpu);
  if (gpu.getContext) return createWebGLProfiler(gpu.getContext());
  return unsupported('Renderer has no timing adapter');
}
