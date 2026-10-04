# Cornell metallic sphere performance — October 3, 2026

Initial browser performance measurement of all 26 real-time Three configurations on `ssgi-metallic`, the Cornell box with a cone and a mirror sphere. All 78 runs completed successfully (three interleaved repetitions per configuration). Blender and path tracers are excluded.

Raw run set: [2026-10-04T00-50-05-359Z_01M4267CXFYE6D4ZSEB537PMYB](../../../performance-results/runsets/2026-10-04T00-50-05-359Z_01M4267CXFYE6D4ZSEB537PMYB/manifest.json). Measured source commit: `aed207b307f4101f61ea10f7d94b8e54fbdf96d6`.

Hardware: Apple M3; GPU Apple M3; darwin 27.0.0. Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36.

Each run uses 1920×1080 at DPR 1, vsync on, 2 s warmup, 10 s measured, and 2 s cooldown. A fresh scene/renderer is created per run; capture precedes measurement. GPU timestamps instrument render/compute passes, so these timings include profiling overhead. Captures use the render CLI’s AVIF settings: alpha removed, quality 90, full-resolution 4:4:4 chroma. The transport capture was lossless PNG; conversion changes only the saved capture path, with raw timestamps preserved.

## Derived summary

Typical is the median of per-run frame-interval medians. Tail, jitter, setup and GPU columns are medians of their per-run derived values. The range shows the lowest and highest repetition median; “unstable” means that spread exceeds 5%. CPU submit and GPU spans are separate from frame pacing. Values are derived from raw records and are not stored in result JSON.

| Configuration                    | Typical ms | FPS equiv. | Rep range ms  | p95 ms | IQR ms | Setup s | GPU ms | Repeat spread |
| -------------------------------- | ---------: | ---------: | ------------- | -----: | -----: | ------: | -----: | ------------- |
| Three Light Probe                |      37.14 |      26.93 | 37.09–37.91   |  73.13 |   2.80 |    4.91 |   1.86 | ≤5%           |
| Three Light Bake                 |      37.58 |      26.61 | 36.10–40.70   |  88.50 |  11.36 |    0.23 |   1.99 | unstable      |
| Three DDGI                       |      38.13 |      26.23 | 37.61–38.18   |  73.98 |   3.10 |    6.16 |   3.00 | ≤5%           |
| Three-New ssgi-third             |      54.57 |      18.33 | 54.26–62.84   |  63.29 |   3.43 |    0.16 |   4.08 | unstable      |
| Three-New ssgi-2x8               |      56.29 |      17.77 | 55.08–77.89   |  64.99 |   2.93 |    0.18 |   1.54 | unstable      |
| Three-New ssgi-2x16              |      65.84 |      15.19 | 64.85–66.62   |  88.08 |   3.69 |    0.19 |   2.39 | ≤5%           |
| Three-New ssgi-half              |      72.93 |      13.71 | 72.33–82.66   |  84.71 |   7.78 |    0.18 |   3.95 | unstable      |
| Three-New ssgi-4x16              |      83.36 |      12.00 | 81.47–85.34   | 120.75 |   1.77 |    0.21 |   1.33 | ≤5%           |
| Three-New ssgi-4x32              |     110.50 |       9.05 | 105.91–112.99 | 196.33 |   4.96 |    0.22 |   1.87 | unstable      |
| Three-New ssgi-8x16              |     115.40 |       8.67 | 114.84–115.59 | 228.15 |   6.60 |    0.23 |   4.09 | ≤5%           |
| Three-New ssgi-6x24              |     117.64 |       8.50 | 115.92–137.64 | 242.84 |  58.25 |    0.22 | 121.51 | unstable      |
| Three-Base                       |     131.54 |       7.60 | 123.94–141.91 | 275.97 | 232.92 |    0.24 | 135.20 | unstable      |
| Three-New ssgi-6x32              |     134.19 |       7.45 | 131.96–184.75 | 178.18 |   4.12 |    0.25 |   3.27 | unstable      |
| Three-New ssgi-8x24              |     145.91 |       6.85 | 143.46–166.73 | 301.81 |  16.79 |    0.25 |   3.87 | unstable      |
| Three-New ssgi-7x32              |     149.40 |       6.69 | 145.02–184.27 | 327.60 |  25.54 |    0.25 |   3.42 | unstable      |
| Three-New ssgi-8x28              |     150.16 |       6.66 | 146.71–173.26 | 295.94 |  13.88 |    0.25 |   2.43 | unstable      |
| Three-New ssgi-radiance-mips     |     155.80 |       6.42 | 155.42–156.11 | 174.73 |   5.66 |    0.25 |   2.03 | ≤5%           |
| Three-New ssgi-reuse-texels      |     155.87 |       6.42 | 153.10–173.05 | 290.27 |   9.19 |    0.26 |   3.43 | unstable      |
| Three-New ssgi-early-exit        |     156.45 |       6.39 | 155.83–182.27 | 317.13 |  12.58 |    0.28 |   3.42 | unstable      |
| Three-New hierarchy-combined     |     157.65 |       6.34 | 153.35–163.20 | 315.19 |   9.43 |    0.26 |   3.20 | unstable      |
| Three-New ssgi-redundant-work    |     160.36 |       6.24 | 152.33–172.10 | 326.46 |  15.45 |    0.27 |   2.11 | unstable      |
| Three-New ssr-radiance-mips      |     165.47 |       6.04 | 164.21–175.07 | 179.92 |   4.58 |    0.27 |   3.61 | unstable      |
| Three-New ssr-hiz-tight          |     166.44 |       6.01 | 165.61–180.92 | 345.37 |  11.16 |    0.27 |   3.79 | unstable      |
| Three-New                        |     172.26 |       5.81 | 168.69–192.03 | 185.17 |   7.36 |    0.29 |   1.44 | unstable      |
| Three-New ssr-temporal-gaussian  |     172.59 |       5.79 | 170.85–207.98 | 336.52 |  13.33 |    0.27 |   2.94 | unstable      |
| Three-New ssr-temporal-validated |     173.18 |       5.77 | 168.84–211.07 | 335.53 |  17.99 |    0.27 |   1.80 | unstable      |

## Comparison with Three-Base

A/Base is the ratio of pooled frame-interval medians. Confidence intervals resample whole runs, keeping correlated frames together; Mann–Whitney compares the frame distributions. These are initial observations from three repetitions on one machine and one scene. Different algorithms/sample budgets can produce different image quality; inspect the AVIF captures and fidelity comparisons before choosing a variant.

| Configuration                    | A/Base ratio | Run bootstrap 95% CI | Verdict                  |
| -------------------------------- | -----------: | -------------------- | ------------------------ |
| Three-New                        |        1.323 | 1.223–1.441          | slower                   |
| Three Light Bake                 |        0.291 | 0.265–0.316          | faster                   |
| Three Light Probe                |        0.286 | 0.263–0.300          | faster                   |
| Three DDGI                       |        0.293 | 0.269–0.307          | faster                   |
| Three-New ssr-hiz-tight          |        1.279 | 1.179–1.367          | slower                   |
| Three-New ssr-radiance-mips      |        1.282 | 1.173–1.378          | slower                   |
| Three-New ssgi-radiance-mips     |        1.200 | 1.098–1.256          | slower                   |
| Three-New hierarchy-combined     |        1.208 | 1.112–1.276          | slower                   |
| Three-New ssgi-half              |        0.571 | 0.523–0.635          | faster                   |
| Three-New ssgi-third             |        0.427 | 0.393–0.473          | faster                   |
| Three-New ssr-temporal-validated |        1.353 | 1.233–1.668          | slower                   |
| Three-New ssr-temporal-gaussian  |        1.338 | 1.226–1.561          | slower                   |
| Three-New ssgi-early-exit        |        1.210 | 1.120–1.368          | slower                   |
| Three-New ssgi-reuse-texels      |        1.213 | 1.112–1.310          | slower                   |
| Three-New ssgi-redundant-work    |        1.223 | 1.107–1.325          | slower                   |
| Three-New ssgi-4x32              |        0.838 | 0.767–0.890          | faster                   |
| Three-New ssgi-8x16              |        0.887 | 0.813–0.928          | faster                   |
| Three-New ssgi-4x16              |        0.641 | 0.589–0.673          | faster                   |
| Three-New ssgi-2x16              |        0.503 | 0.464–0.528          | faster                   |
| Three-New ssgi-2x8               |        0.433 | 0.398–0.600          | faster                   |
| Three-New ssgi-6x32              |        1.033 | 0.948–1.423          | no detectable difference |
| Three-New ssgi-8x24              |        1.139 | 1.043–1.284          | slower                   |
| Three-New ssgi-6x24              |        0.913 | 0.836–1.060          | no detectable difference |
| Three-New ssgi-7x32              |        1.133 | 1.051–1.419          | slower                   |
| Three-New ssgi-8x28              |        1.154 | 1.060–1.334          | slower                   |

## View and reproduce

Published report: [performance viewer](https://ss-fidelity.ben3d.ca/performance/). The report provides captures, phase/responsiveness timelines, repetitions, GPU/CPU series, raw JSON links and label comparisons. CI also uploads a `performance-report` artifact.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm performance:serve
pnpm performance:build
# To repeat the measurement:
pnpm performance:metallic --executable-path <chrome>
```

Keep browser, power policy, driver and hardware consistent when comparing later runs. The manifest snapshots the original suite, schedule, browser flags and environment. The original recorded source commit predates the unrelated coffee-maker exposure update merged while this measurement was running.
