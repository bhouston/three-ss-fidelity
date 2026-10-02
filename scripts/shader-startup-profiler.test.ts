import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { installShaderStartupProfiler, shaderCodeMetrics } from './shader-startup-profiler.mjs';

function fixture() {
  let clock = 0;
  const advance = (ms: number) => {
    clock += ms;
  };
  const pendingPipelines: ((value: unknown) => void)[] = [];
  const failure = new Error('deliberate shader failure');
  class Device {
    lastPromise: Promise<unknown> | null = null;
    fail = false;
    createShaderModule(descriptor: { label: string; code: string }) {
      advance(2);
      if (this.fail) throw failure;
      return { label: descriptor.label };
    }
    createRenderPipeline(descriptor: unknown) {
      advance(3);
      return descriptor;
    }
    createRenderPipelineAsync(_descriptor: unknown) {
      advance(1);
      if (this.fail) return (this.lastPromise = Promise.reject(failure));
      const promise = new Promise((resolve) => pendingPipelines.push(resolve));
      this.lastPromise = promise;
      return promise;
    }
  }
  class Queue {
    lastPromise: Promise<void> | null = null;
    onSubmittedWorkDone() {
      advance(2);
      return (this.lastPromise = Promise.resolve());
    }
  }
  class Backend {
    device = new Device();
    createProgram(program: { name: string; stage: string; code: string }) {
      return this.device.createShaderModule({ label: program.name, code: program.code });
    }
  }
  class Renderer {
    debug: { onNodeBuilderCreated: ((builder: unknown, object: unknown) => void) | null } = {
      onNodeBuilderCreated: null,
    };
    backend = new Backend();
    lastPromise: Promise<this> | null = null;
    init() {
      advance(4);
      return (this.lastPromise = Promise.resolve(this));
    }
  }
  class Builder {
    buildStage: string | null = null;
    shaderStage: string | null = null;
    fragmentShader = 'fn main() { var nodeVar0 : f32; if (true) { nodeVar0 = 1.0; } }';
    lastPromise: Promise<this> | null = null;
    setBuildStage(stage: string | null) {
      this.buildStage = stage;
    }
    setShaderStage(stage: string | null) {
      this.shaderStage = stage;
    }
    prebuild() {
      advance(1);
    }
    buildCode() {
      advance(5);
    }
    buildUpdateNodes() {
      advance(1);
    }
    stages() {
      for (const [stage, ms] of [
        ['setup', 2],
        ['analyze', 3],
        ['generate', 4],
      ] as const) {
        this.setBuildStage(stage);
        this.setShaderStage('fragment');
        advance(ms);
      }
      this.setBuildStage(null);
      this.setShaderStage(null);
    }
    build() {
      this.prebuild();
      this.stages();
      this.buildCode();
      this.buildUpdateNodes();
      return this;
    }
    buildAsync(
      yieldFn = async () => {
        advance(7);
      },
    ) {
      return (this.lastPromise = (async () => {
        this.prebuild();
        this.setBuildStage('setup');
        this.setShaderStage('fragment');
        advance(2);
        await yieldFn();
        this.setBuildStage('analyze');
        advance(3);
        this.setBuildStage('generate');
        advance(4);
        this.setBuildStage(null);
        this.setShaderStage(null);
        this.buildCode();
        this.buildUpdateNodes();
        return this;
      })());
    }
  }
  const original = {
    init: Renderer.prototype.init,
    shaderModule: Device.prototype.createShaderModule,
    pipeline: Device.prototype.createRenderPipeline,
    pipelineAsync: Device.prototype.createRenderPipelineAsync,
    queueDone: Queue.prototype.onSubmittedWorkDone,
  };
  const profiler = installShaderStartupProfiler({
    RendererClass: Renderer,
    GPUDeviceClass: Device,
    GPUQueueClass: Queue,
    now: () => clock,
  });
  const renderer = new Renderer();
  const object = { object: { name: 'SSR [ Trace ]' }, material: { name: 'SSR', uuid: 'material-1' } };
  const attach = (builder: Builder) => renderer.debug.onNodeBuilderCreated!(builder, object);
  return {
    profiler,
    renderer,
    Builder,
    Renderer,
    Device,
    Queue,
    object,
    attach,
    advance,
    pendingPipelines,
    failure,
    original,
  };
}

test('accounts actual builder phases, links source modules, snapshots pass names, and restores hooks', async () => {
  const f = fixture();
  const builder = new f.Builder();
  const originalBuild = builder.build;
  const originalProgram = f.renderer.backend.createProgram;
  let callbacks = 0;
  const previous = () => {
    callbacks++;
  };
  f.renderer.debug.onNodeBuilderCreated = previous;
  try {
    const initialization = f.renderer.init();
    assert.equal(initialization, f.renderer.lastPromise);
    await initialization;
    f.attach(builder);
    assert.equal(callbacks, 1);
    assert.equal(builder.build(), builder);
    const module = f.renderer.backend.createProgram({ name: 'SSR', stage: 'fragment', code: builder.fragmentShader });
    const descriptor = { label: 'SSR pipeline', fragment: { module, targets: [{ format: 'rgba16float' }] } };
    assert.equal(f.renderer.backend.device.createRenderPipeline(descriptor), descriptor);
    f.object.object.name = 'next reused fullscreen pass';
    descriptor.fragment.targets[0]!.format = 'rgba8unorm';
    await f.profiler.settled();
    const report = await f.profiler.reportAsync();
    assert.equal(report.builders.length, 1);
    assert.equal(report.builders[0].objectName, 'SSR [ Trace ]');
    const build = report.builders[0].builds[0];
    assert.equal(build.exclusiveMs.prebuild, 1);
    assert.equal(build.exclusiveMs.setup, 2);
    assert.equal(build.exclusiveMs.analyze, 3);
    assert.equal(build.exclusiveMs.generate, 4);
    assert.equal(build.exclusiveMs.buildCode, 5);
    assert.equal(build.exclusiveMs.buildUpdateNodes, 1);
    assert.equal(report.summary['builder-total'].summedMs, 16);
    assert.equal(report.summary['gpu-module-api'].summedMs, 2);
    assert.equal(report.summary['gpu-pipeline-api'].summedMs, 3);
    assert.equal(report.sources.length, 1);
    assert.match(report.sources[0].sha256, /^[a-f0-9]{64}$/);
    const pipeline = report.events.find((entry: { kind: string }) => entry.kind === 'gpu-pipeline-api');
    assert.equal(pipeline.descriptor.targets[0].format, 'rgba16float');
    assert.equal(pipeline.sourceIds.fragment, report.sources[0].id);
    assert.equal(pipeline.sourceHashes.fragment, report.sources[0].sha256);
    assert.equal(f.profiler.trace().traceEvents.length, report.events.length);
  } finally {
    f.profiler.restore();
  }
  assert.equal(builder.build, originalBuild);
  assert.equal(f.renderer.backend.createProgram, originalProgram);
  assert.equal(f.renderer.debug.onNodeBuilderCreated, previous);
  assert.equal(f.Renderer.prototype.init, f.original.init);
  assert.equal(f.Device.prototype.createShaderModule, f.original.shaderModule);
  assert.equal(f.Device.prototype.createRenderPipeline, f.original.pipeline);
  assert.equal(f.Device.prototype.createRenderPipelineAsync, f.original.pipelineAsync);
  assert.equal(f.Queue.prototype.onSubmittedWorkDone, f.original.queueDone);
  f.profiler.restore();
});

test('keeps original async promises and distinguishes dispatch, overlapping readiness, and queue completion', async () => {
  const f = fixture();
  try {
    await f.renderer.init();
    const device = f.renderer.backend.device;
    const first = device.createRenderPipelineAsync({ label: 'first' });
    assert.equal(first, device.lastPromise);
    const second = device.createRenderPipelineAsync({ label: 'second' });
    assert.equal(second, device.lastPromise);
    f.advance(20);
    f.pendingPipelines[0]!('first result');
    f.pendingPipelines[1]!('second result');
    assert.deepEqual(await Promise.all([first, second]), ['first result', 'second result']);
    const queue = new f.Queue();
    const completion = queue.onSubmittedWorkDone();
    assert.equal(completion, queue.lastPromise);
    await completion;
    await f.profiler.settled();
    const report = f.profiler.report();
    assert.equal(report.summary['gpu-pipeline-api'].summedMs, 2);
    assert.equal(report.summary['gpu-pipeline-ready'].summedMs, 43);
    assert.equal(report.summary['gpu-pipeline-ready'].unionMs, 22);
    assert.equal(report.summary['gpu-queue-completion'].summedMs, 2);
    assert.equal(report.pendingObservers, 0);
  } finally {
    f.profiler.restore();
  }
});

test('excludes explicit async builder yields and marks uninstrumented default scheduler waits', async () => {
  const f = fixture();
  try {
    await f.renderer.init();
    const explicit = new f.Builder();
    f.attach(explicit);
    const build = explicit.buildAsync(async () => {
      f.advance(7);
    });
    assert.equal(build, explicit.lastPromise);
    assert.equal(await build, explicit);
    const defaultYield = new f.Builder();
    f.attach(defaultYield);
    await defaultYield.buildAsync();
    await f.profiler.settled();
    const report = f.profiler.report();
    const first = report.builders[0].builds[0];
    assert.equal(first.yieldMs, 7);
    assert.equal(first.exclusiveMs.setup, 2);
    assert.equal(
      Object.values(first.exclusiveMs).reduce((a: number, b: number) => a + b, 0),
      16,
    );
    assert.equal(report.builders[1].builds[0].defaultYieldIncluded, true);
    assert.equal(report.builders[1].builds[0].exclusiveMs.setup, 9);
  } finally {
    f.profiler.restore();
  }
});

test('preserves synchronous failures and records the failed native API span', async () => {
  const f = fixture();
  try {
    await f.renderer.init();
    f.renderer.backend.device.fail = true;
    assert.throws(
      () => f.renderer.backend.createProgram({ name: 'bad', stage: 'fragment', code: 'invalid shader' }),
      (error) => error === f.failure,
    );
    const report = f.profiler.report();
    assert.equal(
      report.events.find((entry: { kind: string }) => entry.kind === 'gpu-module-api').error,
      f.failure.message,
    );
    assert.equal(
      report.events.find((entry: { kind: string }) => entry.kind === 'backend-api').error,
      f.failure.message,
    );
  } finally {
    f.profiler.restore();
  }
});

test('preserves asynchronous pipeline rejections on the original application promise', async () => {
  const f = fixture();
  try {
    await f.renderer.init();
    f.renderer.backend.device.fail = true;
    const promise = f.renderer.backend.device.createRenderPipelineAsync({ label: 'bad pipeline' });
    assert.equal(promise, f.renderer.backend.device.lastPromise);
    await assert.rejects(promise, (error) => error === f.failure);
    await f.profiler.settled();
    assert.equal(
      f.profiler.report().events.find((entry: { kind: string }) => entry.kind === 'gpu-pipeline-ready').error,
      f.failure.message,
    );
  } finally {
    f.profiler.restore();
  }
});

test('counts lexical shader structure without counting comments as executable code', () => {
  const metrics = shaderCodeMetrics(`// fn imaginary() { loop {} }
fn main() {
  var nodeVar0 : f32;
  for (var i = 0; i < 2; i++) {
    if (i > 0) { nodeVar0 = textureLoad(t, vec2i(0), 0).x; }
  }
}`);
  assert.equal(metrics.functions, 1);
  assert.equal(metrics.loops, 1);
  assert.equal(metrics.branches, 1);
  assert.equal(metrics.textureCalls, 1);
  assert.equal(metrics.temporaryDeclarations, 1);
  assert.equal(metrics.lines, 7);
});
