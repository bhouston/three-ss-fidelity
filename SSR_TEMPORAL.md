# Real-time temporal SSR (three-new-ssr-rt)

Refs #20

## Goal

`three-new-ssr` / `three-new-ssr-fast` (see `SSR_IMPROVEMENTS.md`) look right only once the camera has stopped. Make
the stochastic SSR look good **while moving**, at a frame rate approaching 60 fps at 1080p, without giving up the
fidelity work of the earlier rounds. The new renderer is `three-new-ssr-rt`. `three-new-ssr`, `three-new-ssr-fast`,
`three-new-ssgi`, `three-ss-legacy` and the three.js submodule are unchanged.

## Summary

- **What worked.**
  - One pipeline frame per displayed frame with **TRAA** (E1).
  - An **SSSR-style filter** (E3): spatial ratio-estimator resolve plus temporal accumulation with surface and
    virtual-point reprojection, geometry validation, variance clipping and roughness-dependent history.
  - **Jitter-free virtual reprojection** (E5), which removed a progressive blur.
  - **Hit-motion history rejection** for moving objects (E6).
  - **Half-resolution tracing** with a joint bilateral upsample (E7).
  - **Hi-Z traversal** (E9).
- **Quality.** Right after a camera move, `three-new-ssr-rt` is as close to the path tracer (RMSE 0.0367) as
  `three-new-ssr-fast` is after fully converging at rest (0.0361). It cuts moving-object ghosting by 40 %. It passes
  the static quality gate (+0.75 % mean RMSE) with 1/12 of the frames.
- **Speed.** 16–21 ms per 1080p frame on the SSR scenes, against ~610–990 ms for `three-new-ssr-fast`: at the
  60 fps line on this shared machine.
- **What did not work.**
  - The fork's specular temporal/denoise chain (E2): smooth, but biased on high-variance reflections.
  - A capped march (E4): contact reflections detach.
  - Tight clipping, longer history and smaller spatial kernels (E5, E8).
- **TRAA** is implemented correctly. Its measured weaknesses are bilinear history blur after motion and single-tap
  static shimmer (`TRAA_TESTS.md`).
- **Defects found.** Hi-Z mip coverage and texel-test bugs (fixed); a jitter-induced history blur (fixed);
  moving-object smearing in `three-new-ssr(-fast)` (not fixed there); the fork's `PreviousFrameGeometry` first-frame
  crash under SMAA.

## Diagnosis: why it only looked good at rest

- **The running mean restarts on every camera change.** `NewSSRNode`'s `accumulate` mode keeps an unbiased
  running mean of the ratio-estimator terms `vec4(L·w, w)`. It resets whenever `camera.matrixWorld` changes
  (`updateBefore`), so any camera move drops the result back to 1 sample.
- **Each displayed frame is 12–16 pipeline frames.** `createSSGIRenderer` runs `ceil(accumFrames / effects.frames)`
  pipeline frames per `render()` (12 for the `ssr-*` scenes in `three-new-ssr-fast`). In the viewer that is ~1 s per
  frame at 1080p, and every orbit step shows a 12-sample image.
- **Moving objects smear.** The running mean restarts only on camera changes, so a moving reflected object
  accumulates its whole path (see the ghost test below).
- **No TRAA on the SSR scenes.** Every `ssr-*` scene uses SMAA. Nothing integrates the per-frame noise across frames
  except the running mean itself.

## Research summary

Current practice for 1-ray-per-pixel stochastic SSR (Stachowiak & Uludag 2015; AMD FidelityFX SSSR + Denoiser; NVIDIA
ReBLUR / NRD, Zhdan 2021; UE5 Lumen reflections; Godot 4.6 SSR) converges on the same recipe:

1. Trace against the **previous frame's anti-aliased color**, reprojected (already the case here).
2. **Spatial ratio-estimator resolve**: reuse neighbouring pixels' rays, `Σ L·w / Σ w`, over a lobe-sized kernel.
3. **Temporal accumulation with two reprojections**: surface motion (velocity buffer) for rough reflections, and
   the **virtual point** (the hit seen through the mirror, from the hit distance) for sharp ones; choose by
   roughness and similarity to the current neighbourhood.
4. History validation (depth/normal) plus **neighbourhood clipping** (mean ± k·σ, YCoCg), and a **history length
   capped by roughness** (mirrors ~4–8 frames, rough ~16–32).
5. A "history fix" (wider spatial blur) where history is short; anti-lag; hierarchical (Hi-Z) tracing; half-res
   tracing with an edge-aware upsample; tracing gated by roughness.
6. SSR has its **own** temporal filter before the final TAA; TAA is not relied on as the only SSR denoiser.

Budget reference: FidelityFX SSSR's whole trace + denoise chain is ~2.6 ms at 1080p on an RTX 3080 mobile.

### Audit: the fork's TRAA (`TRAANode.js`)

A line-by-line audit against Karis 2014 / Salvi 2016 / Playdead found the core mechanics **correct**:

- Halton(2,3) × 32 jitter.
- Jitter applied to all passes of the pipeline (the pre-pass depth/velocity and the scene pass see the same jitter:
  `setViewOffset` runs in `OnBeforeRenderPipeline`).
- Jitter-free velocity (`VelocityNode` uses the unjittered projection).
- 3×3 closest-depth velocity dilation.
- 3×3 variance clipping with clip-to-centre.
- Previous-depth disocclusion test and off-screen rejection.
- Luminance-weighted anti-flicker blend.
- HDR linear input with tone mapping after TRAA.
- The history reset on resize.

Gaps against best practice, all quality issues rather than bugs:

- History is sampled **bilinearly** (no Catmull-Rom), which blurs progressively under motion.
- The current sample is **one jittered tap**, not a filtered 3×3 reconstruction.
- Clipping happens in RGB rather than YCoCg.
- There is no sharpening.

The `previousFrame` texture the effects read is last frame's resolve by construction (the scene pass is a dependency
of TRAA). That is correct, but it is a build-order invariant rather than an explicit ping-pong. The numeric TRAA tests
are in "TRAA test scenes" below.

### Audit: the fork's specular temporal chain

`TemporalReprojectNode` (`mode: 'specular'`) plus `RecurrentDenoiseNode` is what `three-new-ssgi` uses for its SSR.
It is a capable ReBLUR-style chain:

- 4-tap confidence-weighted bilinear history.
- Hit-point parallax reprojection.
- YCoCg variance clip with inverse-luminance compression.
- An 8-tap Vogel-disk spatial filter with lobe-shaped normal, plane, luma and hit-distance edge stopping.
- Recurrent feedback.

It expects `alpha` to be a **hit distance**. It deliberately biases, through clipping, firefly suppression and luma
edge stopping, which is why `three-new-ssr` bypassed it.

## Method

- **Motion eval** (new, `cli render --motion degrees,moveFrames,captures…`).
  - The camera orbits 20° about the scene target over 60 frames (smoothstep eased) and arrives exactly at the
    reference pose. It stays there, and frames are captured at 0 (arrival), 4, 16 and 64 frames at rest.
  - `scripts/ssr-motion-metrics.mjs` scores them against the committed path-traced reference.
  - Scenes (9): `ssr-diag-{mirror, rough-10, rough-30, rough-60, sphere, metal-hit, occlusion}`,
    `ssr-steampunk-camera`, `ssgi-metallic`.
  - The arrival frame is the "while moving" number: all of its history comes from moving poses.
- **Ghost test** (new, `--motion-object name:dx`). The camera is still, and `sphere-green` slides 1.5 units along x
  over 30 frames back to its home position above the `mirror`, `rough-10` and `rough-30` floors. Captures at 0, 2
  and 8 frames after it stops.
- **Static quality**: `cli render` / `compare` / `quality-gate` over all 32 scenes at the default frame counts.
- **Speed**: `cli bench` at 1920×1080, 30 warm-up / 100 measured frames.
  - This machine is a shared desktop (WindowServer, Safari and VS Code on the same GPU), with run-to-run swings of
    up to 3×.
  - Every number below is the **minimum of 3 runs**, and comparisons are always from the same session.
  - GPU timestamp queries (`cli bench --gpu`, added here) work mechanically but are useless on this Apple GPU
    through dawn: every pass's range spans most of the frame (tile-based GPUs overlap passes), so they do not give a
    per-pass breakdown. The cost breakdown below comes from ablations instead.

## Experiments

Motion-eval numbers are mean RMSE over the 9 scenes at arrival / after 64 frames at rest. Reference point:
`three-new-ssr-fast` (12 pipeline frames per displayed frame) gives **0.0398 / 0.0361**.

### E0. One pipeline frame per displayed frame (`realtime: 'reset'`), kept as the baseline

`three-new-ssr-rt` starts as `three-new-ssr-fast`'s tracing without the sub-frame loop, still using the resetting
running mean. This is what `three-new-ssr-fast` would look like at 60 fps.

- **Result.** **0.0507 / 0.0369.** Arrival is a 1-sample image: `rough-30` 0.0431 against 0.0187 for
  `three-new-ssr-fast`, and steampunk 0.1412 against 0.0968.

### E1. TRAA instead of SMAA (kept)

- **Change.** `three-new-ssr-rt` always resolves with TRAA (`useTRAA` in `ssgi.ts`). The material packing of the
  ssgi example is not affected.
- **Result.** **0.0507 → 0.0384** at arrival and 0.0359 at rest, with nothing else changed.
  - TRAA's own history integrates the stochastic reflections, and its anti-aliasing also moves the image closer to
    the supersampled reference.
  - Static control: with 256 frames at rest, reset + TRAA converges steampunk to **0.0685**, against 0.0715 for
    `three-new-ssr-fast` with SMAA. TRAA helps; it is not a source of error.
- **Visual.** The image is still visibly grainy while moving. TRAA's clip keeps much of the per-frame noise.

### E2. The fork's specular temporal chain (`realtime: 'fork'`), not kept

- **Change.** `NewSSRNode` gains `radianceHistoryNode`, so the hit-specular redirection (R3.2) can read an external
  filter's output instead of the running mean's resolve. In `'fork'` mode the node outputs `vec4(L, hit distance)`,
  wired to `temporalReproject(mode 'specular')` + `recurrentDenoise` with `three-new-ssgi`'s settings.
- **Pitfall.** On the SMAA scenes `PreviousFrameGeometry.update` crashes (`copyTextureToTexture` on a depth texture
  that has not been rendered yet): nothing forces the pre-pass to render before it. It works with TRAA, which reads
  the pre-pass depth first. This is one more reason `three-new-ssr-rt` always uses TRAA.
- **Result.** **0.0411 / 0.0402.** It is smooth and noise-free while moving, and `rough-30`/`rough-60`/`metal-hit`
  even beat the static reference. But **steampunk stays at 0.1165 however long the camera rests**: the floor loses
  the dark-red reflection of the camera body and comes out too bright. The chain's clipping, firefly suppression and
  luma edge stopping bias exactly the high-variance case. It is kept as an option, not the default.

### E3. SSSR-style spatial + temporal filter in `NewSSRNode` (`realtime: 'sssr'`), kept

`NewSSRNode.temporalFilter` replaces the running mean. Per frame:

1. **Trace** (MRT): `vec4(L·w, w)` as before, plus the hit distance (`ENV_RAY_LENGTH` on a miss).
2. **Spatial resolve**: `Σ L·w / Σ w` over the pixel and 8 Vogel-disk neighbours, per-frame rotated.
   - Radius = 40·α pixels (α = roughness²), capped at 12; mirrors keep their own ray.
   - Each tap is weighted by plane distance (1 % of view depth), `(N·N_j)^16` and roughness similarity.
   - Also resolves the w-weighted hit distance.
3. **Temporal**: reproject along the surface velocity and to the virtual point `C + v̂·(|P−C| + hitDistance)`.
   - Validate each against the previous frame's world normal and camera distance (a small geometry target written
     each frame).
   - Take the valid history that is closer to this frame's 3×3 neighbourhood mean (luma, in σ units).
   - YCoCg variance clip.
   - Blend with `1/n`, where `n` is capped by `mix(4, 32, roughness / 0.4)`.
4. **History copy**, and this frame's geometry for next frame's validation.
5. The hit-specular redirection reads **last frame's filtered output reprojected by velocity** in place of the
   running mean's resolve.

**Result.** **0.0364 / 0.0361**: at arrival, about equal to `three-new-ssr-fast`'s fully converged value (0.0361),
with 1 pipeline frame per displayed frame. Visually it is smooth while moving, with no visible bias on the
diagnostics. Steampunk is 0.0767 at arrival but does not improve with rest (0.0780 after 64 frames): that is bias,
not lag (see E5).

### E4. Capped march (`maxMarchSteps`), not kept

The dense march (one step per 1/0.6 texels of screen-space ray length, front and back depth per step) dominated the
cost: hundreds of steps per ray at 1080p. The option caps it, spacing steps as `(i/n)^2` (never under a texel) so
contacts stay dense.

| cap       | 1080p ms/frame (rough-30) | motion eval at arrival |
| --------- | ------------------------- | ---------------------- |
| uncapped  | 78.5                      | 0.0364                 |
| 48        | 47                        | —                      |
| 32        | ~22–25                    | 0.0427                 |
| 24        | ~20–23                    | 0.0440                 |
| 16        | ~21–24                    | 0.0464                 |
| 8 (floor) | 14.8                      | —                      |

The quality cost is large: **contact reflections detach from their objects** (the far steps jump over an object's
thin screen-space depth extent, even with dual-layer depth and binary refinement). The option is left unset. The
8-step row gives the non-march floor of the pipeline, about 15 ms at 1080p.

### E5. Jitter-free virtual-point reprojection and clip width (kept)

A static 256-frame steampunk render isolated the bias. The reset running mean with TRAA gives **0.0685**; the filter
gives 0.0782.

| variant (static steampunk, 256 frames)           | RMSE                     |
| ------------------------------------------------ | ------------------------ |
| filter (clip 1.25σ)                              | 0.0782                   |
| no clipping                                      | 0.0702                   |
| no spatial resolve                               | 0.0912                   |
| history cap 128                                  | 0.0806                   |
| no clip, no spatial, cap 256 (pure accumulation) | 0.0776                   |
| same, after the jitter fix below                 | 0.0701                   |
| after the jitter fix: clip 1.25σ / 2σ / 3σ       | 0.0811 / 0.0776 / 0.0748 |

- **Bug (fixed).** Pure accumulation should reach the reset value, but did not. The virtual point was reconstructed
  from the jittered depth but projected with the unjittered previous camera, so even a still camera resampled the
  history bilinearly by TRAA's sub-pixel offset every frame: progressive blur. It is now a **motion vector between the
  two unjittered cameras added to the pixel's UV**, like the velocity buffer. Result: 0.0776 → 0.0701.
- **Clip width.** A tight clip against the 3×3 statistics of a still-noisy signal is the dominant bias.

  | clip  | motion eval arrival / rest (mean) | steampunk arrival / rest |
  | ----- | --------------------------------- | ------------------------ |
  | 1.25σ | 0.0365 / 0.0365                   | 0.0770 / 0.0817          |
  | 2σ    | 0.0363 / 0.0361                   | 0.0753 / 0.0783          |
  | 3σ    | 0.0362 / 0.0357                   | 0.0739 / 0.0755          |
  | 5σ    | 0.0362 / 0.0354                   | 0.0728 / 0.0726          |

  Wider is better on camera motion, but worse on moving objects (next), so **3σ** was chosen.

### E6. Rejecting stale history of moving objects (kept)

- **Finding.** With a still camera and a moving reflected object, neither reprojection is right: the floor does not
  move, and the virtual point assumes a static hit. The reflection trails behind the object. Ghost test, mean at
  0 / 2 / 8 frames: clip 1.25σ **0.0188** / 0.0169 / 0.0163, 3σ 0.0213, 5σ 0.0226. A single clip width trades static
  bias against ghosting.
- **Change.** The trace writes a second value: the **hit object's own screen motion**, i.e. the velocity buffer at
  the hit minus the motion the camera alone gives the hit's world position (both unjittered cameras). The temporal
  pass takes its 3×3 maximum. Where it exceeds ~0.1–1 px, it tightens the clip (3σ → 0.5σ) and caps the history at
  2 frames.
- **Result.** Ghost test **0.0213 → 0.0178** (better than a global 1.25σ clip), and the camera-motion eval is
  unchanged (0.0362 / 0.0357). There are no false positives from camera motion.
- **Residual.** A faint trail remains where the rays now hit the static background behind the object's old position.
  Those rays report no motion, so they keep the wide clip. Carrying a "recently dynamic" flag in the history would
  close this.

### E7. Half-resolution trace with a joint bilateral upsample (kept)

- **Change.** `traceResolutionScale: 0.5` runs the trace and the whole filter at half resolution. A new pass
  upsamples the filtered result from the 4 nearest texels, weighted bilinearly and by plane-distance and normal
  similarity to the full-resolution pixel.
- **Result.**

  | variant                      | 1080p ms/frame (metal-hit / rough-30 / steampunk) | motion eval arrival / rest |
  | ---------------------------- | ------------------------------------------------- | -------------------------- |
  | full resolution              | 53.5 / 78.5 / 87.2                                | 0.0362 / 0.0357            |
  | half, bilinear               | 15.4 / 20.2 / 22.4                                | 0.0379 / 0.0370            |
  | half + joint bilateral       | **18.1 / 22.8 / 23.7**                            | **0.0372 / 0.0365**        |
  | `three-new-ssgi` (same runs) | 22.3–37.8                                         | —                          |

  About 4× faster for a small loss. The bilateral upsample recovers about half of that loss and costs ~2 ms.

### E8. Tuning that did not help (motion eval, half-res configuration before E9)

| change                                | arrival / rest  |
| ------------------------------------- | --------------- |
| (E7)                                  | 0.0372 / 0.0365 |
| spatial radius 20·α, max 6 (half-res) | 0.0371 / 0.0364 |
| history cap 64                        | 0.0374 / 0.0365 |
| both                                  | 0.0372 / 0.0365 |
| clip 8σ                               | 0.0372 / 0.0360 |
| no clip                               | 0.0374 / 0.0359 |

No change moved the steampunk plateau (~0.075–0.078). Its remaining gap to the reset mean's 0.0685 is spread over
half-resolution tracing on a normal-mapped metal model (full resolution: ~0.074), spatial reuse, and clipping.

### E9. Hi-Z traversal (`hiZ`), kept

An ablation (the march capped at 8 steps) put the half-resolution floor at **5.0–6.7 ms**, so the dense march was
still 10–15 ms of the frame.

- **Change.** `NewSSRNode` builds a 7-level **min-depth pyramid** of the depth buffer at the trace resolution. Level
  0 is the nearest of the 2×2 full-resolution depths. WebGPU cannot sample a texture it renders into, so the pyramid
  ping-pongs between two mip-chained targets (even levels in one, odd in the other), with one material per level.
- **Traversal.** At each step the ray finds its cell at the current level.
  - If it stays in front of the cell's nearest depth over the whole cell, it skips the cell and goes one level
    coarser. This is safe: both the thickness and the dual-layer tests need the ray behind the front surface.
  - Otherwise it goes one level finer.
  - At level 0 it runs the dense march's hit test for that texel.
  - The budget is 96 iterations per ray, and the second bounce uses the same traversal.
- **Bugs found on the way.**
  1. Testing each texel at the ray's exit point samples the _next_ texel's depth: crossings were missed. Testing
     the texel centre instead (off the ray) made grazing floors self-intersect: garbage at the horizon, mean 0.083.
     The test now runs at the **middle of the ray's span inside the texel**, with depth and ray depth at the same
     point.
  2. Floor-rounded mip sizes leave the **last partial cell of coarse levels uncovered** (180 px ÷ 64 = 2.8 rows).
     The lookup clamped those rays to the previous cell and skipped them against the wrong depth: spheres lost
     their floor reflections (`ssr-diag-sphere` 0.0640; the chrome sphere in `ssgi-metallic` turned black below its
     equator). Found by bisecting: with skipping disabled, Hi-Z matched the dense march. The downsample now takes a
     3×3 footprint (clamped), and uncovered cells are never skipped.
  - Ruled out along the way: iteration budget, self-intersection near the origin, a vertical flip of the pyramid,
    and shared-uniform caching between mip draws.
- **Result.**

  | variant (half res)      | motion eval arrival / rest | 1080p ms/frame (metal-hit / rough-30 / steampunk) |
  | ----------------------- | -------------------------- | ------------------------------------------------- |
  | dense march             | 0.0372 / 0.0365            | 18.0 / 23.6 / 23.0                                |
  | Hi-Z, 64 iterations     | 0.0370 / 0.0362            | 14.9 / 17.7 / 17.6                                |
  | **Hi-Z, 96 iterations** | **0.0367 / 0.0359**        | 16.4 / 19.6 / 20.5                                |
  | Hi-Z, 128 iterations    | —                          | 16.9 / 20.4 / 21.5                                |

  Hi-Z is both better and faster. It finds hits the dense march's 1/0.6-texel steps skip: `ssr-diag-sphere`
  0.0606 → 0.0593, steampunk 0.0778 → 0.0767. At 64 iterations `ssgi-metallic` loses a little (0.0521 against 0.0507;
  the Cornell box's long rays run out of budget), and 96 recovers it (0.0509).

### E10. Silhouette color fetch (`silhouetteFetch`), kept

`ssr-diag-dielectric-0` showed a dark, vertically streaked band at the top of the green sphere's floor reflection
(directly under the sphere). It was not the Hi-Z or the trace resolution: the band is identical at half and full
resolution and in `three-new-ssr-fast` (dense march, no Hi-Z).

- **Diagnosis** (`cli render --ssr-debug hits|hitcolor`, the trace pass's own output). The rays there do hit the
  sphere, partly as dual-layer (inside-solid) hits. They reflect its hidden underside, which projects onto the
  sphere's bottom silhouette: about ten floor rows all land on the same one or two texels. In the TRAA color buffer
  that silhouette texel is a coverage blend with the dark floor behind it. The hits read 57 % of the sphere's
  radiance.
- **Change.** When the texel before the hit (along the ray) is another surface, i.e. the ray entered the footprint at
  its silhouette, read the color one or two texels further along the ray, as long as the ray is still strictly
  between that texel's front and back-face depth. Only for non-metal hits: for a mirror-like hit the silhouette
  texel, whose normal is the closest to the hidden side's, is the better proxy for view-dependent radiance.
- **Variants rejected** (all 17 `ssr-*` scenes, beauty RMSE against the path tracer; renders are deterministic, a
  rerun differs by ≤ 0.01 %):

  | variant                                                        | mean    | worst scene                 |
  | -------------------------------------------------------------- | ------- | --------------------------- |
  | always read 1–2 texels further on (depth within the thickness) | +0.09 % | `metal-hit` +9.2 %          |
  | only for inside-solid hits                                     | −0.66 % | +0.02 % (band mostly stays) |
  | plus a normal-similarity test                                  | −0.38 % | +0.11 % (band stays)        |
  | ray still inside the solid, back-face slack of the thickness   | −0.64 % | `grazing` +1.8 %            |
  | **ray strictly inside the solid, non-metal hits only (kept)**  | −0.56 % | +0.02 %                     |

  Grazing rays passing _beside_ the sphere are thickness hits on its side silhouette. The blend used to hide them,
  and reading an interior texel bloated the reflection (`grazing`). A strict inside test rejects them.

- **Result.** 14 of 17 scenes improve, and the other three are within noise: `dielectric-0` −3.5 %,
  `dielectric-30` −2.8 %, `mirror` −4.0 %, `rough-10` −5.4 %, `rough-30` −3.3 %, `offscreen` −2.8 %,
  `grazing` −0.8 %. `three-new-ssr-fast` is pixel-identical (the option is off there).

## TRAA test scenes

Written up in full in `TRAA_TESTS.md`. New asset-free, fully emissive scenes (`packages/scenes/src/traa-diagnostics.ts`):

- `traa-checker`: an oblique, nearest-filtered 48× checker floor plus sub-pixel lines.
- `traa-checker-smaa`: the same scene with SMAA, as a non-temporal control.
- `traa-disocclusion`: a slab slid across a checker wall with `--motion-object`.

`scripts/traa-metrics.mjs` measures flicker (per-pixel temporal standard deviation) and sharpness (the ratio of mean
Sobel gradient to the reference). Renderer: `three-new-ssgi`.

| test                                  | result                                              | verdict                                                                              |
| ------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Static convergence, 1 → 64 frames     | RMSE 0.133 → 0.040, monotonic (SMAA flat at 0.103)  | Correct; also rules out a pre-pass/scene-pass jitter mismatch                        |
| Sharpness after a 10° orbit, m0 → m64 | 0.955 → 1.017 of the reference (SMAA flat at 1.076) | Bilinear-history blur confirmed: ~4.5 % blurrier after motion, ~16 frames to recover |
| Disocclusion, m0 → m16                | RMSE 0.058 → 0.048                                  | Depth-based rejection works; no persistent ghost                                     |
| Static flicker (11 same-pose frames)  | mean 2.18/255, p95 8.74, max 36 (SMAA 0)            | Single-tap current-sample shimmer confirmed                                          |

No bugs. The measured gaps are exactly the audit's (a) bilinear history and (b) single-tap current sample. Gaps
(c) RGB clip and (d) no sharpening are confirmed by source inspection only. Both fixes, Catmull-Rom history and a
Blackman-Harris reconstruction of the current sample, would need the TRAA node vendored (like
`ssgi-fast/SSGINode.js`) and regression-checked on every TRAA scene; they are listed under next steps.

## Final results

`three-new-ssr-rt` defaults, from the `index.ts` table:

- Tracing inherited from `three-new-ssr-fast`: `clipRaysToScreen`, `secondBounceRoughnessCutoff 0.8`,
  `quality 0.6`, `secondBounceQuality 0.4`.
- `realtime: 'sssr'`, `hiZ: true` (96 iterations), traced at full resolution (the E7 half-resolution trace is no
  longer the default; set `traceResolutionScale: 0.5` to get it back, with its joint bilateral upsample).
- TRAA.
- Filter uniforms: `spatialRadius 40`, `spatialMaxRadius 12`, history 4–32 by roughness, `clipGamma 3`, with 0.5σ and
  2 frames where reflected objects move.

**While moving** (motion eval, mean RMSE of the 9 scenes):

| renderer                                           | pipeline frames / displayed frame | arrival    | +4     | +16    | +64    |
| -------------------------------------------------- | --------------------------------- | ---------- | ------ | ------ | ------ |
| `three-new-ssr-fast`                               | 12                                | 0.0398     | 0.0371 | 0.0363 | 0.0361 |
| `three-new-ssr-rt` E0 (reset, SMAA)                | 1                                 | 0.0507     | 0.0427 | 0.0391 | 0.0369 |
| `three-new-ssr-rt` E1 (reset, TRAA)                | 1                                 | 0.0384     | 0.0382 | 0.0376 | 0.0359 |
| `three-new-ssr-rt` E2 (fork chain)                 | 1                                 | 0.0411     | 0.0409 | 0.0405 | 0.0402 |
| `three-new-ssr-rt` full-res filter (E3–E6)         | 1                                 | 0.0362     | 0.0361 | 0.0359 | 0.0357 |
| `three-new-ssr-rt` half-res, dense march (E7)      | 1                                 | 0.0372     | 0.0372 | 0.0367 | 0.0365 |
| **`three-new-ssr-rt` final (half-res + Hi-Z, E9)** | 1                                 | **0.0367** | 0.0366 | 0.0361 | 0.0359 |

**Moving objects** (ghost test, mean at 0 / 2 / 8 frames after the object stops): `three-new-ssr-fast`
0.0304 / 0.0294 / 0.0268 (the reset mean smears the object's whole path); **`three-new-ssr-rt` 0.0181 / 0.0167 /
0.0158**.

**Static, all 32 scenes** (`quality-gate three-new-ssr-fast three-new-ssr-rt`, default frame counts, so 16 pipeline
frames for `three-new-ssr-rt` against 192 for `three-new-ssr-fast` on the SSR scenes): mean RMSE 0.0756 → 0.0762
(**+0.75 %, QUALITY OK** against the 1 % gate; before Hi-Z it was +1.23 %).

- The regressions are the steampunk scenes (`ssr-steampunk-camera` 0.0715 → 0.0805, `roughness-50` 0.0856 → 0.0892,
  `roughness-100` 0.0716 → 0.0806), where `roughness-0`/`roughness-25` are slightly better, and the Cornell `ssgi-*`
  scenes, which are +1.6–3 %.
- The diagnostics are flat or better: `dielectric-0` 0.0131 → 0.0109, `dielectric-30` 0.0127 → 0.0105, `sphere`
  0.0610 → 0.0589, `mirror` 0.0171 → 0.0169, `metal-hit` 0.0268 → 0.0269.
- Scenes without SSR are identical.

**Speed** (1080p, min of 3, same session):

| scene                  | `three-new-ssr-rt` | `three-new-ssgi` | `three-new-ssr-fast` (`SSR_IMPROVEMENTS.md`) |
| ---------------------- | ------------------ | ---------------- | -------------------------------------------- |
| `ssr-diag-metal-hit`   | **16.3 ms**        | 41.4 ms          | ~610 ms                                      |
| `ssr-diag-rough-30`    | **17.4 ms**        | 38.7 ms          | 848 ms                                       |
| `ssr-steampunk-camera` | **20.7 ms**        | 23.7 ms          | 988 ms                                       |

That is **~35–50× faster per displayed frame than `three-new-ssr-fast`** at equal or better in-motion quality, and
faster than `three-new-ssgi` (the fork SSR pipeline) in the same runs. It is at the 60 fps line (16.7 ms) on this
loaded, shared desktop, with the non-SSR part of the frame (three scene renders plus TRAA) now the larger share.
`ssgi-metallic` stays SSGI-bound (~500 ms; its SSGI is not part of this work).

## Defects found along the way

- **`three-new-ssr` / `three-new-ssr-fast` smear moving objects.** Their running mean only restarts on camera
  changes. Not fixed there (out of scope; `three-new-ssr-rt` does not have the problem).
- **The fork's `PreviousFrameGeometry` crashes on the first frame when nothing renders the pre-pass before it**
  (SMAA pipelines). Worked around by using TRAA.
- **The fork's SSR temporal chain is biased on high-variance reflections** (E2).
- **Wall-clock benchmarks here are unreliable** (±3× on a shared desktop), and GPU timestamps give no per-pass
  breakdown on Apple GPUs.

## Next steps

- **The rest of the frame.** With Hi-Z the SSR trace is ~10 ms at half resolution, and the 5–7 ms floor is three scene
  renders (pre-pass, back-face depth, scene pass) plus TRAA and the filter passes. Next levers:
  - Render the back-face pass only for SSR-relevant geometry, or at lower resolution with a conservative fallback.
  - Hi-Z with a max-depth / thickness layer, so rays passing behind geometry can also skip; they currently crawl
    texel by texel, which is what the 96-iteration budget pays for.
  - Gate tracing by roughness (FidelityFX-style tile classification).
- **The steampunk plateau.** Try tonemapped-space clipping, re-weighting neighbour rays by this pixel's BRDF in the
  spatial resolve (Stachowiak's full ratio estimator), and a full-resolution trace on normal-mapped metals.
- **Dynamic-object trail.** Carry a decaying "dynamic" flag in the history (E6 residual).
- **History fix.** A wider spatial pass where `n` is small. It was not needed on these scenes (arrival ≈ rest), but
  fast motion or large disocclusions will need it.
- **TRAA.** Vendor `TRAANode.js` and add Catmull-Rom history sampling (measured: ~4.5 % blur after motion) and a
  filtered current-sample reconstruction (measured: 2.2/255 mean static flicker). `TRAA_TESTS.md` has the harness to
  measure both fixes.
