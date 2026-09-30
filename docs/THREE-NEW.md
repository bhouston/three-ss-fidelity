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

- `pnpm cli quality-gate three-current three-new` compares mean RMSE.
- `pnpm cli converge` measures quality after a camera move ([CONVERGENCE.md](CONVERGENCE.md)).
- `pnpm cli bench --renderers three-new` measures frame time ([PERF.md](PERF.md)).
- `pnpm cli render --ssr-debug hits` writes the SSR hit classification.
