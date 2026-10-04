# Cornell metallic sphere performance — October 3, 2026

Current measurement of all 26 real-time Three configurations on `ssgi-metallic`, the Cornell box with a cone and a mirror sphere. Every configuration completed successfully with one measured run and vsync disabled. Blender and path tracers are excluded.

Results use the flat layout [`performance-results/<renderer.id>/<scene.id>/`](../../performance-results/), with `raw.json`, processed `metrics.json`, and `screenshot.avif`. Measured source commit: `35e03f6acbe32b1acd95ffa297bbdc4048b18eef`. The [earlier three-repetition measurement with vsync enabled](../history/performance/METALLIC-CORNELL.md) is archived separately and uses different measurement settings.

## Measurement settings

Hardware: Apple M3 CPU and GPU, macOS/darwin 27.0.0. Browser: HeadlessChrome 154.0.0.0. All raw records report a 1920 × 1080 canvas, DPR 1, WebGPU, cross-origin isolation, and available GPU timestamp support.

Each configuration uses 2 s warmup, 10 s measurement, and 2 s cooldown. A fresh renderer/scene is created for each configuration. Vsync and the frame-rate limit are disabled. Capture happens after warmup and before the measured interval; AVIF encoding happens after measurement. GPU instrumentation adds profiling overhead.

All 26 captures decode as opaque AV1/AVIF at 1920 × 1080. The encoder uses the fidelity render CLI settings: quality 90, full-resolution `4:4:4` chroma, and alpha removed. Browser transport is lossless PNG. Encoder settings are recorded in [`capture.ts`](../../submodules/performance-kit/packages/cli/src/capture.ts); image metadata verifies dimensions, codec, and opacity.

## Current summary

These values come from the saved processed metrics, whose exact statistics use the complete measured raw data. Typical FPS is `1 / median frame interval`; tail FPS is `1 / p95 frame interval`. Jitter is the interquartile range. Setup is harness start to renderer ready, corrected by clock synchronization. CPU submission and GPU query costs are separate from frame pacing. An unavailable GPU median is shown as `—`.

| Configuration                           | Typical FPS | Tail FPS |   Jitter |  Setup | GPU median |
| --------------------------------------- | ----------: | -------: | -------: | -----: | ---------: |
| Three Light Bake                        |       26.97 |    22.92 |  3.42 ms | 0.21 s |   40.95 ms |
| Three Light Probe                       |       26.39 |    22.83 |  2.88 ms | 5.20 s |    3.78 ms |
| Three DDGI                              |       26.18 |    22.46 |  2.24 ms | 6.39 s |    1.58 ms |
| Three-New · Third resolution SSGI       |       14.90 |    12.14 |  4.79 ms | 0.22 s |    4.02 ms |
| Three-New · SSGI 2x8                    |       14.31 |    12.50 |  9.63 ms | 0.24 s |    4.16 ms |
| Three-New · SSGI 2x16                   |       13.32 |    12.52 |  2.34 ms | 0.24 s |   77.21 ms |
| Three-New · Half resolution SSGI        |       11.11 |     9.91 |  6.66 ms | 0.23 s |   49.48 ms |
| Three-New · SSGI 4x16                   |       10.33 |     9.83 |  2.89 ms | 0.20 s |   98.42 ms |
| Three-New · SSGI 4x32                   |        7.90 |     7.22 |  6.53 ms | 0.25 s |  125.70 ms |
| Three-New · SSGI 8x16                   |        7.48 |     6.44 | 11.51 ms | 0.22 s |  132.77 ms |
| Three-Base                              |        7.22 |     6.63 |  6.74 ms | 0.35 s |          — |
| Three-New · SSGI 6x32                   |        6.34 |     5.89 |  5.90 ms | 0.41 s |  158.34 ms |
| Three-New · SSGI 6x24                   |        6.18 |     4.31 | 29.07 ms | 0.21 s |  171.51 ms |
| Three-New · SSGI radiance mipmaps       |        6.05 |     5.75 |  6.95 ms | 0.26 s |  168.86 ms |
| Three-New · SSGI 8x28                   |        5.85 |     4.63 |  8.60 ms | 0.25 s |  173.26 ms |
| Three-New · SSR radiance mipmaps        |        5.84 |     5.57 |  7.48 ms | 0.27 s |  178.56 ms |
| Three-New · Tight SSR hierarchy         |        5.77 |     5.21 |  9.36 ms | 0.44 s |  179.54 ms |
| Three-New                               |        5.66 |     5.21 |  6.00 ms | 0.29 s |  173.90 ms |
| Three-New · SSGI texel reuse            |        5.50 |     5.12 | 11.24 ms | 0.31 s |  189.25 ms |
| Three-New · SSGI early exit             |        5.45 |     5.22 |  4.95 ms | 0.29 s |  182.89 ms |
| Three-New · Combined hierarchy          |        5.41 |     4.53 | 10.96 ms | 0.25 s |  183.04 ms |
| Three-New · SSGI 8x24                   |        5.30 |     4.61 | 35.26 ms | 0.29 s |  195.83 ms |
| Three-New · Reduced redundant SSGI work |        5.23 |     4.47 | 29.14 ms | 0.25 s |  186.49 ms |
| Three-New · Validated temporal SSR      |        4.94 |     4.23 | 14.47 ms | 0.44 s |          — |
| Three-New · SSGI 7x32                   |        4.74 |     4.18 | 27.57 ms | 0.27 s |    4.20 ms |
| Three-New · Gaussian temporal SSR       |        4.71 |     4.10 | 19.45 ms | 0.27 s |          — |

A single run per configuration describes this observation and cannot estimate run-to-run variability. Different algorithms and sample budgets produce different image quality; inspect the captures and [fidelity report](https://ss-fidelity.ben3d.ca/) alongside these timings. The historical vsync-on results are not directly comparable to this vsync-off measurement.

## Processed format and viewer

The viewer requests only a lightweight result index, processed metrics, captures, and the optional results README. It never fetches raw measurements. Every timing or duration in processed metrics uses seconds, with numeric shared `frameSeconds`, `cpuSeconds`, and `gpuSeconds` arrays. Typical and tail FPS are precomputed. The viewer formats short costs in milliseconds and longer durations in seconds.

The render timeline starts at ready and includes warmup and capture frames. The measured interval is marked separately. Warmup and capture frames provide context in the chart and remain excluded from summary statistics. Display indices preserve extrema without inventing intervals between decimated frame timestamps.

- Raw measurements: 3,290,478 bytes across 26 files.
- Processed metrics: 1,295,568 bytes across 26 files.
- Captures: 1,220,840 bytes across 26 files.

## View and reproduce

Published report: [performance viewer](https://ss-fidelity.ben3d.ca/performance/).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm performance:metallic --port 4500 --executable-path <chrome>
pnpm performance:process
pnpm performance:dev
# Export a static metrics-and-captures report:
pnpm performance:build
```

`performance:dev` processes changed raw files before saving metrics and sending a targeted update for the affected renderer/scene pair. `performance:serve` serves a snapshot without filesystem watching. Reprocessing updates display data without modifying raw measurements. Keep hardware, driver, power policy, and Chrome version consistent when comparing future measurements.
