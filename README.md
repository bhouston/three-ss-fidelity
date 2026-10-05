# three-ss-fidelity

three-ss-fidelity measures how close three.js screen-space effects (SSGI, SSR, TRAA, and the AO/depth/normal/velocity
pre-pass they depend on) get to a path-traced ground truth. It is the test harness for significantly improving those
effects, which is done in a fork of three.js. Each scene is rendered by the screen-space pipeline and by
[three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer). The images are diffed and scored, and the
results can be browsed in a web viewer.

The suite follows the design of the sibling [material-fidelity](https://github.com/bhouston/mtlx-fidelity) project: a
scene registry, a renderer package, a CLI that renders, and [fidelity-kit](https://github.com/bhouston/fidelity-kit)
for scoring, diffing, and viewing the committed results.

Workflow rules (issues, branches, Conventional Commits, PRs, required checks) are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## How the work is done

1. Change an effect in `submodules/three.js`, or in a vendored node under `packages/renderers/src/` (see below).
2. Render the affected scenes: `pnpm cli render --scenes 'diag-*,steampunk-camera' --renderers three-new-baseline`.
3. Score them against the path tracer: `pnpm exec fidelity-kit process fidelity-results`.
4. Check for regressions: `pnpm cli quality-gate <baseline> <candidate>` (per-scene PSNR-drop threshold, default 0.1 dB), e.g.
   against results rendered before the change into another `--results`.
5. For temporal and real-time work, also run `pnpm cli converge` (image quality after a camera move) and
   `pnpm cli bench` (frame time).
6. Commit the updated `fidelity-results/` and record the findings in the matching doc (see [Documentation](#documentation)).

Improvements go into `three-new`; `three-current` (stock three.js) stays fixed as the baseline. What `three-new` does
and why is in [docs/THREE-NEW.md](docs/THREE-NEW.md).

## Repository layout

```
submodules/three.js              bhouston/three.js @ ssgi-traa-redesign: the fork with the SSGI/SSR/TRAA nodes
submodules/three-gpu-pathtracer  bhouston/three-gpu-pathtracer @ ss-fidelity: the ground-truth renderer
submodules/fidelity-kit-blender bhouston/fidelity-kit-blender: reusable Blender Cycles rendering
submodules/fidelity-kit-three-gpu-pathtracer bhouston/fidelity-kit-three-gpu-pathtracer: reusable legacy WebGL rendering
packages/scenes     @ss-fidelity/scenes     renderer-agnostic scene definitions + registry (browser and node)
packages/renderers  @ss-fidelity/renderers  screen-space pipeline and path-tracer adapters behind one LiveRenderer API
packages/cli        @ss-fidelity/cli        headless render / converge / bench / quality-gate
packages/runtime    @ss-fidelity/runtime    backend-independent capture / benchmark runners + reports
packages/playground @ss-fidelity/playground interactive live lab (pnpm live)
fidelity-results/<scene>/beauty/                     committed render output; scored/viewed with fidelity-kit
docs/                                       THREE-NEW.md, plans, benchmark write-ups; docs/history/ holds the experiment logs
scripts/                                    one-off metric and experiment scripts (gi-*, ssr-*, traa-*) + check-pr.mjs
```

The workspace overrides `three` and `three-gpu-pathtracer` with `workspace:*`, so every package, and three-gpu-pathtracer itself, uses the fork
in `submodules/three.js`. There is only ever one copy of three.

### `packages/scenes`

- `src/types.ts` holds the contract. A `SceneDefinition` has a `name`, `description`, `width`/`height` and an async
  `create(ctx)`, which returns a `SceneSetup`: the scene, camera, orbit `target`, `effects` (SSGI/SSR parameters,
  `temporalDenoise`, tone mapping, `frames` to render before capture).
- `src/index.ts` is the registry (`listSceneNames`, `getScene`). Scene families each live in their own file:
  `ssgi.ts`, `ssr.ts` (steampunk), `ssr-diagnostics.ts` (`diag-*`), `gi-diagnostics.ts` and
  `gi-visible-walls.ts` (`gi-*`), `traa-diagnostics.ts` (`traa-*`), `gltf-examples.ts` (`gltf-*`), `higharc.ts`.
- Assets (glTF, HDR) are loaded from paths relative to `submodules/three.js/examples/`. `src/node.ts` provides the
  node-side `SceneContext`. Repository assets use the `suite-assets/` prefix, served by the playground from `assets/`.
- **To add a scene:** add a `SceneDefinition` to the family file (or a new file), make sure it is spread into the
  registry in `index.ts`, add or extend the family's `*.test.ts`, then render the path-tracer reference.
- Scene IDs describe the content: `cornell-box-*`, `steampunk-camera`, and `diag-*`. Archived
  measurements under `docs/history/` retain the scene IDs used when they were captured.
- `cornell-box-basic-oblique` preserves the basic Cornell box and uses an elevated oblique camera captured in the live
  viewer at 960×540. Select it in the live lab or with `pnpm cli render --scenes cornell-box-basic-oblique` to reproduce
  the screen-space artifact view with any renderer.

### Complex glTF scenes and offline lightmap UVs

`complex-models.ts` adds `khronos-transmission-test`, `model-bedroom`, `model-breakfast-room`, `model-coffee-maker`,
`model-contemporary-bathroom`, `model-country-kitchen`, `model-grey-and-white-room`, and `model-headphone-with-stand`.
Models retain their original dimensions, physical materials and embedded cameras. The interiors are enclosed rooms
and have no IBL, because the unshadowed environment term would light them from inside. A warm, shadow-casting
directional sun through each room's window and the models' own interior emitters light them; the window openings show
black. Source window-emitter proxies are hidden to let sunlight enter, and transmissive glass does not cast opaque
raster shadows. Studio HDR lights the products and
transmission test. The headphone also has a glossy floor. Licenses, attribution, source hashes and preprocessing details
live in [assets/complex-scenes](assets/complex-scenes/README.md).

Each of these eight scenes also has a `-w` variant (for example, `model-bedroom-w`). It uses the same GLB and
whitens materials during scene setup: color textures and vertex tint are removed, while alpha cutouts, transmission,
roughness, metalness and normal detail remain. Emission is neutralized at the same luminance. Cameras, window sunlight
and precomputed atlases are identical to the colored variant; the headphone's floor is also white.

[glTF Transform](https://gltf-transform.dev/modules/functions/functions/unwrap) already provides an xatlas-based
unwrap CLI and a separately installable core/transform SDK, so this suite uses it instead of adding another repository:

```sh
pnpm dlx @gltf-transform/cli unwrap input.glb output.glb --texcoord 1 --overwrite --group-by scene
node scripts/preunwrap-scenes.mjs ../three-gpu-pathtracer-fidelity/submodules
pnpm cli render --scenes 'model-*,khronos-transmission-test' --renderers three-gpu-pathtracer
```

The import script additionally splits mesh instances, configures atlas resolution and chart padding, and writes
`scene.extras.lightmapAtlas = { version: 1, size: 2048, padding: 8 }`. Three.js loads `TEXCOORD_1` as `uv1` and the
extras as `userData`. Rare collapsed UV triangles receive separate padded islands, with metadata reporting the
conservative resulting gap (7 pixels on repaired assets). The baker validates the marked group's UVs and reserves its shared atlas as one tile, alongside
any procedural geometry. It skips projection/chart generation for that group, while retaining the runtime unwrap
for unmarked, invalid or repeated mesh geometry. A secondary UV channel alone is insufficient evidence of a shared,
nonoverlapping lightmap atlas: it can also be used by material textures. Multiple imported groups get separate tiles.

### `packages/renderers`

- `src/types.ts` defines `rendererNames`, `RendererOptions` and the
  `LiveRenderer` interface (`render`/`setSize`/`setCamera`/`dispose`).
- `src/index.ts` has `createRenderer`, which dispatches a renderer name to its adapter.
- `src/three-new.ts` is the improved pipeline (WebGPURenderer + SSGI/SSR/TRAA/denoise), `src/three-current.ts` the
  stock r186 one, and the WebGL path tracer calls `fidelity-kit-three-gpu-pathtracer` directly.
- `src/ssr/NewSSRNode.js` and `src/ssgi-fast/SSGINode.js` are vendored nodes. They are developed here instead of in
  the submodule.

| Renderer                     | What it is                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `three-gpu-pathtracer`       | Ground truth (default 4096 spp, seeded).                                                                    |
| `three-current`              | Unmodified three.js r186 from npm (`three@0.186.1`) with its stock SSGI/SSR example pipelines.              |
| `three-new-light-probe-ddgi` | Baked diffuse probes with DDGI visibility weighting and relocation ([research](docs/DDGI_RESEARCH.md)).     |
| `three-new-vpl`              | Surface virtual point lights with RIS and BVH visibility ([research](docs/VPL_RESEARCH.md)).                |
| `three-new-light-probe`      | Automatically fitted baked SH diffuse probe grid replacing SSGI ([research](docs/LIGHT_PROBE_RESEARCH.md)). |
| `three-new`                  | The fork + vendored SSGI/SSR nodes, real-time, TRAA ([docs/THREE-NEW.md](docs/THREE-NEW.md)).               |

### `packages/cli`

Commands are the files in `src/commands/`, loaded by `yargs-file-commands`. Each render runs in its **own child
process** (`render-process.ts`, `bench-process.ts`), because dawn and ANGLE don't share a process reliably and GPU
state leaked between scenes. Headless GPU comes from `src/headless/webgpu.ts` (dawn, the `webgpu` package) and
`src/headless/webgl.ts` (`@onirenaud/node-webgl`, ANGLE). `Math.random` is seeded, so renders are reproducible.

The reference path tracer renders directly in Node, without launching Puppeteer or a browser:

| CLI renderer           | Native backend                                                                           | Integration                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `three-gpu-pathtracer` | [`@onirenaud/node-webgl`](https://github.com/RenaudRohlinger/node-webgl) (ANGLE, WebGL2) | Canvas and DOM shims, with `getImageData()` pixel readback. |

After building, try the reference renderer with a small render into an isolated output directory:

```sh
pnpm cli render --scenes cornell-box-basic --renderers three-gpu-pathtracer --width 64 --height 64 --samples 16 --output /tmp/ss-fidelity-native-cli
```

The reference renderer uses `--renderers three-gpu-pathtracer`. The CLI waits for the requested number of accumulated
samples, including shader compilation calls that do not accumulate a sample. It fails if sampling makes no
progress for two minutes, and SIGINT/SIGTERM cancel capture before an image is saved. Screen-space captures
continue to count rendered frames.

This avoids browser startup, a page server, and page-to-Node communication for CLI rendering. Faster total runs
are plausible, especially for short jobs, but a speedup over Puppeteer requires a matched benchmark on the same
GPU, scene, resolution, and sample count. The two path tracers use independent implementations, so comparing
their timings does not measure native versus browser overhead. The WebGPU adapter currently approximates
gradient backgrounds with their center color; differences between its images and the WebGL reference can also
come from renderer behavior. Browser tests still verify the interactive viewer.

Verification on macOS arm64 with Node 26.3.0, using `cornell-box-basic` at 64×64 on `origin/main` revision
`b07d48cbf15`: the WebGPU CLI produced a nonblack 16-sample image. Legacy WebGL CLI runs with both 16 and 1024
requested samples produced all-zero RGB pixels. A direct native WebGL adapter probe that waited for its
accumulated sample counter to reach 16 produced nonblack pixels after 181 render calls (7.56 seconds).
These checks established native rendering support and exposed the CLI accumulation issue fixed in
[#92](https://github.com/bhouston/three-ss-fidelity/issues/92). They do not establish a speedup or full-scene fidelity.
A fresh legacy CLI render with the accumulation fix produced a nonblack 64×64 image at 16 samples (RGB ranges
0–255). A long capture cancelled with SIGINT exited with an error and saved no image.

| Command                               | Does                                                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli list [--verbose]`                | List scene names.                                                                                                                                                                                                                |
| `cli render`                          | Write `fidelity-results/<scene>/beauty/<renderer>.avif`. `--scenes/--renderers` take comma-separated globs; also `--missing-only`, `--samples`, `--frames`, `--motion`, `--motion-object`, `--ssr-debug`, `--width`, `--height`. |
| `cli quality-gate <base> <candidate>` | Fail if the candidate's PSNR (from `fidelity-kit process`'s metrics) drops by more than `--threshold` dB on any scene.                                                                                                           |
| `cli converge`                        | Move-then-stop benchmark: write `fidelity-results/<scene>/beauty/converge-<renderer>.json` ([docs/CONVERGENCE.md](docs/CONVERGENCE.md)).                                                                                         |
| `cli bench --renderers a,b`           | Repeated five-second completed-work benchmarks and A/B speedup; JSON + offline HTML reports; `--experiment` selects variants; `--profile` / `--gpu` for instrumented GPU timing ([docs/PERF.md](docs/PERF.md)).                  |

Run `pnpm cli <command> --help` for all flags. `pnpm cli` runs the built `dist/`, so run `pnpm build` (or `pnpm dev`)
after changing sources.

### Live lab

Run `pnpm build` then `pnpm live` and open <http://127.0.0.1:5173/> for orbit interaction, converged PNG captures, fresh seeded benchmarks, and saved report inspection. The lab supports browser cadence, completed-work throughput, optional GPU profiling, and alternating stock/experimental comparisons. Each scene load also shows startup stages, shader-generation and pipeline-call details, and downloadable startup JSON. See [docs/PERF.md](docs/PERF.md) for protocols, report semantics, and custom pipeline helpers.

### Viewer

[fidelity-kit](https://github.com/bhouston/fidelity-kit) scores and serves `fidelity-results/` directly; there is no custom
viewer package. `fidelity-results/fidelity.json` declares the renderers (`three-gpu-pathtracer` and `blender` are references)
and the single implicit beauty output.

- `pnpm fidelity:dev` serves the results grid and scene detail views at `localhost:3000`, uncached.
- `pnpm fidelity:build` exports a static site to `site/`.

Merging to `main` deploys `site/` to GitHub Pages at <https://ss-fidelity.ben3d.ca>.

## Results

`fidelity-results/<scene>/beauty/` is committed and holds:

- `three-gpu-pathtracer.avif` / `blender.avif`: the two references.
- `<renderer>.avif`: each screen-space render.
- `<renderer>.vs-<reference>.delta.avif` / `.metrics.json`: written by `fidelity-kit process`
  (PSNR vs the reference).
- `converge-<renderer>.json` (beauty only): the convergence curve.

Use `pnpm cli render --missing-only` to fill gaps across all renderers, including every hierarchy variant, without overwriting existing images. Select complete renderer names with `--renderers`; comma-separated names and globs such as `'three-new-*'` work. The render command uses these names:

| Renderer name                                      | Output image                            |
| -------------------------------------------------- | --------------------------------------- |
| `three-new-baseline`                               | `three-new.avif`                        |
| `three-new-ssr-hiz-tight`                          | `three-new-ssr-hiz-tight.avif`          |
| `three-new-ssr-radiance-mips`                      | `three-new-ssr-radiance-mips.avif`      |
| `three-new-ssgi-radiance-mips`                     | `three-new-ssgi-radiance-mips.avif`     |
| `three-new-hierarchy-combined`                     | `three-new-hierarchy-combined.avif`     |
| `three-new-ssr-temporal-validated`                 | `three-new-ssr-temporal-validated.avif` |
| `three-new-ssr-temporal-gaussian`                  | `three-new-ssr-temporal-gaussian.avif`  |
| `three-new-ssgi-half`                              | `three-new-ssgi-half.avif`              |
| `three-new-ssgi-third`                             | `three-new-ssgi-third.avif`             |
| `three-current`, `three-gpu-pathtracer`, `blender` | `<renderer>.avif`                       |

`pnpm cli render --renderers three-new-light-probe` captures the basic SH probe renderer. The same renderer name is available in the live lab and `cli bench`. It bakes about 2,000 probes before rendering; moving lights and geometry need a new scene session. See [probe research](docs/LIGHT_PROBE_RESEARCH.md).

`three-new-light-probe-ddgi` adds directional visibility and probe relocation/classification. It remains a static bake; both probe renderers are available independently in render, bench, and the live lab. See [DDGI research](docs/DDGI_RESEARCH.md).

The `three-new-ssr-temporal-validated` and `three-new-ssr-temporal-gaussian` profiles compare validated reflection history and Gaussian clipping. Their captures appear in fidelity-kit; the same options are available in the live lab's experiment selector. Bare `pnpm cli render --missing-only` includes both profiles automatically. To fill only these profiles, use `pnpm cli render --missing-only --renderers 'three-new-ssr-temporal-*' --frames 128`. See [temporal research](docs/SSR_TEMPORAL_RESEARCH.md).

For example, `pnpm cli render --missing-only --renderers three-new-hierarchy-combined` fills only combined hierarchy captures. `cli render` no longer accepts `--experiment`; select the full renderer name instead. Baseline images retain their existing `three-new.avif` filename and viewer ID.

The option checks the requested AVIF paths in `--output` (default: `fidelity-results/`) before starting render processes, including SSR debug variants. With `--motion`, existing captures are preserved and only missing captures are written; frames still advance normally to preserve temporal history. Omit the flag to regenerate images after changing render settings or code.

Images are AVIF q90 4:4:4 (`RESULT_AVIF` in `packages/cli/src/compare.ts`). All renderers produce full beauty images; there is no pass selector. Historical AO/direct images remain as archived artifacts and are excluded from the active viewer configuration.

Path-tracer references are slow (4096 spp). Regenerate them only when a scene changes, with
`pnpm cli render --renderers three-gpu-pathtracer --scenes <name>`.

## Setup and checks

```bash
git clone --recurse-submodules <repo>   # or: git submodule update --init
pnpm install --frozen-lockfile          # Node 26 (.nvmrc), pnpm pinned in package.json
pnpm build                              # tsc -b, then builds submodules/three.js, then the packages
pnpm tsc && pnpm lint && pnpm test --coverage
pnpm exec oxfmt <changed files>
```

- Tests are Vitest and live next to the sources as `packages/*/src/**/*.test.ts` (scene registries, path helpers,
  compare/converge maths, the renderer table, and the single-three check).
- **Rebuild after editing the three.js fork.** `pnpm build` rebuilds `submodules/three.js`, and the packages consume
  its build output, not its sources.
- **Submodule edits need their own commits.** The submodules are marked `ignore = dirty`, so `git status` in this repo
  won't show uncommitted changes inside them. Commit inside the submodule, push it, then commit the updated pointer
  here.

## Results introduction

Edit `fidelity-results/README.md` to update the Markdown introduction above the comparisons. Fidelity-kit displays this file in the local viewer, static exports, and the deployed container. Keep its renderer descriptions in sync with `fidelity-results/fidelity.json`.

## Documentation

| Doc                                        | Topic                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| [docs/THREE-NEW.md](docs/THREE-NEW.md)     | What `three-new` does now, its cost, and where each part came from.                                                      |
| [docs/PLAN.md](docs/PLAN.md)               | Original design: layout, scene contract, renderer and CLI plan.                                                          |
| [docs/CONVERGENCE.md](docs/CONVERGENCE.md) | Move-then-stop convergence benchmark method and findings.                                                                |
| [docs/PERF.md](docs/PERF.md)               | `cli bench` and GPU timing.                                                                                              |
| [docs/TSL_GUIDE.md](docs/TSL_GUIDE.md)     | Writing compact TSL shaders: loops, materialization, reusable functions, and generated-code validation.                  |
| [docs/history/](docs/history/)             | Experiment logs (SSGI estimator, SSR correctness/speed/real-time, SSGI speed, TRAA tests), under the old renderer names. |

The JSON and PNG files in `docs/history/` are the data behind those logs. Most were produced by the scripts in `scripts/`.

Blender reference rendering calls `fidelity-kit-blender/three` directly. Set `BLENDER_EXECUTABLE` to choose an installation; otherwise the package discovers Blender on PATH or in macOS Applications. The suite explicitly bakes procedural IBL and passes environment intensity/rotation, background, bounce count, and Three.js tone-mapping/sRGB settings. The package owns GLB export, camera/light translation, Blender execution, and linear output processing. Unsupported suite features emit diagnostics.

## Performance-kit

The independent [performance-kit](https://github.com/bhouston/performance-kit) submodule supplies performance measurement, a CLI, and its own report website. Fidelity images live in `fidelity-results/`; performance snapshots live in `performance-results/`.

```sh
pnpm build
pnpm live                         # renderer site at http://127.0.0.1:5173
# In another terminal:
pnpm performance:run --renderer three-current
pnpm performance:dev              # watch results and refresh changed entries over SSE
pnpm performance:serve            # static reader; no watcher or SSE
pnpm performance:process          # migrate legacy raw results and rebuild the index
pnpm performance:build            # portable static report in performance-site/
```

`performance-suite.json` contains entries with explicit renderer and scene IDs for Three-Base (the stock `three-current` renderer), the other real-time Three variants, and every Three-New experiment. Blender and path tracers are excluded. Change renderer and scene references, durations in a copied suite and pass it with `pnpm performance:run --suite <file>`. The dedicated `/performance.html` renderer supports `params.scene`, `renderer`, `experiment`, `width`, `height`, `seed`, and `motion` (`static` or `orbit`). Each entry gets a fresh scene and renderer, shader preparation, immediate measurement from ready, then end-of-run capture.

The harness uses `localhost`, while renderer entries use `127.0.0.1`, to allow Chrome site isolation. The renderer page runs no playground controls or charts. Keep the pinned browser, hardware and drivers consistent when comparing performance snapshots. Results record the vsync mode and network profile; comparisons reject mixed modes or network conditions. Existing `cli bench` remains available for the native diagnostic protocols documented in [docs/PERF.md](docs/PERF.md).

To run all 27 real-time Three configurations on the Cornell box with a mirror sphere, build once and run `pnpm performance:metallic`. It serves the built renderer independently of Vite/HMR, running each workload once with vsync disabled at 1920×1080 and 10 s measured from ready, without warmup. Use `--executable-path <chrome>` if your bundled browser installation needs repair.

The performance report introduction comes from `performance-results/README.md`. Edit this Markdown file to describe the suite; `performance:dev` refreshes it as it changes, while `performance:build` includes it in the static export.

Each performance configuration uses `performance-results/<renderer-id>/<scene-id>/` with `screenshot.avif` and directly saved `metrics.json`. The viewer uses one shared time scale across filtered timelines, combines setup phases and frame timing with hover values, and links to shareable details pages with one combined timing chart, histograms, bandwidth, and a Phases table with total setup time. Timing and bandwidth charts start at example navigation. Examples initialize automatically using workload params supplied in their URL, report ready, and then receive the measured run request. Uncovered initialization spans appear automatically as `unknown` phases. Harness and client timestamps are retained independently; precision clock synchronization and discrepancy tables are removed. `performance:process` validates current metrics and refreshes their report index.

The performance suites define `unthrottled`, `fast-4g`, `slow-4g`, and `3g`
network profiles, defaulting to `unthrottled`. To test a slower connection, copy a
suite, set `defaults.networkProfile` to `slow-4g` (or another profile name), and
run it with `pnpm performance:run --suite <file> --out <separate-directory>`.
Profiles specify uniform latency and download/upload bytes per second; `-1`
means uncapped. Every run disables HTTP cache and bypasses service workers,
including the isolated renderer iframe. Use separate output directories per
profile because each renderer/scene pair has one saved result.

The fifth top-right card metric, Download, sums known wire bytes from load and
post-load requests, formatted with `humanize-units`; choose Download in the sort
menu to compare totals. Open the details page for the bandwidth chart, waiting lead-ins,
category totals, and individual request waterfall. Cross-origin assets without
Timing-Allow-Origin have unknown sizes; worker fetches are outside the iframe's
performance timeline. The chart approximates uniform byte arrival and uses the
same time axis as frame charts, including downloads before the reporter starts.

For timed GI quality comparisons, run `pnpm performance:convergence` after building. See [GI performance and convergence](docs/performance/GI_CONVERGENCE.md) for the optional reference workflow and initial results.
