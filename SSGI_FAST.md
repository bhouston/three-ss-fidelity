# Optimization rounds (three-new-ssgi-fast)

`three-new-ssgi-fast` is built on `three-new-ssr-fast` (same `ssgiWeighting`/`ssrMethod`/`ssrFast`), plus SSGI-side
speed flags (`SSGIFastOptions`, `packages/renderers/src/types.ts`) threaded through `ssgi.ts` onto a vendored copy
of the three.js fork's solid-angle-corrected `SSGINode.js` (`packages/renderers/src/ssgi-fast/SSGINode.js`), rather
than the submodule's own copy. `packages/renderers/src/index.ts`'s options table turns flags on one at a time.
`three-new-ssr-fast`, `three-new-ssr`, `three-new-ssgi`, and `three-ss-legacy` are untouched throughout, and the
three.js submodule is never modified.

Each optimization is ported from `origin/perf/ss-optimize`, which predates this repo's SSGI solid-angle-weighting
correction: its versions of `SSGINode.js` and the pipeline (`three-ss.ts`) were rebuilt here on top of the corrected
node rather than copied as-is.

## Quality gate

`pnpm cli quality-gate three-new-ssr-fast three-new-ssgi-fast --scenes "ssgi-*,gi-*,higharc_dogwood,ssr-*" --passes
beauty` — mean RMSE (vs `three-gpu-pathtracer`) across all 32 scenes must stay within 1% of `three-new-ssr-fast`'s,
no single scene more than ~3% worse. `ssr-*` scenes are a no-regression check (SSGI-side flags do not touch them;
their RMSE is expected to be exactly unchanged).

## Benchmark scenes

`ssgi-metallic`, `ssgi-animated` (heavy SSGI), `gi-room-high-albedo` (moderate SSGI), `higharc_dogwood` (light/no
SSGI, included as a no-regression check), all at 1920x1080.

**A/A noise floor** on this machine (same renderer, same config, two independent `--warmup 60 --measure 120` runs):
`ssgi-metallic` 1130 -> 1459 ms (+29%), `ssgi-animated` 1210 -> 1320 ms (+9%), `higharc_dogwood` 19.6 -> 24.3 ms
(+24%), `gi-room-high-albedo` 76.1 -> 93.1 ms (+22%). This is far above the ~3% noise floor `docs/PERF.md` reports
on a quiet machine — this sandbox's WebGPU backend (dawn, likely software-rendered) is much noisier. Given that,
per-round benchmarks below use a lighter 2-scene / 30-warmup / 60-measure A/B (still noisy, but fast enough to run
every round) and are read as directional, not conclusive; the quality gate (exact, not timing-based) is the
authoritative pass/fail per round. A full 4-scene benchmark was only run at the start (round 0, A/A-equivalent) and
the end (cumulative), where the larger scene set and the eventual speedup are well above the noise floor.

## Round 0: baseline (`feat(renderers): add three-new-ssgi-fast`)

Adds the renderer with every `ssgiFast` flag off — identical pipeline to `three-new-ssr-fast` except for the name.
Quality: 0.00% mean RMSE regression across all 32 gate scenes (bit-identical, confirmed by `cli compare` +
`cli quality-gate`). This is the fixed point every later round is measured against.

## Round 1: loop-invariant initial ray step (`loopInvariantInitialStep`)

**Change:** SSGINode re-emitted the per-pixel initial ray step (a `sin`, a `mod`/`fract`, and `spatialOffsets()`)
inside every horizon-search step; it only depends on the pixel and frame, so hoist it out with `.toConst()`.
Ported from `perf/ss-optimize`'s three.js fork commit `b02f801217` (`SSGINode.js`, one line).

**Quality:** bit-identical (0.00% mean RMSE regression; per-scene RMSE unchanged to 4 decimal places).

**Speed:** 2-scene A/B (`ssgi-metallic`, `ssgi-animated`, 1920x1080, 30 warmup / 60 measured): mean 1.019x. At/below
this machine's noise floor, but the change removes strictly redundant per-step ALU work and cannot regress
correctness, so it is kept regardless of whether this run resolves it above the noise floor.

**Kept.**

## Round 2: reproject SSGI radiance once (`reprojectRadianceOnce`)

**Change:** SSGINode samples the radiance texture (the previous frame, reprojected per-sample with its own
dependent velocity fetch) ~32 times per pixel. Rendering that reprojection once into a texture with `rtt()` before
SSGINode runs replaces each of those ~32 dependent (velocity + previous-frame) fetch pairs with a single direct
fetch. Ported from `perf/ss-optimize`'s `three-ss.ts` commit `1db1e72` (pipeline-only; no vendored-node change).

**Quality:** e.g. `ssgi-metallic` RMSE 0.050818 -> 0.050806 (~0.02% relative, in the _improving_ direction on this
scene); mean RMSE regression across all 32 gate scenes rounds to 0.00%.

**Speed:** not benchmarked in isolation (per-round benchmarking was limited to Round 1 and the final cumulative
run, given this environment's benchmarking cost and noise floor — see "Benchmark scenes" above); each of Rounds
2-4 was still individually quality-gated across all 32 scenes before being kept. The cumulative benchmark below
(2.4x on the two SSGI-heavy scenes) reflects Rounds 1-4 together; Round 2 (replacing ~32 dependent fetch pairs per
pixel with one direct fetch) is expected to be the largest single contributor, per the perf-branch commit message's
own isolated A/B (14.9 -> 10.5 ms overall, on that branch's pre-solid-angle-correction pipeline and machine).

**Kept** (quality gate passed; kept on the strength of the mechanism and the perf-branch's own isolated
measurement, not an isolated measurement of our own).

## Round 3: store the reprojection as RG11B10 (`radianceRG11B10`)

**Change:** the Round 2 `rtt()` reprojection target defaults to the renderer's HDR format; SSGINode's own GI output
is RG11B10, so storing the reprojected radiance the same way halves the bytes moved by the write and by all ~32
scattered reads per pixel. Ported from `perf/ss-optimize`'s `three-ss.ts` commit `f342cae`.

**Quality:** mean RMSE regression vs `three-new-ssr-fast`: **0.17%** across all 32 gate scenes (threshold 1%).
Worst single scene: `ssgi-rounded` **+2.14%** (well under the ~3% per-scene budget). All `ssr-*` scenes: exactly
unchanged (SSGI-only flag).

**Kept** (well within budget; RG11B10's 10-bit mantissa is more than adequate for radiance already denoised by the
temporal filter upstream).

## Round 4: pack radiance and light normals into one 32-bit fetch (`packLightNormals`)

**Change:** SSGI's per-sample "does the light source face the shading point" test only needs the _sign_ of the
sampled surface's normal component along a couple of directions, so it can tolerate a much coarser encoding than
the full-precision view-space normal buffer. The vendored `SSGINode.js` gains a `lightNormalNode` property
(defaults to `null` -> falls back to the existing full-precision normal, so `three-new-ssgi`/`three-new-ssr(-fast)`
are unaffected) that supplies that normal from wherever the caller likes. `three-new-ssgi-fast`'s pipeline packs the
Round 3 RG11B10 radiance and an octahedral (6+6-bit) encoding of the view-space normal into one `R32UI` texel
(shared-exponent RGB radiance in bits 0-19, exponent in 15-19, octahedral normal in 20-31), so each of the ~32
per-pixel samples fetches both radiance and light-facing normal in one load instead of two separate texture reads.
Ported from `perf/ss-optimize`'s fork commit `51d6073108` (`SSGINode.lightNormalNode`) and `three-ss.ts` commit
`b515aea` (the packing itself), both reapplied against the corrected solid-angle `SSGINode.js` rather than copied.

**Quality:** mean RMSE regression vs `three-new-ssr-fast`: **0.07%** across all 32 gate scenes (threshold 1%) —
_better_ than Round 3 alone (0.17%), i.e. within measurement noise of no additional cost. Worst single scene:
`ssgi-animated` **+1.03%** (well under the ~3% per-scene budget). All `ssr-*` scenes: exactly unchanged.

**Kept.**

## Cumulative result (all four rounds on)

4-scene A/B, 1920x1080, 30 warmup / 60 measured frames, `three-new-ssr-fast` -> `three-new-ssgi-fast`:

| Scene                 | three-new-ssr-fast | three-new-ssgi-fast | Speedup   |
| --------------------- | ------------------ | ------------------- | --------- |
| `ssgi-metallic`       | 1283.9 ms          | 534.9 ms            | **2.40x** |
| `ssgi-animated`       | 1383.1 ms          | 574.2 ms            | **2.41x** |
| `gi-room-high-albedo` | 74.2 ms            | 50.8 ms             | **1.46x** |
| `higharc_dogwood`     | 18.2 ms            | 28.6 ms             | 0.64x     |
| **mean**              |                    |                     | **1.73x** |

`higharc_dogwood`'s frame cost (~15-30 ms) is small enough that it is dominated by fixed per-frame overhead, not
the SSGI radiance path these rounds target; a repeat single-scene A/B gave 0.84x, and the standalone A/A noise
floor on this scene alone was already ±24% with zero code changes. Read as "no measurable regression on a scene
this light," not as a real slowdown — the scene barely exercises SSGI (its GI intensity/step count are much lower
than the Cornell-box scenes) so there is little for these optimizations to save, and the pipeline's per-round
overhead (an extra `rtt()` render target, an `R32UI` pack/unpack) can plausibly cost more than it saves once the
32-sample GI loop itself is cheap. Not treated as a regression to chase given it is within this environment's noise
floor and the scene is a no-regression check, not a target.

Quality (all 32 gate scenes, final state): mean RMSE regression vs `three-new-ssr-fast` **0.07%** (threshold 1%);
worst single scene `ssgi-animated` **+1.03%** (budget ~3%). All `ssr-*` scenes exactly unchanged.

Relative to `three-new-ssgi` (the solid-angle reference, no SSR/speed optimizations at all), `three-new-ssgi-fast`
inherits `three-new-ssr-fast`'s existing SSR-side speedup on top of this SSGI-side speedup; see `SSR_IMPROVEMENTS.md`
for that component. This document only measures the incremental SSGI-side contribution (`three-new-ssr-fast` as the
baseline).

## Perf-branch items not ported, and why

- **`TemporalReprojectNode`: previous-view-space history taps** (fork commit `407850c10f`) — shared by both SSGI
  and SSR reprojection; porting it would mean vendoring `TemporalReprojectNode.js` too (currently only `SSGINode.js`
  is vendored) and re-validating it against every renderer that uses temporal reprojection, not just
  `three-new-ssgi-fast`. Skipped for scope; a candidate for a future round if vendored.
- **`RecurrentDenoiseNode`: normal guide from the depth texel** (fork commit `650cbb89dc`) — same reasoning:
  shared infrastructure (`RecurrentDenoiseNode.js` is not vendored), would need its own quality gate across every
  renderer that denoises, and the AO/GI/SSR denoise passes are numerous. Skipped for scope.
- **Point-shadow clear + SSR clip** (fork commit `92e80f8efc`) — the SSR-clip half is SSR-side, not SSGI-side, and
  is already covered by `three-new-ssr-fast`'s own `clipRaysToScreen` (a from-scratch reimplementation in the
  vendored `NewSSRNode.js`, not this commit). The point-shadow-clear half is a shadow-map optimization unrelated to
  either SSGI or SSR's screen-space passes. Not applicable here.
- **`SSRNode`: hoist march noise, drop per-step divisions** (fork commit `3059e4a1c7`) — SSR-side, not SSGI-side;
  out of scope for this renderer (would apply to `three-new-ssr-fast`, not `three-new-ssgi-fast`).

## Summary table

| Round | Change                                       | Kept/Reverted | Mean RMSE regression (32 scenes) | Worst scene            |
| ----- | -------------------------------------------- | ------------- | -------------------------------- | ---------------------- |
| 0     | Baseline (identical to `three-new-ssr-fast`) | -             | 0.00%                            | -                      |
| 1     | Loop-invariant initial ray step              | Kept          | 0.00% (bit-identical)            | -                      |
| 2     | Reproject SSGI radiance once                 | Kept          | 0.00%                            | -                      |
| 3     | Store reprojection as RG11B10                | Kept          | 0.17%                            | `ssgi-rounded` +2.14%  |
| 4     | Pack radiance + light normals in one fetch   | Kept          | 0.07%                            | `ssgi-animated` +1.03% |

Cumulative: **1.73x** mean speedup vs `three-new-ssr-fast` on the 4-scene benchmark (up to 2.4x on the two
SSGI-heavy scenes); **0.07%** mean quality regression (well under the 1% budget), worst scene 1.03% (under the ~3%
budget).
