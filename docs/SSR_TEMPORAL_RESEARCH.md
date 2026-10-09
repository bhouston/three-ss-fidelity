# GGX reflections and temporal reconstruction: research and implementation choices

Research reviewed October 1, 2026. Implementation work: [issue #111](https://github.com/bhouston/three-fidelity/issues/111).

The goal is to keep `three-new`'s more accurate converged reflections while improving its appearance during camera and object movement. The steampunk camera is the motivating example: users report visible dynamic noise in `three-new`, while `three-current` appears substantially cleaner during movement. That observation does not establish that TRAA is broken. Stochastic reflection sampling, reflection-history reconstruction, and final-image antialiasing must be evaluated separately.

This document records the literature behind our choices, the connection to the actual implementation, and the experiments we are pursuing. Papers describe algorithms; maintained SDK documentation and source provide additional implementation guidance. An adaptation is explicitly identified as an adaptation, rather than represented as a faithful port or a proven improvement.

For the complete TRAA, SSR, SSGI and AO inventory and upstream change map, see
[Screen-space algorithm reference](SCREEN_SPACE_ALGORITHMS.md).

## Why preserve the new reflection model?

`three-current` uses three.js r186's SSR node with its default non-stochastic mode. It traces a mirror direction and approximates roughness with a blurred reflection texture. `three-new` samples directions from the GGX visible-normal distribution and estimates reflected radiance over the material's specular lobe. The latter better represents rough materials' directional reflection response, at the cost of sampling variance.

Higher PSNR against a path-traced reference means closer agreement for the tested image. It supports keeping the new model where the measurements show an advantage, but does not establish that every scene improves or that temporal stability is better. Converged-image accuracy and quality during movement are separate requirements.

The rendering and earlier measurements are described in [THREE-NEW.md](THREE-NEW.md), [SSR improvement history](history/SSR_IMPROVEMENTS.md), and [SSR temporal history](history/SSR_TEMPORAL.md). Some historical logs use renderer names that have since been consolidated. Their numbers describe those configurations, not automatically the current implementation.

| Aspect                      | `three-current`                                      | `three-new`                                                | Reason for the new choice                                                                 |
| --------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Rough reflection directions | Default mirror-direction tracing with roughness blur | Stochastic GGX visible-normal sampling                     | Integrate directional reflectance rather than approximate it solely with image-space blur |
| Lighting composition        | Additive SSR over the rendered scene                 | Reflection radiance supplied to material lighting          | Let material shading apply the reflection response                                        |
| Material coverage           | Stock SSR defaults                                   | Metals and dielectrics                                     | Dielectrics also have specular reflection                                                 |
| Hit information             | Scene-pass depth and normal                          | Separate pre-pass, material/specular data, back-face depth | Improve hit tests and evaluate hit specular for the reflected direction                   |
| Radiance source             | Scene-pass color                                     | Reprojected previous anti-aliased radiance                 | Support feedback and indirect lighting; introduces temporal dependencies to validate      |
| Reflection filtering        | Default non-stochastic roughness blur                | Dedicated spatial and temporal reflection filter           | Low-sample stochastic rays need reconstruction before final TRAA                          |
| Antialiasing                | TRAA                                                 | TRAA with optional progressive still-view accumulation     | Antialias the final image and integrate samples while still                               |

These are implementation differences and intended benefits. They are not an assertion that every difference independently improves PSNR. Screen-space visibility remains incomplete: off-screen surfaces and hidden geometry cannot be recovered merely by changing the GGX sampler.

## Sources and their implementation relevance

### Stochastic SSR and ratio reconstruction: Stachowiak, 2015

Tomasz Stachowiak's [Stochastic Screen-Space Reflections](https://h3.gd/stochastic-ssr/), presented at SIGGRAPH 2015 with Yasin Uludag's collaboration, is the foundational reference for stochastic SSR and the ratio-estimator reconstruction used here.

Our spatial resolve accumulates weighted radiance numerators and denominators from the center ray and neighboring rays, then divides the sums. It also applies plane-distance, normal, and roughness compatibility weights. This is an adaptation of the reconstruction approach, not an exact reproduction of the whole Frostbite implementation. A finite-sample ratio estimator and its spatial reuse should not be described as universally unbiased.

Implementation: [`NewSSRNode.js`](../packages/renderers/src/ssr/NewSSRNode.js), `_setupTemporalFilter()` spatial resolve. Source comments identify the reference there.

### GGX visible-normal sampling: Heitz, 2018; Dupuy and Benyoub, 2023

Eric Heitz's [Sampling the GGX Distribution of Visible Normals](https://jcgt.org/published/0007/04/01/) provides the visible-normal sampling foundation. Jonathan Dupuy and Anis Benyoub's [Sampling Visible GGX Normals with Spherical Caps](https://arxiv.org/abs/2306.05044), HPG 2023, gives a simpler, faster way to sample the same distribution. Its contribution is sampling efficiency, not a temporal denoising algorithm.

Our fork's [`SpecularHelpers.js`](../submodules/three.js/examples/jsm/tsl/utils/SpecularHelpers.js) already uses the spherical-cap formulation. Replacing it with the same paper's method would not be a new improvement.

### Bounded GGX sampling: Eto and Tokuyoshi, 2023

Kenta Eto and Yusuke Tokuyoshi's [Bounded VNDF Sampling for Smith–GGX Reflections](https://gpuopen.com/download/Bounded_VNDF_Sampling_for_Smith-GGX_Reflections.pdf), SIGGRAPH Asia 2023 Technical Communications, reduces rejected below-surface reflection samples by restricting the sampling range and adjusting the probability density.

This is already implemented in `SpecularHelpers.js`, including the corresponding PDF and sample weights. Preserve that relationship. Arbitrarily shrinking the roughness lobe without correcting the estimator would change the reflection model rather than simply denoise it.

### Reflection reconstruction reference: AMD FidelityFX SSSR and Denoiser

AMD's maintained [SSSR documentation](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/stochastic-screen-space-reflections/) and [Reflection Denoiser documentation](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/denoiser/#amd-fidelityfx-reflection-denoiser) are the closest practical references for our workload.

The reflection denoiser performs reprojection/disocclusion handling, variance-guided spatial filtering, and temporal accumulation. Its edge reprojection path reconstructs history from a 2x2 interpolation neighborhood. The temporal pass uses 9x9 Gaussian neighborhood statistics for clipping and blends according to sample count.

Our experimental adaptations are:

- **Validated history reconstruction:** check each of four interpolation taps against geometry and history occupancy before mixing their colors. Normalize RGB by valid bilinear coverage so background or incompatible surfaces do not contaminate history.
- **Coverage confidence:** retain the coverage-weighted history count, reducing accumulation where only part of the footprint supports valid history. This is our heuristic, not AMD's exact confidence formula.
- **Gaussian clipping statistics:** compare the existing uniform 3x3 neighborhood with a 9x9 Gaussian footprint in YCoCg. Sigma is two pixels, an experimental choice made here; it is not presented as an AMD-prescribed setting.

Neither adaptation changes the GGX rays, spatial resolve radius, reflection history caps, or final TRAA weighting. The `gaussian` profile includes the validated reconstruction, so its difference from `validated` isolates the added neighborhood change.

A wider neighborhood might stabilize a noisy local estimate but also admit history across real changes or soften features. Its extra texture reads have a cost. Measurements must determine whether the tradeoff is useful.

### History confidence and specular reconstruction: NVIDIA NRD / REBLUR

[NVIDIA Real-Time Denoisers](https://github.com/NVIDIA-RTX/NRD) provide maintained implementation guidance for dedicated specular reconstruction using geometry, roughness, hit distance, and history confidence. These denoisers target ray-traced signals; applying their ideas to SSR requires accounting for screen-space hit/miss changes.

Our existing filter already compares surface-motion and virtual-point reprojection. Sharp reflected features move differently from the reflecting surface; increasing the history length cannot compensate for sampling the wrong previous pixel.

[NRD's history-confidence guidance](https://github.com/NVIDIA-RTX/NRD#history-confidence) proposes comparing stored lighting with lighting recomputed using the previous RNG seed. Matching random samples helps distinguish actual lighting changes from sampling noise. That is a stronger concept than treating every noisy frame difference as evidence that history is stale.

The current experiment only computes interpolation-coverage confidence. It does **not** implement NRD's same-seed lighting-gradient confidence, curvature-aware specular tracking, or its full denoising pipeline. These remain possible follow-up work. NRD also recommends initially disabling anti-lag during integration; that motivates auditing history rejection before adding more responsiveness heuristics.

Virtual history is validated against normal compatibility, occupied geometry, and populated history. It does not use the surface path's distance-to-original-world-point test: applying that test at a different virtual UV would reject valid reflection parallax. More complete virtual-history validation is still an open question.

### Noise distribution: Wolfe et al., 2022

Alan Wolfe, Nathan Morrical, Tomas Akenine-Möller, and Ravi Ramamoorthi's [Spatiotemporal Blue Noise Masks](https://research.nvidia.com/publication/2022-07_spatiotemporal-blue-noise-masks), EGSR 2022, provides sampling patterns designed for spatial noise quality and temporal filtering. Usable masks and generation code are available from the authors.

Our primary reflection samples currently use a four-dimensional low-discrepancy sequence with per-pixel/per-dimension hash rotations. That is not equivalent to an STBN mask. An equal-ray-budget comparison is a reasonable future experiment. A faster sampler or different noise spectrum is not automatically a solution to incorrect reprojection, and benefits under camera motion need direct measurement.

STBN has not been added in this change.

### Final TRAA: Yang, Liu and Salvi, 2020

Lei Yang, Shiqiu Liu, and Marco Salvi's [A Survey of Temporal Antialiasing Techniques](https://research.nvidia.com/labs/rtr/publication/yang2020survey/), Computer Graphics Forum 2020, organizes TAA around sample accumulation and history validation and reviews reconstruction limitations.

Our final TRAA has a 5% minimum current-frame weight in its ordinary moving-average mode. Motion increases that contribution; subpixel correction can add up to 25 percentage points. Variance clipping tightens under motion. Consequently, lowering the explicit blend weight alone may not retain more useful history: clipping can move that history toward the noisy current neighborhood before blending.

The fork has a progressive mode for a still view. It does not provide equivalent progressive averaging during movement. That difference can make settled screenshots look good while interactive movement remains visibly noisy.

We will evaluate final TRAA weighting and reconstruction after isolating the SSR filter. Potential experiments include subpixel correction, motion-dependent clipping, current-sample reconstruction, and sharper history resampling. Preserve disocclusion rejection: newly visible regions need fresh data.

The existing [TRAA diagnostics](history/TRAA_TESTS.md) identify bilinear-history blur and residual jitter shimmer. They are historical evidence for specific configurations, not proof that the present moving steampunk case is correct. Static convergence alone cannot prove that motion vectors and jitter handling are correct during movement.

## Experiment profiles and reproducibility

`RendererOptions.ssrTemporalProfile` selects a compile-time experiment for `three-new`:

| Profile              | History reconstruction                                  | Clipping statistics |
| -------------------- | ------------------------------------------------------- | ------------------- |
| `baseline` (default) | Existing bilinear history and validity checks           | Uniform 3x3         |
| `validated`          | Per-tap validation and coverage-weighted history length | Uniform 3x3         |
| `gaussian`           | Same as `validated`                                     | Gaussian 9x9        |

The default remains `baseline`. The live viewer exposes `ssr-temporal-validated` and `ssr-temporal-gaussian` in its experiment selector; these select the corresponding temporal profiles with the baseline tracing and radiance settings. The fidelity-kit viewer exposes matching renderers alongside `three-new`. Native-resolution beauty captures for all suite scenes use 128 frames, matching the suite's settled-capture protocol. They show settled appearance, not continuous-motion stability.

Regenerate the viewer captures with:

```sh
# Fill all missing renderer/profile outputs (including these two profiles):
pnpm cli render --missing-only

# Fill only the temporal profiles, using the recorded 128-frame protocol:
pnpm cli render --missing-only --renderers 'three-new-ssr-temporal-*' --frames 128
pnpm fidelity:dev
```

For movement diagnostics use the runner below, or select the same experiment in `pnpm live` and orbit the scene.

Build first, then run:

```sh
pnpm build
node scripts/ssr-temporal-experiments.mjs

# Quick diagnostic sweep:
node scripts/ssr-temporal-experiments.mjs \
  --scenes diag-rough-30 --warmup 16 --move-frames 20

# Moving reflected object, with the camera held still:
node scripts/ssr-temporal-experiments.mjs \
  --scenes diag-rough-30 --ghost --out .output/ssr-temporal-ghost
```

`--scale 0.25` can shorten a preliminary sweep. It resizes the committed reference, so those scores include a pixel-filter/resampling mismatch and must not be treated as native-resolution accuracy gates.

The runner starts a fresh process per scene/profile, uses a fixed seed and explicit frame advancement, warms history, follows the same orbit or object path, and writes lossless PNGs. It saves consecutive frames during the last part of movement and during settled rendering, plus selected recovery frames. Each profile includes a contact strip ordered as frames -16, -8, -1, 0, 16, 128 relative to stopping.

`report.json` records PSNR and brightness bias against the committed path-traced reference at the matching final pose, settled temporal standard deviation, and render-plus-GPU-completion timing. Reference captures are AVIF, so their encoding remains part of the accuracy measurement. Timing excludes cold compilation and capture readback but is not a GPU timestamp profile.

Movement captures are visual diagnostics. Raw differences between consecutive moving frames are **not** reported as noise: legitimate scene movement changes pixels. Measuring in-motion noise requires pose-matched references or motion-aligned residuals. Whole-image settled standard deviation also does not isolate reflection pixels or fully measure localized ghosting.

## Initial measurements: October 1, 2026

These are exploratory single-run measurements, with seed 1, 16 warmup frames, 20 movement frames, and 128 recovery frames. Arrival is the first capture at the final pose. Settled standard deviation uses frames 112–128 and reports the whole-image mean in 0–255 channel units. Lower deviation is better; higher PSNR is better.

| Case                                                        | Profile   | Arrival PSNR (dB) | Frame 128 PSNR (dB) | Mean settled deviation |
| ----------------------------------------------------------- | --------- | ----------------: | ------------------: | ---------------------: |
| Roughness 0.3, camera orbit, native 480×360                 | baseline  |            36.577 |              37.109 |                0.01590 |
| Same                                                        | validated |            36.560 |              37.111 |                0.01586 |
| Same                                                        | gaussian  |            36.488 |              37.177 |                0.01562 |
| Steampunk, camera orbit, quarter scale 160×120              | baseline  |            21.397 |              22.602 |                0.27864 |
| Same                                                        | validated |            21.366 |              22.599 |                0.27880 |
| Same                                                        | gaussian  |            21.692 |              22.872 |                0.28693 |
| Roughness 0.3, moving reflected object, third scale 160×120 | baseline  |            35.161 |              38.085 |                0.01927 |
| Same                                                        | gaussian  |            34.715 |              38.077 |                0.02029 |

Raw measurements: [native roughness case](history/ssr-temporal/rough30-native.json), [quarter-scale steampunk](history/ssr-temporal/steampunk-quarter.json), and [third-scale moving object](history/ssr-temporal/moving-object-third.json). The latter moves `sphere-green` by 1.5 world units while holding the camera still. Camera-orbit cases start 20 degrees from the reference pose and move to it.

Per-tap validation makes little difference in these cases. The Gaussian profile gains 0.270 dB settled PSNR on quarter-scale steampunk, but its mean settled fluctuation increases about 3%, its 95th-percentile fluctuation increases about 7%, and its brightness bias grows from +0.0060 to +0.0222 on normalized channels. The moving-object case loses 0.446 dB on arrival before mostly recovering. The native roughness case shows a small settled improvement but slightly worse arrival accuracy.

These results support keeping **baseline as the default**. They do not demonstrate that Gaussian statistics fix movement noise, or establish whether final TRAA is broken. Higher PSNR alone is insufficient: the steampunk result illustrates that accuracy, brightness bias, and temporal stability can move in different directions. Reduced-resolution reference resampling, single repetitions, and whole-image metrics limit these conclusions. Timing was collected on a shared device and is diagnostic only; no performance claim is made.

The next useful work is native-resolution steampunk measurement, repeated baselines, reflection-region masks, and pose-matched or motion-aligned noise metrics. Compare `three-current` under the same movement protocol before attributing the difference solely to TRAA. Then vary final TRAA clipping and subpixel current weighting independently of the reflection filter.

## Acceptance criteria and next decisions

Preserve the baseline until an experiment demonstrates useful improvement. Evaluate:

1. **Accuracy:** arrival, recovery, and settled PSNR against matching reference poses; brightness bias as a separate measurement.
2. **Temporal stability:** continuous-motion visual inspection and, when available, aligned residual noise measurements.
3. **Responsiveness:** moving reflected objects and newly exposed surfaces must not leave persistent trails.
4. **Detail:** inspect reflection edges and fine features; lower noise achieved solely by excessive blur is insufficient.
5. **Cost:** profile the reflection filter independently at representative resolutions, including 1080p.
6. **Robustness:** repeat the baseline, test mirrors/rough surfaces, screen boundaries, grazing angles, and camera cuts/resizes.

If per-tap validation regresses stability, inspect rejected-history coverage rather than compensating blindly with longer history. If Gaussian statistics improve noise but hurt sharpness or moving-object response, retain the experiment for comparison and refine validation. If noise survives a well-aligned reflection filter, investigate final TRAA's current weighting and clipping separately.

This work aims to reuse published reconstruction methods while preserving the new reflection model. The experiments establish which adaptations help this particular pipeline; they are not an attempt to invent a denoiser from scratch.
