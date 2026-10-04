# Performance results

[Open the performance viewer](https://ss-fidelity.ben3d.ca/performance/) for the committed benchmark runs. Fidelity comparisons remain at [the site root](https://ss-fidelity.ben3d.ca/).

The Cornell metallic-sphere run set contains 78 runs: three interleaved repetitions of 26 real-time Three configurations. It was recorded on October 3, 2026 (America/Toronto) on an Apple M3 GPU using WebGPU and Headless Chrome 154. The suite uses a fixed 1920 × 1080 canvas at DPR 1, 2 seconds of warmup, 10-second measurement windows, and vsync on. The manifest records the suite snapshot, schedule, source commit, browser flags, clock isolation, and host/GPU metadata.

Each run JSON stores raw CPU frame timestamps, available GPU timestamp pairs, phase marks, clock-sync samples, and responsiveness records. Captures are AVIF files beside the runs; their relative paths are recorded in each JSON. PNG is used internally for browser capture transport before conversion for storage. The report derives statistics when read, overlays repetitions, exposes raw JSON, and compares matching label groups within the same vsync mode.

The suite includes Three-Base (`three-current`), Three-New, light bake/probe/DDGI variants, and the SSR/SSGI experiments listed in `performance-suite-metallic.json`. Blender and the path tracers are excluded. The renderer and experiment labels let you distinguish baseline renderer comparisons from changes within Three-New.

To inspect or build the committed report after installing and building the workspace:

```sh
pnpm performance:serve
pnpm performance:build
```

The local server reads `performance-results/`; the static build writes `performance-site/`. CI uploads that static viewer as the `performance-report` artifact. GitHub Pages deploys the fidelity viewer at the root and this independent performance viewer under `/performance/`.

To append another metallic-sphere run set after `pnpm build`, run `pnpm performance:metallic`. For the broader scene suite, start `pnpm live` and then run `pnpm performance:run`. New invocations append a self-describing manifest and raw results under `runsets/`. Generated output is ignored by default; commit selected real-GPU run sets when recording a performance investigation.
