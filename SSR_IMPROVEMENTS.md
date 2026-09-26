# SSR improvements: `three-new-ssr` vs the path-traced reference

Refs #16

## Goal

Bring `three-new-ssr`'s screen-space reflections closer to the `three-gpu-pathtracer` ground truth,
without touching `three-new-ssgi` or `three-ss-legacy`. Correctness first; speed doesn't matter yet.

## Method

- **Scenes.** 11 asset-free `ssr-diag-*` diagnostics (`packages/scenes/src/ssr-diagnostics.ts`: mirror/rough/
  dielectric metal and non-metal floors, grazing view, offscreen emitter, occlusion + thin pole, a vertical
  mirror wall, a metal sphere) and 5 `ssr-steampunk-*` scenes (`packages/scenes/src/ssr.ts`: a textured model
  over a metal disc, plus a roughness sweep). References are path-traced and committed at
  `results/<scene>/beauty/three-gpu-pathtracer.avif`.
- **Metrics.** `scripts/ssr-metrics.mjs [renderers]` prints per-scene beauty RMSE/PSNR from
  `results/<scene>/beauty/metrics-<renderer>.json` (written by `pnpm cli compare`), plus mean RMSE overall and
  split by `ssr-diag-*` / `ssr-steampunk-*`. `packages/cli/scripts/ssr-visual.mjs <out-dir> [scenes] [renderer]`
  writes reference | test | abs-diff×4 PNGs for visual inspection (numbers alone are misleading here — several
  regressions below look nearly identical to the reference and several "improvements" still look wrong).
- **Renderer lineage.** `three-new-ssgi` (fork `SSRNode.js`, unchanged) → `three-new-ssr` (vendored,
  editable copy at `packages/renderers/src/ssr/NewSSRNode.js`, wired in `packages/renderers/src/ssgi.ts` for
  `ssrMethod: 'new'`) → a future `three-new-ssr-fast` that reintroduces speed once correctness is settled.
  Before this work `three-new-ssr` was bit-identical to `three-new-ssgi` (same fork code, same settings).

## Research summary

A full audit with line citations and a literature review lives in the scratchpad research note (11 problem
categories: energy/compositing, ray march and hit validation, input radiance/multi-bounce, plus a stochastic-mode
summary). The headline findings that shaped this round:

- **Distance fade + hard `maxDistance` cutoff (A1/A2).** The mirror path fades hit radiance by
  `(1 - planeDist/maxDistance)²` and drops hits beyond `maxDistance`, then falls back to environment. For a
  radiance-mode reference this manufactures "ghost reflections": scenes tuned with an artistic `maxDistance`
  (1–6 in these scenes) lose most of a reflection to unoccluded environment.
- **Dielectrics never traced (A6).** `reflectNonMetals: false` skips the whole march for non-metals, so black
  dielectric floors get pure environment instead of a Fresnel-ramped reflection of local emitters.
- **Thin/flat thickness test + no self-intersection guard (B1/B5).** A crossing is only a hit within
  `max(thickness, 3px)` of the ray _line_; a solid occluder behind that band leaks the environment through it.
  Curved and grazing surfaces can also re-hit their own depth-buffer samples immediately after the ray leaves.
- **Coarse, non-refined march (B2).** `quality 0.5` with no binary refinement stair-steps hits and can skip
  geometry thinner than a stride (the occlusion scene's 0.05-wide pole).
- **Wide-lobe visibility is architecturally missing for rough surfaces (A3/A4).** The mirror ray + screen-space
  blur only knows whether _one_ direction is occluded; a real GGX lobe at roughness ≳ 0.3 samples a visibility
  cone the current architecture can't approximate. This needs the stochastic/temporal rework the task explicitly
  defers to the next round.
- Literature: split-sum/pre-integrated DFG (Karis 2013), stochastic SSR with ray reuse (Stachowiak & Uludag
  2015), perspective-correct screen-space marching with an interval hit test (McGuire & Mara 2014), Hi-Z cone
  tracing (Uludag 2014), FidelityFX SSSR, and VNDF sampling (Heitz 2018) — see the research note for details.

## Baseline (three-new-ssgi == three-new-ssr, before this work)

| scene                              | RMSE   | PSNR (dB) |
| ---------------------------------- | ------ | --------- |
| ssr-diag-dielectric-0              | 0.0249 | 32.06     |
| ssr-diag-dielectric-30             | 0.0222 | 33.07     |
| ssr-diag-grazing                   | 0.0249 | 32.08     |
| ssr-diag-mirror                    | 0.0280 | 31.07     |
| ssr-diag-occlusion                 | 0.0184 | 34.70     |
| ssr-diag-offscreen                 | 0.0493 | 26.14     |
| ssr-diag-rough-10                  | 0.0271 | 31.33     |
| ssr-diag-rough-30                  | 0.0290 | 30.76     |
| ssr-diag-rough-60                  | 0.0517 | 25.73     |
| ssr-diag-sphere                    | 0.0676 | 23.41     |
| ssr-diag-wall                      | 0.0879 | 21.12     |
| ssr-steampunk-camera               | 0.0970 | 20.27     |
| ssr-steampunk-camera-roughness-0   | 0.1172 | 18.62     |
| ssr-steampunk-camera-roughness-25  | 0.1152 | 18.77     |
| ssr-steampunk-camera-roughness-50  | 0.1103 | 19.15     |
| ssr-steampunk-camera-roughness-100 | 0.0969 | 20.27     |

**Mean RMSE:** overall 0.0605, diag 0.0392, steampunk 0.1073.

## Experiments

### 1. Drop the distance fade and hard `maxDistance` rejection (research items 1, A1/A2)

- **Hypothesis.** Ghost reflections in radiance mode come from `(1-d/maxD)²` blending real hits toward
  environment, and from `maxDistance` bounding the ray length to an artistic cutoff instead of the frustum.
- **Change.** In `NewSSRNode.js`'s radiance-mode mirror path: `hitWeight` is now only the screen-border fade
  (no distance attenuation); the `distance > maxDistance → Break` and the `withinRange` gate are skipped when
  `outputRadiance`. In `ssgi.ts`, `three-new-ssr`'s `maxDistance` uniform is set to `camera.far * 2` (a large,
  scene-independent ray-length budget) instead of the scene's `effects.ssr.maxDistance`.
- **Result.** Mean RMSE: diag 0.0392 → 0.0392 (before the later steps below; measured cumulatively, see
  final numbers). In isolation: `ssr-diag-mirror` 31.07 → 31.83 dB, `ssr-diag-wall` 21.12 → 22.29 dB (see root
  cause below), `ssr-diag-occlusion` 34.70 → 36.34 dB, `ssr-diag-sphere` 23.41 → 23.84 dB — but
  `ssr-diag-grazing` 32.08 → 29.18 dB and `ssr-diag-rough-30` 30.76 → 29.50 dB got worse, and steampunk mean
  RMSE rose from 0.1073 to 0.1135. Overall mean RMSE alone: 0.0605 → 0.0620 (worse).
- **Visual check.** Mirror/wall/occlusion/sphere: previously-missing reflections appear. Grazing/rough-30:
  visually similar to before (a hazy near-grey reflection in the reference either way); the regression is a
  small quantitative penalty from now finding real (but still noisy/self-intersecting) hits instead of quietly
  falling back to an environment grey that happened to be closer to the reference by coincidence.
- **Kept**, pending the thickness/self-intersection work below, which is what actually fixes those hits rather
  than just suppressing them. Reverting this step would re-introduce the primary target of this round (ghost
  reflections), so it is judged on the cumulative result, not in isolation — see the final summary.

### 2. Reflect non-metals (research item 5, A6)

- **Change.** `ssgi.ts` passes `reflectNonMetals: true` to `newSSR()` only when `ssrMethod === 'new'` (the fork
  path used by `three-new-ssgi`/`three-ss-legacy` is untouched).
- **Result.** `ssr-diag-dielectric-0` 32.06 → 36.99 dB, `ssr-diag-dielectric-30` 33.07 → 36.07 dB. No other
  scene changed (metals were already traced). Diag mean RMSE 0.0386 → 0.0376 (cumulative on top of step 1).
- **Kept.** Large, isolated win with no regressions; this is exactly the "black dielectric floor should show
  emitters at Fresnel F≈0.04→1" case the diagnostic scenes were built to catch.

### 3. Root cause: the vertical mirror wall (`ssr-diag-wall`, 21 dB baseline)

- **Investigation.** The wall directly faces the camera; the emitters in front of it are all _closer_ to the
  camera than the wall. Reflecting off a near-frontal mirror at an object between the camera and the mirror
  is physically valid, but the reflected ray then travels back toward the camera (its view-space Z becomes
  less negative as the ray parameter increases) and must cover nearly the _entire_ remaining scene depth to
  reach the emitter — there is no shortcut through the wall. The scene's `maxDistance` (6) sized for an
  artistic cutoff was, for this geometry, barely enough (or not enough at glancing angles, since
  `maxReflectRayLen = maxDistance / dot(V,N)` only grows the budget away from normal incidence) to reach the
  emitters at all, so most wall pixels rays fell short and silently reported "miss → environment". This is the
  same root cause as items A1/A2, not a separate march/clipping bug: the near-plane clip
  (`d1viewPosition.z > -near`) already reprojects the ray end correctly once the budget is large enough.
- **Fix.** Covered by experiment 1 (large scene-independent `maxDistance`). `ssr-diag-wall` improved
  21.12 → 21.85 dB in the final cumulative state (dark but present reflections; see remaining error below).
- **Remaining gap.** The reflected emitters on the wall are visibly dimmer than the reference even where
  found — likely the still-narrow (single-mirror-ray) hit combined with 8-bit-quantized normals/roughness
  and the screen-border fade landing a hit near the very edge of its own footprint. This needs the same
  wide-lobe/denoiser work called out for rough surfaces below, not a further one-line fix.

### 4. Thickness and self-intersection (research item 4, B1/B5)

- **Change (thickness, `NewSSRNode.js`).** The hit-acceptance thickness is now
  `max(minThickness, thickness, |viewZ| * 0.02)` — depth-proportional (McGuire & Mara / Unreal HZB SSR
  heuristic), so a surface farther from the camera needs a proportionally larger crossing gap to reject,
  reducing light leaking through solid occluders as the ray recedes.
- **Change (self-intersection, `NewSSRNode.js`).** The march now starts from a `rayOrigin` offset along the
  surface normal by `max(|viewZ| * 0.002, 0.001)` (view-depth-proportional), used consistently for the ray's
  far endpoint, near-plane clip, `reflectRayZAt`, and the thickness line test — instead of marching from the
  raw `viewPosition`, which let curved/grazing surfaces immediately re-cross their own depth-buffer samples.
- **Result (cumulative).** `ssr-diag-mirror` 31.83 → 32.95 dB, `ssr-diag-rough-10` 31.75 → 32.83 dB,
  `ssr-diag-occlusion` unchanged (already fixed by step 1), `ssr-diag-sphere` visually much improved (the
  red/yellow/blue/green emitter reflections that were nearly absent now appear clearly on the metal sphere,
  matching the reference's layout) though its RMSE barely moved (0.0646, still dominated by the missing
  wide-lobe blur at roughness 0.1 near the sphere's silhouette). Diag mean RMSE 0.0376 → 0.0364.
- **Kept.** Clear, visible improvement (see the sphere self-intersection speckle disappear) with no visible
  regressions.

### 5. Dense march + binary refinement (research item 6, B2/B3)

- **Change (`ssgi.ts`).** For `ssrMethod === 'new'`, `quality` is forced to `1` (from the scenes' 0.5) and
  `binaryRefine` is forced to `true` (from the scenes' `false`), regardless of the scene's authored values —
  speed doesn't matter for this reference renderer.
- **Result (cumulative).** Sharper contacts, no visible stair-stepping. Diag mean RMSE 0.0364 → 0.0362 (small;
  most of this round's gain was in step 1/2/4, not step count). `ssr-diag-offscreen` 26.14 → 27.14 dB.
- **Kept.** Strictly better or neutral everywhere measured, and it is what makes the occlusion scene's thin
  pole and sharp contact edges reliable, which matters more once the pipeline runs at quality 1 by default for
  every future experiment.

### 6. Investigate the sphere scene (23 dB baseline)

- Covered by experiment 4: the self-intersection offset was the primary bug (curved-surface rays re-hitting
  their own surface within the flat, non-depth-proportional thickness band, so most reflected rays terminated
  immediately on the sphere itself instead of reaching the surrounding emitters). Visually fixed; the RMSE
  is still high (0.0645) because the sphere is roughness 0.1 and the emitter reflections are still traced as
  a single mirror ray with a screen-space blur — small residual blur-width mismatch and the sphere's own
  silhouette (background bleeding into the blur, A5, not yet fixed — see below) account for the rest.

### 7. Investigate the steampunk roughness sweep (research sanity item)

- **Finding.** The roughness override _does_ reach the WebGPU materials on both renderers — it's not a scene
  bug. Comparing `roughness-0` vs `roughness-100` mean absolute pixel difference: pathtracer 9.52/255,
  `three-new-ssr` 5.08/255 (up from ~5/255 pre-fix; not a dramatic change from this round's work). The smaller
  raster response is best explained by material composition, not a broken override: most of the steampunk
  model's surface area is dielectric with the default low F0 (~4% specular at normal incidence), so its own
  environment-specular contribution — with or without SSR — is a small fraction of its shaded color, and IBL
  specular roughness response is inherently subtle for low-F0 materials. The path tracer's multi-bounce GI and
  correct Fresnel ramp make the same roughness change more visible. This is a genuine, expected difference
  between a screen-space approximation and a path tracer, not a bug in either the scene or `three-new-ssr`; no
  scene change is warranted.

### Deferred (explicitly out of scope this round)

- **A5 (background black bleed into the blur).** Not implemented. Background pixels are discarded (alpha 0)
  into the SSR target that the roughness-driven blur mip chain reads, darkening rough surfaces near silhouettes
  (visible on the sphere's rim and the steampunk disc edge). Fix: write environment radiance with alpha 1, or
  blur premultiplied with a separate coverage channel.
- **Wide-lobe visibility for rough surfaces (A3/A4) — the big remaining error source.** `ssr-diag-rough-60`
  (25.73 → 25.23 dB, essentially unchanged) and the steampunk floor/model both need a real GGX lobe visibility
  term, which a single mirror ray + isotropic screen-space blur cannot approximate (the blur only spreads
  _found_ mirror-ray results; it can't tell that a wide lobe at roughness 0.5–1 would have found different,
  mostly-occluding geometry). This is the stochastic GGX / temporal accumulation rework the task explicitly
  defers to the next round. It is the dominant remaining error on `ssr-diag-rough-30/60` and the steampunk
  floor/model, and the reason those scenes did not improve (or slightly regressed) this round.
- **Ratio estimator, mirrorBias/luminance-cap removal, view-dependent hit shading (A7-A11, C3).** Lower
  expected impact per the research note's ranking; not attempted this round to stay within scope.

## Final results (three-new-ssr, after all kept experiments)

| scene                              | baseline RMSE | final RMSE | baseline PSNR | final PSNR | Δ PSNR                       |
| ---------------------------------- | ------------- | ---------- | ------------- | ---------- | ---------------------------- |
| ssr-diag-dielectric-0              | 0.0249        | 0.0137     | 32.06         | 37.26      | +5.20                        |
| ssr-diag-dielectric-30             | 0.0222        | 0.0156     | 33.07         | 36.14      | +3.07                        |
| ssr-diag-grazing                   | 0.0249        | 0.0338     | 32.08         | 29.43      | -2.65                        |
| ssr-diag-mirror                    | 0.0280        | 0.0220     | 31.07         | 33.14      | +2.07                        |
| ssr-diag-occlusion                 | 0.0184        | 0.0154     | 34.70         | 36.24      | +1.54                        |
| ssr-diag-offscreen                 | 0.0493        | 0.0440     | 26.14         | 27.14      | +1.00                        |
| ssr-diag-rough-10                  | 0.0271        | 0.0224     | 31.33         | 32.98      | +1.65                        |
| ssr-diag-rough-30                  | 0.0290        | 0.0315     | 30.76         | 30.03      | -0.73                        |
| ssr-diag-rough-60                  | 0.0517        | 0.0548     | 25.73         | 25.23      | -0.50                        |
| ssr-diag-sphere                    | 0.0676        | 0.0646     | 23.41         | 23.79      | +0.38 (visually much better) |
| ssr-diag-wall                      | 0.0879        | 0.0808     | 21.12         | 21.85      | +0.73                        |
| ssr-steampunk-camera               | 0.0970        | 0.1063     | 20.27         | 19.47      | -0.80                        |
| ssr-steampunk-camera-roughness-0   | 0.1172        | 0.1178     | 18.62         | 18.58      | -0.04                        |
| ssr-steampunk-camera-roughness-25  | 0.1152        | 0.1175     | 18.77         | 18.60      | -0.17                        |
| ssr-steampunk-camera-roughness-50  | 0.1103        | 0.1150     | 19.15         | 18.78      | -0.37                        |
| ssr-steampunk-camera-roughness-100 | 0.0969        | 0.1064     | 20.27         | 19.46      | -0.81                        |

**Mean RMSE:** overall 0.0605 → 0.0601, diag 0.0392 → 0.0362 (-7.7%), steampunk 0.1073 → 0.1126 (+5.0%).

The diagnostic scenes this round targeted (ghost reflections, dielectrics, occlusion, the wall, the sphere)
are all measurably and visibly better. The steampunk scenes and the rough-floor diagnostics regressed
slightly in RMSE despite being visually similar or arguably more correct in direction (real reflections
instead of an accidental grey match) — their dominant remaining error is the wide-lobe visibility gap
(A3/A4), which is the next round's stochastic GGX / temporal-accumulation work, not something fixable within
this round's scope.

---

# Round 2: stochastic reference configuration

Round 2 targets accuracy on rough surfaces and fixes round 1's regressions. Speed is still not a goal.
Every number below is beauty RMSE against the path tracer. The column order is baseline
(`three-new-ssgi`), round 1, and then the step being described.

## R2.1 Diagnosis of the round-1 regressions

- **`ssr-diag-grazing` (−2.65 dB).** Looking at the images shows a dark trapezoid on the floor near the
  horizon. The cause is rays that no longer stop at `maxDistance`: they run past the far plane and "hit"
  the cleared background depth (`depth = 1`, `viewZ = −far`). The depth-proportional thickness
  (`0.02·|z| = 2` units at z = −100) accepts that hit, so the reflection samples the screen-space
  gradient backdrop (0.14–0.22) instead of the environment. The fix is to never accept a crossing
  whose depth sample is `>= 1` (the march `Continue`s instead). With the round-1 mirror path plus only
  this fix, grazing goes from 0.0338 to 0.0215, which beats the 0.0249 baseline.
- **Steampunk (+5 %).** The white metal disc has roughness 0.5, yet round 1 reflected the model on it as
  a sharp, displaced mirror image. The fork's distance fade used to hide that image, and removing the
  fade exposed it. The path tracer shows only a soft reddish tint with contact darkening. A mirror ray
  plus a small screen-space blur cannot produce that result; a real GGX lobe can (R2.2). The
  background-hit fix alone moves `ssr-steampunk-camera` only from 0.1063 to 0.1052.
- **`rough-30/60`.** These regressed for the same reason: sharp mirror hits on rough floors.

## R2.2 E0: stochastic VNDF reference with unbiased accumulation (kept)

- **Change (`NewSSRNode.js`).**
  - **Sampling.** The stochastic path samples bounded-VNDF GGX with α = roughness², the same
    distribution as the path tracer (`surf.roughness = roughness²`, and `filterGlossyFactor` is 0).
    `mirrorBias` is 0. Below-horizon samples get weight 0 (G2 = 0) instead of a correlated
    re-sample.
  - **Noise.** The per-pixel, per-frame random numbers are a 4-D R-sequence over a node-local frame
    counter, Cranley–Patterson rotated by a PCG hash per pixel and per dimension. This replaces the
    32×32 analytic R² tile, whose four dimensions derive from one scalar.
  - **March.** Stochastic rays use the same dense 1-px uniform march with binary refinement as the
    mirror path, instead of 32 `s²`-spaced steps.
  - **Hit validation.** Back-face hits are rejected in both modes, and background hits are rejected
    (R2.1).
  - **Misses and off-screen rays.** Both sample `pmremTexture(env, rayDir, 0)`: the environment in
    that ray's own direction at the sharpest prefilter level, not the full-lobe prefiltered value.
  - **Output and accumulation.** With `accumulate`, the pass outputs the ratio-estimator terms
    `vec4(L·w, w)`, where `w = luminance(F·G2/G1)` is the VNDF sample weight. A plain running mean
    (FloatType ping-pong, no clamping, restarted when the camera or size changes) is resolved to
    `Σ L·w / Σ w`. That value is lobe-normalized incoming radiance, which `builtinRadianceContext`
    feeds to `PhysicalLightingModel.indirectSpecular` as `radiance · (F0·DFG.x + F90·DFG.y)`. The
    Fresnel/DFG term is therefore applied exactly once, and E[w] is the DFG term.
- **Change (`ssgi.ts`, three-new-ssr only).**
  - **Node options.** `stochastic` and `accumulate` are on, `maxLuminance` is 1e9 (no cap), and
    `screenEdgeFade` is 0. A hit is a hit; rays that leave the screen fall back to the environment.
  - **Denoise chain.** The temporal reprojection/denoise chain is bypassed.
  - **Frame count.** Each `render()` runs `ceil(256 / effects.frames)` pipeline frames, advancing the
    node frame for the extra ones, so each result averages at least 256 frames. That is 16 sub-frames
    for the SSR scenes. Scenes without SSR are unchanged.
- **Result.** Every SSR scene improved on round 1. Overall 0.0601 → **0.0529**, diag 0.0362 → 0.0319,
  steampunk 0.1126 → 0.0993.

| scene                              | baseline | round 1 | E0     |
| ---------------------------------- | -------- | ------- | ------ |
| ssr-diag-dielectric-0              | 0.0249   | 0.0137  | 0.0135 |
| ssr-diag-dielectric-30             | 0.0222   | 0.0156  | 0.0130 |
| ssr-diag-grazing                   | 0.0249   | 0.0338  | 0.0214 |
| ssr-diag-mirror                    | 0.0280   | 0.0220  | 0.0219 |
| ssr-diag-occlusion                 | 0.0184   | 0.0154  | 0.0152 |
| ssr-diag-offscreen                 | 0.0493   | 0.0440  | 0.0381 |
| ssr-diag-rough-10                  | 0.0271   | 0.0224  | 0.0209 |
| ssr-diag-rough-30                  | 0.0290   | 0.0315  | 0.0197 |
| ssr-diag-rough-60                  | 0.0517   | 0.0548  | 0.0524 |
| ssr-diag-sphere                    | 0.0676   | 0.0646  | 0.0617 |
| ssr-diag-wall                      | 0.0879   | 0.0808  | 0.0728 |
| ssr-steampunk-camera               | 0.0970   | 0.1063  | 0.0839 |
| ssr-steampunk-camera-roughness-0   | 0.1172   | 0.1178  | 0.1131 |
| ssr-steampunk-camera-roughness-25  | 0.1152   | 0.1175  | 0.1114 |
| ssr-steampunk-camera-roughness-50  | 0.1103   | 0.1150  | 0.1042 |
| ssr-steampunk-camera-roughness-100 | 0.0969   | 0.1064  | 0.0839 |

- **Pitfall found.** The first attempt looped `renderPipeline.render()` inside one `render()` call and
  produced 16-sample noise. Effect passes (`updateBefore` with `FRAME`) only run once per node frame,
  and the node frame advances only in the animation loop, so the loop must call
  `nodeFrame.update()` for each extra sub-frame.

## R2.3 Non-SSR residual: multiscatter energy compensation

On `ssr-diag-rough-60`, the floor far from any emitter (bottom corners) is sRGB 141 in both
`three-new-ssr` and `three-new-ssgi`, against 126 in the path tracer. In linear terms the raster floor is
about 1.27× brighter. On `mirror`, `rough-10` and `rough-30` the same patch agrees to within 1/255.

Monte-Carlo single-scatter GGX albedo `Ess(α, N·V)` with height-correlated Smith G2, as the path tracer
uses, is:

| roughness (α) | Ess at N·V 0.3 / 0.5 / 0.7 / 0.9 |
| ------------- | -------------------------------- |
| 0.3 (0.09)    | 0.945 / 0.975 / 0.985 / 0.989    |
| 0.5 (0.25)    | 0.838 / 0.857 / 0.885 / 0.907    |
| 0.6 (0.36)    | 0.797 / 0.782 / 0.795 / 0.814    |
| 1.0 (1.0)     | 0.561 / 0.451 / 0.380 / 0.328    |

For a white metal (F0 = 1), three.js's Fdez-Agüera term adds `Ems·E_irr/π`, so the raster reflects
about 1/Ess of the single-scatter energy. At rough-60 and N·V ≈ 0.75 that is 1/0.795 = 1.26×, which
matches the measured 1.27×. The rough-floor brightness offset is therefore entirely material-model
(single- vs multi-scatter) and cannot be fixed in SSR. It is the dominant remaining error on
`rough-60` away from the emitters, and about 15 % of floor radiance on the steampunk disc
(roughness 0.5, α = 0.25).

## R2.4 Hit acceptance: keep back-face hits and add dual-layer depth (kept)

- **Hypothesis 1: back-face rejection leaks the environment.** The `dot(R, N_hit) >= 0 → Continue`
  back-face test makes a ray that enters a solid from its hidden side march straight through it to the
  environment. This happens, for example, when a camera-facing mirror wall reflects the far sides of
  the emitters in front of it. A path tracer would hit that hidden side.
- **Hypothesis 2: the thickness heuristic is scene-scale dependent.** The heuristic
  `max(3 px, thickness, 0.02·|z|)` misses rays that pass under or behind an object's visible surface,
  for example the floor at the base of an emitter reaching the emitter's hidden underside. That is why
  contact glow was missing on `mirror` and `rough-*`.
- **Experiments (overall / diag / steampunk).**

| variant                                    | overall    | diag       | steampunk |
| ------------------------------------------ | ---------- | ---------- | --------- |
| E0                                         | 0.0529     | 0.0319     | 0.0993    |
| keep back-face hits                        | 0.0526     | 0.0312     | 0.0996    |
| infinite thickness                         | 0.0535     | 0.0323     | 0.1000    |
| keep back-face hits + infinite thickness   | 0.0543     | 0.0323     | 0.1027    |
| keep back-face hits + thickness 0.15       | 0.0533     | 0.0300     | 0.1047    |
| keep back-face hits + thickness 0.4        | 0.0531     | 0.0305     | 0.1027    |
| **keep back-face hits + dual-layer depth** | **0.0517** | **0.0295** | 0.1004    |

- **Keeping back-face hits.** The wall improves from 0.0728 to 0.0674. The steampunk scenes move by
  +0.001 because the visible side is only a proxy for the radiance of the hidden side.
- **Any global thickness.** Contacts improve on the diagnostics (mirror 0.0219 → 0.0183), but
  steampunk loses up to +0.008 and infinite thickness makes the sphere 0.0617 → 0.0722. The rays that
  pass behind the thin, intricate parts of the model, or behind the sphere's own silhouette, then get
  blocked. No single constant fits both scene scales.
- **Change.** `three-new-ssr` renders an extra depth pre-pass of back faces (`overrideMaterial` with
  `side: BackSide`, depth only) and passes it to the node as `backDepthNode`. A depth crossing is a hit
  when the ray lies inside the solid, which means behind the front depth and in front of the back-face
  depth plus the same `tk` slack. The old thickness test still applies as an alternative. Open
  surfaces such as the floor and the wall have no back face in front of anything behind them, so they
  count as solid, which is right for a ground plane.
- **Result.** Overall 0.0529 → **0.0517**, diag 0.0319 → 0.0295. Mirror 0.0219 → 0.0167, rough-10
  0.0209 → 0.0160, rough-30 0.0197 → 0.0158, offscreen 0.0381 → 0.0333, wall 0.0728 → 0.0677.
  Steampunk is flat overall (0.0993 → 0.1004). `roughness-50` moved +0.003 and the others by
  0.000–0.0014. Visually the steampunk images are indistinguishable: the differences are on
  inter-reflections between parts of the model, where hidden-side radiance is proxied anyway. **Kept**,
  because it is the principled fix and a clear, scale-independent win on every diagnostic.

## R2.5 Transparent-flagged surfaces in the pre-passes (kept)

- **Finding.** The steampunk scene, like the three.js example it copies, marks the `Lense_Casing`
  material `transparent`. That material is opaque (opacity 1), and it covers the whole front of the
  model: lens, rings, crank and front body. The pre-pass skipped transparent objects, so those pixels
  had no G-buffer. Debug views of the pre-pass metal/roughness and of the SSR target showed the entire
  front assembly missing. The casing then read its reflections from the SSR result of the surface behind
  it, or from a discarded texel (0), and no other ray could hit it.
- **Change.** In the `three-new-ssr` setup, the pre-pass and the back-face depth pass include
  transparent objects.
- **Result.** Steampunk improves 0.1004 → **0.0967**:

  | scene                  | before | after  |
  | ---------------------- | ------ | ------ |
  | `ssr-steampunk-camera` | 0.0840 | 0.0808 |
  | `roughness-0`          | 0.1136 | 0.1090 |
  | `roughness-25`         | 0.1128 | 0.1086 |
  | `roughness-50`         | 0.1074 | 0.1043 |
  | `roughness-100`        | 0.0840 | 0.0809 |

  The diagnostics are unchanged, and overall goes 0.0517 → **0.0505**. Most of the gain comes from
  the back-face pass: the pre-pass alone gave steampunk only −0.0011.

- **Scene note.** A truly translucent surface would now occlude SSR rays behind it. No scene in the suite
  has one; this is an assumption to revisit if one is added.

## R2.6 Experiments that did not help (reverted)

- **Unblurred environment for the rays.** Stochastic misses used a sigma-0 PMREM instead of the
  materials' sigma-0.04/0.05 one. This mirrors the path tracer's unblurred cube, but steampunk got
  worse on every roughness except 0 and 25 (+0.0012 on the default, −0.0018 on `roughness-0`). With
  256 samples, RoomEnvironment's small, very bright light panels produce firefly noise, which costs
  more than the blur mismatch. The diagnostics' smooth gradient environment is unaffected.
- **Material roughness without the specular-AA floor.** `getRoughness` raises roughness to
  `0.4·sqrt(geometryRoughness)`. Sampling the lobe with `materialRoughness` instead, which has no such
  floor, left steampunk flat at 0.1004 → 0.1005. On the default model the geometric floor is not a
  significant error source.
- **1024 instead of 256 accumulated frames.** The diagnostics did not change (±0.0001), and steampunk
  moved by at most −0.0006, so 256 frames is converged to well under 1 % of the remaining error.

## R2.7 Hit radiance direction (C3): measured, not fixed

A hit reuses the previous frame's radiance at the hit pixel, which is the radiance leaving toward the
camera and not toward the reflecting point. That is exact for the diagnostics' emitters, which are
view-independent. It is wrong for metal-on-metal paths, and the steampunk model is almost entirely
metal.

As a sensitivity bound, turning every hit on a metal surface (hit metalness 1) into an environment miss
worsens steampunk by +0.008 to +0.014 (mean 0.1004 → 0.1115). The screen-space signal on metal hits,
occlusion plus approximate radiance, is therefore essential, and discarding it is not an option.

A principled fix needs the hit's outgoing radiance toward `−R`. That requires splitting the scene pass
into view-independent (emissive + diffuse) and specular parts, then re-evaluating the hit's specular for
`−R` from the hit G-buffer: normal, roughness, and F0/base color, which is not in the G-buffer today.
This is left as future work. For glossy metal hits the error is roughly that of shading the hit with the
wrong reflection vector, and it grows with the angle between the camera ray and `−R`.

## R2.8 Silhouette zero-weight pixels and non-finite samples (kept)

- **Finding.** On `ssr-diag-sphere` and on the steampunk parts, isolated silhouette pixels came out
  black. At those pixels the interpolated normal faces away from the camera (N·V ≤ 0), every VNDF
  sample gets weight 0, and the resolve returns 0. A debug resolve that painted `Σw = 0` magenta
  confirmed this.
- **Change.** The stochastic path bends its sampling normal toward V until N·V ≥ 0.02. The
  accumulation also drops non-finite samples as zero-weight samples, because a single NaN would
  otherwise poison a pixel's running mean for good.
- **Result.** The black silhouette pixels are gone. Steampunk moves 0.0967 → 0.0966 and the
  diagnostics do not change.

## Round 2 summary

| scene                              | baseline (three-new-ssgi) | round 1 | round 2 (final) |
| ---------------------------------- | ------------------------- | ------- | --------------- |
| ssr-diag-dielectric-0              | 0.0249                    | 0.0137  | 0.0132          |
| ssr-diag-dielectric-30             | 0.0222                    | 0.0156  | 0.0128          |
| ssr-diag-grazing                   | 0.0249                    | 0.0338  | 0.0213          |
| ssr-diag-mirror                    | 0.0280                    | 0.0220  | 0.0167          |
| ssr-diag-occlusion                 | 0.0184                    | 0.0154  | 0.0151          |
| ssr-diag-offscreen                 | 0.0493                    | 0.0440  | 0.0333          |
| ssr-diag-rough-10                  | 0.0271                    | 0.0224  | 0.0160          |
| ssr-diag-rough-30                  | 0.0290                    | 0.0315  | 0.0158          |
| ssr-diag-rough-60                  | 0.0517                    | 0.0548  | 0.0521          |
| ssr-diag-sphere                    | 0.0676                    | 0.0646  | 0.0608          |
| ssr-diag-wall                      | 0.0879                    | 0.0808  | 0.0677          |
| ssr-steampunk-camera               | 0.0970                    | 0.1063  | 0.0805          |
| ssr-steampunk-camera-roughness-0   | 0.1172                    | 0.1178  | 0.1090          |
| ssr-steampunk-camera-roughness-25  | 0.1152                    | 0.1175  | 0.1086          |
| ssr-steampunk-camera-roughness-50  | 0.1103                    | 0.1150  | 0.1041          |
| ssr-steampunk-camera-roughness-100 | 0.0969                    | 0.1064  | 0.0807          |

**Mean RMSE:**

|                 | overall                          | diag                 | steampunk            |
| --------------- | -------------------------------- | -------------------- | -------------------- |
| baseline        | 0.0605                           | 0.0392               | 0.1073               |
| round 1         | 0.0601                           | 0.0362               | 0.1126               |
| round 2 (final) | **0.0505** (−16.5 % vs baseline) | **0.0295** (−24.7 %) | **0.0966** (−10.0 %) |

Every scene is better than both the baseline and round 1, except `rough-60`, which is flat (see below).

**Other scenes (beauty, `three-new-ssr` against the committed `three-new-ssgi`).**

- **Scenes without SSR.** The `gi-*` scenes and `higharc_dogwood` have identical RMSE.
- **Cornell `ssgi-*` scenes.** These use SSR, and they improve:

  | scene                         | three-new-ssgi | three-new-ssr |
  | ----------------------------- | -------------- | ------------- |
  | `ssgi-basic`                  | 0.0681         | 0.0606        |
  | `ssgi-rounded`                | 0.0519         | 0.0431        |
  | `ssgi-metallic`               | 0.0707         | 0.0504        |
  | `ssgi-animated`               | 0.0492         | 0.0401        |
  | `ssgi-animated-visible-walls` | 0.0486         | 0.0398        |

  In `ssgi-metallic` the chrome sphere now reflects the red and green walls and the floor instead of
  being mostly black. These scenes' 128 frames become 256 pipeline frames, so SSGI's temporal
  accumulation also gets twice as many frames. Part of that gain is therefore not SSR.

**Cost.**

- **Frames.** The `ssr-*` scenes run 16 pipeline frames per rendered frame (256 in total) with 1
  stochastic ray per pixel per pipeline frame.
- **Per pipeline frame.** At 640×480 (`pnpm cli bench`), one pipeline frame takes about 12 ms on
  `ssr-steampunk-camera` and about 11 ms on `ssr-diag-rough-30`. `three-new-ssgi` takes 6.0 ms and
  10.5 ms for its whole frame.
- **Per rendered frame.** That makes `three-new-ssr` 17–33× slower per rendered frame (198 ms and
  175 ms).
- **Where the per-frame cost goes.**
  - A dense 1-px march with binary refinement.
  - An extra back-face depth pass.
  - The accumulate and resolve passes.

**Remaining error and how much is not SSR.**

- **Multiscatter energy compensation.** This is a raster material-model difference. With three.js's
  Fdez-Agüera indirect term and the direct compensation zeroed in a local, uncommitted build:
  - `rough-60` drops 0.0521 → **0.0137**, which is essentially all of its error.
  - `rough-30` drops 0.0158 → 0.0143.
  - Steampunk drops by about 0.002 per scene.
  - Overall mean falls 0.0517 → 0.0486 and diag 0.0295 → 0.0259.

  The path tracer is single-scatter GGX (R2.3).

- **Steampunk.** 87 % of the squared error lies inside the model's bounding box. The main SSR-side
  causes there are:
  - Hit radiance is view-dependent, and the model is almost entirely metal (R2.7, unfixed).
  - Hidden sides of parts are proxied by their visible sides.
  - Missing diffuse occlusion and GI: the scene has no SSGI, so the materials' diffuse and multiscatter
    terms use unoccluded environment irradiance.

  The last two are not SSR.

- **Off-screen and hidden geometry.** This is inherent to SSR and dominates `wall`, where the lower
  wall should mirror the floor near the camera, which is off-screen. It also dominates `sphere`, where
  the lower hemisphere should mirror floor that is off-screen or hidden by the sphere, and the red
  emitter is off-screen. In `offscreen` it is the box behind the camera.
- **Environment prefilter.** The rays sample PMREM level 0 (sigma 0.04/0.05) where the path tracer uses
  an unblurred cube. With 256 samples that is the better trade-off (R2.6).

**Candidates for the optimization round.**

- **Traversal.** Replace the 1-px march and 8-step bisection with Hi-Z traversal. The march is the
  dominant cost.
- **Ray count and noise.** Trace at half resolution with neighbour ray reuse in the resolve, the
  ratio estimator with this pixel's BRDF (Stachowiak 2015). Add a spatio-temporal denoiser, or
  reprojection with ratio-estimator history, in place of the 256-frame running mean.
- **Rough surfaces.** Above a roughness threshold, fall back to the prefiltered environment plus a
  visibility term. For rough-60 a few coarse rays already give the occlusion.
- **Back-face depth pass.** Render it only for SSR-relevant geometry, or derive the thickness from a
  conservative constant with dual-layer depth only where needed.
- **Keep for quality.** VNDF sampling, `mirrorBias` 0, the ratio estimator, back-face hits,
  background-hit rejection, and per-ray environment misses cost nothing extra and should stay.

---

# Round 3: view-dependent hit radiance

## R3.0 Note on the Cornell (`ssgi-*`) gains of round 2

Round 2 noted that part of the `ssgi-*` gain might come from `three-new-ssr` running 256 pipeline frames
instead of 128. That is not the main cause. `three-new-ssgi` rendered with `--frames 256`:

| scene                         | three-new-ssgi (128) | three-new-ssgi (256) | three-new-ssr |
| ----------------------------- | -------------------- | -------------------- | ------------- |
| `ssgi-basic`                  | 0.0681               | 0.0669               | 0.0606        |
| `ssgi-rounded`                | 0.0519               | 0.0507               | 0.0431        |
| `ssgi-metallic`               | 0.0707               | 0.0697               | 0.0504        |
| `ssgi-animated`               | 0.0492               | 0.0484               | 0.0401        |
| `ssgi-animated-visible-walls` | 0.0486               | 0.0478               | 0.0398        |

The extra frames explain about 0.001 of each scene's 0.008–0.020 improvement; the rest is SSR.

## R3.1 New diagnostic: `ssr-diag-metal-hit`

A mirror metal floor reflects a floating chrome sphere (roughness 0) and a floating gold box (roughness 0.3,
rotated 45°). Those reflect an overhead panel, out of frame, whose own floor reflection is below the frame, and
a red emissive tile on the floor under them, plus a blue cylinder and a green sphere. The camera sees the metals
from above and the floor sees them from below, so the radiance an SSR hit reads (toward the camera) differs
strongly from the radiance toward the floor. The reference is path-traced at 4096 samples.

| renderer       | RMSE   |
| -------------- | ------ |
| three-new-ssgi | 0.0374 |
| three-new-ssr  | 0.0380 |

In the `three-new-ssr` image the floor reflection of the gold box shows the camera's view of its faces (red and
green reflections from above), where the path tracer shows a dark brown underside with a red tint, and the
floor reflection of the chrome sphere shows red streaks copied from the camera's view of its lower rim.

## R3.2 Re-evaluate the hit's specular for the reflected ray (kept)

- **Hypothesis.** A hit reads the previous frame's color at the hit pixel, which is the radiance leaving the hit
  toward the camera. For a glossy hit, the specular part of that color is wrong for the reflected ray. The scene
  pass computed that specular as `radiance · (F0·DFG.x + F90·DFG.y)(N·V_camera)`, where `radiance` is this node's
  own previous SSR result at the hit pixel. That term can be removed exactly and replaced by the specular toward
  `−R`.
- **Change.**
  - **Pre-pass (`ssgi.ts`, three-new-ssr only).** A `specular` MRT target stores
    `vec4(specularColorBlended, specularF90)` (F0 already blended by metalness). The node gets it and the
    metal/roughness texture as `hitSpecularNode` / `hitMaterialNode`, sampled at the hit UV.
  - **Hit shading (`NewSSRNode.js`).** At a front-facing hit (`N_hit·(−R) > 0`):
    `L = L_hit − S_prev(hit)·Fss(N·V_camera) + L₂·w₂`. `S_prev` is the previous resolve at the hit pixel.
    `Fss` uses three.js's own `DFGLUT` at the hit's roughness. `L₂·w₂` is a second screen-space bounce: one
    VNDF sample of the hit's lobe for the view direction `−R` (F0 = the hit's specular color, noise decorrelated
    from the primary ray's), traced with the same march, reading the previous frame's color on a hit and the
    environment (PMREM level 0) on a miss. `w₂ = F·G2/G1` makes `L₂·w₂` an unbiased estimate of the hit's
    specular toward `−R`. Back-face hits keep the visible side's radiance as a proxy, as before.
  - **Refactor.** The march and binary refinement moved into a `trace()` helper so the second bounce reuses
    them. The primary ray is unchanged (bit-identical results with the correction disabled).
- **Variants (RMSE).**

  | variant                                                  | metal-hit | steampunk mean | diag mean (old 11) |
  | -------------------------------------------------------- | --------- | -------------- | ------------------ |
  | round 2                                                  | 0.0380    | 0.0966         | 0.0295             |
  | `−S_prev·Fss(V_cam) + Env(reflect(R, N), rough)·Fss(−R)` | 0.0310    | 0.0970         | 0.0298             |
  | `−S_prev·Fss(V_cam) + L₂·w₂` (second bounce) — **kept**  | 0.0257    | 0.0929         | 0.0295             |
  | second bounce, skipped for dual-layer (hidden-side) hits | —         | +0.0008        | +0.0001            |

  The prefiltered-environment variant has no occlusion or inter-reflection for the second bounce, which costs
  `roughness-0` +0.0067 and `mirror`/`rough-10` +0.001. The second bounce keeps them.

- **Result (kept variant).** metal-hit 0.0380 → **0.0257**. Steampunk 0.0966 → **0.0929**: `camera`
  0.0805 → 0.0767, `roughness-25` 0.1086 → 0.1053, `roughness-50` 0.1041 → 0.0953, `roughness-100`
  0.0807 → 0.0769, but `roughness-0` 0.1090 → 0.1104 (see R3.3: the lens casing's scene-pass specular is
  not `S_prev`, so subtracting it is wrong there until R3.3). The other diagnostics move by at most ±0.0003.
  Cornell: `ssgi-metallic` 0.0504 → 0.0506, the others ±0.0001 (the chrome sphere's hits are the walls,
  which are diffuse, and its own highlight is direct light, which this does not touch). Overall mean
  0.0497 → **0.0479** (all 17 scenes), 0.0505 → 0.0493 over the 16 round-2 scenes.
- **Visual check.** The gold box's floor reflection turns from the camera's view of its faces (red/green
  reflections from above) into the dark brown underside of the reference. The chrome sphere's floor reflection
  keeps red streaks where the floor sees its hidden underside: those hits are dual-layer proxies (the visible
  surface's position and normal stand in for the hidden one), which no screen-space data can fix.
- **Cost.** At 640×480 (`pnpm cli bench`, same machine, before → after, per rendered frame of 16 pipeline
  frames): steampunk 182 → 268 ms (11.4 → 16.8 ms per pipeline frame), `rough-30` 171 → 211 ms
  (10.7 → 13.2 ms), metal-hit 145 → 169 ms (9.1 → 10.5 ms). The second march only runs for hits.

## R3.3 SSR radiance for transparent-flagged materials (kept)

- **Finding.** R2.5 added the steampunk `Lense_Casing` (opaque, but flagged `transparent`) to the pre-passes, so
  rays hit it and it has a G-buffer. But `builtinRadianceContext` returns the environment radiance unchanged for
  transparent-flagged materials, so the casing, which covers the whole front of the model, never received SSR
  in the scene pass. It reflected the unoccluded environment, and R3.2 subtracted the wrong radiance at hits
  on it, which is why `roughness-0` regressed there.
- **Change (`ssgi.ts`, three-new-ssr only).** The scene pass uses a local copy of `builtinRadianceContext`
  without the transparent check. `three-new-ssgi`/`three-ss-legacy` keep the three.js function.
- **Result.** Steampunk 0.0929 → **0.0854**: `camera` 0.0767 → 0.0715, `roughness-0` 0.1104 → 0.1023,
  `roughness-25` 0.1053 → 0.0960, `roughness-50` 0.0953 → 0.0855, `roughness-100` 0.0769 → 0.0715. The
  diagnostics have no transparent materials and are unchanged. Overall 0.0479 → **0.0457**. The casing now
  shows the dark, occluded reflections of the reference instead of the bright environment.
- **Residual.** The model shows more per-pixel noise than in round 2: the casing's SSR and the second bounce
  of R3.2 both add variance that 256 frames do not fully average out.

## R3.4 Second bounce for hidden-side hits (kept)

- **Hypothesis.** R3.2 skipped back-face hits and treated dual-layer hits (a ray inside a solid, behind the
  visible surface) as if they hit the visible surface. For both, the visible pixel's normal is not the hit
  surface's. On steampunk the floor next to the model reflects the model's underside, which the reference shows
  bright (metal reflecting the white floor) and `three-new-ssr` showed as the dark top side.
- **Change (`NewSSRNode.js`).** `trace()` also reports whether the hit was accepted only by the dual-layer test.
  For those hits and for back-face hits, the second bounce assumes the hidden surface faces the ray
  (`N = −R`); the material (F0, roughness) and the view-independent part still come from the visible pixel.
- **Result.** Steampunk 0.0854 → **0.0840** (`camera` 0.0715 → 0.0703, `roughness-0` 0.1023 → 0.1000,
  `roughness-25` 0.0960 → 0.0943, `roughness-50` 0.0855 → 0.0849, `roughness-100` 0.0715 → 0.0703).
  metal-hit 0.0257 → 0.0261: the floor sees the undersides of the gold box and the chrome sphere, whose true
  normals point down at the red tile, while `N = −R` sends the bounce back toward the grey floor. The other
  diagnostics move by ±0.0001 and the Cornell scenes by +0.0000–0.0003. Overall 0.0457 → **0.0453**.

## R3.5 Experiments that did not help (reverted)

All measured on top of R3.4 (steampunk mean 0.0840, diag mean 0.0292), except the first row.

| experiment                                                                                   | result                                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Cheap correction `L_hit + Fss·(Env(reflect(R, N)) − Env(reflect(−V_cam, N)))`, hit roughness | metal-hit 0.0375 (round 2: 0.0380), steampunk 0.0920, diag +0.0010: no occlusion or inter-reflection in either term |
| Also correct the multiple-scattering term `Fms·Ems·E_irr/π` for N·(−R)                       | every scene within ±0.0002                                                                                          |
| Environment for rays (misses, second bounce) prefiltered at sigma 0 instead of 0.04/0.05     | steampunk 0.0840 → 0.0849 (fireflies from RoomEnvironment's light panels)                                           |
| Same at sigma 0.02                                                                           | steampunk 0.0840 → 0.0843                                                                                           |
| 1024 instead of 256 accumulated frames                                                       | steampunk 0.0840 → 0.0835, diagnostics ±0.0001                                                                      |
| Sigma 0 with 1024 frames                                                                     | steampunk 0.0838, worse than 1024 frames at sigma 0.04                                                              |

The environment prefilter is therefore not a measurable error source: even with four times the frames the
unblurred environment loses to the materials' prefilter. Noise from the second bounce and the casing's SSR
accounts for about 0.0005 of the steampunk mean at 256 frames.

## Round 3 summary

| scene                              | baseline (three-new-ssgi) | round 2 | round 3 (final) |
| ---------------------------------- | ------------------------- | ------- | --------------- |
| ssr-diag-dielectric-0              | 0.0249                    | 0.0132  | 0.0131          |
| ssr-diag-dielectric-30             | 0.0222                    | 0.0128  | 0.0127          |
| ssr-diag-grazing                   | 0.0249                    | 0.0213  | 0.0212          |
| ssr-diag-metal-hit (new)           | 0.0374                    | 0.0380  | 0.0261          |
| ssr-diag-mirror                    | 0.0280                    | 0.0167  | 0.0168          |
| ssr-diag-occlusion                 | 0.0184                    | 0.0151  | 0.0152          |
| ssr-diag-offscreen                 | 0.0493                    | 0.0333  | 0.0331          |
| ssr-diag-rough-10                  | 0.0271                    | 0.0160  | 0.0160          |
| ssr-diag-rough-30                  | 0.0290                    | 0.0158  | 0.0158          |
| ssr-diag-rough-60                  | 0.0517                    | 0.0521  | 0.0521          |
| ssr-diag-sphere                    | 0.0676                    | 0.0608  | 0.0608          |
| ssr-diag-wall                      | 0.0879                    | 0.0677  | 0.0674          |
| ssr-steampunk-camera               | 0.0970                    | 0.0805  | 0.0703          |
| ssr-steampunk-camera-roughness-0   | 0.1172                    | 0.1090  | 0.1000          |
| ssr-steampunk-camera-roughness-25  | 0.1152                    | 0.1086  | 0.0943          |
| ssr-steampunk-camera-roughness-50  | 0.1103                    | 0.1041  | 0.0849          |
| ssr-steampunk-camera-roughness-100 | 0.0969                    | 0.0807  | 0.0703          |
| ssgi-basic                         | 0.0681                    | 0.0606  | 0.0606          |
| ssgi-rounded                       | 0.0519                    | 0.0431  | 0.0432          |
| ssgi-metallic                      | 0.0707                    | 0.0504  | 0.0507          |
| ssgi-animated                      | 0.0492                    | 0.0401  | 0.0402          |
| ssgi-animated-visible-walls        | 0.0486                    | 0.0398  | 0.0398          |

**Mean RMSE (`ssr-*`):**

|                 | overall (17 scenes) | overall (round-2 16) | diag (12) | diag (round-2 11) | steampunk  |
| --------------- | ------------------- | -------------------- | --------- | ----------------- | ---------- |
| baseline        | 0.0591              | 0.0605               | 0.0390    | 0.0392            | 0.1073     |
| round 2         | 0.0497              | 0.0505               | 0.0302    | 0.0295            | 0.0966     |
| round 3 (final) | **0.0453**          | **0.0465**           | 0.0292    | 0.0295            | **0.0840** |

Round 3 lowers the steampunk mean by 13 % and metal-hit by 31 %. The other diagnostics hit emissive (view-
independent) surfaces and do not change, as intended. The Cornell scenes move by at most +0.0003
(`ssgi-metallic`); their metal hits are rare and their view-dependent highlights come from direct light,
which this round does not re-evaluate.

**Cost.** At 640×480 (`pnpm cli bench`, round 2 → round 3, per rendered frame of 16 pipeline frames):
steampunk 182 → 268 ms (11.4 → 16.8 ms per pipeline frame), `rough-30` 171 → 193 ms (10.7 → 12.1 ms),
metal-hit 145 → 157 ms (9.1 → 9.8 ms). The extra cost is the second march for every hit, plus one more MRT
target in the pre-pass.

**Remaining error.**

- **Hidden geometry.** The floor next to the steampunk model now holds about 46 % of that scene's squared
  error. The reference shows the model's underside there as a dark red glow. Here the dual-layer hits proxy the
  underside with the visible surface's material, and the second bounce can only reach the floor visible in
  front of the model, which is brighter than the occluded floor under it. The same limit leaves streaks in the
  metal-hit floor reflections of the sphere's and box's undersides.
- **Third bounce.** The second bounce reads the camera-view radiance at its own hit, so metal-to-metal-to-metal
  paths keep the original error one bounce later.
- **Direct-light specular.** Hit colors still contain their camera-view highlights from punctual lights
  (the Cornell scenes; the SSR scenes are environment- and emitter-lit). Removing them needs the scene pass
  to output direct specular separately.
- **Off-screen geometry** (`wall`, `sphere`, `offscreen`, and the overhead panel in metal-hit) and
  **multiscatter energy compensation** (`rough-60`, R2.3) are unchanged from round 2.

---

# Optimization rounds (three-new-ssr-fast)

`three-new-ssr-fast` is built on `three-new-ssr`'s exact `ssgi.ts` / `NewSSRNode.js` pipeline; every optimization
is an `SSRFastOptions` flag (`packages/renderers/src/types.ts`) threaded through `ssgi.ts` into `NewSSRNode`'s
constructor, defaulting to reproducing `three-new-ssr` exactly. `packages/renderers/src/index.ts`'s options table
turns flags on one at a time. `three-new-ssr`, `three-new-ssgi`, and `three-ss-legacy` are untouched throughout.

**Gated scene set** (quality budget, ≤1% mean regression, ~3% worst-scene): the 12 `ssr-diag-*` scenes, the 5
`ssr-steampunk-camera*` scenes, and the 5 `ssgi-*` Cornell scenes (22 scenes, beauty pass), via
`pnpm cli quality-gate three-new-ssr three-new-ssr-fast --scenes <gated set>`.

**Benchmark scene set** (speed): `ssr-steampunk-camera`, `ssr-diag-rough-30`, `ssr-diag-metal-hit`,
`ssgi-metallic`, at 1920×1080 via `pnpm cli bench --renderers three-new-ssr,three-new-ssr-fast`.

## Benchmark noise (A/A)

With `three-new-ssr-fast`'s flags all unset (bit-identical to `three-new-ssr`), `pnpm cli bench` on the
benchmark scene set at 1920×1080, warmup 10 / measure 40, gives the run-to-run noise floor for every later
round's speedup number. Round 1's two independent runs (one accidentally overlapping the code edit, one clean;
see below) landed within 0.001 of each other on the mean, so ±3% single-run noise (matching `docs/PERF.md`'s
own note) is the working noise floor; a round is only kept if its speedup clears that.

## Round 1: clip SSR rays to the screen (kept)

- **Candidate.** Ported from the fork's `perf(three-ss): clip SSR rays to the screen` commit
  (`92e80f8efc`, `submodules/three.js`): the march's per-step bounds test
  (`xy.x<0 or xy.x>width or xy.y<0 or xy.y>height`, 4 comparisons + 3 ORs) is replaced by one precomputed ray
  parameter `sExit` (where the ray leaves the screen, in the same pixel-space `d0`/`xLen`/`yLen` the march
  already computes) and a single `s > sExit` comparison per step. Same exit point algebraically, so the output
  is unchanged. The fork's other candidate in the same log ("hoist the march noise and drop per-step
  divisions", `3059e4a1c7`) turned out to already be done in `NewSSRNode.js`: `sampleMarchNoise` is called once
  per pixel (not per step) and the march's `xSpan`/`ySpan` are computed once outside the loop, so there was
  nothing to port there.
- **Change (`NewSSRNode.js`).** New constructor option `clipRaysToScreen` (compile-time constant, default
  `false`). `trace()` computes `sExit` once per ray before the march loop when set, and the loop's bounds `If`
  branches on `s.greaterThan(sExit)` instead of the four-comparison screen-edge test. Applies to both the
  primary ray and the second bounce's `trace()` call (they share the same function).
- **Change (`ssgi.ts` / `index.ts` / `types.ts`).** New `SSRFastOptions.clipRaysToScreen`, threaded into
  `newSSR()`'s options only for `ssrMethod === 'new'`; `three-new-ssr-fast`'s row in `index.ts`'s options table
  sets it `true`.
- **Quality.** `pnpm cli quality-gate three-new-ssr three-new-ssr-fast` over the 22 gated scenes: mean RMSE
  0.0457 → 0.0457 (**-0.00%**, i.e. within float rounding), threshold 1%. Worst single-scene move:
  `ssr-diag-metal-hit` 0.0262 → 0.0261 (noise). **QUALITY OK.**
- **Speed.** `pnpm cli bench` on the benchmark scene set, 1920×1080, warmup 10 / measure 40 (two runs):

  | scene                  | three-new-ssr (ms) | three-new-ssr-fast (ms) | speedup         |
  | ---------------------- | ------------------ | ----------------------- | --------------- |
  | `ssgi-metallic`        | 1504–1710          | 1418–1539               | 1.06–1.11       |
  | `ssr-steampunk-camera` | 2076–2419          | 2014–2224               | 1.03–1.09       |
  | `ssr-diag-rough-30`    | 1916–2961          | 1882–2898               | 1.02–1.02       |
  | `ssr-diag-metal-hit`   | 1289–2023          | 1258–2230               | 0.91–1.03       |
  | **mean**               |                    |                         | **1.032–1.033** |

  Both runs agree on a ~3.2% mean speedup (the wider per-scene ranges above are from the first run partly
  overlapping the code edit, not a real regression on `metal-hit`; the second, clean run has every scene
  ≥1.02). Small but real and free: it never marches into a hit, so it costs nothing on quality and is pure
  upside for scenes whose rays run long before finding a hit or exiting.

- **Kept.** Positive on every scene in the clean run, zero quality cost, matches the task's named candidate.
- **Cumulative:** speedup **1.03×**, quality **0.00%** regression vs `three-new-ssr` (both cumulative, since
  this is the first round).

## Round 2: skip the second bounce's march for rough hits (kept)

- **Profiling first.** Before picking a candidate, tried fewer binary-refinement steps
  (`SSRFastOptions.binaryRefineSteps`, already wired in round 1's commit): 8 → 4 gave mean bench speedup
  1.009× (within the ~3% noise floor, i.e. not measurably faster) at +0.06% mean quality regression; 8 → 2
  gave 1.02–1.03-ish territory but pushed `ssr-diag-metal-hit` to **+5.7%** RMSE regression, over the ~3%
  worst-scene budget. The dense 1px march (`quality` = 1) dominates cost far more than its 8-step bisection,
  so this candidate was reverted (left at the default 8) rather than kept at a risky step count for a
  sub-noise-floor gain.
- **Candidate.** `redirectHitSpecular`'s second bounce (R3.2) traces a full second march (`trace()`, the same
  cost as the primary ray) for every hit, to re-evaluate the hit's specular toward `-R`. For a rough hit, a
  single VNDF sample is already a poor stand-in for a wide GGX lobe (R2's "wide-lobe visibility" gap, still
  the dominant remaining error on rough surfaces per the round-2/3 logs above), so marching for it buys little
  accuracy. `SSRFastOptions.secondBounceRoughnessCutoff`: above this hit roughness, skip `trace()` and read
  the prefiltered environment for the sampled direction `dir2` directly (still an unbiased VNDF sample of the
  lobe, weighted the same way; only the screen-space occlusion/inter-reflection term of that one sample is
  dropped).
- **Tuning.** Cutoff 0.6: mean regression +0.13%, `ssr-diag-rough-30` +4.4% (over the ~3% worst-scene budget:
  0.0158 → 0.0165 — that scene's hits include the rougher parts of its own floor, which are hit targets for
  other rays even though the _primary_ surface is roughness 0.3). Cutoff 0.8: mean regression **+0.05%**,
  every scene within ~0.5% of its `three-new-ssr` RMSE (worst: `ssr-diag-offscreen` 0.0331 → 0.0332).
  **QUALITY OK** at 0.8; kept at that value.
- **Speed.** `pnpm cli bench`, 1920×1080, warmup 10 / measure 40, cutoff 0.8 vs round 1:

  | scene                  | three-new-ssr (ms) | three-new-ssr-fast (ms) | speedup   |
  | ---------------------- | ------------------ | ----------------------- | --------- |
  | `ssgi-metallic`        | 1493               | 1260                    | 1.185     |
  | `ssr-steampunk-camera` | 2005               | 2007                    | 0.999     |
  | `ssr-diag-rough-30`    | 1914               | 1724                    | 1.110     |
  | `ssr-diag-metal-hit`   | 1294               | 1222                    | 1.059     |
  | **mean**               |                    |                         | **1.088** |

  Clearly above the ~3% noise floor. `ssr-steampunk-camera` doesn't move: its disc is roughness 0.5 and its
  model is mostly low-roughness metal, so few of its hits clear the 0.8 cutoff. `ssgi-metallic`/`rough-30`/
  `metal-hit` have plenty of rough dielectric hits (Cornell walls, floor) that now skip their second march.

- **Kept.** Clearly faster on 3 of 4 benchmark scenes, flat on the fourth, quality within budget.
- **Cumulative:** speedup **1.03 × 1.088 ≈ 1.12×**, quality **0.05%** regression vs `three-new-ssr` (worst
  single scene ≈0.5%, both well within the 1%/3% budgets).

## Round 3: fewer accumulated pipeline frames (time-to-image, kept)

- **Candidate.** `three-new-ssr` always runs `subFrames = ceil(SSR_ACCUM_FRAMES / effects.frames)` pipeline
  frames per rendered result (256 total). `SSRFastOptions.accumFrames` lowers that budget: fewer stochastic
  samples per rendered frame, at the same per-pipeline-frame cost, i.e. a time-to-image win rather than a
  per-frame one.
- **Tuning: the `ceil()` cliff.** `accumFrames: 128` looked reasonable (half) but the Cornell `ssgi-*`
  scenes have `effects.frames = 128`, so `ceil(256/128) = 2` and `ceil(128/128) = 1`: that halves their
  sample count too, not just the SSR diagnostics'. Result: mean regression **+1.54%** (over the 1% budget),
  driven by `ssgi-*` (e.g. `ssgi-basic` 0.0606 → 0.0621) and steampunk (`camera` 0.0703 → 0.0733) — both hit
  the `ceil()` cliff. **Reverted.**
- **Fix: stay above the Cornell cliff.** `accumFrames: 192` keeps `ceil(192/128) = 2` for `ssgi-*` (so those
  5 scenes are completely unaffected — confirmed identical RMSE below) while lowering the `ssr-diag-*`/
  `ssr-steampunk-*` scenes' `subFrames` from `ceil(256/16)=16` to `ceil(192/16)=12` (25% fewer pipeline
  frames, only where the risk is contained to scenes this task's diagnostics were built to measure).
- **Quality.** Mean RMSE 0.0457 → **0.0458 (+0.34%)**, threshold 1%. Every `ssgi-*` scene's RMSE is
  byte-for-byte unchanged (confirming the `ceil()` analysis). Worst single-scene move: `ssr-steampunk-camera`/
  `roughness-100` 0.0703 → 0.0715 (**+1.7%**), within the ~3% worst-scene budget. **QUALITY OK.**
- **Speed.** `pnpm cli bench`, 1920×1080, warmup 10 / measure 40, cumulative through round 3:

  | scene                  | three-new-ssr (ms) | three-new-ssr-fast (ms) | speedup   |
  | ---------------------- | ------------------ | ----------------------- | --------- |
  | `ssgi-metallic`        | 1503               | 1263                    | 1.189     |
  | `ssr-steampunk-camera` | 2005               | 1476                    | 1.358     |
  | `ssr-diag-rough-30`    | 1923               | 1297                    | 1.482     |
  | `ssr-diag-metal-hit`   | 1284               | 908                     | 1.414     |
  | **mean**               |                    |                         | **1.361** |

  `ssgi-metallic`'s speedup (1.189) matches round 2's alone (1.185, within noise) since its `subFrames` is
  unchanged — this round adds nothing there, as predicted. `steampunk`/`rough-30`/`metal-hit` jump
  substantially: the 25% fewer pipeline frames stacks multiplicatively with rounds 1-2's per-frame savings.

- **Kept.** Large win concentrated exactly where the quality budget has room, none of it on the Cornell
  scenes where the `ceil()` cliff would have made it risky.
- **Cumulative:** speedup **1.03 × 1.088 × (≈1.25 further) ≈ 1.36×** (measured directly above), quality
  **0.34%** regression vs `three-new-ssr` (worst single scene ≈1.7%, both within the 1%/3% budgets).

## Round 4: coarser march step density (kept)

- **Candidate.** `three-new-ssr` always marches at `quality = 1` (one step per texel of the ray's screen-
  space length; see round 1's log entry on `NewSSRNode.js`'s `totalStep`). `SSRFastOptions.quality` lets
  `three-new-ssr-fast` march more coarsely; binary refinement (still 8 steps, unchanged from round 2's
  revert) runs on top of whichever coarse bracket the march finds, so the final hit position is still
  refined to sub-texel precision — only the chance of _missing_ a thin/close crossing between two coarse
  steps gets worse as the steps get sparser.
- **Setting.** `quality: 0.6` (5 texels per 3 steps).
- **Quality.** Mean RMSE 0.0457 → **0.0459 (+0.57% cumulative)**, threshold 1%. Worst single scenes:
  `ssr-diag-metal-hit` 0.0262 → 0.0269 (**+2.7%**, the closest any round gets to the ~3% worst-scene budget:
  it has more, smaller reflected objects at oblique angles than the other diagnostics, so a coarser march is
  more likely to skip past one), `ssr-steampunk-camera-roughness-100`/`ssr-diag-mirror` ≈+1.8%. **QUALITY OK**,
  with headroom against the 1% mean budget (+0.43% left) but the worst-scene margin is now tight (+0.3% left
  before `metal-hit` would cross 3%) — noted for round 5, which should avoid stacking more error onto that
  scene specifically.
- **Speed.** `pnpm cli bench`, 1920×1080, warmup 10 / measure 40, cumulative through round 4:

  | scene                  | three-new-ssr (ms) | three-new-ssr-fast (ms) | speedup   |
  | ---------------------- | ------------------ | ----------------------- | --------- |
  | `ssgi-metallic`        | 1455               | 1184                    | 1.229     |
  | `ssr-steampunk-camera` | 2031               | 1060                    | 1.916     |
  | `ssr-diag-rough-30`    | 1896               | 859                     | 2.208     |
  | `ssr-diag-metal-hit`   | 1294               | 636                     | 2.035     |
  | **mean**               |                    |                         | **1.847** |

  By far the largest single-round win: the dense 1px march is the pipeline's dominant cost (per round 2's
  analysis), and this cuts it directly for every ray, not just a subset of hits.

- **Kept.** Nearly doubles the cumulative speedup for a manageable quality cost, but the `metal-hit` margin
  means round 5 should target a scene/mechanism this round didn't touch, not push `quality` (or anything else
  that affects the march density) any further.
- **Cumulative:** speedup **1.847×** (measured directly), quality **0.57%** regression vs `three-new-ssr`
  (worst single scene ≈2.7%, both within the 1%/3% budgets, worst-scene margin now tight).
