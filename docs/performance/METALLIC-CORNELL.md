# Cornell metallic sphere performance — October 4, 2026

Fresh measurement of all 26 real-time Three configurations on `cornell-box-metallic`, the Cornell box with a cone and a metallic sphere. Every configuration completed successfully with one measured run and vsync disabled. Blender and path tracers are excluded.

Results use the flat layout [`performance-results/<renderer.id>/<scene.id>/`](../../performance-results/), with `metrics.json` and `screenshot.avif`. Measured source commit: `f60d5d1775b375eb8992917a8a04c9ba7729e0ae`. The [earlier three-repetition measurement with vsync enabled](../history/performance/METALLIC-CORNELL.md) is archived separately and uses different measurement settings.

## Measurement settings

Hardware: Apple M3 CPU and GPU, macOS/darwin 27.0.0. Browser: HeadlessChrome 154.0.0.0. Each result records a 1920 × 1080 canvas, DPR 1, WebGPU, cross-origin isolation, and available GPU timestamp support.

Each configuration requests 10 s measurement and 2 s cooldown, with a fresh renderer/scene and no warmup. Initialization begins at navigation and includes loading, scene processing, and graph compilation. Measurement includes the first ready frames. Vsync and the frame-rate limit are disabled. Capture happens after measurement, followed by AVIF encoding. GPU instrumentation adds profiling overhead.

All 26 captures are opaque AVIF at 1920 × 1080. The encoder uses quality 90, full-resolution `4:4:4` chroma, and alpha removed. Browser transport is lossless PNG. Encoder settings are recorded in [`capture.ts`](../../submodules/performance-kit/packages/cli/src/capture.ts).

## Current summary

These values come from exact statistics calculated over complete measured raw samples before saving reports. Average FPS is `1 / average frame interval`, typical FPS is `1 / median frame interval`, and tail FPS is `1 / p95 frame interval`. Max jitter is the largest absolute deviation from the average interval. Initialization runs from navigation to explicit render start. CPU submission and GPU query costs are separate from frame pacing. An unavailable GPU median is shown as `—`.

| Configuration                           | Average FPS | Typical FPS | Tail FPS | Max jitter |   Init | GPU median |
| --------------------------------------- | ----------: | ----------: | -------: | ---------: | -----: | ---------: |
| Three Light Probe                       |       33.54 |       27.97 |    26.02 |   29.39 ms | 4.81 s |   20.95 ms |
| Three DDGI                              |       33.29 |       27.78 |    25.36 |   29.60 ms | 6.33 s |   38.14 ms |
| Three Light Bake                        |       23.83 |       27.63 |    10.25 |   67.02 ms | 0.23 s |   64.74 ms |
| Three-New · Third resolution SSGI       |       23.36 |       18.86 |    17.99 |   42.24 ms | 0.19 s |    3.64 ms |
| Three-New · SSGI 2x8                    |       21.72 |       17.50 |    15.48 |   45.47 ms | 0.21 s |    1.58 ms |
| Three-New · Half resolution SSGI        |       18.85 |       14.33 |    13.39 |   52.40 ms | 0.19 s |    3.78 ms |
| Three-New · SSGI 2x16                   |       17.34 |       13.96 |     9.51 |   57.08 ms | 0.21 s |   37.44 ms |
| Three-Base                              |       15.37 |        8.10 |     7.66 |   70.67 ms | 0.36 s |  124.45 ms |
| Three-New · SSGI 4x16                   |       14.25 |       10.58 |     8.46 |   69.35 ms | 0.23 s |  118.21 ms |
| Three-New · SSGI 4x32                   |       13.32 |        8.93 |     7.67 |   74.29 ms | 0.26 s |  138.31 ms |
| Three-New · SSGI 8x16                   |       12.79 |        8.31 |     7.58 |   77.39 ms | 0.24 s |  120.87 ms |
| Three-New · SSGI 6x32                   |       11.91 |        7.60 |     6.71 |   83.47 ms | 0.27 s |  149.23 ms |
| Three-New · SSGI 6x24                   |       11.79 |        7.94 |     5.82 |   96.23 ms | 0.27 s |  173.34 ms |
| Three-New · SSGI 8x24                   |       11.52 |        7.02 |     6.33 |   85.99 ms | 0.28 s |  154.17 ms |
| Three-New · Combined hierarchy          |       11.11 |        6.58 |     6.03 |   96.78 ms | 0.26 s |  156.55 ms |
| Three-New · SSGI 7x32                   |       10.89 |        6.40 |     5.72 |   98.19 ms | 0.28 s |  162.09 ms |
| Three-New                               |       10.83 |        6.19 |     5.68 |  109.62 ms | 0.30 s |  189.06 ms |
| Three-New · Tight SSR hierarchy         |       10.73 |        6.14 |     5.52 |  101.76 ms | 0.29 s |  187.24 ms |
| Three-New · SSGI 8x28                   |       10.71 |        6.35 |     5.46 |  105.54 ms | 0.31 s |  161.68 ms |
| Three-New · Validated temporal SSR      |       10.56 |        6.05 |     5.30 |  117.51 ms | 0.32 s | 2607.46 ms |
| Three-New · SSGI radiance mipmaps       |       10.54 |        6.36 |     5.11 |  120.48 ms | 0.28 s |  165.84 ms |
| Three-New · Reduced redundant SSGI work |       10.53 |        6.13 |     5.21 |  113.06 ms | 0.32 s |  171.16 ms |
| Three-New · SSR radiance mipmaps        |       10.52 |        6.14 |     5.57 |  106.91 ms | 0.30 s |  209.44 ms |
| Three-New · SSGI texel reuse            |       10.39 |        5.98 |     4.94 |  127.13 ms | 0.29 s |  167.39 ms |
| Three-New · SSGI early exit             |        9.89 |        5.70 |     4.26 |  147.98 ms | 0.37 s | 2646.18 ms |
| Three-New · Gaussian temporal SSR       |        9.65 |       27.07 |     4.14 |  140.74 ms | 0.32 s | 1436.69 ms |

A single run per configuration describes this observation and cannot estimate run-to-run variability. Different algorithms and sample budgets produce different image quality; inspect the captures and [fidelity report](https://ss-fidelity.ben3d.ca/) alongside these timings. The historical warmup-based and vsync-on results are not directly comparable to this measurement.

## Processed format and viewer

Schema v3 metrics use seconds for every time measurement, including resource timings and network latency. Time field names describe their meaning without repeating unit suffixes: `frameTimes`, `cpuDurations`, `gpuDurations`, and `measuredIntervals`. Timeline and resource timestamps are navigation-relative; lifecycle timestamps in `timing` are Unix epoch seconds. Sizes use bytes, network rates use bytes per second, and frame rates use frames per second.

Phases and blocks store `start` plus `duration`; the viewer computes their end. Unused message receipt logs and script attribution are omitted. Exact statistics and measured intervals support charts, histograms and CLI comparisons. Display indices preserve extrema without inventing intervals between decimated frame timestamps. The viewer formats short costs in milliseconds and longer durations in seconds.

The viewer requests only a lightweight result index, metrics, captures, and the optional results README. It never fetches raw measurements. All timeline axes begin at navigation, with uncovered initialization time inferred as `unknown` phases. Older metrics are not supported; regenerate them with a benchmark run.

- Metrics: 727,651 bytes across 26 files.
- Captures: 1,231,748 bytes across 26 files.

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

`performance:process` rebuilds the index from saved metrics. `performance:dev` watches metrics and sends targeted viewer updates for the affected renderer/scene pair. `performance:serve` serves a snapshot without filesystem watching. Keep hardware, driver, power policy, and Chrome version consistent when comparing future measurements.
