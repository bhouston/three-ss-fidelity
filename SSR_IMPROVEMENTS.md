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

(to be filled in as experiments are run; see the git history of this file.)
