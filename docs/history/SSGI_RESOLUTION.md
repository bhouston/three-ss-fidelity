# Reduced-resolution SSGI experiment

Opt-in renderer profiles `three-new-ssgi-half` and `three-new-ssgi-third` reduce each SSGI target dimension by two or three. They build on the unchanged baseline, independently of the radiance-mip experiments. SSGI traces approximately one-quarter or one-ninth as many receiver pixels; its per-receiver slice and step counts remain unchanged. The reprojected radiance source and GI/AO temporal filters use the same scale. Scene rendering, pre-pass geometry, SSR and TRAA retain their original settings.

The reconstruction is a 3×3 joint bilateral upsample, using a Gaussian spatial weight, relative view-depth agreement (2% with a 0.01 view-unit floor), and normal agreement raised to power 32. Full-resolution depth and normals guide the filter. Each coarse receiver samples the same snapped depth texel as SSGINode, including odd dimensions. GI and AO are packed into one full-resolution RGBA16F render target so material shading does not repeat the nine-tap gather. Very small weight sums fall back to the strongest sample; if all weights vanish, the nearest coarse sample is used. All newly owned targets are disposed with the pipeline.

This follows the established [joint bilateral upsampling method](https://www.microsoft.com/en-us/research/publication/joint-bilateral-upsampling/). Full-resolution visibility inputs avoid averaged depths across silhouettes. A coarse receiver grid still misses thin surfaces and small illumination features, and interpolation cannot recover unsampled lighting. Halving a target dimension therefore does not guarantee four times faster complete frames.

## Reproduction

Run `pnpm build`, then:

```sh
node scripts/hierarchical-experiments.mjs --out .output/ssgi-lowres-quality \
  --experiments ssgi-half,ssgi-third \
  --scenes ssgi-basic,ssgi-rounded,gi-hierarchy-discontinuity,gi-room-open-high-albedo,ssgi-metallic \
  --skip-timing

node scripts/hierarchical-experiments.mjs --out .output/ssgi-lowres-timing \
  --experiments ssgi-half,ssgi-third --scenes ssgi-basic,gi-hierarchy-discontinuity \
  --skip-quality --repeats 3 --warmup 10 --measure 20

node scripts/hierarchical-quality.mjs --out .output/ssgi-lowres-extra \
  --experiments ssgi-half,ssgi-third --scenes ssgi-basic,gi-hierarchy-discontinuity \
  --width 961 --height 541
```

Native quality uses 128 frames and decoded sRGB RGB8 PSNR against the existing path-traced reference. The runner also renders the baseline twice, reports candidate differences from the matched baseline, and flags reference-PSNR losses greater than 0.1 dB. The timing runner alternates variant order across three fresh-process repetitions, with GPU-synchronized batch wall times and separate timestamp profiling. Overlapping GPU timestamps are not added together. Native quality does not establish 1080p fidelity. The optional additional-capture command checks 961×541 odd dimensions and a 20° camera move over 16 frames with captures at arrival and 4, 16 and 64 frames at rest.

## Validation

Build, type checking, lint and 123 tests with coverage passed. Lint retains existing warnings in vendored SSGI/SSR. The dependency audit reports three existing high-severity advisories in the path-tracer submodule’s Puppeteer dependencies: two in extract-zip and one in basic-ftp. No dependencies changed.

The implementation and current captures are proposed in a PR; the original checkout retains its local changes on main as requested. Tracking issue: [#107](https://github.com/bhouston/three-ss-fidelity/issues/107).

## Current measurements

The [native-quality report](ssgi-resolution/native-quality.json) contains all five matched comparisons. PSNR is against the path-traced reference; higher is better. Every baseline repeat was byte-identical. The 0.1 dB gate is diagnostic, as requested, and does not block this experiment.

| Scene                        | Baseline PSNR | Half PSNR | Third PSNR | Half change | Third change |
| ---------------------------- | ------------: | --------: | ---------: | ----------: | -----------: |
| `ssgi-basic`                 |        27.481 |    27.613 |     27.632 |      +0.132 |       +0.151 |
| `ssgi-rounded`               |        29.348 |    29.168 |     29.353 |      -0.180 |       +0.006 |
| `gi-hierarchy-discontinuity` |        35.146 |    34.242 |     34.983 |      -0.904 |       -0.164 |
| `gi-room-open-high-albedo`   |        31.726 |    31.345 |     31.697 |      -0.381 |       -0.029 |
| `ssgi-metallic`              |        27.627 |    27.591 |     27.589 |      -0.035 |       -0.038 |

Half resolution fails the diagnostic gate on rounded geometry, the striped-emitter diagnostic, and the high-albedo open room. Third resolution fails it only on the striped-emitter diagnostic. Both profiles remain opt-in. Visual inspection of basic and striped scenes shows similar overall illumination, with differences in contact regions and surface lighting; full-image PSNR does not establish edge or motion fidelity.

The [preliminary timing record](ssgi-resolution/preliminary-timing.json) preserves the interrupted 1080p run. Its one completed repetition on `ssgi-basic` measured 558.96 ms baseline, 350.83 ms half, and 298.83 ms third. Concurrent path-tracing work was observed on the same machine, and these numbers are not a validated frame-rate comparison. The requested timing rerun is pending; no repeated-speedup claim is made in this PR. The optional 961×541 and camera-motion captures are also pending.

Completed variant images already present in `results/` are included for viewer inspection. The five-scene report describes only the controlled captures listed above; other images do not establish additional timing or motion evidence.
