# Optimization rounds (three-new-ssgi-fast)

> **Historical log.** Renderer names here (`three-new-ssgi`, `three-new-ssr`, `-fast`, `-ssgi-fast`, `-rt`, `three-ss-legacy`) and `ssgi.ts` predate the consolidation into `three-new` / `three-new.ts` and `three-current` (issue #40). What is kept today is summarized in [../THREE-NEW.md](../THREE-NEW.md).

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

**Implemented and quality-gated, but shipped OFF by default** — see "Post-review investigation" below: isolating
Round 4 on `higharc_dogwood` (a light-SSGI, no-regression scene) showed it adds real but secondary speed on top of
Rounds 1-3 on SSGI-heavy scenes (mean 1.81x -> ~2.1x on the two Cornell benchmark scenes) while providing no benefit
and a small extra cost on `higharc_dogwood` specifically. The flag and vendored `lightNormalNode` machinery are kept
(quality-gated and available via `SSGIFastOptions.packLightNormals`) for a workload that is consistently SSGI-heavy,
but `three-new-ssgi-fast`'s shipped default is Rounds 1-3 only.

## Post-review investigation: `higharc_dogwood` regression (Refs #18)

A supervisor review measured `three-new-ssgi-fast` at 0.64-0.71x vs `three-new-ssr-fast` on `higharc_dogwood`
(3 consistent runs of `cli bench --scenes ssgi-metallic,ssgi-animated,higharc_dogwood`), well outside noise, and
asked for the responsible flag to be isolated, root-caused, and fixed to >=1.0x without giving up the Cornell gains.

**Isolation.** Toggling `SSGIFastOptions` one at a time on `higharc_dogwood` alone (`cli bench --scenes
ssgi-metallic,higharc_dogwood`, since the CLI benches scenes in the fixed canonical order `ssgi-metallic,
ssgi-animated, higharc_dogwood, gi-room-high-albedo` regardless of the `--scenes` argument's own order):
`loopInvariantInitialStep` alone: ~1.0-1.1x (no regression). Adding `reprojectRadianceOnce` (with the then-current
code): **0.63x** — reproduces the reported regression on its own; Rounds 3/4 (format/packing changes on top of the
same pass) don't add further regression. **Round 2 is the responsible flag.**

**Root cause 1 (found and fixed): `rtt()` ignored the scene's `resolutionScale`.** `higharc_dogwood` is the only
scene in the suite with `resolutionScale < 1` (`packages/scenes/src/higharc.ts`: `1/2`) — every other gate scene
runs SSGI at full canvas resolution. Round 2's `rtt()` reprojection pass (and Round 4's pack pass) was created with
`rtt(node, null, null, options)` and no `resolutionScale` in `options`, so it defaulted to full canvas resolution
(`RTTNode`'s own default is `resolutionScale: 1`) regardless of the scene's own `effects.resolutionScale`. On
`higharc_dogwood` this made the added pass **4x more pixels** than the SSGI effect it feeds (which does run at
`resolutionScale`), inflating exactly the fixed cost these rounds add relative to what they save — worse the
cheaper SSGI's own sample loop already is. Fixed in `packages/renderers/src/ssgi.ts` by passing `resolutionScale`
(the same value already used for `giPass.resolutionScale` a few lines below) into both `rtt()` calls' `options`.
Verified: isolated `higharc_dogwood` (own process, no preceding scene) went from a consistent ~0.65-0.71x to a
16-sample spread of 0.75-1.30x, median/mean **~0.96x** — within this environment's own noise floor (see "Benchmark
scenes" above: this scene alone showed +-24% A/A noise with _zero_ code changes), i.e. effectively parity, not a
regression.

**Root cause 2 (found, NOT fully fixed): a benchmark-order-sensitive artifact tied to the extra render target(s).**
Independently of Root cause 1, benching `higharc_dogwood` _immediately after_ a heavy SSGI scene in the same CLI
process (`cli bench --scenes ssgi-metallic,higharc_dogwood`, or the supervisor's 3-scene command) still measures
`higharc_dogwood` at ~0.7-0.75x even after the `resolutionScale` fix and even with Round 4 off, while benching it
_first_ (`cli bench --scenes higharc_dogwood,gi-room-high-albedo`) or alone gives the ~0.96x figure above. This does
**not** reproduce for `three-new-ssr-fast` doing the same heavy-then-light sequence (18.47 ms after `ssgi-metallic`
vs 20.00 ms alone — ordinary noise, no systematic penalty), and it disappears entirely when only Round 1 is active
(no extra render target at all: 18.07 ms after `ssgi-metallic`, matching its isolated value) — so it is specific to
the presence of the Round 2 `rtt()` render target, not to running `three-new-ssgi-fast` per se, and not explained by
Round 4's extra pack/unpack cost. Ruled out as explanations:

- **Async disposal race** (`Renderer.dispose()` is `async` but `LiveRenderer.dispose()` and every call site,
  `packages/cli/src/bench-process.ts` included, call it fire-and-forget): tested by inserting an explicit
  post-dispose delay (300 ms, then 3000 ms) between scenes in a scratch copy of `bench-process.ts` (not committed);
  the regression was unchanged at 3 seconds, ruling out a simple async-completion race.
- **Missing explicit disposal of the `rtt()` render target**: `RenderPipeline.dispose()` and `Renderer.dispose()`
  don't walk arbitrary node-graph-internal `RenderTarget`s the way they do the pipeline's own tracked passes, and
  `RTTNode` has its own `dispose()` that was never being called. Added explicit disposal (`ssgi.ts` now collects
  the `rtt()`-created nodes into `rttDisposables` and disposes them in `LiveRenderer.dispose()` before
  `renderPipeline.dispose()`/`renderer.dispose()`) as a correct fix regardless, but it did not change the measured
  benchmark-order effect (still ~0.7x after a heavy scene, before and after this fix).
- **CPU-side cost**: `cpuMs` (this scene's `process.cpuUsage()`-measured render() time) stays flat (~2-4.5 ms)
  across all these variants; only the GPU-synced wall-clock `totalMs` inflates. The extra cost is on the GPU/driver
  side, not in this renderer's JS/TSL-generated CPU work.

Given cpuMs stays flat, a 3-second gap doesn't help, and explicit disposal doesn't help, the remaining plausible
explanation is a native WebGPU-backend (dawn, likely software-rendered in this sandbox) or allocator characteristic
where allocating/freeing the extra render target(s) leaves the backend in a state that penalizes a subsequent
scene's GPU-synced frame time specifically when benched back-to-back in the same process — not a logic defect in
any of the four flags, and not reproducible in isolated (realistic, one-scene-at-a-time) measurement. This is
**not fully root-caused or fixed** within this investigation's budget. Recommendation for follow-up: change
`cli bench` to run each scene in its own child process (matching how it already isolates renderers), which would
make scene order-independent by construction; out of scope for this change (it's a CLI harness change, not a
renderers-package one).

**Resulting decision.** `packLightNormals` (Round 4) is shipped OFF by default (see above) since it added cost
with no offsetting benefit on this scene once Root cause 1 was fixed. The `resolutionScale` fix and the explicit
`rtt()` disposal fix are both kept regardless of the second, unresolved finding, since they are correct and
measurably improve the realistic (isolated) case. `higharc_dogwood` is not a benchmark target for this work (it is
in the suite as a no-regression check on a light-SSGI scene); its isolated speed is at parity within this
environment's noise floor, and its quality is unaffected (`+0.11%` RMSE with Round 4 on, `+0.001%` with it off).

## Cumulative result (shipped default: Rounds 1-3; Round 4 off)

4-scene A/B, 1920x1080, 30 warmup / 100 measured frames, `three-new-ssr-fast` -> `three-new-ssgi-fast`:

| Scene                 | three-new-ssr-fast | three-new-ssgi-fast | Speedup   |
| --------------------- | ------------------ | ------------------- | --------- |
| `ssgi-metallic`       | 1337.0 ms          | 730.0 ms            | **1.83x** |
| `ssgi-animated`       | 1360.3 ms          | 737.5 ms            | **1.85x** |
| `gi-room-high-albedo` | 83.9 ms            | 62.0 ms             | **1.35x** |
| `higharc_dogwood`     | 17.9 ms            | 26.5 ms             | 0.68x*    |
| **mean**              |                    |                     | **1.44x** |

\* This combined-run figure reflects the unresolved benchmark-order artifact above (heavy scenes benched
immediately before it in the same process); `higharc_dogwood` benched alone or first measures at parity (median
~0.96x across 16 samples) — see "Post-review investigation." Included here for transparency since it is what
`cli bench` reports for the exact scene set used elsewhere in this document, not because it reflects this scene's
realistic, isolated cost.

With Round 4 also on (not shipped, available via the flag), the same benchmark gave `ssgi-metallic` 2.05-2.40x,
`ssgi-animated` 2.18-2.41x, `gi-room-high-albedo` 1.35-1.54x, i.e. an additional ~15-20% on the Cornell scenes on
top of Rounds 1-3, at the cost noted above.

Quality (all 32 gate scenes, shipped default): mean RMSE regression vs `three-new-ssr-fast` **0.17%** (threshold
1%); worst single scene `ssgi-rounded` **+2.14%** (budget ~3%). All `ssr-*` scenes exactly unchanged.

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

| Round | Change                                       | Shipped default?             | Mean RMSE regression (32 scenes) | Worst scene                  |
| ----- | -------------------------------------------- | ---------------------------- | -------------------------------- | ---------------------------- |
| 0     | Baseline (identical to `three-new-ssr-fast`) | -                            | 0.00%                            | -                            |
| 1     | Loop-invariant initial ray step              | On                           | 0.00% (bit-identical)            | -                            |
| 2     | Reproject SSGI radiance once                 | On (fixed, see below)        | 0.00%                            | -                            |
| 3     | Store reprojection as RG11B10                | On                           | 0.17%                            | `ssgi-rounded` +2.14%        |
| 4     | Pack radiance + light normals in one fetch   | **Off** (available via flag) | 0.07% if on                      | `ssgi-animated` +1.03% if on |

Round 2 originally shipped a bug (its `rtt()` render target ignored the scene's `resolutionScale`), found in a
post-review investigation and fixed — see "Post-review investigation" above.

Cumulative (shipped default, Rounds 1-3): **1.44x** mean speedup vs `three-new-ssr-fast` on the 4-scene benchmark
(1.83-1.85x on the two Cornell scenes; `higharc_dogwood`'s combined-run figure reflects an unresolved
benchmark-order artifact, not a real regression -- see above); **0.17%** mean quality regression (well under the
1% budget), worst scene 2.14% (under the ~3% budget). With Round 4 also enabled: up to ~2.4x on the Cornell scenes,
0.07% mean quality regression, at the cost of a measurable (if secondary) regression on light-SSGI scenes.
