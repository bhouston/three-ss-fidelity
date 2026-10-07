# Representative benchmarks on Windows001

Run `2026-10-07-02-18` started on October 6, 2026 at 22:18 in America/Toronto (02:18 UTC October 7). It adds a separate dated run to the existing `window001` machine, retaining its historical folder spelling.

## Coverage and conditions

The `representative` collection covers `model-breakfast-room-w`, `cornell-box-basic`, `higharc_dogwood`, and `model-coffee-maker` across all 30 browser renderer configurations, including experimental configurations normally disabled in fidelity rendering. Dogwood excludes `three-new-vpl-mirror` and `three-new-vpl-box-projected`, following their registry `disabledScenes` declarations. The external Blender reference renderer is outside the browser FPS workflow. This gives 118 workloads: 30, 30, 28, and 30 respectively.

Hardware: Windows PC Windows001, AMD Ryzen 9 5950X, NVIDIA GeForce RTX 3060 Ti (8 GB), NVIDIA driver 617.14. Browser: headless Chrome for Testing 148.0.7778.97, hardware WebGPU (NVIDIA Ampere) and WebGL2 (ANGLE Direct3D11).

Each workload creates a fresh scene and renderer at 1920 x 1080, DPR 1, with a one-second warmup followed by at least ten seconds of throughput measurement. Completed frames are counted in batches of 16 after GPU completion; the final batch can extend the measurement beyond ten seconds. Browser vsync is disabled, networking is unthrottled, the scheduling seed is 17, Chrome is recycled every four workloads, and the cooldown is two seconds. Each result includes an end-of-run AVIF capture. GPU timestamp profiling is disabled.

The collection was added in source commit `5c3c650dc6ceef09415732020a0473b78a1f81b5`, using fidelity-kit `24cedf70d57752f36cc55566bb05dd81e24047ce`. The final WebGL measurements use the explicit completion-fence fix from `ca99809ffa`; WebGPU completion and rendering are unchanged. The first attempt exposed queue flooding during sustained path tracing. The run was stopped and resumed under the same date-time. All path-tracer workloads were then measured again after the fix. The four baseline `three-current` WebGPU workloads were also repeated as a precaution; their completion policy is unchanged. Two Cornell WebGPU results following the interrupted attempt were also measured again in clean browser instances. Published results retain the final successful measurement for each pair.

Progressive light baking, VPL accumulation, and path-tracer accumulation are included in measurement. These are throughput observations at different rendering quality levels, rather than equal-quality or settled-cache comparisons. One observation per workload does not establish confidence intervals or an improvement over older runs with different measurement policies.

## Reproduce or resume

After installing dependencies:

```powershell
pnpm build
node scripts/build-render-server.mjs
pnpm performance:representative --machine window001 --new-run --renderer 'three-*' --scene 'model-breakfast-room-w,cornell-box-basic,higharc_dogwood,model-coffee-maker' --seed 17 --recycle 4 --cooldown-ms 2000
```

Replace `--new-run` with `--session latest` to add measurements to the last run, or with `--session 2026-10-07-02-18` to select this run explicitly. Without either option, an interactive invocation asks whether to create a new run or add to the existing one. Narrow the renderer or scene globs to rerun selected workloads; results overwrite only the matching pair in the chosen session.

## Recorded throughput

FPS is `throughput.completedFrames / throughput.elapsed` from the committed metrics. A dash indicates a registry exclusion.

| Renderer                         | Breakfast room -w FPS | Cornell basic FPS | Dogwood FPS | Coffee maker FPS |
| -------------------------------- | --------------------: | ----------------: | ----------: | ---------------: |
| three-gpu-pathtracer             |                  1.89 |              9.76 |       11.07 |             4.90 |
| three-current                    |                 74.76 |             18.12 |      350.97 |            53.38 |
| three-new                        |                 36.27 |             16.33 |      333.81 |            38.59 |
| three-new-ssr-hiz-tight          |                 35.54 |             16.22 |      333.54 |            38.16 |
| three-new-ssr-radiance-mips      |                 36.16 |             16.31 |      334.39 |            38.54 |
| three-new-ssgi-radiance-mips     |                 36.13 |             22.40 |      333.23 |            39.58 |
| three-new-hierarchy-combined     |                 35.42 |             22.27 |      325.44 |            39.37 |
| three-new-ssr-temporal-validated |                 36.19 |             16.30 |      332.44 |            38.39 |
| three-new-ssr-temporal-gaussian  |                 35.52 |             16.20 |      333.84 |            37.59 |
| three-new-ssgi-half              |                 55.90 |             48.71 |      435.99 |            71.17 |
| three-new-ssgi-third             |                 62.98 |             69.90 |      479.97 |            84.77 |
| three-new-light-probe            |                 73.25 |            107.30 |      775.05 |           105.65 |
| three-new-light-probe-ddgi       |                 70.32 |            104.69 |      615.95 |           101.70 |
| three-new-light-bake             |                  2.67 |            107.41 |      726.31 |            30.10 |
| three-new-vpl                    |                  2.13 |             97.84 |      231.90 |             3.90 |
| three-new-vpl-mirror             |                  2.12 |             98.22 |           - |             3.92 |
| three-new-vpl-box-projected      |                  2.18 |            543.64 |           - |             4.03 |
| three-new-ssgi-early-exit        |                 34.86 |             21.69 |      323.77 |            38.44 |
| three-new-ssgi-reuse-texels      |                 34.37 |             21.61 |      324.04 |            37.93 |
| three-new-ssgi-redundant-work    |                 34.25 |             21.48 |      324.06 |            37.77 |
| three-new-ssgi-4x32              |                 43.14 |             33.42 |      362.02 |            49.71 |
| three-new-ssgi-8x16              |                 41.81 |             30.37 |      358.28 |            47.60 |
| three-new-ssgi-4x16              |                 46.73 |             43.15 |      379.90 |            56.12 |
| three-new-ssgi-2x16              |                 50.05 |             56.13 |      380.23 |            62.25 |
| three-new-ssgi-2x8               |                 51.16 |             64.48 |      388.38 |            64.86 |
| three-new-ssgi-6x32              |                 38.44 |             26.54 |      362.61 |            43.63 |
| three-new-ssgi-8x24              |                 38.34 |             25.35 |      345.60 |            43.11 |
| three-new-ssgi-6x24              |                 41.08 |             30.08 |      370.86 |            47.24 |
| three-new-ssgi-7x32              |                 38.61 |             24.20 |      364.94 |            43.79 |
| three-new-ssgi-8x28              |                 36.83 |             23.59 |      336.25 |            41.13 |
