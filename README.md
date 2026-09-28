# three-ss-fidelity

three-ss-fidelity measures how close three.js screen-space effects (SSGI, SSR, TRAA, and the AO/depth/normal/velocity
pre-pass they depend on) get to a path-traced ground truth. It is the test harness for significantly improving those
effects, which is done in a fork of three.js. Each scene is rendered by the screen-space pipeline and by
[three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer). The images are diffed and scored, and the
results can be browsed in a web viewer, along with a live view of every scene in every renderer.

The suite follows the design of the sibling [material-fidelity](https://github.com/bhouston/mtlx-fidelity) project: a scene registry, a
renderer package, a CLI that renders and compares, and a TanStack Start viewer over committed results.

Workflow rules (issues, branches, Conventional Commits, PRs, required checks) are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## How the work is done

1. Change an effect in `submodules/three.js`, or in a vendored node under `packages/renderers/src/` (see below).
2. Render the affected scenes: `pnpm cli render --scenes 'ssr-*' --renderers three-new-ssr-rt`.
3. Score them against the path tracer: `pnpm cli compare --scenes 'ssr-*' --renderers three-new-ssr-rt`.
4. Check for regressions: `pnpm cli quality-gate <baseline> <candidate>` (mean-RMSE threshold, default 1 %).
5. For temporal and real-time work, also run `pnpm cli converge` (image quality after a camera move) and
   `pnpm cli bench` (frame time).
6. Commit the updated `results/` and record the findings in the matching doc (see [Documentation](#documentation)).

A new approach is added as a **new renderer name**, and the existing renderers stay unchanged, so every change can be
A/B compared against the renderer it builds on.

## Repository layout

```
submodules/three.js              bhouston/three.js @ ssgi-traa-redesign: the fork with the SSGI/SSR/TRAA nodes
submodules/three-gpu-pathtracer  bhouston/three-gpu-pathtracer @ ss-fidelity: the ground-truth renderer
packages/scenes     @ss-fidelity/scenes     renderer-agnostic scene definitions + registry (browser and node)
packages/renderers  @ss-fidelity/renderers  screen-space pipeline and path-tracer adapters behind one LiveRenderer API
packages/cli        @ss-fidelity/cli        headless render / compare / converge / bench / quality-gate
packages/viewer     @ss-fidelity/viewer     TanStack Start site: results grid, scene detail, live renderers
results/<scene>/<pass>/                     committed render output and metrics (~935 files, ~27 MB)
docs/                                       investigation reports, plans and benchmark write-ups
scripts/                                    one-off metric and experiment scripts (gi-*, ssr-*, traa-*) + check-pr.mjs
*.md (root)                                 per-effort logs: SSR_IMPROVEMENTS, SSR_TEMPORAL, SSGI_FAST, TRAA_TESTS
```

The workspace overrides `three` with `workspace:*`, so every package, and three-gpu-pathtracer itself, uses the fork
in `submodules/three.js`. There is only ever one copy of three.

### `packages/scenes`

- `src/types.ts` holds the contract. A `SceneDefinition` has a `name`, `description`, `width`/`height` and an async
  `create(ctx)`, which returns a `SceneSetup`: the scene, camera, orbit `target`, `effects` (SSGI/SSR parameters,
  `antialias: 'traa' | 'smaa'`, `temporalDenoise`, tone mapping, `frames` to render before capture) and `aoRadius`.
- `src/index.ts` is the registry (`listSceneNames`, `getScene`). Scene families each live in their own file:
  `ssgi.ts`, `ssr.ts` (steampunk), `ssr-diagnostics.ts` (`ssr-diag-*`), `gi-diagnostics.ts` and
  `gi-visible-walls.ts` (`gi-*`), `traa-diagnostics.ts` (`traa-*`), `gltf-examples.ts` (`gltf-*`), `higharc.ts`.
- Assets (glTF, HDR) are loaded from paths relative to `submodules/three.js/examples/`. `src/node.ts` provides the
  node-side `SceneContext`.
- **To add a scene:** add a `SceneDefinition` to the family file (or a new file), make sure it is spread into the
  registry in `index.ts`, add or extend the family's `*.test.ts`, then render the path-tracer reference.

### `packages/renderers`

- `src/types.ts` defines `rendererNames`, `passNames` (`beauty`, `direct`, `ao`), `RendererOptions`, the per-renderer
  speed flags (`SSRFastOptions`, `SSGIFastOptions`) and the `LiveRenderer` interface
  (`render`/`setSize`/`setCamera`/`dispose`).
- `src/index.ts` has `createRenderer`, plus a **table** that maps each screen-space renderer name to its pipeline
  options. A new variant is one more row in it.
- `src/ssgi.ts` is the screen-space pipeline (WebGPURenderer + SSGI/SSR/TRAA/SMAA/denoise), and it serves every
  `three-*` renderer. `src/pathtracer.ts` adapts three-gpu-pathtracer.
- `src/ssr/NewSSRNode.js` and `src/ssgi-fast/SSGINode.js` are vendored nodes. They are developed here instead of in
  the submodule.

| Renderer               | What it is                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `three-gpu-pathtracer` | Ground truth (default 4096 spp, seeded).                                                                           |
| `three-current`        | Unmodified three.js r186 from npm (`three@0.186.1`) with its stock SSGI/SSR example pipelines.                     |
| `three-new-ssgi`       | Solid-angle-corrected SSGI + the fork's SSR ([docs/RENDERER-METHODS.md](docs/RENDERER-METHODS.md)).                |
| `three-new-ssr`        | `three-new-ssgi` + vendored `NewSSRNode` ([SSR_IMPROVEMENTS.md](SSR_IMPROVEMENTS.md)).                             |
| `three-new-ssr-fast`   | `three-new-ssr` + quality-gated speed flags (same doc).                                                            |
| `three-new-ssgi-fast`  | `three-new-ssr-fast` + SSGI speed flags on the vendored `SSGINode` ([SSGI_FAST.md](SSGI_FAST.md)).                 |
| `three-new-ssr-rt`     | Real-time SSR: 1 frame per displayed frame, SSSR-style temporal filter, Hi-Z ([SSR_TEMPORAL.md](SSR_TEMPORAL.md)). |

### `packages/cli`

Commands are the files in `src/commands/`, loaded by `yargs-file-commands`. Each render runs in its **own child
process** (`render-process.ts`, `bench-process.ts`), because dawn and ANGLE don't share a process reliably and GPU
state leaked between scenes. Headless GPU comes from `src/headless/webgpu.ts` (dawn, the `webgpu` package) and
`src/headless/webgl.ts` (`@onirenaud/node-webgl`, ANGLE). `Math.random` is seeded, so renders are reproducible.

| Command                               | Does                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli list [--verbose]`                | List scene names.                                                                                                                                                                       |
| `cli render`                          | Write `results/<scene>/<pass>/<renderer>.avif`. `--scenes/--passes/--renderers` take comma-separated globs; also `--samples`, `--frames`, `--motion`, `--motion-object`, `--ssr-debug`. |
| `cli compare`                         | Write `delta-<renderer>.avif` + `metrics-<renderer>.json` (PSNR, RMSE, MAE, max error vs the path tracer).                                                                              |
| `cli quality-gate <base> <candidate>` | Fail if the candidate's mean RMSE regresses by more than `--threshold`.                                                                                                                 |
| `cli converge`                        | Move-then-stop benchmark: write `results/<scene>/beauty/converge-<renderer>.json` ([docs/CONVERGENCE.md](docs/CONVERGENCE.md)).                                                         |
| `cli bench --renderers a,b`           | Steady-state ms/frame, and A/B speedup when two renderers are given; `--gpu` for timestamp queries ([docs/PERF.md](docs/PERF.md)).                                                      |

Run `pnpm cli <command> --help` for all flags. `pnpm cli` runs the built `dist/`, so run `pnpm build` (or `pnpm dev`)
after changing sources.

### `packages/viewer`

A TanStack Start + React + Tailwind site on port 3000 (`pnpm viewer`). It serves `results/` through
`src/routes/api/results/$.ts` and the three.js example assets through `src/routes/three-examples/$.ts`.

- `/` is the results grid.
- `/scenes/$name` shows a scene's images, delta images and metrics.
- `/live/$name/$renderer` renders a scene live in the browser.

Merging to `main` deploys it to Cloud Run (`packages/viewer/Dockerfile`).

## Results

`results/<scene>/<pass>/` is committed and holds:

- `three-gpu-pathtracer.avif`: the reference.
- `<renderer>.avif`: each screen-space render.
- `delta-<renderer>.avif`: an inferno-colormapped error image.
- `metrics-<renderer>.json`: the scores against the reference.
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

## Documentation

| Doc                                                            | Topic                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| [docs/PLAN.md](docs/PLAN.md)                                   | Original design: layout, scene contract, renderer and CLI plan.   |
| [docs/RENDERER-METHODS.md](docs/RENDERER-METHODS.md)           | SSGI integration methods and how to select them.                  |
| [docs/GI-INVESTIGATION.md](docs/GI-INVESTIGATION.md)           | Indoor SSGI energy loss investigation (issue #9).                 |
| [docs/GI-ESTIMATOR-FOLLOWUP.md](docs/GI-ESTIMATOR-FOLLOWUP.md) | The missing solid-angle factor: Cornell RMSE 0.165 → 0.049.       |
| [SSR_IMPROVEMENTS.md](SSR_IMPROVEMENTS.md)                     | `three-new-ssr` correctness work and `-fast` optimization rounds. |
| [SSR_TEMPORAL.md](SSR_TEMPORAL.md)                             | `three-new-ssr-rt`: real-time temporal SSR experiments (E1–E9).   |
| [SSGI_FAST.md](SSGI_FAST.md)                                   | `three-new-ssgi-fast` optimization rounds and quality gate.       |
| [TRAA_TESTS.md](TRAA_TESTS.md)                                 | Numeric verification of the fork's TRAANode.                      |
| [docs/CONVERGENCE.md](docs/CONVERGENCE.md)                     | Move-then-stop convergence benchmark method and findings.         |
| [docs/PERF.md](docs/PERF.md)                                   | `cli bench` and GPU timing.                                       |

The JSON and PNG files in `docs/` are the data behind these reports. Most were produced by the scripts in `scripts/`.
