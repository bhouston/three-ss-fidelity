# Indoor SSGI energy investigation

**Follow-up:** [Angular-weighting experiments](GI-ESTIMATOR-FOLLOWUP.md) identify a missing solid-angle factor and substantially reduce the original Cornell error. The report below records the initial investigation before that correction.

Investigation of issue #9, September 25, 2026. The existing Cornell rooms have much darker SSGI beauty passes than the path tracer, despite close direct-pass agreement. Dogwood's exposed ground and sunlit surfaces agree more closely.

The key result is that the original animated Cornell discrepancy survives removing the off-screen parts of its room planes: RMSE changes only from 0.1646 to 0.1623. Multi-bounce feedback and linear HDR intermediates are already present. A fully visible emitter is also strongly underestimated, so a probe fallback is useful future work but is not established as the main fix for the current indoor results.

## What the implementation actually does

`packages/renderers/src/three-ss.ts` passes the previous anti-aliased **beauty** radiance to SSGI, then injects the resulting irradiance into the next scene pass. This already implements iterative multi-bounce feedback. The scene/AA feedback, temporal reprojection and denoised GI textures are FP16. Raw GI uses unsigned R11G11B10 floating-point HDR (not 8-bit RGB), while AO is 8-bit. SSGI also has an explicit GI luminance cap of 7; the emitting controls use radiance 0.5, below the range where that cap can explain their loss. The feedback texture is linear HDR: `RenderPipeline` applies tone mapping and output encoding after the scene/AA passes. Rendering more frames is not equivalent to making the screen-space visibility representation more complete.

The local `builtinGIContext` explicitly cancels AO on added GI, preventing AO from darkening that diffuse GI a second time. The local SSGI shader also already replaces the extra emitter cosine with a front-face test. Both protections are present in the current code; simply adding them again is not a fix for the remaining deficit.

`SSGINode` uses the single visible depth layer, with a fixed thickness behind each sample. It counts the newly covered angular sectors and adds their sampled radiance, weighted by receiver cosine. Screen-edge exits, unsampled geometry and unrepresented directions cannot contribute light. A screen-space radius is a projected sampling footprint, not the nominal world-space radius. Increasing frames averages this estimator; it does not remove its visibility or integration bias.

Conceptually, feedback iterates `L_next = direct + K_screen × L_previous`. Extra frames converge this approximate screen-space transport operator; they cannot restore missing entries or correct underestimated weights in that operator.

The rooms start with 2 slices / 8 steps, screen-space sampling, radius 12, thickness 1, GI intensity π²/2, and 128 frames. Their mostly white surfaces make repeated transport important. They have no environment map and use no tone mapping. Dogwood has sun plus an HDR environment and ACES tone mapping, and uses world-space sampling. Its exposed surfaces receive substantial illumination without needing surface-to-surface GI. Additionally, its raster direct pass uses unoccluded environment lighting, whereas the path tracer traces environment visibility; AO in beauty compensates for part of that difference. Thus cross-scene beauty RMSE is not a pure GI-quality ranking.

## Controlled scenes

The nine `gi-*` scenes are asset-free, use linear RGB albedos, no ambient light or environment, no SSR, no tone mapping, and full-resolution SSGI. Results are 480×360, 128 SSGI frames and 1024 path-tracer samples with the existing eight-bounce reference.

| Scene                                                 | Control / hypothesis                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gi-emitter-corner`                                   | One fully visible emissive wall, black diffuse albedo, and a gray receiver floor. Isolates one surface-to-surface light transfer.                     |
| `gi-emitter-corner-dense`                             | Same geometry, camera and materials; only slices/steps change from 2/8 to 8/32.                                                                       |
| `gi-emitter-corner-thick`                             | Same baseline; only assumed thickness changes from 1 to 4.                                                                                            |
| `gi-emitter-enclosure-wide`                           | Five equal-radiance emitting walls surrounding a gray floor; wide view shows some emitters.                                                           |
| `gi-emitter-enclosure-crop`                           | Identical world and camera pose, but narrow FOV contains only the floor. Isolates off-screen illumination.                                            |
| `gi-room-low-albedo`                                  | Closed empty point-lit room with linear albedo 0.2.                                                                                                   |
| `gi-room-high-albedo`                                 | Same room and light, linear albedo 0.8; amplifies the role of repeated surface transport.                                                             |
| `gi-room-open-low-albedo`, `gi-room-open-high-albedo` | Corresponding rooms with the entirely off-screen front wall and ceiling physically removed. Camera, remaining surfaces and point light are unchanged. |

The emitter controls use IOR 1 to minimize specular contributions and black emitter albedo to prevent diffuse feedback from the receiver. The raster renderer uses Lambert diffuse and the path tracer uses Disney diffuse, so these are transport diagnostics, not pixel-exact BRDF equivalence tests. In the corner, there is no diffuse receiver→emitter→receiver chain: a large deficit cannot be attributed to missing higher diffuse bounces.

An emissive wall lighting the floor is physically direct area-light illumination. Here “one transfer” refers to gathering its radiance from the screen-space beauty buffer. The harness's `direct` pass does not gather emissive meshes in either renderer: its path-tracer shader stops at secondary surface hits before emission. Consequently, black floors in the emitter scenes' direct passes are expected and do not imply that physical emitters fail in beauty. Use the point-lit rooms to check ordinary direct lighting.

A tenth diagnostic, `ssgi-animated-visible-walls`, uses the original animated Cornell scene and physically clips only the five room planes to the camera frustum. The character, light, fixture, materials, camera and renderer settings are preserved. This removes the off-screen wall portions from secondary-ray transport while preserving interior primary-ray hits. It does not remove surfaces hidden behind the character or supply hidden geometry to SSGI. This is a direct control on the original reported discrepancy, unlike the more deliberately extreme closed-room tests.

## Measured results

Receiver measurements reverse sRGB encoding and average linear luminance over a 16×16 pixel patch centered on the projection of world position (0,0,0). They are not full-frame brightness averages. Wide/cropped views share the center ray; their patch footprints differ slightly. PNG quantization and path-tracing noise limit precision. The point-lit diagnostics also have a direct-pass baseline offset between renderers at the receiver, so beauty agreement alone can be misleading; the data records each renderer's `beauty - direct` increment separately. These differences are estimates of added transport for the no-environment/no-SSR diagnostic scenes, not a universal indirect-pass definition.

| Scene                       | SSGI beauty, linear | Path-traced beauty, linear | SSGI / reference |
| --------------------------- | ------------------: | -------------------------: | ---------------: |
| `gi-emitter-corner`         |             0.01257 |                    0.03875 |            32.4% |
| `gi-emitter-corner-dense`   |             0.01559 |                    0.03722 |            41.9% |
| `gi-emitter-corner-thick`   |             0.01345 |                    0.03713 |            36.2% |
| `gi-emitter-enclosure-wide` |             0.01422 |                    0.25670 |             5.5% |
| `gi-emitter-enclosure-crop` |             0.00000 |                    0.25268 |             0.0% |
| `gi-room-low-albedo`        |             0.03071 |                    0.03116 |            98.6% |
| `gi-room-high-albedo`       |             0.12467 |                    0.36335 |            34.3% |
| `gi-room-open-low-albedo`   |             0.03071 |                    0.02555 |           120.2% |
| `gi-room-open-high-albedo`  |             0.12467 |                    0.13230 |            94.2% |

The fully visible emitter delivers only about one third of the reference brightness at the floor center. More samples raise it to about 42%; greater thickness alone raises it to about 36%. Neither missing off-screen emitters nor missing higher diffuse bounces explain that control. This establishes underestimation of available surface transport, but does not uniquely identify a coding defect versus finite-radius/coverage/weighting/denoising bias.

The cropped enclosure goes completely black in SSGI while the path tracer stays near 0.25. That is the separate, fundamental off-screen limitation.

Removing the front wall and ceiling leaves each open-room SSGI beauty/direct image pixel-identical to its closed counterpart. In the high-albedo path-traced room, floor-center beauty falls from 0.36335 to 0.13230. Thus unseen walls dominate the discrepancy in this deliberately closed control. However, the open beauty match (94.2%) partly hides the raster direct-light baseline being brighter. Compare the added-light increments:

| Point-lit room             | SSGI beauty − direct | Path-traced beauty − direct |
| -------------------------- | -------------------: | --------------------------: |
| `gi-room-low-albedo`       |              0.00001 |                     0.00694 |
| `gi-room-high-albedo`      |              0.00265 |                     0.26812 |
| `gi-room-open-low-albedo`  |              0.00001 |                     0.00133 |
| `gi-room-open-high-albedo` |              0.00265 |                     0.03542 |

Even in the open high-albedo room, SSGI captures only about 7.5% of the reference increment at this patch. Low-albedo SSGI increments approach PNG quantization limits. Do not infer transport correctness from the open scene’s close total beauty alone. Full patch coordinates and direct values are in [gi-receiver-metrics.json](gi-receiver-metrics.json).

For an ideal Lambert receiver, the emitting enclosure gives outgoing radiance ρL = 0.5×0.5 = 0.25. For the corner's floor center, integrating the visible rectangular emitter gives irradiance

`E = L [atan(a/d) - d/sqrt(d²+h²) atan(a/sqrt(d²+h²))]`

with half-width `a=5`, height `h=6`, distance `d=5`, and emission `L=0.5`. Thus `E=0.2104245` and ideal outgoing radiance `ρE/π=0.0334901`. These are useful scale checks; they are not exact predictions of the path tracer's Disney diffuse BRDF or a finite pixel patch.

The open-room pair removes the entire off-screen ceiling and front wall, including their contribution to secondary rays. A grid of primary-ray tests verifies that the visible surfaces are unchanged. Parts of the remaining floor/side walls can still extend outside the image; the fully visible single-emitter corner is the stricter test for visible source transport. Removing unseen geometry tests a fundamental screen-space limitation; residual error in the open scene is not, by itself, proof of an implementation bug.

### Original animated Cornell room: off-screen walls are not the main cause

| Comparison                                     | Beauty RMSE | PSNR (dB) |
| ---------------------------------------------- | ----------: | --------: |
| Original SSGI versus original path tracer      |     0.16462 |     15.67 |
| Frustum-clipped walls: SSGI versus path tracer |     0.16233 |     15.79 |

Physically removing all off-screen portions of the five room planes reduces the renderer gap by only about **1.4% in display-RGB RMSE**. The SSGI image itself changes by only 0.000039 mean absolute RGB (the largest changes are at clipped image boundaries). The path-traced clipped room remains much brighter than SSGI.

This is strong evidence that off-screen room-plane illumination is not the main cause of the original `ssgi-animated` discrepancy in this view. It does **not** prove that all hidden geometry is irrelevant: the character and fixture are unchanged, and the single depth layer still cannot represent surfaces behind foreground objects. The separate fully visible emitter control establishes that there is also a large deficit without such an off-screen source or higher diffuse-bounce chain.

The closed synthetic room demonstrates a case where unseen walls really do dominate; it must not be used to diagnose the original Cornell view without this control. Reflection probes are appropriate for missing information, but adding them should not be treated as the established fix for the current original-room error. Next, isolate raw gathering versus temporal reconstruction and audit angular coverage/weighting and radiometric normalization against the visible-emitter and analytic controls.

Full geometry-removal comparisons are in [gi-visibility-comparisons.json](gi-visibility-comparisons.json). Reference-to-reference differences include sampling noise and image-edge clipping, so they are not an exact decomposition of physical indirect energy.

## Existing-room sensitivity experiment

The script creates a fresh scene and copies its effect settings for every variant. Overrides are independent, not cumulative. All metrics compare to the existing `ssgi-animated` beauty reference; RMSE uses the viewer's display-encoded RGB convention and must not be read as a fraction of missing physical energy.

| Variant                              | Beauty RMSE | PSNR (dB) |
| ------------------------------------ | ----------: | --------: |
| Baseline, 128 frames                 |     0.16462 |     15.67 |
| 512 frames                           |     0.16462 |     15.67 |
| 8 slices / 32 steps                  |     0.14462 |     16.80 |
| Thickness 4 (only)                   |     0.14698 |     16.65 |
| Double GI intensity (only)           |     0.14441 |     16.81 |
| World radius 25, 4 slices / 32 steps |     0.14237 |     16.93 |
| SSR disabled                         |     0.16559 |     15.62 |

Increasing frames from 128 to 512 changes mean absolute display RGB by only 0.000195 (about 0.05 of an 8-bit code value). It does not recover the missing room illumination. Independent changes to sample density, thickness, gain or radius modestly improve the error but leave a substantial deficit. Disabling SSR has little effect on the broad discrepancy. Full measurements and overrides are in [gi-sweep.json](gi-sweep.json).

No setting change is adopted globally. Larger thickness can incorrectly block thin geometry, a larger radius spreads a finite sample budget over a larger region, and higher gain can over-brighten or destabilize multi-bounce feedback. More slices/steps also cost more. Timings from the diagnostic script include shader warmup and readback and are not representative frame-time benchmarks.

## Interpretation and options

1. **Keep SSGI, improve and calibrate its estimator.** These scenes provide a small regression suite for coverage, cosine/solid-angle normalization, sampling radius, thickness, and camera dependence. Compare raw GI against denoised GI next to separate reconstruction bias from gathering bias. Validate any normalization change across multiple orientations and albedos, rather than matching one room with an intensity multiplier. Keep direct lighting fixed during this work.
2. **Use a world-space diffuse-light source with SSGI for local detail.** For mostly static architecture, bake indirect lightmaps and/or visibility-aware irradiance probes; animated objects can sample probes. Blend or replace overlapping contributions to avoid counting the same bounce twice. For dynamic lighting, investigate a probe/radiance cache updated using scene-space visibility. This addresses illumination that is outside the image and provides higher-bounce fill.
3. **Expand the visibility representation.** A guard band helps near image edges; multiple depth layers or additional views recover some hidden surfaces. They cost memory and rendering work, and do not provide complete scene-space GI by themselves.
4. **Trace the missing transport in scene space.** A BVH ray-traced GI fallback or a path-traced quality mode gives stronger correctness at higher implementation/runtime cost. A WebGPU implementation must choose a supported scene-traversal approach; desktop hardware-RT SDKs are not drop-in three.js solutions.

For this fidelity project, prioritize the controlled estimator tests before changing production defaults. For dependable indoor architectural lighting, the recommended architecture is world-space diffuse illumination plus SSGI detail. More feedback frames alone do not solve missing screen-space paths.

## Published methods and expectations

- [Therrien, Levesque and Gilet: Screen Space Indirect Lighting with Visibility Bitmask](https://arxiv.org/html/2301.11376v2), especially §§3.1 and 4.3: fixed thickness is an approximation, multi-bounce uses previous-frame injection, feedback gain must be balanced, and off-screen direct lighting cannot contribute. This is consistent with the design in the local fork, but is not evidence that every normalization or reconstruction choice in the fork is correct.
- [Mara et al.: Fast Global Illumination Approximations on Deep G-Buffers](https://casual-effects.com/research/Mara2014DeepGBuffer/index.html): additional layers improve robustness, while broad-scale/precomputed illumination fills undersampled regions; the method remains view dependent.
- [Majercik et al.: Dynamic Diffuse Global Illumination with Ray-Traced Irradiance Fields](https://research.nvidia.com/publication/2019-05_dynamic-diffuse-global-illumination-ray-traced-irradiance-fields): a world-space irradiance field with visibility-aware interpolation is a relevant architecture for off-screen diffuse illumination, with its own cost and approximation tradeoffs.

## Reflection probes as the practical next experiment

A room-local HDR cubemap is the most established next step for filling missing SSGI directions. Despite the name “reflection probe”, its directional radiance can also be integrated for diffuse illumination. Unity's documented SSGI-miss fallback is a direct precedent. Capture lighting in linear HDR, use local influence bounds (and possibly box projection), and avoid blending different rooms through walls.

A direct-lit capture provides the light that has left those surfaces after direct illumination; gathering it at another surface produces one surface-to-surface bounce. More bounces require an indirect bake or iterative probe updates. Six cubemap faces can be captured infrequently in a static room or amortized when lighting changes. A single probe still approximates spatial variation and visibility, so placement, doorway leakage and transitions require validation. Use directional probe radiance for unresolved SSGI contributions; adding a full diffuse probe term on top of full SSGI risks double counting.

Probe capture/fallback is tracked separately in [issue #11](https://github.com/bhouston/ss-fidelity/issues/11). No probe integration is implemented in this change. The open/closed and cropped-view scene pairs are intended to measure a future fallback against the current baseline.

## Could simple virtual walls fill screen-space misses?

This is a promising architecture-specific experiment, not implemented here. I found established related techniques, but not a verified published implementation of exactly a handful of manually specified constant-color planes as a drop-in extension to this visibility-bitmask SSGI node.

- [Unity HDRP 17 SSGI](https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/reference-screen-space-global-illumination.html) explicitly supports reflection-probe and sky fallback for screen-space ray misses. This validates the general practice of filling missing SSGI information from a separate lighting representation.
- [Lumen's Surface Cache](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-technical-details-in-unreal-engine) stores surface lighting using captures called cards and combines screen traces with scene-space tracing. It updates direct and indirect surface lighting over frames. Cards are lighting caches, not a replacement for all of Lumen's visibility machinery. Its documented working system is evidence for the broad hybrid approach, not proof that constant-color planes will match its quality.
- [Christensen's Point-Based Approximate Color Bleeding](https://graphics.pixar.com/library/PointBasedColorBleeding/paper.pdf) represents lit surfaces with oriented surfels and computes approximate color bleeding with visibility. This is a related world-space surface approximation, not an SSGI plugin or an exact match for the proposal.

A minimal proxy would contain plane position, normal, finite extents and **linear outgoing diffuse radiance**. Paint/albedo alone is insufficient: a white wall can be dark, and a red wall's outgoing radiance depends on incident illumination. That radiance could be provided explicitly, computed from shadowed direct lighting, or stored in a small lighting texture. Capturing only direct illumination gives a first-bounce approximation; higher-bounce energy needs an additional update/solve or a precomputed value.

At a missing direction, intersect the nearest appropriate bounded proxy and use its radiance. Preserve foreground occlusion, represent openings, and avoid adding the proxy contribution to a direction already accounted for by screen-space GI. Infinite planes would incorrectly close windows/doors and rooms. Constant radiance should work best for broad, evenly lit diffuse walls; sunlight patches, furniture, corridors and thin partitions require more detail. Blending between screen and proxy estimates is also needed to avoid a visible brightness change when a wall enters the image.

The current bitmask algorithm does not have a conventional one-ray/one-miss callback. It would need to integrate proxy illumination over missing angular coverage, including gaps from the single depth layer, rather than only handle UVs that cross the screen edge. That makes this more involved than returning a color from an off-screen texture lookup.

My assessment: worth trying for room-scale architectural geometry, with a few bounded wall/ceiling patches and supplied or precomputed radiance. It should improve the low-frequency fill and camera stability that pure SSGI cannot guarantee. It cannot repair an incorrectly normalized visible-surface estimator, and a mere ambient brightness boost would lose the directional/occlusion benefits. The diagnostic scenes here provide controls for evaluating a future prototype.

## Reproduction

```sh
pnpm build
pnpm cli render --scenes 'gi-*,ssgi-animated-visible-walls' --passes beauty,direct --samples 1024
pnpm cli compare --scenes 'gi-*,ssgi-animated-visible-walls' --passes beauty,direct
node scripts/gi-receiver-metrics.mjs
node scripts/gi-visibility-metrics.mjs
node scripts/gi-sweep.mjs /tmp/ss-fidelity-gi-sweep
```

The new `gi-*` scenes appear automatically in the viewer and live scene routes. Existing scene defaults and result images are unchanged. The scripts require built workspace packages and the existing headless GPU backends. The optional sweep writes outside the saved `results` tree; its JSON records each override and comparison to the baseline.

This investigation inspects saved images and uses the application's headless renderers. Browser UI inspection was unavailable because no browser was connected. Eight path-tracer bounces are a finite reference, especially in the high-albedo closed room; the isolated emitter controls avoid relying on convergence of a long diffuse-bounce chain.
