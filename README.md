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
2. Render the affected scenes: `pnpm cli render --scenes 'ssr-*' --renderers three-new`.
3. Score them against the path tracer: `pnpm exec fidelity-kit process results`.
4. Check for regressions: `pnpm cli quality-gate <baseline> <candidate>` (mean-RMSE threshold, default 1 %), e.g.
   against results rendered before the change into another `--results`.
5. For temporal and real-time work, also run `pnpm cli converge` (image quality after a camera move) and
   `pnpm cli bench` (frame time).
6. Commit the updated `results/` and record the findings in the matching doc (see [Documentation](#documentation)).

Improvements go into `three-new`; `three-current` (stock three.js) stays fixed as the baseline. What `three-new` does
and why is in [docs/THREE-NEW.md](docs/THREE-NEW.md).

## Repository layout

```
submodules/three.js              bhouston/three.js @ ssgi-traa-redesign: the fork with the SSGI/SSR/TRAA nodes
submodules/three-gpu-pathtracer  bhouston/three-gpu-pathtracer @ ss-fidelity: the ground-truth renderer
packages/scenes     @ss-fidelity/scenes     renderer-agnostic scene definitions + registry (browser and node)
packages/renderers  @ss-fidelity/renderers  screen-space pipeline and path-tracer adapters behind one LiveRenderer API
packages/cli        @ss-fidelity/cli        headless render / converge / bench / quality-gate
results/<scene>/<pass>/                     committed render output; scored/viewed with fidelity-kit
docs/                                       THREE-NEW.md, plans, benchmark write-ups; docs/history/ holds the experiment logs
scripts/                                    one-off metric and experiment scripts (gi-*, ssr-*, traa-*) + check-pr.mjs
```

The workspace overrides `three` with `workspace:*`, so every package, and three-gpu-pathtracer itself, uses the fork
in `submodules/three.js`. There is only ever one copy of three.

### `packages/scenes`

- `src/types.ts` holds the contract. A `SceneDefinition` has a `name`, `description`, `width`/`height` and an async
  `create(ctx)`, which returns a `SceneSetup`: the scene, camera, orbit `target`, `effects` (SSGI/SSR parameters,
  `temporalDenoise`, tone mapping, `frames` to render before capture) and `aoRadius`.
- `src/index.ts` is the registry (`listSceneNames`, `getScene`). Scene families each live in their own file:
  `ssgi.ts`, `ssr.ts` (steampunk), `ssr-diagnostics.ts` (`ssr-diag-*`), `gi-diagnostics.ts` and
  `gi-visible-walls.ts` (`gi-*`), `traa-diagnostics.ts` (`traa-*`), `gltf-examples.ts` (`gltf-*`), `higharc.ts`.
- Assets (glTF, HDR) are loaded from paths relative to `submodules/three.js/examples/`. `src/node.ts` provides the
  node-side `SceneContext`.
- **To add a scene:** add a `SceneDefinition` to the family file (or a new file), make sure it is spread into the
  registry in `index.ts`, add or extend the family's `*.test.ts`, then render the path-tracer reference.

### `packages/renderers`

- `src/types.ts` defines `rendererNames`, `passNames` (`beauty`, `direct`, `ao`), `RendererOptions` and the
  `LiveRenderer` interface (`render`/`setSize`/`setCamera`/`dispose`).
- `src/index.ts` has `createRenderer`, which dispatches a renderer name to its adapter.
- `src/three-new.ts` is the improved pipeline (WebGPURenderer + SSGI/SSR/TRAA/denoise), `src/three-current.ts` the
  stock r186 one, and `src/pathtracer.ts` adapts three-gpu-pathtracer.
- `src/ssr/NewSSRNode.js` and `src/ssgi-fast/SSGINode.js` are vendored nodes. They are developed here instead of in
  the submodule.

| Renderer               | What it is                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `three-gpu-pathtracer` | Ground truth (default 4096 spp, seeded).                                                       |
| `three-current`        | Unmodified three.js r186 from npm (`three@0.186.1`) with its stock SSGI/SSR example pipelines. |
| `three-new`            | The fork + vendored SSGI/SSR nodes, real-time, TRAA ([docs/THREE-NEW.md](docs/THREE-NEW.md)).  |

### `packages/cli`

Commands are the files in `src/commands/`, loaded by `yargs-file-commands`. Each render runs in its **own child
process** (`render-process.ts`, `bench-process.ts`), because dawn and ANGLE don't share a process reliably and GPU
state leaked between scenes. Headless GPU comes from `src/headless/webgpu.ts` (dawn, the `webgpu` package) and
`src/headless/webgl.ts` (`@onirenaud/node-webgl`, ANGLE). `Math.random` is seeded, so renders are reproducible.

| Command                               | Does                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli list [--verbose]`                | List scene names.                                                                                                                                                                       |
| `cli render`                          | Write `results/<scene>/<pass>/<renderer>.avif`. `--scenes/--passes/--renderers` take comma-separated globs; also `--samples`, `--frames`, `--motion`, `--motion-object`, `--ssr-debug`. |
| `cli quality-gate <base> <candidate>` | Fail if the candidate's mean RMSE (from `fidelity-kit process`'s metrics) regresses by more than `--threshold`.                                                                         |
| `cli converge`                        | Move-then-stop benchmark: write `results/<scene>/beauty/converge-<renderer>.json` ([docs/CONVERGENCE.md](docs/CONVERGENCE.md)).                                                         |
| `cli bench --renderers a,b`           | Steady-state ms/frame, and A/B speedup when two renderers are given; `--gpu` for timestamp queries ([docs/PERF.md](docs/PERF.md)).                                                      |

Run `pnpm cli <command> --help` for all flags. `pnpm cli` runs the built `dist/`, so run `pnpm build` (or `pnpm dev`)
after changing sources.

### Viewer

[fidelity-kit](https://github.com/bhouston/fidelity-kit) scores and serves `results/` directly; there is no custom
viewer package. `results/fidelity.json` declares the renderers (`three-gpu-pathtracer` and `blender` are references)
and outputs (`beauty`, `direct`, `ao`).

- `pnpm fidelity:dev` serves the results grid and scene detail views at `localhost:3000`, uncached.
- `pnpm fidelity:build` exports a static site to `site/`.

Merging to `main` deploys `site/` to GitHub Pages at <https://ss-fidelity.ben3d.ca>.

## Results

`results/<scene>/<pass>/` is committed and holds:

- `three-gpu-pathtracer.avif` / `blender.avif`: the two references.
- `<renderer>.avif`: each screen-space render.
- `<renderer>.vs-<reference>.delta.avif` / `.metrics.json`: written by `fidelity-kit process`
  (PSNR, RMSE, MAE, max error vs the reference).
- `converge-<renderer>.json` (beauty only): the convergence curve.

Images are AVIF q90 4:4:4 (`RESULT_AVIF` in `packages/cli/src/compare.ts`). Not every renderer is rendered for every
pass: `direct`/`ao` exist only for some renderers.

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

Edit `results/README.md` to update the Markdown introduction above the comparisons. Fidelity-kit displays this file in the local viewer, static exports, and the deployed container. Keep its renderer descriptions in sync with `results/fidelity.json`.

## Documentation

| Doc                                        | Topic                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| [docs/THREE-NEW.md](docs/THREE-NEW.md)     | What `three-new` does now, its cost, and where each part came from.                                                      |
| [docs/PLAN.md](docs/PLAN.md)               | Original design: layout, scene contract, renderer and CLI plan.                                                          |
| [docs/CONVERGENCE.md](docs/CONVERGENCE.md) | Move-then-stop convergence benchmark method and findings.                                                                |
| [docs/PERF.md](docs/PERF.md)               | `cli bench` and GPU timing.                                                                                              |
| [docs/history/](docs/history/)             | Experiment logs (SSGI estimator, SSR correctness/speed/real-time, SSGI speed, TRAA tests), under the old renderer names. |

The JSON and PNG files in `docs/history/` are the data behind those logs. Most were produced by the scripts in `scripts/`.
