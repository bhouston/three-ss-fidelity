# Live rendering and performance reports

The suite uses the same scene and live pipeline for captures, benchmarks, and interactive inspection. Rendering experiments own their graph and GPU resources. Runners own scheduling and measurement; reports do not depend on Three.js.

## Interactive lab

```sh
pnpm build
pnpm live
```

Open <http://127.0.0.1:5173/>. Select a scene, pipeline and physical pixel dimensions, then load the scene. Drag to orbit and scroll to zoom. Capture a converged PNG at the current pose, or run a fresh, seeded benchmark. The stock→experimental comparison alternates renderer order between repetitions. Benchmarking locks interaction; cancellation releases the session. Hidden tabs abort browser runs rather than reporting throttled timing.

The live instrument panel shows a rolling window of up to 120 frame intervals, including FPS, mean/p95 and CPU submission time. Enable **Instrument live GPU passes** to reload the scene with asynchronous query collection and per-pass mean/p95. These exploratory readings include instrumentation overhead and are kept separate from repeatable reports.

All control values and the interactive camera position/target are stored in the URL. Copy the address to share a setup; refreshing restores it. Reports are downloaded separately. Browser seeds control scene generation; renderer sampling uses its native randomness because rewinding Three's global RNG during live rendering can collide with persistent texture identities. Use the CLI's fresh-process runs for fully seeded rendering.

The report panel displays raw timing traces, mean/stddev/median/p95, repetition variation, and optional internal GPU metrics. Download JSON or a self-contained HTML report; import existing JSON to inspect it without re-running the renderer. The HTML works offline.

The lab is a local development tool. Vite serves assets from `submodules/three.js/examples/`; production builds do not copy that large asset tree. The fidelity-kit image viewer and deployed site remain separate. Benchmark HTML can be linked from suite documentation, but it is not automatically discovered by the existing fidelity-kit viewer.

## CLI benchmarks

```sh
# Default: 60 warmup frames, five measured seconds, five fresh repetitions.
pnpm cli bench --renderers three-current,three-new --scenes cornell-box-basic --out benchmarks/ab.json

# Infrastructure smoke test, not evidence of a speed improvement.
pnpm cli bench --renderers three-new --scenes cornell-box-basic \
  --width 160 --height 120 --warmup 3 --measure 7 --repeats 1 --out /tmp/bench.json

# Replay a closed camera trajectory, finishing complete 120-frame cycles.
pnpm cli bench --renderers three-current,three-new --scenes diag-rough-30 \
  --motion orbit --cycle 120 --orbit-degrees 30 --seed 1

# Explicitly instrumented GPU profile; do not compare its wall times to throughput runs.
pnpm cli bench --renderers three-new --scenes cornell-box-basic --profile
```

Each scene/renderer/repetition gets its own child process, fresh scene, random seed, and temporal history. Shader compilation and warmup occur outside measurement. Renderer order alternates between repetitions. Scene traversal order is preserved. `--experiment` selects a three-new-only variant; `--gpu` remains an alias for `--profile`.

CLI throughput renders bounded batches, completes submitted GPU work, then records elapsed wall time per completed frame. WebGPU uses `queue.onSubmittedWorkDone()`; WebGL uses `finish()` at batch boundaries without copying an image. There is no artificial sleep inside the measured frame loop. A host yield between batches keeps async work and cancellation responsive. Overall FPS includes host scheduling; batch timings exclude the inter-batch yield.

`--measure` specifies an exact measured frame count, including partial final batches. Otherwise `--duration` is a minimum wall-clock duration. Motion runs stop at a shared batch/cycle boundary; an exact frame budget must contain whole motion cycles. Camera motion follows frame index at a fixed 1/60 logical timestep, independent of rendering speed. The static workload continues executing temporal effects on every frame. Existing animated scene definitions still contain their fixed reference pose; this does not yet introduce object-animation workloads.

## Timing semantics

| Metric             | Samples | Meaning                                                                      |
| ------------------ | ------- | ---------------------------------------------------------------------------- |
| `cpu.submit`       | Frame   | Wall time for workload update and render submission; excludes GPU waiting    |
| `throughput.frame` | Batch   | GPU-completed batch wall time divided by frames in that batch                |
| `cadence.frame`    | Frame   | Browser animation callback interval, including display pacing and scheduling |
| `profile.frame`    | Frame   | Instrumented submission, query resolution and GPU completion                 |
| `gpu.pass-sum`     | Frame   | Sum of WebGPU render/compute query intervals; not a whole-frame GPU span     |
| `gpu.pass.*`       | Frame   | Duration of a named pass, combining repeated invocations within that frame   |
| `gpu.frame`        | Frame   | WebGL elapsed query around whole-frame command submission                    |

The throughput metric's mean is the mean of normalized batch samples; overall FPS is total frames / total elapsed time. A partial final batch has equal weight in the batch distribution. Its p95 describes batches and cannot identify individual frame hitches. Cadence, CPU and GPU samples have per-frame distributions. CPU submit wall time includes scheduling interruptions; it is not process CPU usage.

Statistics use sample standard deviation and nearest-rank p95. A single repetition does not establish run-to-run variability. A/B ratios compare matching repetitions with identical workload and protocol. Reports retain individual repetitions; there is no confidence claim based on treating adjacent frames as independent samples. Keep the machine quiet for performance conclusions. Smoke tests on a busy machine validate behavior only.

Browser cadence follows refresh and can hide a 10→7 ms improvement at 60 Hz. Use completed-work throughput to study rendering cost. Browser throughput remains subject to browser scheduling and differs from native Dawn; compare runs from the same environment.

The opt-in SSGI work and sample-budget experiments, quality results, and pending speed assessment are documented in [SSGI-WORK-EXPERIMENTS.md](SSGI-WORK-EXPERIMENTS.md).

## GPU profiling

GPU profiling is opt-in and uses a different protocol. Timestamp queries are resolved per measured frame, then the GPU completion boundary is awaited. This serializes CPU/GPU work. It is an initial diagnostic implementation, not a buffered continuous profiler. Unsupported capabilities and invalid samples are explicit in reports.

The WebGPU adapter isolates the current Three.js query-pool internals. Each query is associated with its logical frame and pass label, consumed once, and grouped by frame before statistics. Pass names come from scenes/quads/compute nodes; unnamed contexts use stable context IDs. GPU interval sums are deliberately called `gpu.pass-sum`; they are not presented as whole-frame elapsed time. Timestamp precision, GPU overlap and driver behavior can affect interpretation. The Dawn headless adapter disables timestamp quantization; browsers may have different precision.

WebGL uses `EXT_disjoint_timer_query_webgl2` when supported, waits for availability, and discards disjoint/context-lost queries. The initial adapter provides a whole-frame query; renderer-owned internal profilers can report additional metrics. Elapsed queries must not be nested.

## Toolkit and custom pipelines

`@ss-fidelity/runtime` exports `LivePipeline`, `RenderSession`, `FrameContext`, `benchmark`, `capture`, statistics and versioned reports. It imports no Three.js or Node APIs. The benchmark runner owns the fresh session returned by its factory and disposes it on success, failure or cancellation. Capture operates on a borrowed session and leaves disposal to the caller.

`@ss-fidelity/renderers` exports renderer setup helpers used by the stock and experimental adapters: `configureRenderer`, `setRenderSize`, `prepareScene`, `createLivePipeline`, `createRendererFrameDriver`, and `completeRenderer`. `prepareScene` accepts injected environment baking and gradient-node creation, retaining control over the renderer version/backend. It restores borrowed scene state and releases its generated environment target on disposal. `disposeSceneSetup` separately releases caller-owned scene assets.

A custom graph can use ordinary Three.js objects:

```ts
import { benchmark } from '@ss-fidelity/runtime';
import { createLivePipeline, createRendererFrameDriver, completeRenderer } from '@ss-fidelity/renderers';

const run = await benchmark(
  async () => {
    const { renderer, scene, camera, graph } = await createMySceneAndGraph();
    const pipeline = createLivePipeline({
      name: 'my-experiment',
      renderer,
      camera,
      render: () => graph.render(),
      disposeGraph: () => graph.dispose(),
    });
    return {
      pipeline,
      beforeFrame: createRendererFrameDriver(renderer),
      complete: () => completeRenderer(renderer),
      dispose() {
        pipeline.dispose();
        disposeMySceneAssets(scene);
      },
    };
  },
  { durationMs: 5000 },
  {
    now: () => performance.now(),
    yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
  },
);
```

The frame driver stops Three.js's internal animation loop and advances node frame IDs and logical time once per explicit submission. This is necessary for unpaced batches: multiple `graph.render()` calls within one browser display tick must not reuse temporal-node frame state. It isolates version-sensitive Three.js internals in the renderer package. The caller owns scheduling after adopting it.

The CLI/browser selectors currently use the suite's registered renderer names. Programmatic runners accept arbitrary pipeline factories without adding effect configuration to their interface. An optional `PipelineProfiler` supplies descriptors and logical-frame-tagged samples, so custom internal timing does not require changing the report schema.

## Stored reports and provenance

Reports have `schemaVersion: 1`, a unique run ID, environment/source metadata, workload parameters and individual repetitions. Every metric declares units and its sample unit and preserves raw samples. CLI reports include host/runtime information, the source revision, dirty status, submodule revisions and available adapter information. Browser reports identify the browser and mark unavailable source revisions explicitly.

Default output is `benchmarks/<run-id>/report.json` and `report.html`; generated benchmarks are ignored by Git. `--out` chooses an explicit JSON path and writes companion HTML. Reports are independent of beauty images and fidelity-kit's `.metrics.json` quality scores. Existing JSON consumers of the old `{results, ab}` benchmark format must migrate to the versioned report.

The Three.js and path-tracer sources are ESM. `pnpm build` always builds the Three.js submodule before building the playground. The workspace pins both `three` and `three-gpu-pathtracer` to their local forks, preventing the adapter from pulling in the published path-tracer CommonJS bundle. No `three.cjs` artifact is required.

## Validation

```sh
pnpm build
pnpm tsc
pnpm lint
pnpm test --coverage
pnpm test:browser
```

Browser tests use system Chrome on macOS when present, otherwise Playwright Chromium (`pnpm --filter @ss-fidelity/playground exec playwright install chromium`). They exercise the real renderer, report chart/import, comparison, GPU profiling capability, image-content capture and cancellation. They do not assert speed thresholds. GPU browser tests are optional on machines without WebGPU support.

## Quality regression checks

```sh
pnpm exec fidelity-kit process fidelity-results
pnpm cli quality-gate three-current three-new --scenes cornell-box-basic,cornell-box-animated
```

The quality gate compares existing PSNR scores against the path-tracer reference, with a default maximum drop of 0.1 dB. Measure speed at fixed effect settings and retain the quality/convergence checks when evaluating optimizations.

## Live scene startup

The live lab shows a **Scene startup** panel on every load. `Load scene` disposes the old renderer and creates a fresh scene, renderer, GPU device and pipeline graph. Pipelines used by that scene are recreated; browser/driver caches may reuse compiler work. There is currently no application-level pipeline cache across these loads.

The panel separates page/JavaScript loading on the initial visit, previous-renderer cleanup, scene asset fetch/decode, renderer/environment setup, first-frame CPU setup/submission, GPU completion, and other UI/controls/scheduling work. It marks the scene interactive after the first completed frame. The total and sequential stage rows reconcile; shader generation and API durations are nested observations and must not be added to those stages.

Expand **Shader and pipeline details** to see pass names, shader-generation CPU time, WebGPU pipeline-call time/count and fragment WGSL size. The capture includes the first four naturally rendered frames so history initialization is visible, then restores its hooks. Later early-frame GPU completion is reported separately from time to first frame. Benchmark runs use their existing measurement path without this startup instrumentation. WebGL exposes the scene/setup/submission/completion breakdown but not TSL/WebGPU pass details.

**Exact GPU compiler time is unavailable in the browser.** `createRenderPipeline` often returns before driver compilation finishes. The GPU wait includes deferred compilation, uploads and rendering; pipeline API time is a dispatch observation, and repeated calls may hit caches. This display identifies whether assets, JavaScript generation, setup or deferred GPU work dominated a load without inventing compiler-only durations. No GPU timestamp queries are needed for startup capture.

Use **Download startup JSON** to preserve the load's timings, settings, pass details and raw shader events/metrics. Failures include their message and stack when available. The UI clears the previous load's data on every attempt. See [the startup investigation](history/SHADER_STARTUP.md) for cache controls, native-versus-browser timing differences and Dawn repros.
