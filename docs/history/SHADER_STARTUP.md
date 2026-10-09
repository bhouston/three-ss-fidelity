# Where shader startup time goes

Measured after [PR #114](https://github.com/bhouston/three-fidelity/pull/114), parent `f23db3103953065dea6c674e445641ef8e67f348`. Source improvements reduced SSR from 60,775 to 38,308 bytes, but browser startup remained variable. This investigation separates Three.js graph generation from native WebGPU pipeline calls and deferred completion.

## Findings

**In the measured native Dawn runs, pipeline creation dominates startup across many passes.** SSR is the slowest first-frame pipeline, but accounts for approximately 8.5–8.7% of the pipeline API budget. TSL graph generation is approximately 2–3% of initialization through first completion. Chromium defers work, so its synchronous pipeline calls cannot identify the expensive compiler stage or shader.

Apple M3 / Metal 3 / macOS 27.0.1; Node 26, native `webgpu` 0.6.1 and headed Playwright Chromium; 256 × 256, deterministic seed, four warmup frames and one measurement frame. Fresh devices/processes, unique identifier salts, `disable_symbol_renaming` and `disable_blob_cache`. This discourages reuse without guaranteeing OS/driver caches are cold. Runs were serial. Times are wall-clock observations, not internal compiler CPU time.

| `ssgi-basic` measurement                    | Native A (ms) | Native B (ms) | Chromium B (ms) | Chromium C (ms) |
| ------------------------------------------- | ------------: | ------------: | --------------: | --------------: |
| Initialization through first GPU completion |      3,999.49 |      3,380.01 |        3,293.40 |        3,643.20 |
| First-frame node builders: 27 calls         |         99.10 |         86.39 |           69.20 |           67.60 |
| First-frame shader-module API: 44 calls     |         33.92 |         29.28 |            0.40 |            0.70 |
| First-frame pipeline API: 25 calls          |      3,768.11 |      3,160.66 |            0.40 |            0.20 |
| First GPU-completion wait                   |         22.19 |         37.14 |        3,169.60 |        3,280.50 |
| Warmup pipeline API: 24 calls               |        704.44 |        608.91 |            0.30 |            0.20 |
| One later completed frame                   |        711.97 |        776.70 |          964.20 |          918.10 |

The table's rows are separate observations, not an additive budget: completion can include deferred compilation and execution, while enclosing spans already include child work. The later frame is only one sample and is not a steady-state performance benchmark. Some completion latency persists without new builders or pipelines, so compilation cannot explain all observed frame latency.

A default-cache native control had 47.17 ms of first-frame pipeline calls and 918.87 ms through first completion, versus several seconds of pipeline calls with cache discouragement. This demonstrates that cache conditions materially affect results. It does not establish a universal cold-cache latency or the exact cache layer responsible.

## Which shaders and characteristics?

Actual unsalted builder WGSL and native B first creation durations:

| Pass         | WGSL bytes | Functions | Loops | Branches | Texture calls | Native pipeline (ms) |
| ------------ | ---------: | --------: | ----: | -------: | ------------: | -------------------: |
| SSR trace    |     38,308 |         8 |     2 |       35 |            30 |                269.1 |
| SSGI / AO    |     13,558 |         8 |     3 |       23 |             6 |                177.8 |
| SSR spatial  |      7,674 |         3 |     1 |        5 |            10 |                180.2 |
| SSR temporal |      9,670 |         3 |     2 |        5 |            11 |                186.7 |
| TRAA         |      8,894 |         6 |     3 |        5 |             8 |                184.5 |

Counts are lexical diagnostics, not execution counts or control-flow complexity. Texture calls inside loops can execute many times. Salted native source has longer identifiers and larger byte counts; the table uses original builder source, not that inflated version. The report retains both sources' metrics and hashes.

SSR's trace combines Hi-Z traversal, early exits, hit reconstruction, refinement and two reflection bounces. It remains the largest effect shader after sharing trace and GGX bodies. Its pipeline has `rgba16float` and `rg16float` outputs, one sample, and no depth attachment. Temporal AO/GI reprojection pipelines introduced during warmup took **230.2 and 219.1 ms** in native B, despite containing no shader loops. Recurrent denoisers and physical/standard scene materials also contribute. A loop count or source byte count alone does not predict compilation duration.

**Variant count is another authoring cost.** Hi-Z levels 1–6 have approximately 2.4 KB unsalted fragment source each. Their generated sources differ only in literal mip arguments to `textureDimensions` and `textureLoad`; they consequently create distinct shader programs and pipelines. These six pipelines cost about **0.57–0.66 seconds** in the two fresh native runs. A shared shader with a mip-level uniform is a concrete next optimization to test, preserving odd-size coverage and view/binding semantics. This is deliberate host specialization, not evidence of a broken pipeline cache.

Early-frame repeat builds are bounded in these captures. `ssgi-basic` created 27 builders on frame zero and 24 more across frames 1–3, with none on the measured frame 4. Several repeated SSR/SSGI/Hi-Z sources hit fast native pipeline paths, while history/reprojection variants introduced new work. Seeing `createRenderPipeline` called again does not imply the driver recompiles its shader; many repeats were approximately 0.01–0.08 ms.

## Other scenes and factory-time work

- `ssr-diag-mirror`: initialization through first completion **3,423.1 ms**. Environment/PMREM preparation inside the renderer factory creates **six pipelines / 627.4 ms** before the first main frame. The first frame then creates 19 pipelines / 2,589.2 ms. An additional SSR history variant costs 315.4 ms during warmup. Hooking only after `createRenderer()` returns would miss the environment work.
- `traa-checker`: **942.2 ms** through first completion, with six first-frame pipelines / **859.8 ms**, 20.6 ms of builders, and no further builders or pipelines in warmup. Fewer enabled effects reduce startup work substantially in this capture; it is not a controlled quality-equivalent comparison.

These scenes cover all-effects, SSR/environment and TRAA-only paths. They do not cover every asset-heavy scene, resolution, GPU or shader configuration.

## Is this a Three.js bug?

The captures **do not establish a Three.js compiler bug** causing startup latency. Three.js completes graph construction comparatively quickly; the native cost lies inside WebGPU pipeline calls, and browser work is deferred beyond those calls. Pure Dawn, without Three.js or TSL, also incurs first-pipeline cost: a 362-byte triangle shader took **51.865 ms** initially, semantically equivalent sources with unique identifiers took **10.341 ms median**, and identical-source new modules took **0.1715 ms median**. This is one device/process control, not a universal lower bound or a matched comparison to the effect shaders' formats/layouts.

A separate layout-function capture limitation was reproduced during PR #114: caching by backend/function identity can reuse generated binding names without registering captured uniforms in another builder. SSR avoids it by constructing captured helpers on each graph build; its regression tests cover that lifetime. It should be investigated independently of startup latency. Pure arithmetic layout helpers with explicit arguments do not have the same resource-capture risk.

GPU timestamp measurements on this native setup are unsuitable for ranking pass costs. Three.js reported multi-second pass sums in a frame whose completed wall time was under a second. A raw Dawn repro with **three trivial triangle passes and no Three.js** also reported **167–176 ms summed query intervals** against **116 ms completed wall time**. Queries may cover overlapping vertex/fragment stage spans, and enabling them changed wall time; the excess individual intervals' cause remains unresolved. This is a measurement limitation on the tested Metal/Dawn setup, not proof of a Three.js query-offset bug. Pass sums are not whole-frame spans. Keep the raw results for backend investigation and do not use them to claim a shader runtime regression or gain.

## Reproduce and use the instrumentation

The instrumentation uses Three.js's existing `renderer.debug.onNodeBuilderCreated` callback, installed before factory initialization, and wraps the actual builder's stage transitions. No persistent edits to the Three.js submodule are required. It records `prebuild`, `setup`, `analyze`, `generate`, final code assembly, shader stage and update-node building; backend/module/pipeline calls; async dispatch and readiness; and queue completion. Pass/material names are snapshotted because Three.js reuses fullscreen objects and descriptor objects.

```sh
pnpm build
SHADER_AUDIT_PROFILE=1 SHADER_AUDIT_SALT=runA SHADER_AUDIT_WARMUP=4 SHADER_AUDIT_FRAMES=1 \
  node scripts/shader-audit.mjs /tmp/startup-native three-new ssgi-basic

# Start a playground Vite server separately. Change the URL to its actual port.
SHADER_AUDIT_PROFILE=1 SHADER_AUDIT_SALT=runB SHADER_AUDIT_HEADED=1 \
  SHADER_AUDIT_URL=http://127.0.0.1:5173 SHADER_AUDIT_WARMUP=4 SHADER_AUDIT_FRAMES=1 \
  node scripts/shader-audit-browser.mjs /tmp/startup-browser three-new ssgi-basic
```

`report.json` retains the audit's existing measurements. `startup.json` adds pass-attributed events, builder stage timings, shader SHA-256/metrics, and snapshotted pipeline formats/state. Linked WGSL files hold actual sources. `startup-trace.json` can be opened in a Chrome trace viewer. Profiling currently supports the `three-new` builder; the normal audit continues to support other renderer names. The browser fails explicitly if module identity prevents the builder hook from firing.

`SHADER_AUDIT_GPU=1` additionally enables existing native GPU queries and stores samples/validity metadata in `report.json`. Query readback occurs outside first-frame and batch timers. Use short batches to avoid query capacity issues. On the tested Metal setup, apply the timestamp limitation above.

Manual controls, each using native Dawn without Three.js:

```sh
node scripts/shader-startup-dawn-repro.mjs
node scripts/shader-timestamps-dawn-repro.mjs
```

Six device-independent profiler tests verify stage accounting, source/pipeline linkage, immutable pass-name snapshots, async promise identity and overlap, yield exclusion, exceptions/rejections, restoration, hashing and lexical metrics. Nested builder/backend totals are inclusive; avoid adding them to child durations. Async readiness spans can overlap; interval-union totals are available. Driver optimization can happen after API return, so neither a shader module call nor a queue wait alone is a pure compiler measurement.

[All measurements and source characteristics](shader-startup/measurements.json), [raw Dawn pipeline results](shader-startup/dawn-pipeline.json), [raw heavy/cheap query results](shader-startup/dawn-timestamps-heavy.json), and [raw all-cheap query results](shader-startup/dawn-timestamps-cheap.json) are committed alongside this report. The [TSL authoring guide](../TSL_GUIDE.md) incorporates function lifetime, graph versus shader loops, materialization, specialization count and measurement boundaries.
