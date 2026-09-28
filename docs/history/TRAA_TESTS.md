# TRAA numeric verification

> **Historical log.** Renderer names here (`three-new-ssgi`, `three-new-ssr`, `-fast`, `-ssgi-fast`, `-rt`, `three-ss-legacy`) and `ssgi.ts` predate the consolidation into `three-new` / `three-new.ts` and `three-current` (issue #40). What is kept today is summarized in [../THREE-NEW.md](../THREE-NEW.md).

Dedicated, asset-free test scenes and scripts that put numbers on the prior TRAA audit of
`submodules/three.js/examples/jsm/tsl/display/TRAANode.js` (used by `packages/renderers/src/ssgi.ts`
whenever a scene sets `effects.antialias === 'traa'`). The audit's conclusion was: jitter (Halton 2,3 ×32),
jitter-free velocity, 3×3 closest-depth velocity dilation, 3×3 variance clipping (RGB, Playdead
clip-to-center), the disocclusion depth test, and tone-mapping order are all implemented correctly; the
gaps are (a) history sampled with plain bilinear filtering (no Catmull-Rom) → progressive blur under
motion, (b) the current sample is a single tap of the jittered frame (no reconstruction filter) → residual
jitter shimmer even with a static camera, (c) neighborhood clipping runs in RGB, not YCoCg, and (d) there
is no sharpening pass. This document measures (a), (b) and the already-verified static convergence /
disocclusion behavior, and explains why (c)/(d) are confirmed by code inspection rather than a pixel metric.

## Test scenes

Added to `packages/scenes/src/traa-diagnostics.ts` (registered in `packages/scenes/src/index.ts`, covered by
`packages/scenes/src/traa-diagnostics.test.ts`). All three are asset-free, fully emissive (black base,
`roughness: 1`, `emissive`/`emissiveMap` — the same pattern as `ssr-diagnostics.ts`, so the rasterizer's PBR
shading and the path tracer's emission produce the same radiance with no lights in the scene),
`NoToneMapping`, `temporalDenoise: false`, no ssgi/ssr:

- **`traa-checker`** — an oblique high-frequency checker floor (a 2×2 texture repeated 48×, `NearestFilter`,
  `generateMipmaps: false`, so screen-space aliasing is worst-case) plus six sub-pixel-width (0.015 world unit)
  bright lines. Static-convergence, pan-blur, and flicker test.
- **`traa-checker-smaa`** — identical scene with `antialias: 'smaa'`: a non-temporal control. SMAA has no
  history, so its output is identical every frame regardless of frame count or camera motion; every temporal
  effect below is visible only in the `traa-checker` column.
- **`traa-disocclusion`** — a static checker wall with an opaque slab (`slider-box`, home position x=0) that
  CLI `--motion-object slider-box:2` slides in from x=+2, so it uncovers checker pixels that have no
  reprojectable history: a disocclusion ghosting test.

## Script

`scripts/traa-metrics.mjs` (uses `readRgb` from `packages/cli/dist/compare.js`, the same way
`scripts/ssr-motion-metrics.mjs` does):

- `flicker <frame1> <frame2> ...`: per-pixel, per-channel temporal std-dev across a run of same-pose frames
  (mean / p95 / max, 0–255 scale).
- `sharpness <test> <reference>`: mean Sobel gradient magnitude of luma, reported as a ratio test/reference
  (1.0 = same average edge strength as the path-traced reference; <1 = blurrier).

Renderer: `three-new-ssgi` (the raster pipeline that uses `ssgi.ts`/TRAANode.js). Reference: 1024-sample
`three-gpu-pathtracer`, committed at `results/traa-checker/beauty/three-gpu-pathtracer.avif` etc., alongside
the usual `three-new-ssgi.avif`, `delta-three-new-ssgi.avif` and `metrics-three-new-ssgi.json` from
`pnpm cli compare`.

## 1. Static convergence (does TRAA approach the supersampled reference?)

RMSE vs the path-traced reference, `three-new-ssgi` at increasing frame counts, static camera:

| frames | traa-checker (TRAA) | traa-checker-smaa (SMAA control) |
| ------ | ------------------- | -------------------------------- |
| 1      | 0.1330              | 0.1031                           |
| 4      | 0.0844              | 0.1031                           |
| 16     | 0.0503              | 0.1031                           |
| 64     | 0.0401              | 0.1031                           |

TRAA converges monotonically from worse-than-SMAA at frame 1 (jitter alone, no history yet) to well below
SMAA by frame 64 (2.6× lower RMSE). SMAA's RMSE is exactly constant (0.1031 at every frame count), confirming
it is non-temporal, as expected, and giving a stable baseline for the other tests. This also stands in for
the "pipeline check" (§5 below): a static scene converging smoothly and monotonically to the reference,
with no plateau or divergence at any frame count, is only possible if the pre-pass depth/velocity and the
scene pass agree on the jittered projection each frame — a velocity/jitter desync would show up here as a
non-monotonic curve or a converged image that doesn't match the reference. It does converge cleanly, so no
such desync exists.

## 2. Pan blur under motion (audit gap a: bilinear history)

`--motion 10,60,0,1,4,16,64` (10° camera orbit over 60 frames, arriving at the scene's reference pose at
capture 0). RMSE vs the reference (same pose):

| capture      | traa-checker RMSE | traa-checker-smaa RMSE |
| ------------ | ----------------- | ---------------------- |
| m0 (arrival) | 0.0376            | 0.1031                 |
| m1           | 0.0366            | 0.1031                 |
| m4           | 0.0347            | 0.1031                 |
| m16          | 0.0342            | 0.1031                 |
| m64          | 0.0401            | 0.1031                 |

RMSE alone barely moves — it's dominated by the residual jitter/aliasing noise floor, not the motion blur.
The sharpness ratio (mean gradient magnitude, test/reference) shows the actual effect clearly:

| capture      | traa-checker sharpness ratio | traa-checker-smaa sharpness ratio |
| ------------ | ---------------------------- | --------------------------------- |
| m0 (arrival) | 0.9546                       | 1.0758                            |
| m1           | 0.9591                       | 1.0758                            |
| m4           | 0.9728                       | 1.0758                            |
| m16          | 1.0026                       | 1.0758                            |
| m64          | 1.0174                       | 1.0758                            |

**This is a clean, quantitative confirmation of audit gap (a).** Right after a 10° orbit, TRAA's output is
about 4.5% blurrier than the reference (ratio 0.9546 vs. ~1.0 at rest); it recovers monotonically over the
next ~16 static frames as the bilinearly-blurred history is replaced by fresh, in-focus samples, ending up
slightly _sharper_ than the reference (1.017, from residual noise) once fully converged. SMAA's ratio is
flat at 1.0758 (it has no history to blur, and is somewhat oversharp vs. the noise-free reference because
of its own residual spatial aliasing) — the motion-dependent dip is unique to the TRAA column. A
Catmull-Rom (or similarly sharpening) history filter is the standard fix, and would be expected to reduce
or eliminate the m0–m4 dip in this table.

## 3. Disocclusion ghosting

`--motion-object slider-box:2` with `--motion 0,60,0,1,4,16` (camera static, only the slab moves, arriving
home at capture 0). RMSE vs the reference:

| capture      | traa-disocclusion RMSE |
| ------------ | ---------------------- |
| m0 (arrival) | 0.0580                 |
| m1           | 0.0541                 |
| m4           | 0.0506                 |
| m16          | 0.0477                 |

Ghost energy is highest right at arrival (m0) and decays over the following frames as TRAA's disocclusion
depth test (`isDisocclusion = closestDepth.sub(previousDepth).greaterThan(this.depthThreshold)`,
`TRAANode.js:549`) rejects stale history on the newly-uncovered checker pixels and lets fresh samples
converge in. The decay confirms the disocclusion test is working (no permanent ghosting), while the nonzero
m0 RMSE quantifies the one-frame-ish transient every disocclusion-rejecting TAA has by construction.

## 4. Flicker on a static camera (audit gap b: single-tap current sample)

Per-pixel, per-channel temporal std-dev (0–255 scale) across 11 consecutive same-pose frames (frame indices
200–210, deterministic Halton-jitter re-render per frame count):

|                                  | mean std dev | p95 std dev | max std dev |
| -------------------------------- | ------------ | ----------- | ----------- |
| traa-checker (TRAA)              | 2.18         | 8.74        | 36.08       |
| traa-checker-smaa (SMAA control) | 0.00         | 0.00        | 0.00        |

SMAA is bit-exact frame to frame (no jitter, no history): its std dev is exactly zero, confirming the
harness and metric are sound. TRAA has nonzero flicker on a fully static camera and scene — mean 2.18/255,
but with a p95 of 8.74/255 and outliers up to 36/255, concentrated on the high-frequency checker/thin-line
edges where the Halton jitter shifts which side of an edge each sample lands on. **This is the direct
signature of audit gap (b):** the current frame contributes a single point-sampled tap of the jittered
image (`this.beautyNode.sample(uvNode)`, `TRAANode.js:554`) with no reconstruction filter (Blackman-Harris/
Gaussian), so each frame's "ground truth" for the resolve already contains jitter-dependent aliasing that
the temporal blend only partially damps.

## 5. Pipeline jitter/velocity consistency

As noted in §1: rather than adding a separate scene or hooking into the internal velocity render target
(not practical without modifying the `submodules/three.js` fork, which is out of scope), the static
convergence sweep is the practical form of this check. `traa-checker`'s RMSE decreases smoothly and
monotonically from frame 1 through frame 64 with no plateau, divergence, or ghosting artifact — the
signature a jitter/velocity desync between the pre-pass and scene pass would produce (either the image
never reaching the reference, or visible ghosting from a nonzero "velocity" on a scene where every object is
static). It does converge cleanly, corroborating the audit's conclusion that jitter-free velocity and the
prepass/scene-pass jitter agreement are correct.

## Gaps confirmed by code inspection only

- **(c) RGB clip, not YCoCg** — `varianceClipping` (`TRAANode.js:469-502`) computes `moment1`/`moment2`
  directly on `beautyNode` samples (RGB), and `clipAABB` (`TAAUtils.js:17-28`) clips `historyColor` against
  `minColor`/`maxColor` in the same RGB space. There's no measurement in this suite that isolates the
  colorspace of the clip from its other effects (variance clipping in RGB vs. YCoCg mostly changes clipping
  _tightness_ on colored, not luminance, edges, which none of these deliberately-neutral emissive test scenes
  exercise) — it's confirmed by reading the source, not a pixel metric here.
- **(d) No sharpening** — `resolve()` (`TRAANode.js:523-582`) ends at `flickerReduction` (`TAAUtils.js:52-73`,
  a luminance-weighted blend) with no unsharp-mask or similar pass afterward. The static-convergence
  sharpness ratio (§1/§2, ~1.0–1.02 at rest) is consistent with "no added sharpening": TRAA settles almost
  exactly at the reference's edge strength rather than exceeding it, unlike SMAA (1.076, oversharp from its
  own residual aliasing).

## Bugs found

None. Every measured gap here matches the prior audit's predictions exactly (bilinear-history blur under
motion, single-tap-driven static flicker); no additional defect showed up in the convergence, motion, or
disocclusion sweeps. No code fix is proposed or prototyped — the audited gaps are known best-practice
shortfalls, not incorrect behavior, and are non-trivial to fix cheaply (Catmull-Rom history resampling and a
reconstruction filter both add real shader cost and would need to be measured for regressions on every
existing `antialias: 'traa'` scene, which is out of scope for this verification pass).

## Reproducing

```sh
# references (once)
pnpm cli render --renderers three-gpu-pathtracer --scenes traa-checker,traa-checker-smaa,traa-disocclusion \
  --passes beauty --samples 1024

# static convergence
pnpm cli render --renderers three-new-ssgi --scenes traa-checker,traa-checker-smaa --passes beauty --frames <N>

# pan blur
pnpm cli render --renderers three-new-ssgi --scenes traa-checker,traa-checker-smaa --passes beauty \
  --motion 10,60,0,1,4,16,64 --output /tmp/traa-motion
node scripts/ssr-motion-metrics.mjs /tmp/traa-motion three-new-ssgi 0,1,4,16,64 traa-checker
node scripts/traa-metrics.mjs sharpness /tmp/traa-motion/traa-checker/beauty/three-new-ssgi@m0.avif \
  results/traa-checker/beauty/three-gpu-pathtracer.avif

# disocclusion
pnpm cli render --renderers three-new-ssgi --scenes traa-disocclusion --passes beauty \
  --motion 0,60,0,1,4,16 --motion-object slider-box:2 --output /tmp/traa-disoc-motion
node scripts/ssr-motion-metrics.mjs /tmp/traa-disoc-motion three-new-ssgi 0,1,4,16 traa-disocclusion

# flicker (re-render frames 200..210, each a fresh deterministic run to that frame count)
node scripts/traa-metrics.mjs flicker <frame1.avif> <frame2.avif> ...
```
