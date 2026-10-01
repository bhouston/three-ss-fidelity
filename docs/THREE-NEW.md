# The screen-space renderers

Two screen-space renderers are scored against `three-gpu-pathtracer`:

| Renderer        | Source                                    | What it is                                                                                                     |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `three-current` | `packages/renderers/src/three-current.ts` | Stock three.js r186 from npm, wired like its `webgpu_postprocessing_ssgi` / `_ssr` examples. A fixed baseline. |
| `three-new`     | `packages/renderers/src/three-new.ts`     | The improved real-time pipeline: the fork plus the vendored SSGI and SSR nodes below.                          |

Both always anti-alias with TRAA. SMAA was removed: it is not temporal, so it cannot integrate the per-frame noise
of stochastic SSGI/SSR. The fork's `PreviousFrameGeometry` also crashed under SMAA on the first frame.

This page describes `three-new` as it is now. The experiments that produced it, including the ones that were rejected,
are logged in [history/](history/). Those logs use the names of the renderers they compared (`three-new-ssgi`,
`three-new-ssr`, `-fast`, `-ssgi-fast`, `-rt`). All of them have been folded into `three-new`.

## `three-new` pipeline, per displayed frame

Each displayed frame runs one pipeline frame. There is no sub-frame accumulation loop. Everything converges over
time through TRAA and the temporal filters.

1. **Pre-pass** (MRT): packed view normal, velocity, texture-mapped metalness/roughness, and specular color/F90.
   Transparent-flagged surfaces are included, so their reflections work too.
   See [history/SSR_IMPROVEMENTS.md](history/SSR_IMPROVEMENTS.md) R2.5 and R3.2.
2. **Back-face depth pass** (only for scenes with SSR): gives SSR the real thickness of each solid, for dual-layer
   hit tests. See R2.4.
3. **SSGI** (`ssgi-fast/SSGINode.js`, a vendored copy of the fork's node):
   - Solid-angle-corrected weighting. This fixes the indoor energy loss; Cornell RMSE went from 0.165 to 0.049. See
     [history/GI-ESTIMATOR-FOLLOWUP.md](history/GI-ESTIMATOR-FOLLOWUP.md).
   - The previous frame's radiance is reprojected once into an RG11B10 target, instead of once per sample.
   - The initial ray step is loop-invariant.
   - The two speedups are rounds 1–3 of [history/SSGI_FAST.md](history/SSGI_FAST.md): 1.44× on SSGI, +0.17 % RMSE.
   - AO and GI are denoised by the fork's temporal reprojection and recurrent denoiser.
   - Visibility-bitmask sectors are rounded at both horizons (stock three.js floors the start and takes the ceiling
     of the width). A flat surface's own samples no longer occlude a sector through precision noise, so
     camera-facing flat surfaces reach AO 1 (stock stays at about 0.93). AO RMSE falls 10–16 % in most scenes. SSGI
     beauty RMSE rose about 6 %, because the GI shares the sector counts and the over-count had been adding energy to
     an estimate that was already dark (undone by the next two fixes).
   - Oblique flat surfaces (#52): samples are snapped to depth texel centers, and each sample's horizon is its angle
     from the slice's tangent, placed above or below the tangent plane by its elevation (dot with the normal), instead
     of its angle to the view direction. The depth was read from one texel while the position was rebuilt at the
     fractional sample UV, which puts samples off the surface; and a snapped sample lies up to half a texel off the
     slice plane, where its angle to the view direction no longer matches the slice's horizon. On a 65° wall, a
     sample one pixel away then sits a sector or more inside the hemisphere. A CPU replay of the loop on
     ssgi-basic's exact geometry in float64 gives the same 0.87 as the GPU, so it isn't precision, TRAA jitter, the
     normal buffer (depth-derived normals give the same), GTAOFastAcos, or the denoiser (≈0.01). ssgi-basic walls,
     floor and ceiling go from 0.86–0.88 to 0.99 (reference 0.97–1.0). AO RMSE falls 5–22 % (ssgi-basic 0.1056 →
     0.0930), SSGI beauty RMSE 1–19 % (ssgi-basic 0.0719 → 0.0606). Exceptions: gltf-littlest-tokyo AO +2 % (its
     path-traced AO reference is almost black, so any lighter AO scores worse) and higharc_dogwood beauty +2 %.
     The SSGI pass costs roughly 10 % more at 8 slices × 32 steps (timed on a shared, noisy GPU).
   - GI sectors between samples of one surface are lit (issue #51). Far from the pixel the samples are sparser than
     the 32 sectors, and each sample only lit the sectors between its own front and back horizons, so the sectors
     between two samples of a continuous wall stayed dark. The old `ceil` gave each sample at least one sector,
     which hid this until the rounding fix above (SSGI beauty RMSE rose about 6 %). A sample now also lights the gap
     back to the previous sample's front horizon when the previous sample lies within `thickness` of its tangent
     plane (its normal is fetched only when there is such a gap). A sample facing away from the shading point
     neither fills a gap nor becomes the previous sample. Across depth discontinuities the gap stays open, and the AO
     bitfield is unchanged. See "GI sector gaps" below.
4. **SSR** (`ssr/NewSSRNode.js`):
   - Stochastic VNDF rays over the full GGX lobe, for metals and dielectrics alike.
   - Hits read the previous anti-aliased frame. Their specular is re-evaluated for the reflected direction, and
     hidden-side hits get a second bounce.
   - The trace uses Hi-Z and runs at full resolution. A half-resolution trace with a joint bilateral upsample (E7) was
     tried and then dropped in 85dce37 (#20). The upsample pass is still in `NewSSRNode` and runs when
     `resolutionScale < 1`.
   - An SSSR-style spatial ratio-estimator resolve and temporal filter converge it. The filter uses surface and
     virtual-point reprojection and rejects the history of moving objects.
   - See [history/SSR_IMPROVEMENTS.md](history/SSR_IMPROVEMENTS.md) (correctness) and
     [history/SSR_TEMPORAL.md](history/SSR_TEMPORAL.md) (real-time).
5. **Scene pass** lit by the SSGI (AO + GI context) and the SSR radiance context, then **TRAA**. When nothing moves,
   TRAA's history becomes an exact running mean (`progressive`). It resets when any object's world matrix changes.

Fixed settings are in `SSR_OPTIONS` at the top of `three-new.ts`:

| Setting                                      | Effect                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `quality 0.6`                                | March step density of the primary ray.                                   |
| `secondBounceQuality 0.4`                    | March step density of the second bounce.                                 |
| `secondBounceRoughnessCutoff 0.8`            | From this hit roughness up, the second bounce reads the environment map. |
| `hiZ`, `silhouetteFetch`, `clipRaysToScreen` | Always on.                                                               |

Everything else comes from the scene's `effects`: the SSGI slice and step counts, radius, thickness,
`resolutionScale`, and so on.

## GI sector gaps (issue #51)

In ssgi-basic, beauty minus direct (linear) is 0.47–0.67 of the path tracer's, even though three-new's direct is
already 13–35 % brighter than the path tracer's (a BRDF mismatch, separate from the GI). The estimator's
normalization is right: π²/2 × (sectors/32) × 2|sin h| × cos, averaged over slices, is π · Σ (π/32) L cos |sin h|,
the irradiance integral in view-centred slice coordinates. The loss is the sampling:

| ssgi-basic beauty (8 slices, radius 32, thickness 4) | RMSE   | mean linear |
| ---------------------------------------------------- | ------ | ----------- |
| path tracer                                          | –      | 0.241       |
| 32 steps (before)                                    | 0.0720 | 0.189       |
| 64 steps                                             | 0.0531 | –           |
| 128 steps                                            | 0.0480 | –           |
| 256 steps                                            | 0.0476 | –           |
| 32 steps, gap fill for every sample (heightfield)    | 0.0608 | 0.220       |
| 32 steps, gap fill for one surface only              | 0.0562 | 0.220       |

The step count, not the thickness or the normalization, converges the energy, so light is lost between samples.
With exponent-2 spacing the last samples are about 37 px apart, while a thickness-4 wall sample spans about half a
sector. Filling every gap overshoots the back wall. Limiting it to one surface (the previous sample within
`thickness` of the current sample's tangent plane) gets most of the dense result at 32 steps. The remaining floor and
ceiling shortfall is outside the screen or the radius.

Beauty RMSE vs three-gpu-pathtracer, #51 alone (the AO pass is bit-identical):

| Scene                       | before #50 | after #50 | now    |
| --------------------------- | ---------- | --------- | ------ |
| ssgi-basic                  | 0.0677     | 0.0720    | 0.0562 |
| ssgi-rounded                | 0.0514     | 0.0560    | 0.0415 |
| ssgi-metallic               | 0.0578     | 0.0611    | 0.0488 |
| ssgi-animated               | 0.0441     | 0.0467    | 0.0410 |
| ssgi-animated-visible-walls | –          | 0.0461    | 0.0415 |
| gi-emitter-corner           | 0.0574     | 0.0606    | 0.0544 |
| gi-room-high-albedo         | –          | 0.2749    | 0.2694 |
| gi-room-open-high-albedo    | –          | 0.0327    | 0.0278 |
| gi-room-open-low-albedo     | –          | 0.0127    | 0.0134 |

The gltf and higharc scenes change by at most 0.0002. gi-room-open-low-albedo was already brighter than the reference
because of the direct mismatch, so the extra GI adds to that.

### Back-facing gap samples

The first version let any sample fill its gap. Combined with #52 it left a hard horizontal line across the
ssgi-basic back wall at y ≈ 272 (640×480): G dropped 0.028 (linear) within two rows, where the path tracer is smooth
(largest row-to-row step 0.002). The line is at a wall height of about 4, the height of the short box, and:

- it doesn't appear without the gap fill, or with `thickness` 1;
- it doesn't move when the same-surface tolerance is scaled from 1× to 100× `thickness`, so it isn't the
  same-surface test switching;
- it comes only from gaps filled by samples with an upward normal (floor or box top), and only in the downward half
  of the slices.

Below height 4, the wall sees the short box top from beneath: the top faces away, emits nothing towards the wall,
and yet filled the gap from the wall's tangent plane up to the box edge and then acted as the previous sample. Above
height 4 the same face points at the wall and lights that gap. A sample facing away from the shading point now
neither fills a gap nor becomes the previous sample, and its own sectors are claimed as before. The line is gone
(largest row step 0.003).

| Beauty RMSE (AO pass unchanged) | #51 + #52 before | now    |
| ------------------------------- | ---------------- | ------ |
| ssgi-basic                      | 0.0485           | 0.0423 |
| ssgi-rounded                    | 0.0356           | 0.0341 |
| ssgi-metallic                   | 0.0430           | 0.0416 |
| ssgi-animated                   | 0.0397           | 0.0392 |
| ssgi-animated-visible-walls     | 0.0410           | 0.0408 |
| gi-room-open-high-albedo        | 0.0259           | 0.0259 |

ssgi-basic's mean linear brightness is now 0.241, the same as the path tracer's. Other scenes change by at most
0.0001.

## Cost

Measured per 1080p frame in [history/SSR_TEMPORAL.md](history/SSR_TEMPORAL.md) "Final results":

- **SSR scenes:** 16–21 ms with a half-resolution trace. The trace now runs at full resolution, so these scenes cost
  more: E7 measured about 4× for the trace before Hi-Z. The floor is the three scene renders (pre-pass, back-face
  depth, scene pass) plus TRAA and the filter passes.
- **SSGI-heavy scenes:** bound by their own SSGI settings. For example, `ssgi-metallic` uses 8 slices × 32 steps.
  The SSGI-side rounds above cut this by about a third.
- **Shader compile:** `three-new` compiles more pipelines than `three-current`: the Hi-Z pyramid, the SSR trace and
  filter passes, the back-face pass, and the vendored SSGI. The first frame therefore takes noticeably longer.

The next levers are listed under "Next steps" in [history/SSR_TEMPORAL.md](history/SSR_TEMPORAL.md):

- A cheaper back-face pass.
- A max-depth Hi-Z layer.
- Roughness-gated tracing.
- Catmull-Rom TRAA history.

## Tools

- `pnpm cli quality-gate three-current three-new` checks the per-scene/pass PSNR drop (default allowance 0.1 dB).
- `pnpm cli converge` measures quality after a camera move ([CONVERGENCE.md](CONVERGENCE.md)).
- `pnpm cli bench --renderers three-new` measures frame time ([PERF.md](PERF.md)).
- `pnpm cli render --ssr-debug hits` writes the SSR hit classification.

## Optional hierarchical experiments

`cli render` and `cli bench` accept `--experiment ssr-hiz-tight`, `ssr-radiance-mips`, `ssgi-radiance-mips`, or `hierarchy-combined`.
The default is `baseline`. See [history/HIERARCHICAL.md](history/HIERARCHICAL.md) for the research,
independent experiments, diagnostics, reproducible runner, and measured performance/quality tradeoffs.

`hierarchy-combined` enables all three techniques. When SSGI and SSR both run and
`resolutionScale` is 1, they share the existing GI RG11B10 reprojected radiance target
and its mip chain, avoiding the extra SSR radiance pass. At other scales SSR keeps
its own full-resolution target so its pixel-based footprint remains correct.
Mirror/near-hit SSR and secondary bounces still sample the original history;
depth, normals, hit refinement, sampling budgets, and temporal filters are unchanged.

Select `hierarchy-combined` in the live viewer's Experiment control, or open
`?scene=ssgi-metallic&renderer=three-new&experiment=hierarchy-combined`.
The fidelity viewer identifies captures as `three-new-hierarchy-combined`.

```sh
pnpm cli render --renderers three-new --experiment hierarchy-combined
pnpm exec fidelity-kit process results
pnpm cli quality-gate three-new three-new-hierarchy-combined --threshold 0.1
# Compare all individual profiles and the combined profile on both-effect scenes:
node scripts/hierarchical-experiments.mjs --scenes ssgi-basic,ssgi-metallic --out .output/combined
# 1080p and motion captures for the combined profile:
node scripts/hierarchical-quality.mjs --experiments hierarchy-combined --out .output/combined-extra
```

Mip filtering changes radiance and is not a lossless transformation. The runner
compares against path-traced references, repeats the baseline to expose variation,
and exits unsuccessfully if the allowed PSNR drop is exceeded. With individual
profiles included, it also gates the combined result against each individual result.
Throughput uses fresh seeded processes and alternating order; timestamp profiles
run separately. Performance is scene and device dependent. See
[COMBINED-HIERARCHY.md](COMBINED-HIERARCHY.md) for measured evidence and limitations.
