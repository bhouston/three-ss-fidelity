# three-ss-fidelity plan

This document records the original multi-output design. The current suite renders beauty only and consumes the independent `fidelity-kit-blender` and `fidelity-kit-three-gpu-pathtracer` submodules. AO/direct pass APIs and CLI selectors described below are historical; see [README.md](../README.md) for the current workflow.

Goal: measure how close three.js screen-space effects (SSGI, SSR, plus the AO/depth/normal/velocity
pre-pass they depend on) get to a path-traced ground truth, per programmatic scene, with images,
delta images and metrics viewable in a website that can also show each scene live in either renderer.

## Layout

```
submodules/three.js              bhouston/three.js @ ssgi-traa-redesign (SSGI/SSR/TRAA nodes)
submodules/three-gpu-pathtracer  gkjohnson/three-gpu-pathtracer (ground truth)
packages/scenes      @ss-fidelity/scenes     renderer-agnostic scene definitions + registry (browser + node)
packages/renderers   @ss-fidelity/renderers  three-ss (WebGPURenderer + SSGI/SSR pipeline) and
                                             three-gpu-pathtracer adapters; take a canvas, work in browser + node
packages/cli         @ss-fidelity/cli        yargs + yargs-file-commands + clidoc; headless GPU (dawn `webgpu`,
                                             `@onirenaud/node-webgl` ANGLE), render + compare (sharp)
packages/viewer      @ss-fidelity/viewer     TanStack Start + Router: results listing, scene detail, live views
fidelity-results/<scene>/<pass>/  three-ss.avif, three-gpu-pathtracer.avif, delta.avif, metrics.json (committed)
```

## Scene contract (`@ss-fidelity/scenes`)

- Scenes are built only from `three` core classes (shared `three.core.js`, so the same objects work in
  `WebGPURenderer` and in the pathtracer's `WebGLRenderer`).
- Each scene has a unique lower-case `name` (kebab-case, `_` allowed), a `description`, output `width`/`height`, and
  an async `create(ctx)` returning `{ scene, camera, effects }`. `ctx.loadGLTF(path)` / `ctx.loadHDR(path)` resolve
  assets from
  `submodules/three.js/examples/` (fetch in browser, fs in node).
- `effects` declares what the three-ss pipeline enables and its parameters (ssgi, ssr, ao,
  tone mapping, frame count to converge). The pathtracer ignores `effects` except tone mapping/exposure.
- Animated content is frozen at a fixed time so both renderers see the same pose.
- `listSceneNames()` / `getScene(name)` are the registry API used by the CLI and viewer.

Initial scenes are every variation of the two examples:

| name                   | source                                                                |
| ---------------------- | --------------------------------------------------------------------- |
| `cornell-box-basic`    | webgpu_postprocessing_ssgi, scene "basic" (Cornell box, two boxes)    |
| `cornell-box-rounded`  | scene "rounded" (cone + sphere)                                       |
| `cornell-box-metallic` | scene "metallic" (cone + mirror sphere)                               |
| `cornell-box-animated` | scene "animated" (Michelle.glb, frozen pose)                          |
| `steampunk-camera`     | webgpu_postprocessing_ssr default (model roughness as authored)       |
| `higharc_dogwood`      | webgpu_higharc_ao defaults (Dogwood.glb, sun, HDR sky, SSGI at ½ res) |

Debug outputs of the SSGI example (AO / GI / Direct / Reflections) are not scenes but render passes.

## Render passes

A pass is a render setting applied to every scene (`passNames` in `@ss-fidelity/renderers`, `RendererOptions.pass`),
not a scene setting. Each scene × pass is compared separately in `fidelity-results/<scene>/<pass>/`.

| pass     | three-ss                            | three-gpu-pathtracer       |
| -------- | ----------------------------------- | -------------------------- |
| `beauty` | the full pipeline of `SceneEffects` | full path tracing          |
| `direct` | no SSGI / SSR / temporal denoise    | single scatter             |
| `ao`     | SSGINode AO output                  | `AmbientOcclusionMaterial` |

**direct** is the SSGI example's "Direct" output against one-scatter path tracing: a calibration baseline that
separates shading-model, shadow and environment-lighting differences from the SSGI/SSR approximation.
three-gpu-pathtracer with `bounces = 1` samples lights and the environment only through next-event estimation;
the BSDF-sampled half of the MIS-weighted environment is added when the next ray is traced, so env-lit scenes came
out too dark (18 dB off on `steampunk-camera`). The adapter uses 2 bounces and patches the shader
(`traceDirectOnly`) to stop the second ray at any surface: it only collects environment misses and light hits.
Point-light scenes match plain `bounces = 1` (50 dB, noise). Measured differences:

- three-ss lights with the environment unoccluded (IBL); the pathtracer shadow-rays it. Dominant on the SSR scenes
  (15–17 dB) and higharc (19.6 dB); it is what AO addresses in `beauty`.
- The `cornell-box-*` scenes (≈30 dB): raster shadow maps vs exact shadows, Lambert vs the pathtracer's diffuse, and the
  three-ss-only `AmbientLight`.
- In `direct`, emissive meshes are visible but do not illuminate other surfaces: rasterization does not gather them, and the direct-only path-tracer patch stops before secondary-surface emission. In `beauty`, SSGI gathers their visible radiance and the path tracer collects emission on BSDF-sampled surface hits (without sampling mesh emitters as explicit lights). See [the GI investigation](history/GI-INVESTIGATION.md).

**ao** compares SSGINode's AO (the SSGI example's "AO" output) with three-gpu-pathtracer's `AmbientOcclusionMaterial`
(cosine-weighted hemisphere rays against the scene BVH; a hit within the radius occludes, occluders are infinitely
thick), rasterized over the baked scene geometry, 1024 rays per pixel. Settings (`passEffects`):

- Radius: `SceneInstance.aoRadius` in world units (scene scale is scene data): 4 for the Cornell box, 0.25 for the
  steampunk camera, 120" for higharc. SSGI samples in world space (`useScreenSpaceSampling: false`), `aoIntensity` 1
  (linear visibility), no distance fade; slice/step counts, thickness and resolution scale stay the scene's (the ssgi
  example's 2 slices / 8 steps for the SSR scenes), with temporal denoising and 128 frames.
- Written linear, no tone mapping; background = 1 (unoccluded) on both sides. Pixel centres, no AA jitter.
- Transparent objects are skipped by the three-ss pre-pass, so the pathtracer hides them from the occluders too.
- AO ignores materials: `cornell-box-rounded`/`cornell-box-metallic` and the SSR roughness variants have identical results.

Results: 18.0–18.6 dB (Cornell box), 19.4 dB (steampunk camera), 19.0 dB (higharc). Measured differences:

- SSGI darkens open flat surfaces the pathtracer sees as unoccluded, depending on view angle: 0.85–0.93 on parts of the
  Cornell walls and the steampunk floor (exactly 1.0 in the pathtracer), and across higharc's ground plane.
- higharc runs SSGI and its denoiser at half resolution: its AO is much softer than the ray-traced reference.
- Normal maps: the pathtracer AO uses geometric/vertex normals only.

## Fidelity decisions

Both renderers get the same `SceneInstance` objects (fresh per render); each adapter only translates what the other
renderer cannot express. Everything else is the example verbatim.

- **Camera**: the example's initial pose looking at its OrbitControls target (`SceneInstance.target`); aspect from the
  scene's `width`/`height` (640×480).
- **Tone mapping / output**: `effects.toneMapping`/`toneMappingExposure` on both renderers (none for the SSGI scenes,
  ACES for the SSR scenes), sRGB output. The pathtracer's final blit is replaced by one that tone maps and encodes with
  three's own `tonemapping_fragment`/`colorspace_fragment`.
- **Lights**: point lights are physically identical (candela, inverse square, same `distance` window). The SSGI example's
  `AmbientLight('#0c0c0c')` (≈0.004 linear) is kept for three-ss; the pathtracer has no ambient light, so it is a small
  known bias in dark areas. Raster shadow maps vs exact shadows are part of what is measured.
- **Emissive lamp** (SSGI example's white disc under the point light): an emitter in both renderers. It is part of the
  scene the example renders, SSGI does gather its (on-screen) emission, and the pathtracer integrates it fully, so the
  difference is the screen-space approximation, not a double count. Deviation from the example: the disc casts shadows
  (`castShadow = true`), because the pathtracer cannot make it transparent to the point light only; without it the
  ceiling around the disc was lit in three-ss and shadowed in the pathtracer.
- **Background**: a `scene.background` colour never lights the scene in either renderer (the pathtracer only uses it for
  camera rays; with no `scene.environment` its environment intensity is 0, so the open front of the Cornell box is
  black to bounced rays). The SSR example's TSL `backgroundNode` gradient is data (`SceneInstance.gradientBackground`):
  three-ss builds the same TSL node; the pathtracer renders camera-ray misses black with alpha 0 and its blit composites
  the same gradient under the accumulated radiance before tone mapping.
- **Environment**: the SSR example's `RoomEnvironment` is data (`SceneInstance.environment`). three-ss builds the example's
  PMREM (`fromScene(room, 0.04)`); the pathtracer renders the same scene into a 256² half-float cube map with a
  `CubeCamera` and converts it to an importance-sampled equirect. Same `scene.environmentIntensity` (1.25). The PMREM's
  0.04 rad pre-blur is not applied on the pathtracer side.
- **Animated character**: `Michelle.glb` posed with an `AnimationMixer` frozen at t=1s before either renderer sees it;
  the pathtracer bakes the skinned pose into its static geometry.
- **Convergence**: three-ss renders `effects.frames` frames (128 for TRAA + temporal denoise scenes, measured converged
  at ~64; 16 for the SSR scenes). The pathtracer renders 1024 full-frame samples (`--samples`), 8
  bounces, no glossy filtering, no fades or low-res preview.
- **Known model difference**: with GI off on both sides (three-ss without the GI context, pathtracer with 1 bounce) the
  pathtracer's rough dielectric diffuse is ~15–25% darker than three's Lambert (e.g. white floor under the light:
  0.157 vs 0.184 linear; analytic Lambert 0.188). three-gpu-pathtracer uses a Disney-style diffuse weighted by
  (1 − dielectric Fresnel). This baseline bias is in every delta; a future per-pass "direct" comparison can calibrate
  it out.
- **higharc_dogwood** (webgpu_higharc_ao at its defaults: SSGI on, SSR off, quality medium, radius 120", intensity
  1 → `giIntensity` π²/2, resolution scale ½ for SSGI and its temporal chains, AO/GI distance fade, ACES): the
  `blouberg_sunrise_2_1k.hdr` equirect is `scene.environment` and `scene.background` (both intensity 0.6) in both
  renderers; the pathtracer samples it natively. Camera near/far are the values the example's `animate()` sets for the
  initial orbit distance (not updated while orbiting in live views). The three-ss render matches the example in Chrome
  at 49.6 dB. Known differences:
  - The raster far plane (`distance + 4·span`) clips the 20·span ground plane, so the top ~30 rows show the HDR
    horizon in three-ss (and the example) but ground in the pathtracer, which has no far clip. Kept as in the example;
    it costs ~4.4 dB of the scene's PSNR (21.7 dB overall, 26.1 dB below row 32).
  - Dogwood.glb uses RGB (`VEC3`) vertex colours and `EXT_mesh_gpu_instancing` InstancedMeshes. Upstream
    three-gpu-pathtracer renders the former black and ignores `instanceMatrix`; the submodule therefore tracks
    `bhouston/three-gpu-pathtracer@ss-fidelity`, which merges the fixes proposed upstream in
    gkjohnson/three-gpu-pathtracer#858 (vertex colour merge) and #859 (InstancedMesh).

## Blender Cycles (second reference)

`blender` is a second ground-truth renderer alongside `three-gpu-pathtracer`: an independent, widely-trusted path
tracer that lets us separate "screen-space approximation error" from "our reference renderer's own bias" (BSDF
choice, shadow handling, etc. — see Fidelity decisions above). It isn't a screen-space renderer and isn't built via
`createRenderer()`/`RendererName` (`packages/renderers`): it renders in one batch call, not `LiveRenderer`'s
incremental frame loop, so it's a CLI-only renderer name (`RenderJob.renderer: RendererName | 'blender'`).

- `pnpm cli render --renderers blender --scenes <name> --passes beauty` (or `direct`) shells out to Blender
  (`$BLENDER_EXECUTABLE`, else a discovered `/Applications/Blender*.app` on macOS, else `blender` on PATH) in
  `--background --factory-startup --python packages/cli/blender/render.py` mode and writes
  `fidelity-results/<scene>/<pass>/blender.avif`, same as any other renderer. `--samples` sets Cycles' max sample count
  (unbiased: no denoising, no clamping, box filter — matching the pathtracer's own settings). Adaptive sampling
  (`adaptive_threshold` 0.01) is on, so converged pixels stop sampling before the max — free speed, not a bias
  source, since it only changes when sampling stops, not what a fully sampled pixel's value would be.
- The scene is exported as glTF (`GLTFExporter`) plus its lighting environment as an equirect EXR
  (`environmentEquirect()` in `packages/renderers/src/pathtracer.ts`, reusing the same cube-camera bake the pathtracer
  uses for `SceneInstance.environment`, then `CubeToEquirectGenerator`). Blender path traces to a linear EXR, which
  `packages/cli/src/blender.ts`'s `encodeLinear` composites under the scene's background, ACES-tone-maps and
  sRGB-encodes in Node, bit-matching three.js's own blit (`encodeLinear` is unit tested without a Blender binary;
  actually invoking Blender is not exercised by CI, which has no Blender install).
- `direct` gives Cycles 0 bounces (`max_bounces`/`diffuse_bounces`/`glossy_bounces`/`transmission_bounces` all 0).
  Cycles still multiple-importance-samples lights and the world at the camera-ray hit even with 0 bounces (unlike
  `three-gpu-pathtracer`, which needs its own `traceDirectOnly` shader patch to emulate the same "no secondary
  bounce" definition), so it isn't bit-identical in scope to the pathtracer's `direct` pass, only comparable in
  intent: first-hit shading with light/environment visibility, no indirect light.
- The `ao` pass is not supported (no Cycles equivalent to `AmbientOcclusionMaterial`); `--passes ao` with
  `--renderers blender` throws. `--motion` and `--ssr-debug` are screen-space-only diagnostics and also throw for
  `blender`.
- `pnpm cli compare` defaults to comparing the screen-space renderers against `three-gpu-pathtracer`, unchanged.
  `--reference blender` compares against Blender instead — by default every renderer but Blender itself, so it
  covers both "screen-space renderers vs. Blender" and "three-gpu-pathtracer vs. Blender" in one run — writing
  `delta-<renderer>-vs-blender.avif` / `metrics-<renderer>-vs-blender.json` so these don't collide with the default
  `three-gpu-pathtracer`-referenced files. `pnpm cli compare --renderers blender` (default reference) compares
  Blender itself against `three-gpu-pathtracer`, writing the plain `delta-blender.avif` / `metrics-blender.json`.
- Known differences from `three-gpu-pathtracer`: different BSDF (Blender's Principled BSDF vs.
  three-gpu-pathtracer's Disney-style diffuse, see the baseline-bias note above), Blender's own MIS/light-sampling
  implementation, and no shared code path at all below the exported glTF/EXR — the two are fully independent
  implementations, which is the point of using Blender as a second reference.

## Headless rendering (CLI)

- three-ss: dawn (`webgpu` npm) globals + a minimal canvas whose texture is `COPY_SRC`, read back through a mapped
  buffer.
- three-gpu-pathtracer: ANGLE (`@onirenaud/node-webgl`), `preserveDrawingBuffer`, `getImageData()` readback.
- Each renderer runs in its own child process (`render-process.ts`); dawn keeps the event loop alive, so it exits
  explicitly.
- Assets in node: glTF files are read from `submodules/three.js/examples`, images decoded with sharp into
  `DataTexture`s, and DRACOLoader's worker code runs in-thread with its decoder read from disk.
- The three.js fork removed the `cube_uv_reflection_fragment` chunk that three-gpu-pathtracer still includes (unused);
  the adapter registers it as empty.

## CLI

```
pnpm cli render  --scenes 'cornell-box-*' --passes '*' --renderers '*' [--samples 1024] [--frames N]
                                                     # fidelity-results/<scene>/<pass>/<renderer>.avif
                                                     # --renderers blender also renders with Blender Cycles
pnpm cli compare --scenes '*' --passes '*'           # writes delta.avif + metrics.json (PSNR, RMSE, MAE)
                                                     # --reference blender compares against Blender instead
pnpm cli list                                        # scene names
```

## Viewer

- `/` grid of scenes for one pass (`?pass=`): thumbnails of both renders + delta, PSNR, sortable.
- `/scenes/$name` side-by-side / delta, metrics, one tab per pass.
- `/scenes/$name/live/$renderer` renders the scene interactively in the browser (orbit controls) with
  `three-ss` or `three-gpu-pathtracer` (progressive).

## Risks

- Headless dawn running the full SSGI/TRAA pipeline, and pathtracer on ANGLE float render targets.
  Mitigated by a spike before building on it.
- Matching lighting conventions (point light decay/intensity, emissive, environment from
  `RoomEnvironment` PMREM vs equirect, TSL background nodes) between renderers so deltas measure the
  screen-space approximation and not setup mismatches.

## Validation of the three-ss pipeline

The headless three-ss adapter was checked against `webgpu_postprocessing_ssgi.html` running in Chrome
(WebGPU, 640×480, same camera, 200+ frames): Combined matches at 51 dB outside the lamp fixture (the
lamp differs only because the scene sets `castShadow` on it, see above); GI-only 34 dB, AO-only 36 dB.
So the ~15 dB PSNR of the `cornell-box-*` scenes against the pathtracer is the SSGI approximation itself
(weak bounce light and colour bleed in shadowed regions), not a harness artefact.
