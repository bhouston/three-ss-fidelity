# SSGI work reduction experiments

These experiments test whether `three-new` can reduce SSGI work while retaining the quality of `hierarchy-combined`. They leave the existing pipelines and scene presets unchanged. Early termination and repeated-texel geometry reuse produced identical decoded RGB8 images in the tested scenes and motion captures. Reducing sample counts changes the result, with strongly scene-dependent quality differences. A speed benefit has not been established: background work interfered with timing, and the second timing run was stopped after the user confirmed that load.

The work is tracked in [issue 105](https://github.com/bhouston/three-ss-fidelity/issues/105). The numerical record is in [history/ssgi-work](history/ssgi-work/). Captures, difference images, source snapshots, and child-process logs remain in `.output/ssgi-work/` in the experiment worktree. PSNR changes are review signals; the 0.1 dB allowance is advisory, not a hard acceptance criterion.

## Experiments and settings

All new experiments inherit combined radiance mips, shared full-resolution radiance, and tight SSR Hi-Z. SSR, material lighting, GI intensity, temporal filtering, and image encoding remain at their control settings.

| Experiment                                                      | Change                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ssgi-early-exit`                                               | Stop a direction's sampling loop only when both the AO and GI sector masks are full. Either mask alone is insufficient.                                                              |
| `ssgi-reuse-texels`                                             | Reuse view-space position and lazily fetched lighting normal for consecutive visits to the same snapped depth texel. Preserve every gap, horizon, and previous-surface state update. |
| `ssgi-redundant-work`                                           | Enable both work optimizations.                                                                                                                                                      |
| `ssgi-4x32`, `ssgi-8x16`, `ssgi-4x16`, `ssgi-2x16`, `ssgi-2x8`  | Sweep large reductions in slices, steps, or both.                                                                                                                                    |
| `ssgi-6x32`, `ssgi-8x24`, `ssgi-6x24`, `ssgi-7x32`, `ssgi-8x28` | Sweep smaller reductions to explore the quality tradeoff.                                                                                                                            |

The budget names describe the indoor 8-slice/32-step preset. Implementation scales each scene's own preset, floors each count, and clamps it to at least one. Both sampling directions always run. Thus `ssgi-6x32` gives 6×32×2 visits on SSGI-basic but 1×8×2 on the open-room diagnostic, whose control is 2×8×2. The diagnostic therefore tests a much larger proportional slice reduction. This quantization must be considered before choosing a global profile.

Skipping a whole repeated-texel step was deliberately avoided. A back-facing sample can leave the previous-surface state unchanged on its first visit and change it on a second visit after the sector masks have changed. Geometry reuse preserves that behavior. It also preserves each step's radiance mip selection.

Early termination is conservative and may rarely trigger. Geometry reuse adds comparisons, branches, and live shader values. Both can preserve an image yet fail to improve speed; image equivalence is not evidence of reduced elapsed time.

## Quality measurement

Static captures use 128 frames, native scene dimensions, fresh seeded GPU processes, and the existing path-traced references. Images use the repository's AVIF quality 90, 4:4:4 encoding and are compared as decoded sRGB RGB8. Each stage repeats the unchanged combined control; its decoded images were identical in the completed captures. This makes the observed differences distinguishable from control variation in these runs. It does not prove equality of HDR values or universal quality preservation.

Positive PSNR loss means a candidate scored below the freshly captured combined control against the path-traced reference. Negative values mean a better reference score. Scores across different scenes should not be averaged to hide a local regression.

### SSGI basic sample sweep

The 128-frame combined control scores 27.6800 dB against the reference. All three redundant-work variants match its decoded pixels exactly.

| Slices × steps × directions | Maximum loop visits per pixel | Reference PSNR loss at 128 frames |
| --------------------------- | ----------------------------: | --------------------------------: |
| 8×32×2 control              |                           512 |                         0.0000 dB |
| 7×32×2                      |                           448 |                         0.0756 dB |
| 8×28×2                      |                           448 |                         0.0463 dB |
| 6×32×2                      |                           384 |                         0.2109 dB |
| 8×24×2                      |                           384 |                         0.1584 dB |
| 6×24×2                      |                           288 |                         0.4392 dB |
| 4×32×2                      |                           256 |                         0.7947 dB |
| 8×16×2                      |                           256 |                         1.1146 dB |
| 4×16×2                      |                           128 |                         2.0822 dB |
| 2×16×2                      |                            64 |                         4.0824 dB |
| 2×8×2                       |                            32 |                         7.1569 dB |

Actual work can be lower because sampling exits at the image edge and radiance/normal gathers are conditional. Halving the maximum visits is not a prediction of halving total frame time.

The representative comparison shows changes in indirect brightness, especially on the floor, boxes, and ceiling; the smallest budget visibly darkens the image. A lower reference score is therefore not merely additional invisible noise. The higher-count alternatives preserve much more of the control image. See [the sample comparison](history/ssgi-work/basic-comparison.webp).

### Scene dependence

| Scene                   | 4×32 profile loss | 8×16 profile loss | 6×32 profile loss | 8×24 profile loss |
| ----------------------- | ----------------: | ----------------: | ----------------: | ----------------: |
| SSGI basic              |            0.7947 |            1.1146 |            0.2109 |            0.1584 |
| SSGI rounded            |            0.0290 |            0.4899 |           -0.0939 |           -0.0223 |
| SSGI metallic           |            0.1211 |            0.0917 |           -0.0321 |           -0.0858 |
| Dense emitter corner    |            0.0269 |            0.0872 |            0.0077 |            0.0322 |
| Hierarchy discontinuity |            0.0561 |            0.1066 |            0.0174 |            0.0089 |
| Open high albedo room   |            1.2657 |            1.0461 |            1.2657 |            0.1611 |

Values are dB losses against each scene's own control. The open-room control uses 2 slices and 8 steps; the profile scaling described above explains why its 4×32 and 6×32 rows are identical. All three redundant-work variants match the decoded control exactly across these six scenes.

The smaller-budget follow-up shows why count rounding matters:

| Scene                   | 7×32 profile loss | 8×28 profile loss |
| ----------------------- | ----------------: | ----------------: |
| SSGI basic              |            0.0756 |            0.0463 |
| SSGI rounded            |           -0.0526 |           -0.0108 |
| SSGI metallic           |           -0.0197 |           -0.0297 |
| Dense emitter corner    |            0.0056 |            0.0139 |
| Hierarchy discontinuity |            0.0073 |           -0.0010 |
| Open high albedo room   |            1.2657 |            0.0389 |

The 8×28 profile is the strongest conservative quality candidate in this matrix. It retains all slices and cuts the indoor step budget by 12.5%. The 7×32 profile loses a whole slice in the two-slice diagnostic because counts are floored, so it cannot be assumed to be a small global reduction.

### Motion resolution and convergence

A 20° camera move over 16 frames was captured at arrival and after 4, 16, and 64 settled frames on SSGI-basic and the thin-occluder/striped-emitter diagnostic. All three redundant-work variants matched the controls in every capture. Reduced budgets still differed after settling; the recorded comparisons are image differences from the moving control, not independent motion-reference quality measurements. Still images alone cannot establish an absence of temporal flicker. A separate 8×28 follow-up measures 45.10–45.26 dB against the moving control on SSGI-basic and 54.90–55.69 dB on the discontinuity scene. Visual inspection of the arrival and 64-frame captures found no obvious new trails or color bleeding; amplified differences still reveal changes on receiver surfaces. See [the motion comparison](history/ssgi-work/finalist-motion.webp).

At the live lab's 960×540 dimensions, geometry reuse also matched the control exactly after 128 frames. Reduced-count captures were compared to the combined pipeline at those dimensions, because the committed path-traced reference has different dimensions. They do not supply a new reference-quality score. The 8×28 follow-up scores 46.40 dB against the combined control at 960×540.

At 512 frames on SSGI-basic, the combined control scores 27.8936 dB. The 4×32 candidate scores 27.5367 dB, a 0.3570 dB loss; 8×16 scores 27.2482 dB, a 0.6454 dB loss. More frames improve convergence but do not erase the quality difference in this test. Rendering more frames also consumes work, so settled quality must be compared at both equal frame counts and practical time budgets once timing is available.

## Speed assessment pending

The initial timing sweep used native Dawn/Metal, 960×540, 60 warmup frames, 60 measured frames in completed batches of 20, three repetitions, alternating variant order, and repeated controls. Control means ranged from 32.845 to 54.125 ms/frame, a 1.648× range. Its raw results are retained as observations affected by load. Sweep-wide ratios are not accepted speed claims.

In the first repetition, geometry reuse measured 32.654 ms/frame versus the preceding 32.845 ms control; early exit measured 33.094 ms. These small differences do not establish an improvement. Large budget reductions were faster in the loaded sweep, but their exact speed benefit is unresolved.

A second run bracketed each candidate with control measurements and paused this agent's other work. It was stopped when the user confirmed interfering background tasks. Its partial traces are also excluded from speed conclusions. No default has been changed on the basis of either run. A future timing session must run with other CPU/GPU-heavy work paused and include matched controls for each candidate.

Live GPU pass intervals overlap on this Apple backend and are not an exclusive shader-time budget. The experiment runner uses GPU-completed batch wall time for speed; it does not rank candidates by the sum of pass timestamps.

## Literature and interpretation

[Therrien, Levesque, and Gilet, Screen Space Indirect Lighting with Visibility Bitmask](https://arxiv.org/html/2301.11376v2), especially sections 3 and 4, is the closest match to the estimator. Its bitmask prevents subsequent samples from contributing to sectors already claimed. The paper's AO benchmarks use one temporally jittered slice and include 8–16 samples per side, while explicitly warning that sparse sampling can miss thin occluders. Those results motivate testing smaller budgets; they do not establish an appropriate budget for our multi-bounce lighting, gap reconstruction, and temporal filters. The two-mask early-exit condition is derived from this implementation, not claimed as a published optimization.

[Mara et al., Deep G-Buffers for Stable Global Illumination Approximation](https://casual-effects.com/research/Mara2016DeepGBuffer/Mara2016DeepGBuffer-extended-small.pdf), sections 3.4–3.5, shows that sample placement must be designed for the count and that mip level, temporal filtering, and reconstruction affect the quality/performance tradeoff. Its layered geometry and spiral estimator differ from ours. My inference is that improving temporal/angular sample coverage is a better next direction than assuming a count reduction only adds removable noise.

The earlier repository research also references [McGuire and Mara, Efficient GPU Screen-Space Ray Tracing](https://jcgt.org/published/0003/04/04/paper.pdf), whose perspective-correct traversal addresses oversampling in screen-space rays. This experiment does not replace the SSGI horizon gather with that ray tracer. Radiance mips alone still cannot prove that a region's geometry is irrelevant.

## Reproduction and next decisions

Build first; do not rebuild Three.js while capture children are importing its generated modules. The runner keeps a source snapshot and refuses to resume an output directory whose sources changed. Each GPU job runs in a fresh process, with its input receipt and logs retained. A failed GPU job fails the runner; exceeding the PSNR review allowance does not.

```sh
pnpm build
# All opt-in work and sample experiments, compared with the combined control:
node scripts/ssgi-work-experiments.mjs --out .output/ssgi-work/new-sweep
# Representative additional scenes:
node scripts/ssgi-work-experiments.mjs --out .output/ssgi-work/new-scenes \
  --scenes ssgi-rounded,ssgi-metallic,gi-emitter-corner-dense,gi-hierarchy-discontinuity,gi-room-open-high-albedo \
  --variants ssgi-early-exit,ssgi-reuse-texels,ssgi-redundant-work,ssgi-4x32,ssgi-6x32,ssgi-8x24
# Motion, live-lab dimensions, and extra convergence:
node scripts/ssgi-work-experiments.mjs --mode motion --out .output/ssgi-work/new-motion \
  --scenes ssgi-basic,gi-hierarchy-discontinuity --variants ssgi-redundant-work,ssgi-4x32,ssgi-6x32,ssgi-8x24
node scripts/ssgi-work-experiments.mjs --mode resolution --out .output/ssgi-work/new-resolution \
  --variants ssgi-reuse-texels,ssgi-4x32,ssgi-6x32,ssgi-8x24 --width 960 --height 540
node scripts/ssgi-work-experiments.mjs --out .output/ssgi-work/new-convergence \
  --variants ssgi-4x32,ssgi-8x16 --frames 512
# Run only during a quiet window, with builds, tests, captures, and other heavy work paused:
node scripts/ssgi-work-experiments.mjs --mode timing --out .output/ssgi-work/idle-timing \
  --variants ssgi-early-exit,ssgi-reuse-texels,ssgi-redundant-work,ssgi-4x32,ssgi-6x32,ssgi-8x24,ssgi-7x32,ssgi-8x28
```

For live inspection, choose `three-new` and one of the new names in the Experiment selector. For a single capture, use a full renderer name such as `pnpm cli render --renderers three-new-ssgi-6x32 --scenes ssgi-basic --output .output/ssgi-inspection`. The existing general hierarchy runner retains its earlier default experiment set; it accepts the new work profiles only when explicitly selected.

Keep the redundant-work candidates opt-in until idle timing establishes whether their branches and caches help. Keep the sample-count variants as quality/performance options for comparison rather than adopting a global reduced preset. Prioritize 8×28 for idle timing; its largest reference PSNR loss in the six-scene matrix is 0.0463 dB. The 7×32 variant remains an indoor-specific comparison because count rounding produces a larger change in low-budget scenes. Speed and temporal behavior must govern adoption.

## Validation

`pnpm build`, `pnpm tsc`, `pnpm lint`, and `pnpm test --coverage` completed. All 121 unit tests passed. Lint reports the nine existing shader warnings. Five browser tests were exercised on a separate Vite server at port 5174: four passed initially, including the new experiment test; the existing report-preview test timed out once and passed unchanged on an isolated rerun. The failure trace and logs are retained locally.

`pnpm audit --audit-level=high` reports three existing high advisories in the path tracer's Puppeteer dependencies: two for `extract-zip` and one for `basic-ftp`. Dependencies were not changed by these experiments.

One motion child failed while a concurrent Three.js rebuild temporarily replaced its generated modules. The failed import log was retained, and the capture was retried after the build completed. All recorded final motion images were successfully rendered. Future reproduction commands should finish building before starting GPU children.
