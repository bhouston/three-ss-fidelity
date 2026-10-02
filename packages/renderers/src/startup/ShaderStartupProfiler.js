// GPU-independent installation; use before calling a renderer factory.
// No Node imports: the same helper can be loaded by the CLI or browser harness.
// Example:
// const profile = installShaderStartupProfiler({ RendererClass: Renderer });
// const live = await profile.measure('factory', () => createRenderer(...));
// profile.setPhase('first-frame');
// profile.measure('render', () => live.render());
// await profile.measure('gpu-completion', () => completeRenderer(live.renderer));
// await profile.settled();
// const report = profile.report(); // metrics calculated here, outside timers
// profile.restore();

export function shaderCodeMetrics(code) {
  const lines = code.split(/\r?\n/);
  // Lexical diagnostics, not control-flow complexity or a WGSL parser.
  const tokens = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const count = (pattern) => [...tokens.matchAll(pattern)].length;
  return {
    utf8Bytes: new TextEncoder().encode(code).length,
    lines: lines.length,
    nonblankLines: lines.filter((line) => line.trim()).length,
    maxLineLength: lines.reduce((max, line) => Math.max(max, line.length), 0),
    functions: count(/\bfn\s+[A-Za-z_]\w*\s*\(/g),
    loops: count(/\b(?:for|while|loop)\b/g),
    branches: count(/\b(?:if|switch)\s*\(/g),
    textureCalls: count(/\btexture(?:Sample\w*|Load|Gather\w*|Store)\s*\(/g),
    temporaryDeclarations: count(/\b(?:var|let)\s+(?:[A-Za-z_]\w*_)?(?:nodeVar|nodeConst)\d+\s*[:=]/g),
  };
}

export async function hashShaderSource(code) {
  if (!globalThis.crypto?.subtle) throw new Error('Supply hashSource or enable Web Crypto for SHA-256');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const errorText = (error) => String(error?.message ?? error);
const snapshot = (value) => {
  const object = value?.object;
  const material = value?.material;
  const context = value?.context;
  return {
    objectName: object?.name ?? '',
    objectUuid: object?.uuid ?? null,
    materialName: material?.name ?? '',
    materialType: material?.type ?? '',
    materialUuid: material?.uuid ?? null,
    contextId: context?.id ?? null,
    targetName: context?.textures?.[0]?.name ?? '',
    computeName: object ? null : (value?.name ?? null),
  };
};
const unionMs = (spans) => {
  const intervals = spans
    .filter((entry) => Number.isFinite(entry.endMs))
    .map((entry) => [entry.startMs, entry.endMs])
    .toSorted((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [start, finishAt] of intervals) {
    total += Math.max(0, finishAt - Math.max(start, end));
    end = Math.max(end, finishAt);
  }
  return total;
};

/** @param {{ RendererClass?: object, GPUDeviceClass?: object, GPUQueueClass?: object, now?: () => number }} [options] */
export function installShaderStartupProfiler({
  RendererClass,
  GPUDeviceClass = globalThis.GPUDevice,
  GPUQueueClass = globalThis.GPUQueue,
  now = () => performance.now(),
} = {}) {
  if (!RendererClass?.prototype?.init) throw new Error('RendererClass with init() is required');
  const origin = now();
  const events = [];
  const sources = [];
  const builders = [];
  const sourceIds = new Map();
  const sourceById = new Map();
  const moduleSources = new WeakMap();
  const rendererIds = new WeakMap();
  const builderStates = new WeakMap();
  const instrumentedBackends = new WeakSet();
  const restored = [];
  const pending = new Set();
  const gpuContext = [];
  let sequence = 0;
  let phase = 'startup';
  let active = true;

  const timestamp = () => now() - origin;
  const rendererId = (renderer) => {
    let id = rendererIds.get(renderer);
    if (!id) {
      id = `renderer-${++sequence}`;
      rendererIds.set(renderer, id);
    }
    return id;
  };
  const sourceId = (code, label = '', stage = null) => {
    if (typeof code !== 'string') return null;
    let id = sourceIds.get(code);
    if (!id) {
      id = `source-${++sequence}`;
      sourceIds.set(code, id);
      const source = { id, code, labels: [], stages: [] };
      sources.push(source);
      sourceById.set(id, source);
    }
    const source = sourceById.get(id);
    if (label && !source.labels.includes(label)) source.labels.push(label);
    if (stage && !source.stages.includes(stage)) source.stages.push(stage);
    return id;
  };
  const event = (kind, label, context = {}) => {
    const entry = { id: `event-${++sequence}`, kind, label, phase, startMs: timestamp(), ...context };
    events.push(entry);
    return entry;
  };
  const finish = (entry, error = null) => {
    entry.endMs = timestamp();
    entry.durationMs = entry.endMs - entry.startMs;
    if (error !== null) entry.error = errorText(error);
  };
  const observe = (promise, entry, onSuccess) => {
    // Observe completion without replacing the application's Promise or changing
    // its rejection. The separate observer branch always fulfills.
    let observation;
    observation = Promise.resolve(promise)
      .then(
        (result) => {
          finish(entry);
          if (onSuccess) onSuccess(result);
        },
        (error) => finish(entry, error),
      )
      .then(
        () => pending.delete(observation),
        (error) => {
          entry.instrumentationError = errorText(error);
          pending.delete(observation);
        },
      );
    pending.add(observation);
  };
  const wrap = (target, name, factory) => {
    if (typeof target?.[name] !== 'function') return;
    const own = Object.getOwnPropertyDescriptor(target, name);
    const original = target[name];
    const replacement = factory(original);
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      enumerable: own?.enumerable ?? false,
      value: replacement,
    });
    restored.push(() => {
      if (target[name] !== replacement) return;
      if (own) Object.defineProperty(target, name, own);
      else delete target[name];
    });
  };

  function instrumentBuilder(builder, renderObject, renderer) {
    if (!active || builderStates.has(builder)) return;
    const info = {
      id: `builder-${++sequence}`,
      rendererId: rendererId(renderer),
      phase,
      ...snapshot(renderObject),
      builds: [],
    };
    builders.push(info);
    const state = { running: 0, suspended: 0, at: 0, phases: [], current: null };
    builderStates.set(builder, state);
    const bucket = () => state.phases.at(-1) ?? builder.buildStage ?? 'other';
    const flush = () => {
      const end = timestamp();
      if (state.running && !state.suspended && state.current) {
        const stage = bucket();
        const shaderStage = builder.shaderStage ?? 'none';
        const ms = end - state.at;
        state.current.exclusiveMs[stage] = (state.current.exclusiveMs[stage] ?? 0) + ms;
        const key = `${stage}.${shaderStage}`;
        state.current.stageShaderMs[key] = (state.current.stageShaderMs[key] ?? 0) + ms;
      }
      state.at = end;
    };
    const captureSources = () => {
      const ids = {};
      for (const stage of ['vertex', 'fragment', 'compute']) {
        const code = builder[`${stage}Shader`];
        if (code) ids[stage] = sourceId(code, info.materialName || info.computeName, stage);
      }
      return ids;
    };
    for (const name of ['setBuildStage', 'setShaderStage']) {
      wrap(
        builder,
        name,
        (original) =>
          function (...args) {
            flush();
            try {
              return original.apply(this, args);
            } finally {
              state.at = timestamp();
            }
          },
      );
    }
    for (const name of ['prebuild', 'buildCode', 'buildUpdateNodes']) {
      wrap(
        builder,
        name,
        (original) =>
          function (...args) {
            flush();
            state.phases.push(name);
            state.at = timestamp();
            try {
              return original.apply(this, args);
            } finally {
              flush();
              state.phases.pop();
              state.at = timestamp();
            }
          },
      );
    }
    const begin = (method) => {
      const entry = event('builder-total', method, {
        builderId: info.id,
        rendererId: info.rendererId,
        ...snapshot(renderObject),
      });
      const build = { eventId: entry.id, exclusiveMs: {}, stageShaderMs: {}, yieldMs: 0, sourceIds: {} };
      info.builds.push(build);
      state.current = build;
      state.running++;
      state.at = timestamp();
      return { entry, build };
    };
    const end = (record, error = null) => {
      flush();
      state.running--;
      state.current = null;
      finish(record.entry, error);
      record.build.sourceIds = captureSources();
    };
    wrap(
      builder,
      'build',
      (original) =>
        function (...args) {
          // A nested build is accounted inside the enclosing builder traversal.
          if (state.running) return original.apply(this, args);
          const record = begin('build');
          let error = null;
          try {
            return original.apply(this, args);
          } catch (caught) {
            error = caught;
            throw caught;
          } finally {
            end(record, error);
          }
        },
    );
    wrap(
      builder,
      'buildAsync',
      (original) =>
        function (...args) {
          if (state.running) return original.apply(this, args);
          const record = begin('buildAsync');
          // NodeManager supplies yieldFn for render builds. Preserve unspecified
          // defaults: do not invent a scheduler for compute or external callers.
          if (typeof args[0] === 'function') {
            const yieldFn = args[0];
            args[0] = function (...yieldArgs) {
              flush();
              state.suspended++;
              const start = timestamp();
              let result;
              try {
                result = yieldFn.apply(this, yieldArgs);
              } catch (error) {
                record.build.yieldMs += timestamp() - start;
                state.suspended--;
                state.at = timestamp();
                throw error;
              }
              const resume = () => {
                record.build.yieldMs += timestamp() - start;
                state.suspended--;
                state.at = timestamp();
              };
              return Promise.resolve(result).then(
                (value) => {
                  resume();
                  return value;
                },
                (error) => {
                  resume();
                  throw error;
                },
              );
            };
          } else {
            record.build.defaultYieldIncluded = true;
          }
          let result;
          try {
            result = original.apply(this, args);
          } catch (error) {
            end(record, error);
            throw error;
          }
          let observation;
          observation = Promise.resolve(result)
            .then(
              () => end(record),
              (error) => end(record, error),
            )
            .then(
              () => pending.delete(observation),
              (error) => {
                record.entry.instrumentationError = errorText(error);
                pending.delete(observation);
              },
            );
          pending.add(observation);
          return result;
        },
    );
  }

  function instrumentBackend(backend, renderer) {
    if (!backend || instrumentedBackends.has(backend)) return;
    instrumentedBackends.add(backend);
    for (const method of ['createProgram', 'createRenderPipeline', 'createComputePipeline']) {
      wrap(
        backend,
        method,
        (original) =>
          function (...args) {
            const context = {
              rendererId: rendererId(renderer),
              ...(method === 'createProgram'
                ? { programName: args[0]?.name ?? '', shaderStage: args[0]?.stage ?? null }
                : snapshot(args[0])),
            };
            const entry = event('backend-api', method, context);
            gpuContext.push(context);
            let error = null;
            try {
              return original.apply(this, args);
            } catch (caught) {
              error = caught;
              throw caught;
            } finally {
              finish(entry, error);
              gpuContext.pop();
            }
          },
      );
    }
  }

  wrap(
    RendererClass.prototype,
    'init',
    (original) =>
      function (...args) {
        const renderer = this;
        if (!rendererIds.has(renderer)) {
          rendererId(renderer);
          const previous = renderer.debug?.onNodeBuilderCreated;
          if (renderer.debug) {
            const callback = function (builder, object) {
              if (typeof previous === 'function') previous.apply(this, arguments);
              instrumentBuilder(builder, object, renderer);
            };
            renderer.debug.onNodeBuilderCreated = callback;
            restored.push(() => {
              if (renderer.debug.onNodeBuilderCreated === callback) renderer.debug.onNodeBuilderCreated = previous;
            });
          }
          instrumentBackend(renderer.backend, renderer);
        }
        const entry = event('renderer-init', 'init', { rendererId: rendererId(renderer) });
        let result;
        try {
          result = original.apply(renderer, args);
        } catch (error) {
          finish(entry, error);
          throw error;
        }
        observe(result, entry, () => instrumentBackend(renderer.backend, renderer));
        return result;
      },
  );

  wrap(
    GPUDeviceClass?.prototype,
    'createShaderModule',
    (original) =>
      function (...args) {
        const descriptor = args[0];
        const label = descriptor?.label ?? '';
        const code = descriptor?.code;
        const context = gpuContext.at(-1) ?? {};
        const entry = event('gpu-module-api', label, context);
        let result;
        let error = null;
        try {
          result = original.apply(this, args);
          return result;
        } catch (caught) {
          error = caught;
          throw caught;
        } finally {
          finish(entry, error);
          // Intern source strings after the measured native API call.
          entry.sourceId = sourceId(code, label, context.shaderStage);
          if (result && typeof result === 'object') moduleSources.set(result, entry.sourceId);
        }
      },
  );
  for (const name of [
    'createRenderPipeline',
    'createRenderPipelineAsync',
    'createComputePipeline',
    'createComputePipelineAsync',
  ]) {
    wrap(
      GPUDeviceClass?.prototype,
      name,
      (original) =>
        function (...args) {
          const descriptor = args[0];
          const label = descriptor?.label ?? '';
          const context = {
            ...gpuContext.at(-1),
            sourceIds: {
              vertex: moduleSources.get(descriptor?.vertex?.module) ?? null,
              fragment: moduleSources.get(descriptor?.fragment?.module) ?? null,
              compute: moduleSources.get(descriptor?.compute?.module) ?? null,
            },
          };
          const entry = event('gpu-pipeline-api', name, {
            pipelineLabel: label,
            descriptor: {
              primitive: descriptor?.primitive ? { ...descriptor.primitive } : null,
              multisample: descriptor?.multisample ? { ...descriptor.multisample } : null,
              depthStencil: descriptor?.depthStencil ? structuredClone(descriptor.depthStencil) : null,
              targets: descriptor?.fragment?.targets ? structuredClone(descriptor.fragment.targets) : null,
              vertexBuffers: descriptor?.vertex?.buffers ? structuredClone(descriptor.vertex.buffers) : null,
            },
            ...context,
          });
          let result;
          let error = null;
          try {
            result = original.apply(this, args);
            return result;
          } catch (caught) {
            error = caught;
            throw caught;
          } finally {
            finish(entry, error);
            if (result?.then) {
              const completion = event('gpu-pipeline-ready', name, {
                pipelineLabel: label,
                apiEventId: entry.id,
                ...context,
              });
              completion.startMs = entry.startMs;
              observe(result, completion);
            }
          }
        },
    );
  }
  wrap(
    GPUQueueClass?.prototype,
    'onSubmittedWorkDone',
    (original) =>
      function (...args) {
        const entry = event('gpu-queue-completion', 'onSubmittedWorkDone');
        let result;
        try {
          result = original.apply(this, args);
        } catch (error) {
          finish(entry, error);
          throw error;
        }
        observe(result, entry);
        return result;
      },
  );

  const profiler = {
    setPhase(label) {
      phase = label;
    },
    measure(label, fn) {
      const entry = event('application-span', label);
      let result;
      try {
        result = fn();
      } catch (error) {
        finish(entry, error);
        throw error;
      }
      if (result?.then) observe(result, entry);
      else finish(entry);
      return result;
    },
    async settled() {
      // Instrumentation observers may enqueue additional observers while settling.
      while (pending.size) await Promise.all(pending);
    },
    report({ includeSource = false } = {}) {
      const byKind = {};
      for (const entry of events) {
        const list = (byKind[entry.kind] ??= []);
        list.push(entry);
      }
      return {
        schemaVersion: 1,
        notes: [
          'Builder totals and backend calls are inclusive; do not add them to child durations.',
          'Async ready durations include dispatch latency; use interval unions for overlapping work.',
          'Queue completion measures submitted work, not per-shader compilation.',
          'Default buildAsync scheduling is included unless a yieldFn was explicitly supplied.',
          'Code metrics are lexical counts calculated outside measured calls.',
        ],
        elapsedMs: timestamp(),
        pendingObservers: pending.size,
        summary: Object.fromEntries(
          Object.entries(byKind).map(([kind, entries]) => [
            kind,
            {
              count: entries.length,
              completed: entries.filter((entry) => Number.isFinite(entry.endMs)).length,
              summedMs: entries.reduce((total, entry) => total + (entry.durationMs ?? 0), 0),
              unionMs: unionMs(entries),
            },
          ]),
        ),
        builders: structuredClone(builders),
        events: structuredClone(events),
        sources: sources.map(({ code, ...source }) => ({
          ...structuredClone(source),
          metrics: shaderCodeMetrics(code),
          ...(includeSource ? { code } : {}),
        })),
      };
    },
    async reportAsync({ includeSource = false, hashSource = hashShaderSource } = {}) {
      const report = profiler.report({ includeSource });
      // Hashes are calculated after the timed work, not in module/pipeline calls.
      const hashes = new Map(
        await Promise.all(
          report.sources.map(async (source) => [source.id, await hashSource(sourceById.get(source.id).code)]),
        ),
      );
      for (const source of report.sources) source.sha256 = hashes.get(source.id);
      for (const entry of report.events) {
        if (entry.sourceId) entry.sourceHash = hashes.get(entry.sourceId);
        if (entry.sourceIds)
          entry.sourceHashes = Object.fromEntries(
            Object.entries(entry.sourceIds).map(([stage, id]) => [stage, hashes.get(id) ?? null]),
          );
      }
      for (const builder of report.builders)
        for (const build of builder.builds) {
          build.sourceHashes = Object.fromEntries(
            Object.entries(build.sourceIds).map(([stage, id]) => [stage, hashes.get(id) ?? null]),
          );
        }
      return report;
    },
    trace() {
      return {
        traceEvents: events
          .filter((entry) => Number.isFinite(entry.durationMs))
          .map((entry) => ({
            name: `${entry.kind}: ${entry.label}`,
            cat: entry.kind,
            ph: 'X',
            ts: entry.startMs * 1000,
            dur: entry.durationMs * 1000,
            pid: 1,
            tid: /ready|completion/.test(entry.kind) ? 2 : 1,
            args: structuredClone(entry),
          })),
        displayTimeUnit: 'ms',
      };
    },
    restore() {
      if (!active) return;
      active = false;
      for (const restore of restored.toReversed()) restore();
    },
  };
  return profiler;
}
