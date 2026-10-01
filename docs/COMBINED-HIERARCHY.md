# Combined hierarchical experiment

`hierarchy-combined` enables tight SSR Hi-Z reduction, SSR radiance mip sampling,
and SSGI radiance mip sampling in one opt-in `three-new` profile. The baseline and
three independent profiles retain their previous settings. CLI rendering,
quality gates, benchmark reports, URL restoration, and the live Experiment
selector use the same experiment registry. Thirteen combined captures are
included in the fidelity viewer.

## Composition and resource sharing

The techniques operate on separate parts of the graph and can be enabled together.
When both effects run at `resolutionScale = 1`, SSR reuses the GI RG11B10
reprojected radiance texture and its mip chain. Compared with a naive composition,
this removes one full-resolution radiance target, one reprojection pass, and one
mipmap generation chain. Both independent radiance sources already use RG11B10,
so sharing introduces no additional format conversion or quantization. RTT nodes
update once per frame, so referencing this node
from both effects does not render it twice. The graph owns and disposes it once.

At reduced GI resolution, SSR retains a separate full-resolution radiance source:
its LOD footprint is measured in full-resolution pixels. SSR-only and GI-only
scenes allocate only their needed source. Mirror/near-hit and secondary-bounce SSR
still reads the original history texture. Radiance LOD rules, geometric sampling,
hit refinement, ray budgets, denoising, and temporal accumulation match the
individual experiments.

## Performance status

No performance conclusion is reported: other user tasks were using the GPU, and
performance measurements were stopped. The removed target/pass/mip chain is a
structural saving verified by the graph tests; whether it reduces total frame time
requires a separate run with an idle GPU. Mip-generation and sampling costs can
outweigh the savings on some scenes. Keep this profile experimental.

## Fidelity results

These captures used 128 frames, native scene dimensions (including 481×361), seeded
fresh GPU processes, and the committed path-traced references. Positive delta
means improved PSNR. All 13 scenes pass the suite's 0.1 dB allowance; the largest
PSNR drop is 0.0479 dB on `gi-hierarchy-discontinuity`.

| Scene                        | Baseline PSNR (dB) | Combined PSNR (dB) | Delta (dB) |
| ---------------------------- | -----------------: | -----------------: | ---------: |
| `ssr-diag-mirror`            |            36.5846 |            36.5933 |    +0.0087 |
| `ssr-diag-grazing`           |            34.2103 |            34.2270 |    +0.0167 |
| `ssr-diag-occlusion`         |            36.6322 |            36.6386 |    +0.0064 |
| `ssr-diag-metal-hit`         |            31.9452 |            31.9526 |    +0.0074 |
| `ssr-diag-rough-30`          |            37.1236 |            37.1178 |    -0.0059 |
| `ssr-diag-odd-size`          |            37.9761 |            37.9619 |    -0.0142 |
| `ssr-diag-rough-60`          |            26.0346 |            26.0283 |    -0.0063 |
| `ssgi-basic`                 |            27.4811 |            27.6800 |    +0.1988 |
| `ssgi-rounded`               |            29.3477 |            29.5447 |    +0.1970 |
| `gi-emitter-corner-dense`    |            26.1078 |            26.0911 |    -0.0167 |
| `gi-room-open-high-albedo`   |            31.7259 |            31.6896 |    -0.0363 |
| `gi-hierarchy-discontinuity` |            35.1462 |            35.0983 |    -0.0479 |
| `ssgi-metallic`              |            27.6266 |            27.8281 |    +0.2015 |

[Native results](history/hierarchical/combined-native-quality.json) include reference
hashes and baseline-repeat comparisons. Most repeated baseline images were
identical; `ssr-diag-metal-hit` and `ssgi-metallic` showed residual variation.
`fidelity-kit process` computed all 26 expected comparisons successfully, and the
[standard CLI quality gate](history/hierarchical/combined-fidelity-gate.json) passed
all 13 scenes without skips. Visual inspection of baseline/combined/delta images
for the discontinuity, rough-60, and metallic scenes found no obvious new artifacts.

On scenes running both effects, the combined profile also passes against each
individual profile. It improves PSNR by 0.0300 dB over the best individual profile
on `ssgi-basic`, and by 0.0953 dB on `ssgi-metallic`.
[Individual comparisons](history/hierarchical/combined-individual-quality.json)
contain all per-profile metrics.

These are decoded sRGB RGB8 metrics from AVIF quality 90 with 4:4:4 chroma, not
HDR precision measurements. Mip filtering changes radiance; the measured small
PSNR decreases mean this is not a strictly lossless transformation. Passing this
finite diagnostic suite does not prove zero quality loss on every scene or camera.
Use `--threshold 0` when a strictly nondecreasing PSNR gate is required; this run
fails that stricter gate on six scenes; the
[zero-drop gate results](history/hierarchical/combined-zero-drop-gate.json) preserve
that explicit check.

## Resolution and motion checks

[Additional comparisons](history/hierarchical/combined-extra-quality.json) use
1280×720 captures after 64 frames and native-size camera-motion captures at
arrival and 4, 16, and 64 settled frames. Baseline-to-combined PSNR is 58.17 dB on
the discontinuity scene and 45.29 dB on the metallic scene at 720p. Across the
motion captures the minimum is 54.34 dB and 45.58 dB respectively. These compare
against the baseline, not dimension-matched path-traced references, and are
additional difference checks rather than another reference-quality gate. Visual
inspection of arrival and settled metallic captures found no obvious new trails
or mirror artifacts.

## Validation and reproduction

Graph tests construct real TSL nodes with the GPU host mocked and verify all three
flags, preservation of the independent profiles, full-resolution sharing, the
half-resolution fallback, original-history SSR fallbacks, and single disposal.

```sh
pnpm build
pnpm tsc
pnpm lint
pnpm test --coverage
pnpm test:browser
node scripts/hierarchical-quality.mjs --experiments hierarchy-combined --scenes gi-hierarchy-discontinuity,ssgi-metallic --width 1280 --height 720 --frames 64 --out .output/combined-extra
node scripts/hierarchical-experiments.mjs --experiments hierarchy-combined --skip-timing --out .output/combined-native
node scripts/hierarchical-experiments.mjs --skip-timing --scenes ssgi-basic,ssgi-metallic --out .output/combined-individuals
# Run this with an idle GPU for meaningful repeated 1080p throughput:
node scripts/hierarchical-experiments.mjs --skip-quality --scenes ssgi-basic,ssgi-metallic --out .output/combined-timing
```

The experimental runner now uses the current benchmark protocol and report schema,
with seeded sessions, completed GPU work, alternating profile order, and separate
instrumented profiles. It exits unsuccessfully when any requested reference or
combined-versus-individual quality gate fails. Missing references are errors.

All three browser tests passed, including combined rendering of both effects,
URL selection, camera motion, resizing, nonempty PNG capture, and benchmark export.
The existing long browser workflow initially reached its two-minute overall
capture deadline under the shared workload; it passed unchanged with
`playwright test --grep 'live scene, GPU/CPU' --timeout 300000`.

Build and type checks passed; all 107 unit tests passed with coverage. Lint reports
only existing shader warnings. The dependency audit reports three existing high
advisories in the path tracer's Puppeteer dependency tree (`extract-zip` and
`basic-ftp`); this feature changes no dependencies.
