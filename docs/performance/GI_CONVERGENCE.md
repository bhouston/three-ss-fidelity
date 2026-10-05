# GI performance and convergence

Run `pnpm build`, then `pnpm performance:convergence`. Add `--executable-path /path/to/chrome` if Chrome is not discovered automatically. The suite measures Cornell box light baking and VPL for 15 seconds each, with a 640×480 Blender reference, a 250 ms sampling cadence and a 30 dB PSNR target.

Results are written to `performance-convergence-results/<machine-id>/`; set `PERFORMANCE_MACHINE` as described in the [README](../../README.md#benchmark-machines). The existing results were measured on the MacBook Air M3 (`macbookairm3`). Each workload includes processed metrics, the final screenshot, a lossless reference and a lossless 4× absolute RGB diff. To create a portable report:

```sh
node submodules/performance-kit/packages/cli/dist/bin.js build --out performance-convergence-results --site performance-convergence-site
```

The report presents frame timing, PSNR over elapsed time, and the first observed time to the configured PSNR target. All charts share the longest run’s horizontal time range and plot margins. Average milliseconds, P95 and FPS labels sit outside the plot. Reference runs have a Convergence badge.

## Initial measurement

One isolated Chrome run on October 5, 2026, using the committed Blender image:

| Method                       | Average FPS | Final sampled PSNR | First observed 30 dB |
| ---------------------------- | ----------: | -----------------: | -------------------: |
| Progressive BVH light baking |      135.37 |           28.37 dB |          Not reached |
| VPL                          |      111.00 |           34.54 dB |    4.69 s, frame 123 |

These values describe this browser run and reference. They are not a cross-machine performance claim. The threshold is sampled rather than interpolated, and reaching it once does not establish sustained convergence. Timing begins at `ready()`, after scene setup and the initial compilation frame. Pixel comparisons use displayed sRGB8 RGB values, consistent with the fidelity viewer’s PSNR; they do not measure HDR radiance error. Reference choice can change the ranking.

## Why the earlier VPL speed comparison used a separate benchmark

The earlier benchmark compared completed GPU work in native Dawn, used fresh processes and alternated method order, and separated cache construction from cached rendering. Browser CPU submission time and animation-frame intervals describe a different execution path. The original performance-kit also had no reference image or quality-versus-time measurements, so it could not answer how quickly a method reached a useful quality level.

The new optional reference supports that question without combining the two kits. Fidelity-kit remains responsible for reference generation and static comparisons; performance-kit consumes the same image and measures progressive agreement during a timed run. Native completed-GPU timing remains useful when comparing that backend.

## Reference brightness observation

The current Cornell basic and rounded Blender images have approximately 27% and 26% higher mean luminance than the GPU path tracer, measured after sRGB decoding. VPL is approximately 21% and 20% brighter than the GPU path tracer. Fitting one linear RGB gain to the path tracer increases its linear-RGB PSNR against Blender by roughly 11 dB in these two scenes. Brightness explains much of their reference disagreement, but this does not establish which reference is physically correct. The rooms show additional spatial differences; VPL’s whole-image mean is slightly lower than the path tracer in the grey-and-white room.

Both reference adapters configure eight bounces and use the scene’s exposure and tone mapping. Different bounce accounting and material scattering remain possibilities to investigate, rather than established causes. Do not compensate a renderer with a fitted brightness gain in fidelity scoring.
