# Reusable shader functions

Follow-up to [PR #110](https://github.com/bhouston/three-ss-fidelity/pull/110), measured against `3201856bb062573e54fe7ad1d70e19a7aea662ab`. The baseline already uses shader loops for neighborhoods; this change addresses repeated function bodies.

## Changes and generated WGSL

SSR now emits one `ssrTrace` function and one `ssrSampleReflection` function. Each is called by both reflection bounces. Named struct results are materialized before their fields are read. Per-ray position, direction, UV, jitter, march quality and the existing metalness-derived tracing multiplier are explicit inputs. Sampling, refinement, traversal order, budgets and primary/secondary quality settings are preserved.

SSGI emits its sector-bitfield calculation once and calls it twice. AO is an attachment of the same SSGI MRT shader in `three-new`, so both effects use this change. TRAA already emits reusable `clipAABB`, `flickerReduction` and `subpixelCorrection` functions; its remaining depth/variance helpers have one call site. We hoist the shared center-texel calculation before the neighborhoods instead of adding layouts without a deduplication benefit. The standard renderer does not use upstream GTAO's separate shader.

Actual default `three-new`, `ssgi-basic`, 256 × 256 fragment source:

| Pass      | Before bytes | After bytes | Reduction | Before / after lines |
| --------- | -----------: | ----------: | --------: | -------------------: |
| SSR trace |       60,775 |      38,308 |     37.0% |        1,532 / 1,038 |
| SSGI / AO |       13,828 |      13,558 |      2.0% |            522 / 515 |
| TRAA      |        8,896 |       8,894 |     0.02% |            265 / 265 |

The SSR shader has two shader loops after extraction instead of four expanded across the two tracing bodies. Both bounces still execute their own traversal. The driver can inline functions or unroll loops later; source reductions alone do not establish fewer GPU instructions.

## Compilation and startup measurements

Three alternating baseline/optimized pairs used fresh Dawn devices and headed Chromium processes on Apple M3 / macOS 27.0.1. A distinct identifier salt, `disable_symbol_renaming` and `disable_blob_cache` discourage cache reuse; this is not a guarantee that every OS/driver cache is cold. CLI pair 0 used 16 warmup / 20 measurement frames, pairs 1–2 used 4 / 4. Chromium used 16 / 20 throughout. Frame advancement is explicit in both harnesses.

| Measurement                                          | Baseline samples (ms)     | Optimized samples (ms)    | Median change |
| ---------------------------------------------------- | ------------------------- | ------------------------- | ------------- |
| Dawn synchronous SSR pipeline creation               | 334.04, 678.89, 328.79    | 278.98, 269.00, 275.47    | −17.5%        |
| CLI initialization through first GPU completion      | 3560.71, 8272.87, 3522.46 | 3418.67, 3400.91, 3464.72 | −4.0%         |
| Chromium initialization through first GPU completion | 3566.50, 8900.00, 3438.10 | 9832.50, 3785.10, 3742.10 | +6.1%         |

The long outliers and opposite browser median change prevent a general startup-speed claim. Chromium's synchronous pipeline API returned in approximately 0–0.1 ms, with work deferred elsewhere; its API duration is not compilation duration. SSR's native synchronous pipeline cost fell in every CLI pair. Steady-state frame timings vary substantially, so no runtime speedup is claimed. The next investigation separates actual TSL graph stages, all pipelines and GPU completion rather than attributing total startup to SSR from source size alone.

Full source metrics and all timing samples are in [measurements.json](shader-functions/measurements.json). Capture with `node scripts/shader-audit.mjs <output-dir> [renderer] [scene]` after building. The browser harness requires a running Vite server and `SHADER_AUDIT_HEADED=1` on this Mac. See [the preceding report](SHADER_CODE_SIZE.md) for cache and timing limitations.

## Correctness and capture lifetime

The default scene after 16 deterministic frames is byte-identical: SHA-256 `3ee66bb9edb65a2d15225835b19c1fe7fa84b5b7518f164cdefb9b04e5d04d0c`. Additional four-frame comparisons are also byte-identical for `ssr-diag-rough-30`, `ssr-diag-metal-hit`, half-resolution `ssgi-basic`, `ssr-diag-mirror` with hits debug and `hierarchy-combined`, and `traa-checker`.

The GPU-independent regression tests generate real WGSL and verify one trace/sampler definition, two call sites, independent secondary quality, named result types, and correct captured texture/uniform bindings when the same material graph builds again on the same backend with a different uniform namespace.

This last check matters: the fork caches layout functions by backend and shader-node identity. A layout function that captures builder-assigned resources can retain names from its first compilation if the same function object is reused in another graph build. SSR's captured helpers are therefore created inside each graph build. Pure helpers with explicit scalar/vector arguments are easier to share globally. This correctness limitation is separate from the unproven cause of long startup times.
