# Generated screen-space shader audit

This change reduces the WGSL emitted by the default three-new pipeline's five key fragment shaders from **138,591 to 100,843 bytes (27.2%)**. SSGI/AO, SSR's spatial and temporal filters, and TRAA shrink substantially. The main SSR trace is effectively unchanged. Two cache-busted CLI repetitions show about **8% less synchronous pipeline creation time across those five passes**. Overall startup improves modestly in Chromium, but not consistently in the CLI. A runtime speedup has not been established.

Tracked by #109; broader startup work remains in #24. Baseline: `75896df7c60`, three.js fork: `83c310af72715ae558beea12d169f00c62ea48eb`. Measurements ran on an Apple M3 / Metal 3, macOS 27.0.1, Node 26.3.0, Dawn `webgpu` 0.6.1, and Playwright Chromium. Raw numbers and pixel hashes are in [shader-code-size/measurements.json](shader-code-size/measurements.json).

## What the emitted code showed

- **SSR:** the ray march and binary refinement already use TSL `Loop`. The large expansion was in the eight-tap spatial filter and two 3×3 temporal scans. Those now emit loops; the temporal moments and motion reductions share one traversal. The original JavaScript-computed angle/radius constants remain in a constant array, preserving sample locations and reduction order. Four-tap bilateral upsampling also emits a loop and was checked separately at half resolution.
- **TRAA:** its closest/farthest depth neighborhood and eight variance-clipping neighbors were JavaScript-unrolled. The depth loop preserves x-major order and tie-breaking; a constant offset array preserves variance accumulation order. Targeted `toVar()` calls materialize matrix reprojection and motion magnitude that the generated code duplicated across uses/branches.
- **SSGI and AO:** three-new obtains AO from SSGI's AO attachment; it does not run standalone GTAO/SSAO. Slice and step loops already use TSL `Loop`, but two inline horizon searches duplicated the full sampling body. A two-iteration side loop preserves right-then-left traversal and shared visibility masks. Explicit readonly `toConst()` stages prevent nested selects from reproducing the expensive horizon/acos calculation four times per side; one sector bitfield calculation now feeds both AO and GI.
- **Expression reuse:** the fork's `Node` builder automatically caches many reused expressions. Missing `toVar()` is not a universal explanation for large shaders. Mean/variance bounds in TRAA already received temporaries. Explicit materialization is useful where the actual output demonstrates duplication, particularly across branches.

| Fragment shader               | Before bytes / lines | After bytes / lines | Size reduction |
| ----------------------------- | -------------------: | ------------------: | -------------: |
| SSGI / AO                     |         22,482 / 830 |        13,828 / 522 |          38.5% |
| SSR trace                     |       60,718 / 1,530 |      60,775 / 1,532 |          −0.1% |
| SSR spatial                   |         25,341 / 525 |         7,674 / 199 |          69.7% |
| SSR temporal                  |         15,817 / 307 |         9,670 / 245 |          38.9% |
| TRAA                          |         14,233 / 473 |         8,896 / 265 |          37.5% |
| SSR upsample, half resolution |                9,217 |               4,976 |          46.0% |

The main trace gains a few explicit temporaries rather than shrinking. Its march was never a large JavaScript-unrolled loop. The four non-trace shaders together shrink **48.5%**. Separate JavaScript loops that construct render targets/passes and small Hi-Z tap footprints remain appropriate host-side code.

## Compilation and startup

Both audit scripts intercept the real `GPUDevice.createShaderModule` and `createRenderPipeline` calls, save all emitted WGSL, and wait for submitted work. Timing starts immediately before renderer creation, after scene construction and module imports. It includes renderer initialization, graph construction, shader generation, API calls and completion of the first submitted frame. Later history-dependent shader variants can still be created during warmup. These are instrumented first-frame measurements, not viewer navigation times or exact attribution of all driver work.

An initial comparison falsely suggested a large regression: cached original pipelines took 3–10 ms, while changed ones took roughly 180–340 ms. To reduce that bias, paired measurements enable Dawn's `disable_blob_cache` and `disable_symbol_renaming` toggles and give generated `nodeVar` identifiers a unique prefix per process. This changes names, not arithmetic. It makes each major shader source distinct for the native compiler, while disabling Dawn's persistent blob cache. It is a **cache-busting experiment**, not a guarantee that every driver/OS cache is cold. The toggles follow [Dawn's debugging documentation](https://github.com/google/dawn/blob/main/docs/dawn/debugging.md) and [toggle definitions](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/Toggles.cpp).

CLI synchronous creation times below are means of two alternating baseline/optimized pairs. The browser's API calls return too quickly to attribute driver compilation to individual passes; completion time is the useful browser measurement.

| First pipeline creation, CLI | Before ms | After ms | Reduction |
| ---------------------------- | --------: | -------: | --------: |
| SSGI / AO                    |    201.84 |   187.52 |      7.1% |
| SSR trace                    |    342.86 |   339.78 |      0.9% |
| SSR spatial                  |    242.72 |   187.41 |     22.8% |
| SSR temporal                 |    206.31 |   193.03 |      6.4% |
| TRAA                         |    202.48 |   189.74 |      6.3% |
| Total of these passes        |  1,196.21 | 1,097.48 |      8.3% |

| Backend / repetition | First completed frame before → after (ms) | Completed-work ms/frame before → after |
| -------------------- | ----------------------------------------: | -------------------------------------: |
| CLI / 1              |                         3,707.3 → 3,839.0 |                        646.18 → 649.26 |
| CLI / 2              |                         3,599.4 → 3,550.8 |                        573.75 → 254.75 |
| Chromium / 1         |                         3,577.8 → 3,415.9 |                        250.75 → 207.00 |
| Chromium / 2         |                         3,640.7 → 3,541.2 |                        211.79 → 252.30 |

Chromium's two startup measurements improve 4.5% and 2.7%; the CLI changes +3.6% and −1.4%. Runtime measurements use 16 warmup frames followed by a batch of 20 completed frames, with the same explicit temporal frame driver on both backends. Their variability is too large to claim a runtime benefit or infer a stable regression. They are preliminary observations, not a performance guarantee. Absolute timings between the two Dawn builds are not comparable.

Code size explains only part of startup. Scene/pre-pass materials, denoisers, Hi-Z passes and additional history variants also compile. Asynchronous pipeline preparation, pass count, main SSR helper factoring, and a broader scene/device benchmark remain useful follow-up work in #24.

## Image checks

All captures use seed 1, fresh sessions, 256×256 output, and 16 explicitly driven frames. Comparisons use raw RGB bytes, excluding alpha. Sample budgets and geometry inputs are unchanged.

| Scene                              | Mean absolute RGB difference, 0–255 | Maximum channel difference |      PSNR |
| ---------------------------------- | ----------------------------------: | -------------------------: | --------: |
| ssgi-basic                         |                             0.09239 |                         14 |  57.95 dB |
| ssr-diag-rough-30                  |                                   0 |                          0 | identical |
| traa-checker                       |                                   0 |                          0 | identical |
| ssr-diag-rough-30, half resolution |                           0.0000153 |                          1 |  96.30 dB |

The SSGI result repeats exactly across the two independent pairs; it is not bit-identical to baseline. Explicit intermediates and dynamic loop bodies can change compiler arithmetic even with the same sampling/reduction order. The half-resolution result differs in three RGB channels by one byte. These checks bound changes on these scenes; they do not prove identity on arbitrary scenes, moving cameras, other devices, or against path-traced references.

## Reproduction

Install dependencies and run `pnpm build`. Use fresh processes and separate output directories for each baseline/optimized repetition. Run one GPU workload at a time; use a new salt each time. Ordinary unsalted captures provide the canonical byte counts, while salted captures add identifier text and should not be used for source-size comparisons.

```sh
node scripts/shader-audit.mjs /tmp/audit-wgsl three-new ssgi-basic
SHADER_AUDIT_SALT=trialA SHADER_AUDIT_WARMUP=16 SHADER_AUDIT_FRAMES=20 \
  node scripts/shader-audit.mjs /tmp/audit-cli three-new ssgi-basic
SHADER_AUDIT_SCALE=0.5 SHADER_AUDIT_WARMUP=16 SHADER_AUDIT_FRAMES=4 \
  node scripts/shader-audit.mjs /tmp/audit-half three-new ssr-diag-rough-30
```

For Chromium, start `pnpm --filter @ss-fidelity/playground dev --port 5174` in another terminal. Install Playwright Chromium if it is not already available. On this Mac, Chromium headless WebGPU returned an external-instance error; headed Chromium successfully exercised Metal.

```sh
SHADER_AUDIT_HEADED=1 SHADER_AUDIT_SALT=browserTrialA \
  node scripts/shader-audit-browser.mjs /tmp/audit-browser three-new ssgi-basic
```

`SHADER_AUDIT_URL` overrides the server URL. The scripts emit `report.json` and numbered WGSL files; the CLI also emits `pixels.rgba`. TRAA is vendored with provenance and the original MIT notice, matching the existing local SSR/SSGI approach and leaving the pinned submodule untouched.

## Validation

Build, typecheck, lint, and all 120 tests with coverage pass. Dependency audit reports three existing high-severity transitive advisories through the pathtracer's Puppeteer dependency (`extract-zip` ×2 and `basic-ftp`); no dependency versions changed. Browser and CLI captures compile and complete without shader validation errors. Existing build warnings about bundle size and a `three-mesh-bvh` export conflict remain.
