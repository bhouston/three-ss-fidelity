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
- Each scene has a unique kebab-case `name`, a `description`, output `width`/`height`, and an async
  `create(ctx)` returning `{ scene, camera, effects }`. `ctx.loadGLTF(path)` resolves assets from
  `submodules/three.js/examples/` (fetch in browser, fs in node).
- `effects` declares what the three-ss pipeline enables and its parameters (ssgi, ssr, ao, traa/smaa,
  tone mapping, frame count to converge). The pathtracer ignores `effects` except tone mapping/exposure.
- Animated content is frozen at a fixed time so both renderers see the same pose.
- `listSceneNames()` / `getScene(name)` are the registry API used by the CLI and viewer.

Initial scenes are every variation of the two examples:

| name                               | source                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| `ssgi-basic`                       | webgpu_postprocessing_ssgi, scene "basic" (Cornell box, two boxes) |
| `ssgi-rounded`                     | scene "rounded" (cone + sphere)                                    |
| `ssgi-metallic`                    | scene "metallic" (cone + mirror sphere)                            |
| `ssgi-animated`                    | scene "animated" (Michelle.glb, frozen pose)                       |
| `ssr-steampunk-camera`             | webgpu_postprocessing_ssr default (model roughness as authored)    |
| `ssr-steampunk-camera-roughness-*` | the example's roughness slider at a few fixed values               |

Debug outputs of the SSGI example (AO / GI / Direct / Reflections) are not scenes; they may later become
per-pass comparisons (e.g. pathtracer with 1 bounce vs three-ss "Direct").

## CLI

```
pnpm cli render  --scenes 'ssgi-*' --renderers '*'   # writes results/<scene>/<renderer>.png
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
