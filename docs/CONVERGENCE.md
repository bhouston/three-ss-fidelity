# Move-then-stop convergence benchmark

The goal is a generic SSR/SSGI/TRAA stack that looks like the path-traced reference on general scenes, and that
converges quickly to a great result once the camera stops. The single-image results (`cli render` + `cli compare`)
score a cold start at a fixed frame count, which is not how the renderers are used: a cold start happens once, at
load. `cli converge` measures the case that matters.

## Method

`cli converge [--scenes] [--renderers] [--degrees 15] [--move-frames 90]`, per scene and renderer:

1. The camera orbits 15° about world Y into the scene's reference pose over 90 frames (smoothstep), so every
   temporal history (TRAA, denoisers, SSGI's multi-bounce feedback) is warm and in motion when it stops.
2. Frames 0, 1, 2, 4, 8, 16, 32, 64, 128, 255 and 256 after stopping are scored against the committed
   `three-gpu-pathtracer` reference.
3. `results/<scene>/beauty/converge-<renderer>.json` records the curve (RMSE and brightness bias per capture) and a
   summary:

| field       | meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `atStop`    | RMSE on the arrival frame: quality while moving                           |
| `after16`   | RMSE 16 frames after stopping: "converges quickly"                        |
| `final`     | RMSE at frame 256: converged quality                                      |
| `finalBias` | mean signed error relative to the reference's mean (−0.05 = 5 % too dark) |
| `flicker`   | RMSE between frames 255 and 256: residual temporal instability            |

The default covers every screen-space renderer (all are real-time now). The findings below were measured before the
consolidation: `three-new-ssr-rt` is now `three-new`, and `three-new-ssgi` (the fork's SSR) was removed.

## Reproducibility

Measurements are now exactly repeatable, so a change of any size is a real change:

- **Path-traced references** are rendered once, committed, and not re-rendered for comparisons. They use 4096
  samples (was 1024: re-rendering moved scores by up to 6 %) with `Math.random` replaced by a fixed-seed generator
  in the render process, so a re-render is bit-identical.
- **Frames are driven explicitly.** The headless `requestAnimationFrame` used to be a timer, so three's node frame
  counter (velocity history, per-frame noise) advanced at wall-clock pace and TRAA scenes varied ±15 % between runs.
  The CLI now runs one display frame (`headless.animationFrame()`) before each rendered frame, like a browser.
- **One process per renderer, scene and pass.** With deterministic frames, GPU state visibly leaked from one scene's
  renderer into the next scene's in the same process (issue #25), so no result may depend on what rendered before it.
- A small residual per-pixel nondeterminism remains on normal-mapped glTF scenes (issue #25). It moves the metric by
  at most 0.0001 RMSE.

## First results (38 scenes)

| renderer           | RMSE at stop | +16 frames | final  | brightness bias | flicker |
| ------------------ | ------------ | ---------- | ------ | --------------- | ------- |
| `three-new-ssr-rt` | 0.0703       | 0.0699     | 0.0699 | −6.9 %          | 0.0025  |
| `three-new-ssgi`   | 0.0802       | 0.0800     | 0.0803 | −7.0 %          | 0.0024  |

By scene group (`three-new-ssr-rt`):

| group   | scenes | final RMSE | brightness bias | stop → final |
| ------- | ------ | ---------- | --------------- | ------------ |
| `gi-`   | 9      | 0.1473     | −25.2 %         | 0.0 %        |
| `gltf-` | 3      | 0.0567     | −3.7 %          | +0.5 %       |
| higharc | 1      | 0.0810     | −2.9 %          | −0.2 %       |
| `ssgi-` | 5      | 0.0469     | −6.8 %          | −2.6 %       |
| `ssr-`  | 17     | 0.0432     | +1.1 %          | −2.0 %       |
| `traa-` | 3      | 0.0372     | −1.4 %          | +4.4 %       |

Findings:

1. **Convergence after stopping is already fast; the error is bias.** Error changes by 0–2.6 % between the arrival
   frame and frame 256. What limits quality is systematic error that waiting doesn't remove.
2. **Missing indirect light dominates.** The GI rooms are 25 % too dark on average, `gi-emitter-enclosure-crop` is
   black (its emitter is off screen) and `gi-room-high-albedo` 47 % too dark; the Cornell boxes are 5–10 % too dark.
   These are screen-space GI's structural limits (off-screen emitters, multi-bounce energy), not noise.
3. **Reflections are in good shape.** On the `ssr-` scenes `three-new-ssr-rt` has about half the error of
   `three-new-ssgi`'s SSR with near-zero bias.
4. **The running mean converges away from the reference on the TRAA scenes and Tokyo** (`traa-checker` 0.0331 at
   +16, 0.0388 at 256). Likely a pixel-filter mismatch between TRAA's jittered mean and the path tracer; not yet
   verified.
5. The earlier +6–9 % "regression" of `three-new-ssr-rt` on the Cornell boxes from the still-view running mean
   (`8805f3c`) was a cold-start artifact: with warm history it converges to 0.0610 on `ssgi-basic`, the moving
   average's best.

## Next steps

- One generic, scale-aware configuration for the flagship renderer (no per-scene effect tuning), measured here.
- Missing indirect light: off-screen and multi-bounce energy (e.g. an environment or probe fallback, issue #11).
- Pixel-filter match between TRAA's converged mean and the reference (finding 4).
- Weight the headline number toward general content (glTF models, rooms, outdoor, moving objects), and gate on these
  summaries instead of RMSE at frame N.
