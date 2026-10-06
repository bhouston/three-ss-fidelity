# Real-time browser performance on build001 — October 5, 2026

These are the first results from `build001` (Ubuntu, AMD Ryzen 9 5950X, NVIDIA GeForce GTX 1050). All 81 workloads completed successfully, and their metrics and end-of-run AVIF captures are stored in [`performance-results/build001/`](../../performance-results/build001/). The MacBook Air M3 results are described in [REALTIME.md](REALTIME.md).

## Measurement conditions

Measured source commit: `9d1e4c9f898418c55580f61ab987fd9dd272b82b`, with performance-kit `7bdaf334d92e61bf9b7d85dcfe40b8d0daa81f14`. Hardware: AMD Ryzen 9 5950X, NVIDIA GeForce GTX 1050 (2 GB, Pascal) with driver 580.178.04, Ubuntu 26.04.1 (kernel 7.0.0-38-generic), GNOME on Wayland, 1920×1080 display at 59.96 Hz. Browser: Chrome for Testing 148.0.7778.97, WebGPU on the Vulkan backend.

The workloads, resolution, duration and capture settings match the M3 run: a fresh scene and renderer at 1920×1080, DPR 1, seed 1, 10 seconds measured from ready with no warmup, one run per workload, a 2-second cooldown and an end-of-run screenshot. Two settings differ, because of [Chrome WebGPU issues on Linux](CHROME_LINUX_WEBGPU.md):

- **Headful Chrome:** a visible browser window, because headless Chrome on Linux has no frame backpressure and would report submission rates, not rendering rates.
- **Vsync on:** Chrome on Linux has no frame backpressure with vsync off either, so frame rates are capped at the 59.96 Hz display rate. No workload exceeded 36 fps, so the cap did not limit any result.

Results record `config.vsync: "on"`, while the M3 results record `"off"`. The comparison column is included for orientation; it compares different GPUs, operating systems and vsync modes.

## Results

Average FPS and P95 come directly from each committed `metrics.json`. P95 frame intervals are converted from seconds to milliseconds.

### cornell-box-basic

| Configuration                           | Average FPS | P95 frame interval (ms) | Setup (s) | MacBook Air M3 FPS |
| --------------------------------------- | ----------: | ----------------------: | --------: | -----------------: |
| Three-Base                              |        2.88 |                  391.45 |      0.63 |              15.37 |
| Three-New                               |        2.49 |                  478.62 |      0.71 |              10.74 |
| Three Light Bake                        |        8.73 |                  141.62 |      0.49 |              29.38 |
| Three VPL                               |        7.55 |                  139.50 |      0.48 |              22.38 |
| Three Light Probe                       |       19.32 |                   53.16 |     23.23 |              34.78 |
| Three DDGI                              |       18.76 |                   56.06 |      4.57 |              33.92 |
| Three-New · Tight SSR hierarchy         |        2.49 |                  477.80 |      0.70 |              10.88 |
| Three-New · SSR radiance mipmaps        |        2.50 |                  476.77 |      0.68 |              10.71 |
| Three-New · SSGI radiance mipmaps       |        2.83 |                  417.08 |      0.66 |              11.00 |
| Three-New · Combined hierarchy          |        2.81 |                  419.75 |      0.65 |              11.09 |
| Three-New · Half resolution SSGI        |        6.91 |                  155.61 |      0.40 |              18.99 |
| Three-New · Third resolution SSGI       |       10.59 |                   98.47 |      0.34 |              23.94 |
| Three-New · Validated temporal SSR      |        2.51 |                  475.86 |      0.70 |              10.74 |
| Three-New · Gaussian temporal SSR       |        2.49 |                  479.78 |      0.69 |              10.63 |
| Three-New · SSGI early exit             |        2.81 |                  418.56 |      0.67 |              11.15 |
| Three-New · SSGI texel reuse            |        2.79 |                  423.78 |      0.69 |              11.26 |
| Three-New · Reduced redundant SSGI work |        2.79 |                  425.66 |      0.67 |              11.16 |
| Three-New · SSGI 4x32                   |        4.23 |                  274.53 |      0.53 |              14.15 |
| Three-New · SSGI 8x16                   |        4.00 |                  296.60 |      0.56 |              13.48 |
| Three-New · SSGI 4x16                   |        5.93 |                  193.87 |      0.47 |              17.11 |
| Three-New · SSGI 2x16                   |        8.20 |                  135.29 |      0.44 |              20.72 |
| Three-New · SSGI 2x8                    |       10.17 |                  107.84 |      0.43 |              23.36 |
| Three-New · SSGI 6x32                   |        3.34 |                  349.81 |      0.58 |              12.32 |
| Three-New · SSGI 8x24                   |        3.26 |                  359.90 |      0.58 |              12.02 |
| Three-New · SSGI 6x24                   |        3.87 |                  304.74 |      0.56 |              13.31 |
| Three-New · SSGI 7x32                   |        3.05 |                  386.38 |      0.61 |              11.59 |
| Three-New · SSGI 8x28                   |        3.01 |                  391.02 |      0.60 |              11.56 |

### steampunk-camera

| Configuration                           | Average FPS | P95 frame interval (ms) | Setup (s) | MacBook Air M3 FPS |
| --------------------------------------- | ----------: | ----------------------: | --------: | -----------------: |
| Three-Base                              |       35.87 |                   28.57 |      0.66 |             114.04 |
| Three-New                               |       22.16 |                   45.78 |      0.72 |              54.68 |
| Three Light Bake                        |       18.36 |                   75.02 |      0.72 |              52.46 |
| Three VPL                               |       13.68 |                   77.18 |      0.64 |              48.69 |
| Three Light Probe                       |       22.40 |                   46.03 |      0.43 |              54.70 |
| Three DDGI                              |       22.42 |                   45.72 |      0.43 |              54.86 |
| Three-New · Tight SSR hierarchy         |       22.12 |                   46.34 |      0.45 |              55.29 |
| Three-New · SSR radiance mipmaps        |       22.59 |                   44.65 |      0.55 |              51.35 |
| Three-New · SSGI radiance mipmaps       |       22.29 |                   46.01 |      0.44 |              54.72 |
| Three-New · Combined hierarchy          |       22.58 |                   45.99 |      0.46 |              53.26 |
| Three-New · Half resolution SSGI        |       22.38 |                   45.70 |      0.43 |              54.74 |
| Three-New · Third resolution SSGI       |       22.41 |                   45.67 |      0.44 |              54.90 |
| Three-New · Validated temporal SSR      |       22.27 |                   45.93 |      0.44 |              54.03 |
| Three-New · Gaussian temporal SSR       |       21.64 |                   47.26 |      0.43 |              52.32 |
| Three-New · SSGI early exit             |       22.67 |                   45.16 |      0.43 |              53.20 |
| Three-New · SSGI texel reuse            |       22.58 |                   45.57 |      0.44 |              53.04 |
| Three-New · Reduced redundant SSGI work |       22.59 |                   45.45 |      0.43 |              53.34 |
| Three-New · SSGI 4x32                   |       22.53 |                   45.32 |      0.43 |              53.16 |
| Three-New · SSGI 8x16                   |       22.59 |                   45.76 |      0.45 |              53.10 |
| Three-New · SSGI 4x16                   |       22.66 |                   45.28 |      0.44 |              52.97 |
| Three-New · SSGI 2x16                   |       22.57 |                   45.39 |      0.43 |              53.27 |
| Three-New · SSGI 2x8                    |       22.61 |                   45.69 |      0.46 |              53.00 |
| Three-New · SSGI 6x32                   |       22.66 |                   45.28 |      0.43 |              53.04 |
| Three-New · SSGI 8x24                   |       22.67 |                   45.04 |      0.43 |              53.02 |
| Three-New · SSGI 6x24                   |       22.58 |                   45.81 |      0.44 |              53.36 |
| Three-New · SSGI 7x32                   |       22.66 |                   45.15 |      0.43 |              53.03 |
| Three-New · SSGI 8x28                   |       22.68 |                   45.10 |      0.44 |              53.30 |

### cornell-box-metallic

| Configuration                           | Average FPS | P95 frame interval (ms) | Setup (s) | MacBook Air M3 FPS |
| --------------------------------------- | ----------: | ----------------------: | --------: | -----------------: |
| Three-Base                              |        2.79 |                  404.65 |      0.67 |              14.85 |
| Three-New                               |        2.42 |                  492.34 |      0.72 |              10.43 |
| Three Light Bake                        |        5.04 |                  210.31 |      0.50 |              23.11 |
| Three VPL                               |        5.24 |                  204.88 |      0.51 |              16.60 |
| Three Light Probe                       |       18.02 |                   57.75 |      2.89 |              32.82 |
| Three DDGI                              |       17.56 |                   58.28 |      4.35 |              32.42 |
| Three-New · Tight SSR hierarchy         |        2.41 |                  496.89 |      0.72 |              10.62 |
| Three-New · SSR radiance mipmaps        |        2.41 |                  493.89 |      0.69 |              10.46 |
| Three-New · SSGI radiance mipmaps       |        2.77 |                  427.16 |      0.65 |              10.85 |
| Three-New · Combined hierarchy          |        2.76 |                  429.55 |      0.65 |              10.82 |
| Three-New · Half resolution SSGI        |        6.61 |                  163.23 |      0.41 |              18.40 |
| Three-New · Third resolution SSGI       |       10.09 |                  103.80 |      0.35 |              23.35 |
| Three-New · Validated temporal SSR      |        2.42 |                  491.57 |      0.71 |              10.67 |
| Three-New · Gaussian temporal SSR       |        2.41 |                  496.42 |      0.70 |              10.52 |
| Three-New · SSGI early exit             |        2.75 |                  429.37 |      0.65 |              10.93 |
| Three-New · SSGI texel reuse            |        2.72 |                  434.08 |      0.67 |              10.85 |
| Three-New · Reduced redundant SSGI work |        2.72 |                  433.49 |      0.65 |              11.05 |
| Three-New · SSGI 4x32                   |        4.14 |                  280.17 |      0.53 |              13.99 |
| Three-New · SSGI 8x16                   |        3.93 |                  295.39 |      0.57 |              13.33 |
| Three-New · SSGI 4x16                   |        5.79 |                  196.95 |      0.49 |              16.83 |
| Three-New · SSGI 2x16                   |        7.98 |                  138.18 |      0.45 |              20.35 |
| Three-New · SSGI 2x8                    |        9.86 |                  111.54 |      0.45 |              21.66 |
| Three-New · SSGI 6x32                   |        3.28 |                  357.72 |      0.60 |              12.19 |
| Three-New · SSGI 8x24                   |        3.18 |                  368.95 |      0.61 |              11.98 |
| Three-New · SSGI 6x24                   |        3.78 |                  308.47 |      0.57 |              12.77 |
| Three-New · SSGI 7x32                   |        2.98 |                  404.75 |      0.62 |              11.44 |
| Three-New · SSGI 8x28                   |        2.94 |                  400.36 |      0.62 |              11.43 |

## Reproduce

```sh
pnpm build
mkdir -p packages/playground/dist/models/gltf
cp submodules/three.js/examples/models/gltf/steampunk_camera.glb packages/playground/dist/models/gltf/
PERFORMANCE_MACHINE=build001 pnpm performance:run --renderer-root packages/playground/dist --renderer-port 5173 --headful --vsync on
PERFORMANCE_MACHINE=build001 pnpm performance:metallic --headful --vsync on
pnpm performance:process
```

Keep the Chrome windows visible and uncovered during the run, which takes about 27 minutes. Do not add `--enable-features=Vulkan`: in headful mode it corrupts the captured screenshots.
