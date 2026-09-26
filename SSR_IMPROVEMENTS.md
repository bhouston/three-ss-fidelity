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
