# Performance benchmarking

Two `cli` commands, both taking renderer names as arguments (never hardcoded), so they keep working as
screen-space renderers are added (`three-new-ssr-fast`, `three-new-ssgi-fast`, ...).

## `cli bench`: steady-state frame time

Measures median ms/frame per scene for one or more renderers, after a warm-up period. Each renderer runs in its
own child process (dawn and ANGLE don't share a process reliably), same as `cli render`.

```sh
pnpm cli bench --renderers three-new-ssgi,three-ss-legacy --scenes ssgi-basic,ssgi-animated --out bench.json
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

## `cli quality-gate`: RMSE regression gate

Compares two already-compared renderers' mean RMSE against the `three-gpu-pathtracer` reference (i.e. it reads
`metrics-<renderer>.json`, produced by `cli compare`, rather than re-decoding images):

```sh
pnpm cli compare --renderers three-ss-legacy,three-new-ssgi --scenes ssgi-basic,ssgi-animated
pnpm cli quality-gate three-ss-legacy three-new-ssgi --scenes ssgi-basic,ssgi-animated
```

Fails (non-zero exit) when the candidate's mean RMSE across the selected scenes/passes is worse than the
baseline's by more than `--threshold` (default `0.01`, i.e. 1%, relative). Options: `--scenes`, `--passes`
(both default `*`), `--threshold`, `--results` (results directory), `--out` (JSON file with the row-by-row and
summary result). Scene/pass combinations missing a metrics file for either renderer are skipped with a warning.
