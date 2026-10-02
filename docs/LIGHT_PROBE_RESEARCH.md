# Automatic diffuse light probes

The basic `three-new-light-probe` renderer replaces SSGI with a static, automatically fitted L2 spherical-harmonic grid. It preserves the existing SSR and TRAA pipeline. It is a useful baked-lighting baseline, not an optimal GI solver or a complete implementation of dynamic diffuse global illumination (DDGI). Default `three-new` remains unchanged.

## Sources and implementation choice

- [Ramamoorthi and Hanrahan, An Efficient Representation for Irradiance Environment Maps, SIGGRAPH 2001](https://lightfield.stanford.edu/papers/envmap/): nine coefficients represent low-frequency diffuse irradiance efficiently. The paper's approximately 1% average error applies to angular irradiance approximation under its assumptions, not spatial interpolation across walls, bake resolution, or the total image error in these scenes.
- [Three.js WebGPU Sponza light-probe example](https://threejs.org/examples/webgpu_lightprobes_sponza.html) and [LightProbeGrid documentation](https://threejs.org/docs/pages/LightProbeGrid.html): the existing implementation the user recalled. We reuse the repository's pinned fork at `83c310af72715ae558beea12d169f00c62ea48eb`, specifically `examples/jsm/lighting/LightProbeGrid.js` and `examples/jsm/tsl/lighting/LightProbeGridNode.js`. The imported addon registers itself as a light node, so standard lit node materials receive its irradiance automatically.
- [Majercik et al., Dynamic Diffuse Global Illumination with Ray-Traced Irradiance Fields, JCGT 2019](https://research.nvidia.com/publication/2019-05_dynamic-diffuse-global-illumination-ray-traced-irradiance-fields): a uniform irradiance field with directional distance moments and visibility-aware interpolation. This is the basis for the separately requested DDGI extension; the basic grid does not implement its visibility solution.
- [Majercik et al., Scaling Probe-Based Real-Time Dynamic Global Illumination for Production, 2020](https://research.nvidia.com/publication/2020-09_scaling-probe-based-real-time-dynamic-global-illumination-production-technical): probe relocation/classification and practical bias/update controls address some production limitations. Merely increasing the number of SH probes does not substitute for these features.

## What is baked

`fitProbeGrid` unions visible mesh bounds in world space, expands them by 4%, gives degenerate dimensions at least 5% of the longest axis, and increases the axis with the largest spacing until another subdivision would exceed 2,048 probes. About 2,000 probes is a default budget, not a guarantee of enough spatial detail in every scene. A single large terrain mesh can spread this budget too thinly.

Each probe captures six 16×16 linear HDR cube faces and projects radiance using 512 equal-area Fibonacci directions into nine RGB SH coefficients. The GPU-resident addon packs 27 floats into seven RGBA16F subvolumes. Hardware trilinear interpolation needs seven atlas texture samples per shaded surface, independent of the total probe count. One pass captures surface emission and direct-lit surface radiance; two more complete passes use snapshots of the prior field to gather additional diffuse bounces. This is finite-bounce raster feedback, not a converged path-traced solution. Material response, finite cubemap sampling and the unoccluded interpolation introduce bias.

Batches of 32 probes wait for GPU completion and yield to the event loop. Baking is awaited during renderer construction, so settled captures and benchmarks cannot accidentally measure an incomplete field. Bake time includes shader compilation and CPU submission and is logged independently. No probe capture occurs during ordinary displayed frames. Camera changes reuse the bake. Moving geometry, animation, lights, materials and environment changes need a new renderer session; this renderer does not automatically update them.

During capture the presentation background/gradient is temporarily replaced with black; surface shading still receives the original environment and analytic lights. The final materials retain their existing environment term. Thus the grid adds emitted/reflected surface radiance without counting escaped environment radiance twice. This pragmatic choice also retains unoccluded environment lighting: a room does not get physically correct sky occlusion. Captures can include raster specular highlights, so this is not a pure diffuse path integrator. We do not apply the example scenes' artistic SSGI `giIntensity` to physical SH irradiance.

SSGI AO is removed with SSGI. Material AO maps still apply; there is no replacement contact-AO pass. Direct-only scene variants remove `effects.ssgi`, so they skip both the bake and probe lighting. Grid resources and the snapshot atlas are disposed with the renderer, and borrowed scene background/environment state is restored on success or failure. The upstream addon retains small pooled cube/projection targets at module scope; its public `dispose()` does not release that shared pool.

## Assessment

This is a good pragmatic static diffuse-lighting baseline within current Three.js: camera-independent surface information, GPU-only radiance baking, compact storage and constant shading cost. It is not optimal for enclosed architecture with thin walls or moving objects. The existing addon offsets sample position by half a cell along the surface normal and blindly interpolates all neighboring probes; it stores neither directional visibility nor relocation offsets. Probes inside solids and interpolation through barriers can leak light. Boundary padding prevents atlas-layer bleeding but does not prevent geometric leakage. Dense placement can reduce interpolation error, but cannot guarantee visibility.

The next renderer should explicitly fetch the eight neighboring probes, reject invalid probes, use their relocated positions, and apply directional first/second distance-moment visibility weights before normalizing the SH contribution. A BVH-assisted static bake is feasible in Three.js without assuming native hardware ray tracing. An optimal dynamic DDGI system would also update radiance and geometry visibility together on the GPU, use irradiance/visibility atlases with robust borders, relocate/classify probes, and budget updates spatially and temporally. That is substantially more machinery than this addon.

## Reproduction

```sh
pnpm build
pnpm cli render --scenes ssgi-basic --renderers three-new-light-probe --frames 128
pnpm cli bench --scenes ssgi-basic --renderers three-new,three-new-light-probe --experiment baseline
node scripts/hierarchical-experiments.mjs --experiments sh-probes --scenes gi-emitter-corner,gi-room-high-albedo,ssgi-basic --out .output/sh-probes --repeats 3 --width 1920 --height 1080 --warmup 30 --measure 60
```

The script's `sh-probes` report key selects the public `three-new-light-probe` renderer. Quality captures use native scene resolution, 128 settled frames and the existing 4,096-sample path-traced AVIF references. Metrics are decoded sRGB image PSNR; they are not linear irradiance error. Timings use separate sequential GPU processes, GPU-synchronized batches, three repeats and median batch wall time. They include CPU submission and preserve SSR/TRAA costs. Timestamp pass sums are recorded separately and are not whole-frame GPU spans.

## Measured results

Apple M3 / macOS arm64, Node 26.3.0. The initial run used the internal `sh-probes` experiment before it was exposed under the requested public renderer name; the lighting algorithm and bake settings are identical. Source was dirty during measurement, recorded in the report. Timing ranges are wide (CPU scheduling and startup history matter), so these speedups are exploratory medians, not stable GPU-only ratios.

| Scene               | SSGI ms/frame | Probes ms/frame | Speedup | SSGI reference PSNR | Probes reference PSNR | Probe bake |
| ------------------- | ------------: | --------------: | ------: | ------------------: | --------------------: | ---------: |
| gi-emitter-corner   |         18.88 |            3.03 |   6.24× |            25.42 dB |              37.17 dB |     11.1 s |
| gi-room-high-albedo |         36.45 |            4.35 |   8.38× |            11.48 dB |              25.66 dB |     13.8 s |
| ssgi-basic          |        268.86 |           40.78 |   6.59× |            27.48 dB |              28.22 dB |     16.8 s |

All three improve display-image PSNR against the reference, while cutting measured total pipeline time substantially. Native captures were visually inspected: the emitter-corner probe floor follows the path-traced illumination more closely than the underlit SSGI floor. This does not imply every surface or scene improves. At native resolution SSR remains a substantial cost in ssgi-basic; these are not isolated GI-pass timings. Initial atlas dimensions are 15×9×15 (2,025 probes) for the emitter/room and 14×11×13 (2,002) for ssgi-basic. One live padded atlas uses `nx * ny * 7 * (nz+2) * 8` bytes: 128,520 and 129,360 bytes respectively, plus an equal-sized bounce snapshot and temporary shared cube/projection storage. Construction performs over 36,000 cube-face draws per scene across three passes, explaining the bake cost.

Research artifacts, native-resolution captures, per-run timings and reference hashes are archived under `history/light-probes/initial/`. The stored report points to omitted delta PNGs, which can be regenerated with the script; AVIF captures and metrics are preserved. The final public renderer has also been exercised on additional scenes; see the extra report below.

## Validation

`pnpm build`, `pnpm tsc`, `pnpm lint` and `pnpm test --coverage` pass (147 tests). Build emits the existing BVH namespace and large-bundle warnings; lint emits existing vendored shader warnings. `pnpm audit --audit-level=high` reports three existing high advisories in the path-tracer submodule's Puppeteer tooling: two extract-zip path/symlink traversal advisories and one basic-ftp CPU denial-of-service advisory. No dependencies or lockfile entries were changed by this implementation.

## Additional final-renderer quality sweep

Native-resolution 128-frame captures under the final `three-new-light-probe` name are archived in `history/light-probes/extra/` and published in the comparison viewer. These are static captures, including the scene named ssgi-animated; they do not validate updates of moving geometry.

| Scene                    | SSGI PSNR | Probes PSNR |    Change |
| ------------------------ | --------: | ----------: | --------: |
| ssgi-rounded             |  29.35 dB |    28.93 dB |  -0.42 dB |
| ssgi-animated            |  28.15 dB |    29.69 dB |  +1.54 dB |
| gi-emitter-corner-thick  |  25.55 dB |    37.17 dB | +11.63 dB |
| gi-room-open-high-albedo |  31.73 dB |    31.42 dB |  -0.30 dB |
| gi-room-low-albedo       |  43.66 dB |    33.85 dB |  -9.81 dB |
| gltf-coffeemat           |  26.87 dB |    29.06 dB |  +2.19 dB |

Three additional scenes improve and three regress. In particular the closed low-albedo room loses about 9.81 dB, despite its small indirect term. The basic implementation does **not** meet a universal same-or-better-quality target and should not replace the default pipeline. Its faster runtime and the improved emitter/high-albedo controls justify keeping it as a separate experimental renderer while testing visibility and relocation independently. No automatic quality gate is waived or presented as passed: the report explicitly records the failed per-scene 0.1 dB gates. CI checks implementation correctness, not approval of this quality tradeoff.
