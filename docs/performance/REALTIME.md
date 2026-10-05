# Real-time browser performance — October 5, 2026

The standard and metallic suites now include Three VPL (`three-new-vpl`), bringing each scene to 27 configurations. All 81 workloads completed successfully and their metrics and end-of-run AVIF captures are stored in [`performance-results/macbookairm3/`](../../performance-results/macbookairm3/) (MacBook Air M3).

## Measurement conditions

Measured source commit: `3b87a21fc3b39d44a8ab70810c65d43ddf8711ac`. Hardware: Apple M3 CPU/GPU, macOS (darwin 27.0.0), HeadlessChrome 154.0.0.0. These runs use the built renderer, served independently of Vite/HMR, with cross-site iframe isolation and the current performance-kit reporter.

Each workload creates a fresh scene and renderer at 1920×1080, DPR 1, seed 1, with vsync disabled. Scene loading, renderer preparation and an initial compilation frame precede `ready()`. Measurement starts immediately at ready, lasts 10 seconds, and includes progressive GI accumulation. An end-of-run screenshot follows measurement. There is no additional warmup; successful workloads are measured once with a 2-second cooldown. The initial camera workloads encountered an unavailable model asset; those failed attempts were discarded and rerun after making the local model available. GPU timestamp profiling is disabled.

Frame intervals measure browser pacing; CPU submission timings do not wait for completed GPU execution. These single-run observations have no repeated-run confidence interval and do not establish equal-quality speedups. VPL and light baking have different work budgets and convergence behavior. Use the [GI convergence suite](GI_CONVERGENCE.md) for quality-versus-time measurements.

The historical [metallic Cornell report](../history/performance/METALLIC-CORNELL.md) retains its original measurements. Its profiling, warmup, capture order and repetition policy differ, so it should not be used as a direct before/after comparison.

## Refreshed results

Average FPS and P95 come directly from each committed `metrics.json`. P95 frame intervals are converted from seconds to milliseconds. The full viewer also exposes initialization, frame distributions and screenshots.

### cornell-box-basic

| Configuration                           | Average FPS | P95 frame interval (ms) | Setup (s) |
| --------------------------------------- | ----------: | ----------------------: | --------: |
| Three-Base                              |       15.37 |                  128.65 |      0.32 |
| Three-New                               |       10.74 |                  179.75 |      0.47 |
| Three Light Bake                        |       29.38 |                   66.54 |      0.34 |
| Three VPL                               |       22.38 |                   73.85 |      0.36 |
| Three Light Probe                       |       34.78 |                   37.57 |      4.90 |
| Three DDGI                              |       33.92 |                   38.35 |      6.07 |
| Three-New · Tight SSR hierarchy         |       10.88 |                  175.79 |      0.30 |
| Three-New · SSR radiance mipmaps        |       10.71 |                  175.84 |      0.28 |
| Three-New · SSGI radiance mipmaps       |       11.00 |                  166.92 |      0.35 |
| Three-New · Combined hierarchy          |       11.09 |                  166.35 |      0.32 |
| Three-New · Half resolution SSGI        |       18.99 |                   75.29 |      0.36 |
| Three-New · Third resolution SSGI       |       23.94 |                   56.12 |      0.20 |
| Three-New · Validated temporal SSR      |       10.74 |                  177.62 |      0.32 |
| Three-New · Gaussian temporal SSR       |       10.63 |                  181.49 |      0.45 |
| Three-New · SSGI early exit             |       11.15 |                  165.42 |      0.27 |
| Three-New · SSGI texel reuse            |       11.26 |                  164.95 |      0.29 |
| Three-New · Reduced redundant SSGI work |       11.16 |                  163.87 |      0.45 |
| Three-New · SSGI 4x32                   |       14.15 |                  111.29 |      0.40 |
| Three-New · SSGI 8x16                   |       13.48 |                  121.14 |      0.38 |
| Three-New · SSGI 4x16                   |       17.11 |                   87.03 |      0.39 |
| Three-New · SSGI 2x16                   |       20.72 |                   66.66 |      0.37 |
| Three-New · SSGI 2x8                    |       23.36 |                   60.49 |      0.36 |
| Three-New · SSGI 6x32                   |       12.32 |                  140.16 |      0.28 |
| Three-New · SSGI 8x24                   |       12.02 |                  143.91 |      0.43 |
| Three-New · SSGI 6x24                   |       13.31 |                  123.13 |      0.42 |
| Three-New · SSGI 7x32                   |       11.59 |                  156.44 |      0.30 |
| Three-New · SSGI 8x28                   |       11.56 |                  154.48 |      0.43 |

### steampunk-camera

| Configuration                           | Average FPS | P95 frame interval (ms) | Setup (s) |
| --------------------------------------- | ----------: | ----------------------: | --------: |
| Three-Base                              |      114.04 |                   10.85 |      1.97 |
| Three-New                               |       54.68 |                   23.90 |      0.26 |
| Three Light Bake                        |       52.46 |                   29.53 |      0.56 |
| Three VPL                               |       48.69 |                   30.54 |      4.01 |
| Three Light Probe                       |       54.70 |                   23.74 |      1.84 |
| Three DDGI                              |       54.86 |                   23.91 |      0.34 |
| Three-New · Tight SSR hierarchy         |       55.29 |                   23.42 |      0.34 |
| Three-New · SSR radiance mipmaps        |       51.35 |                   24.46 |      0.71 |
| Three-New · SSGI radiance mipmaps       |       54.72 |                   23.72 |      0.33 |
| Three-New · Combined hierarchy          |       53.26 |                   24.26 |      0.35 |
| Three-New · Half resolution SSGI        |       54.74 |                   23.82 |      0.35 |
| Three-New · Third resolution SSGI       |       54.90 |                   23.64 |      0.35 |
| Three-New · Validated temporal SSR      |       54.03 |                   24.16 |      0.35 |
| Three-New · Gaussian temporal SSR       |       52.32 |                   24.54 |      0.35 |
| Three-New · SSGI early exit             |       53.20 |                   24.17 |      0.34 |
| Three-New · SSGI texel reuse            |       53.04 |                   24.42 |      0.33 |
| Three-New · Reduced redundant SSGI work |       53.34 |                   24.11 |      0.32 |
| Three-New · SSGI 4x32                   |       53.16 |                   24.58 |      0.34 |
| Three-New · SSGI 8x16                   |       53.10 |                   24.25 |      0.33 |
| Three-New · SSGI 4x16                   |       52.97 |                   24.48 |      0.34 |
| Three-New · SSGI 2x16                   |       53.27 |                   24.34 |      0.33 |
| Three-New · SSGI 2x8                    |       53.00 |                   24.66 |      0.32 |
| Three-New · SSGI 6x32                   |       53.04 |                   24.21 |      0.32 |
| Three-New · SSGI 8x24                   |       53.02 |                   24.32 |      0.35 |
| Three-New · SSGI 6x24                   |       53.36 |                   24.16 |      0.33 |
| Three-New · SSGI 7x32                   |       53.03 |                   24.09 |      0.34 |
| Three-New · SSGI 8x28                   |       53.30 |                   24.25 |      0.35 |

### cornell-box-metallic

| Configuration                           | Average FPS | P95 frame interval (ms) | Setup (s) |
| --------------------------------------- | ----------: | ----------------------: | --------: |
| Three-Base                              |       14.85 |                  136.56 |      0.35 |
| Three-New                               |       10.43 |                  188.91 |      0.35 |
| Three Light Bake                        |       23.11 |                   97.25 |      0.28 |
| Three VPL                               |       16.60 |                  102.98 |      0.23 |
| Three Light Probe                       |       32.82 |                   40.13 |      5.13 |
| Three DDGI                              |       32.42 |                   40.92 |      6.15 |
| Three-New · Tight SSR hierarchy         |       10.62 |                  183.77 |      0.29 |
| Three-New · SSR radiance mipmaps        |       10.46 |                  184.59 |      0.29 |
| Three-New · SSGI radiance mipmaps       |       10.85 |                  173.02 |      0.29 |
| Three-New · Combined hierarchy          |       10.82 |                  170.90 |      0.31 |
| Three-New · Half resolution SSGI        |       18.40 |                   78.45 |      0.24 |
| Three-New · Third resolution SSGI       |       23.35 |                   57.12 |      0.19 |
| Three-New · Validated temporal SSR      |       10.67 |                  184.93 |      0.31 |
| Three-New · Gaussian temporal SSR       |       10.52 |                  188.30 |      0.30 |
| Three-New · SSGI early exit             |       10.93 |                  168.97 |      0.29 |
| Three-New · SSGI texel reuse            |       10.85 |                  168.92 |      0.30 |
| Three-New · Reduced redundant SSGI work |       11.05 |                  168.70 |      0.31 |
| Three-New · SSGI 4x32                   |       13.99 |                  115.03 |      0.25 |
| Three-New · SSGI 8x16                   |       13.33 |                  126.74 |      0.24 |
| Three-New · SSGI 4x16                   |       16.83 |                   88.08 |      0.21 |
| Three-New · SSGI 2x16                   |       20.35 |                   66.73 |      0.21 |
| Three-New · SSGI 2x8                    |       21.66 |                   62.35 |      0.20 |
| Three-New · SSGI 6x32                   |       12.19 |                  141.03 |      0.26 |
| Three-New · SSGI 8x24                   |       11.98 |                  145.46 |      0.29 |
| Three-New · SSGI 6x24                   |       12.77 |                  143.72 |      0.26 |
| Three-New · SSGI 7x32                   |       11.44 |                  166.32 |      0.31 |
| Three-New · SSGI 8x28                   |       11.43 |                  156.90 |      0.32 |

## Reproduce

```sh
pnpm build
mkdir -p packages/playground/dist/models/gltf
cp submodules/three.js/examples/models/gltf/steampunk_camera.glb packages/playground/dist/models/gltf/
pnpm performance:run --renderer-root packages/playground/dist --renderer-port 5173
pnpm performance:metallic
pnpm performance:process
pnpm performance:build
```

The build intentionally omits the Three.js example asset library. Copying the camera GLB into the static renderer directory makes the camera workload available without duplicating the full library. This refresh used a local symlink to that same model directory.

The standard suite uses port 5173 for its renderer URLs; the metallic suite uses 4401. The commands above start their own static renderer servers. Keep those ports free. If the report port 4400 is already occupied, pass `--port 4410` (as used for this refresh). If the bundled browser needs repair, append `--executable-path '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'` to each run command, as used for these measurements.

To measure only VPL, append `--renderer three-new-vpl` to either run command. Both suite files retain the same workload resolution, duration, seed and capture settings for VPL as for the existing configurations.
