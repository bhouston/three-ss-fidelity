# ss-fidelity plan

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
results/<scene>/     three-ss.png, three-gpu-pathtracer.png, delta.png, metrics.json (committed)
```

## Scene contract (`@ss-fidelity/scenes`)

- Scenes are built only from `three` core classes (shared `three.core.js`, so the same objects work in
  `WebGPURenderer` and in the pathtracer's `WebGLRenderer`).
- Each scene has a unique lower-case `name` (kebab-case, `_` allowed), a `description`, output `width`/`height`, and
  an async `create(ctx)` returning `{ scene, camera, effects }`. `ctx.loadGLTF(path)` / `ctx.loadHDR(path)` resolve
  assets from
  `submodules/three.js/examples/` (fetch in browser, fs in node).
- `effects` declares what the three-ss pipeline enables and its parameters (ssgi, ssr, ao, traa/smaa,
  tone mapping, frame count to converge). The pathtracer ignores `effects` except tone mapping/exposure.
- Animated content is frozen at a fixed time so both renderers see the same pose.
- `listSceneNames()` / `getScene(name)` are the registry API used by the CLI and viewer.

Initial scenes are every variation of the two examples:

| name                               | source                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `ssgi-basic`                       | webgpu_postprocessing_ssgi, scene "basic" (Cornell box, two boxes)    |
| `ssgi-rounded`                     | scene "rounded" (cone + sphere)                                       |
| `ssgi-metallic`                    | scene "metallic" (cone + mirror sphere)                               |
| `ssgi-animated`                    | scene "animated" (Michelle.glb, frozen pose)                          |
| `ssr-steampunk-camera`             | webgpu_postprocessing_ssr default (model roughness as authored)       |
| `ssr-steampunk-camera-roughness-*` | the example's roughness slider at a few fixed values                  |
| `higharc_dogwood`                  | webgpu_higharc_ao defaults (Dogwood.glb, sun, HDR sky, SSGI at ½ res) |

Debug outputs of the SSGI example (AO / GI / Direct / Reflections) are not scenes; they may later become
per-pass comparisons (e.g. pathtracer with 1 bounce vs three-ss "Direct").

## Fidelity decisions

Both renderers get the same `SceneSetup` objects (fresh per render); each adapter only translates what the other
renderer cannot express. Everything else is the example verbatim.

- **Camera**: the example's initial pose looking at its OrbitControls target (`SceneSetup.target`); aspect from the
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
  black to bounced rays). The SSR example's TSL `backgroundNode` gradient is data (`SceneSetup.gradientBackground`):
  three-ss builds the same TSL node; the pathtracer renders camera-ray misses black with alpha 0 and its blit composites
  the same gradient under the accumulated radiance before tone mapping.
- **Environment**: the SSR example's `RoomEnvironment` is data (`SceneSetup.environment`). three-ss builds the example's
  PMREM (`fromScene(room, 0.04)`); the pathtracer renders the same scene into a 256² half-float cube map with a
  `CubeCamera` and converts it to an importance-sampled equirect. Same `scene.environmentIntensity` (1.25). The PMREM's
  0.04 rad pre-blur is not applied on the pathtracer side.
- **Animated character**: `Michelle.glb` posed with an `AnimationMixer` frozen at t=1s before either renderer sees it;
  the pathtracer bakes the skinned pose into its static geometry.
- **Convergence**: three-ss renders `effects.frames` frames (128 for TRAA + temporal denoise scenes, measured converged
  at ~64; 16 for the deterministic SMAA/SSR scenes). The pathtracer renders 1024 full-frame samples (`--samples`), 8
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

## Headless rendering (CLI)

- three-ss: dawn (`webgpu` npm) globals + a minimal canvas whose texture is `COPY_SRC`, read back through a mapped
  buffer. An `Image` stand-in decodes data URIs with sharp (SMAANode's lookup textures) and
  `copyExternalImageToTexture` falls back to `writeTexture` for it.
- three-gpu-pathtracer: ANGLE (`@onirenaud/node-webgl`), `preserveDrawingBuffer`, `getImageData()` readback.
- Each renderer runs in its own child process (`render-process.ts`); dawn keeps the event loop alive, so it exits
  explicitly.
- Assets in node: glTF files are read from `submodules/three.js/examples`, images decoded with sharp into
  `DataTexture`s, and DRACOLoader's worker code runs in-thread with its decoder read from disk.
- The three.js fork removed the `cube_uv_reflection_fragment` chunk that three-gpu-pathtracer still includes (unused);
  the adapter registers it as empty.

## CLI

```
pnpm cli render  --scenes 'ssgi-*' --renderers '*' [--samples 1024] [--frames N]   # results/<scene>/<renderer>.png
pnpm cli compare --scenes '*'                        # writes delta.png + metrics.json (PSNR, RMSE, MAE)
pnpm cli list                                        # scene names
```

## Viewer

- `/` grid of scenes: thumbnails of both renders + delta, PSNR, sortable.
- `/scenes/$name` side-by-side / delta, metrics.
- `/live/$name/$renderer` renders the scene interactively in the browser (orbit controls) with
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
So the ~15 dB PSNR of the `ssgi-*` scenes against the pathtracer is the SSGI approximation itself
(weak bounce light and colour bleed in shadowed regions), not a harness artefact.
