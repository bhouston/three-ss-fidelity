# Performance benchmarking

Two `cli` commands, both taking renderer names as arguments (never hardcoded), so they keep working as
screen-space renderers are added (`three-new-ssr-fast`, `three-new-ssgi-fast`, ...).

## `cli bench`: steady-state frame time

Measures median ms/frame per scene for one or more renderers, after a warm-up period. Each renderer runs in its
own child process (dawn and ANGLE don't share a process reliably), same as `cli render`.

```sh
pnpm cli bench --renderers three-new-ssgi,three-current --scenes ssgi-basic,ssgi-animated --out bench.json
```

Options: `--renderers` (required, comma-separated glob(s) against the renderer names), `--scenes` (default `*`),
`--pass` (default `beauty`), `--width`/`--height` (default 1920x1080), `--warmup` (default 60 frames),
`--measure` (default 120 frames, in batches of 20 back-to-back submits per GPU sync), `--out` (JSON file).

Timing: each measured batch submits 20 frames, then waits for the GPU queue to actually finish
(`device.queue.onSubmittedWorkDone()` for the dawn/WebGPU renderers; a pixel readback stands in for that on the
WebGL path used by `three-gpu-pathtracer`, which has no such API here) before recording elapsed wall time. That
total is steady-state GPU-bound frame time, not just CPU submit time. `cpuMs` (process CPU time inside `render()`)
is also reported, for comparison. Each frame yields to the renderer's own `requestAnimationFrame`-driven loop
(needed for the effect passes to actually advance) and the reported total is the median across batches, which is
robust to the occasional slow batch.

With exactly two `--renderers`, the command also prints and (with `--out`) writes a per-scene speedup
(`baselineMs / candidateMs`, so >1 means the candidate is faster) and the mean speedup across scenes.

Keep smoke tests short: few frames (`--warmup 5 --measure 20`), 1-2 scenes, a small `--width`/`--height`.

Noise: on a quiet machine with a small scene (`ssgi-basic`, 320x240, 5 warmup / 20 measured frames) the same A/B
pair measured three times in a row gave speedups of 1.234, 1.062 and 1.230 — roughly ±15% run-to-run noise at
this frame count. Use more frames/scenes for anything you intend to act on; this command is for local iteration,
not for gating on a shared/noisy CI runner.

### `--gpu`: GPU timing via WebGPU timestamp queries

Wall-clock is unreliable on a shared machine. `--gpu` reports actual GPU time instead, for screen-space
renderers only (`three-gpu-pathtracer` is WebGL/ANGLE here and has no timestamp-query API available):

```sh
pnpm cli bench --renderers three-new-ssr-rt --scenes ssr-diag-rough-30 --warmup 10 --measure 20 --gpu
```

```text
three-new-ssr-rt | ssr-diag-rough-30: 87.16 ms (cpu 4.15 ms)
  gpu 598.540 ms/frame
    Render Pipeline: 78.578 ms
    TRAA: 77.595 ms
    SSR [ Previous Geometry ]: 75.366 ms
    SSR [ History ]: 75.170 ms
    SSR [ Temporal ]: 74.514 ms
    SSR [ Spatial Resolve ]: 73.859 ms
    SSR [ Reflections ]: 70.910 ms
    Pre-Pass: 2.949 ms
    Back-Face Depth Pre-Pass: 2.490 ms
```

It creates the renderer with `trackTimestamp: true` and, after every measured frame, calls
`renderer.resolveTimestampsAsync('render')` and `('compute')` (this forces a GPU sync every frame, so `totalMs`
in `--gpu` mode measures per-frame sync latency, not pipelined throughput — read `gpu` for the GPU cost, not
`totalMs`). `gpu` is the median, across measured frames, of the sum of every render + compute timestamp range
recorded for that frame; the indented lines below it are the median ms of each named pass, descending.

Pass names come from the `scene`/`computeNodes` argument passed to `renderer.render()`/`renderer.compute()` at
the point each pass's timestamp query is allocated (e.g. a `QuadMesh.name` like `'SSR [ Reflections ]'`, or a
`Mesh.name` like `'Pre-Pass'`) — three.js's `RenderContext` itself carries no such label, so this is inferred by
patching the renderer instance at bench time (not three.js/renderers), and falls back to the render context's
uid (e.g. `r:3:4`) when nothing set a `.name`.

Caveat: on tile-based GPUs (Apple Silicon/Metal, which is what this repo's dawn-backed headless WebGPU normally
runs on) consecutive render passes without an explicit barrier can overlap on the GPU, so the sum of per-pass
timestamp ranges can legitimately exceed the frame's wall-clock time (as in the example above: 598ms of summed
GPU ranges for an 87ms frame). Read `gpu` and the per-pass breakdown as relative costs for comparing renderers or
passes against each other, not as a serial time budget that should add up to wall time.

If the adapter has no `timestamp-query` feature, `--gpu` prints `(gpu unsupported)` instead and falls back to
`totalMs`/`cpuMs` only; dawn's `webgpu` package exposes it by default (see `packages/cli/src/headless/webgpu.ts`,
which also disables dawn's timestamp-quantization toggle, a WebGPU spec timing-side-channel mitigation that
otherwise rounds query results to a coarse granularity -- safe here since this is a headless benchmark process,
not a browser sandbox).

## `cli quality-gate`: RMSE regression gate

Compares two already-compared renderers' mean RMSE against the `three-gpu-pathtracer` reference (i.e. it reads
`metrics-<renderer>.json`, produced by `cli compare`, rather than re-decoding images):

```sh
pnpm cli compare --renderers three-current,three-new-ssgi --scenes ssgi-basic,ssgi-animated
pnpm cli quality-gate three-current three-new-ssgi --scenes ssgi-basic,ssgi-animated
```

Fails (non-zero exit) when the candidate's mean RMSE across the selected scenes/passes is worse than the
baseline's by more than `--threshold` (default `0.01`, i.e. 1%, relative). Options: `--scenes`, `--passes`
(both default `*`), `--threshold`, `--results` (results directory), `--out` (JSON file with the row-by-row and
summary result). Scene/pass combinations missing a metrics file for either renderer are skipped with a warning.
