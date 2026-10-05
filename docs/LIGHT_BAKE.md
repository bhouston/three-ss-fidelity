# Progressive BVH lightmaps

`three-new-light-bake` replaces `three-new`'s SSGI and its denoisers with a finite, view-independent diffuse lightmap bake. It retains the current stochastic GGX SSR with spatial/temporal reconstruction and the fork's progressive TRAA. Reflection filter experiments remain separate; this renderer uses the established default, rather than claiming that one experimental profile is universally best.

Select it in the fidelity viewer, the Live Lab, or the CLI:

```sh
pnpm cli render --renderers three-new-light-bake --frames 192
pnpm live
```

The Live Lab shows bake progress. A default bake runs 64 passes, with 16 cosine-weighted BVH rays per covered texel per pass (1,024 samples). Afterwards `step()` returns immediately: the frame renders the existing direct lighting and specular pipeline with a lightmap lookup for diffuse indirect light. Camera movement does not restart the bake. Progressive TRAA resets while lighting changes, then accumulates normally when the bake finishes. “Baked” means the fixed sample budget completed, not a measured variance or error guarantee.

## Implementation

The bake graph, material sampling, light evaluation, hemisphere sampling, feedback, accumulation and gutter filtering use Three.js TSL. Shader loops use `Loop`, runtime conditions use `If`, and intermediate ray hits and barycentric UVs use `toVar()` inside their sampling scope, following [the TSL guide](TSL_GUIDE.md).

Traversal uses gkjohnson's `three-mesh-bvh` `BVHComputeData`, the WebGPU BVH infrastructure used by `three-gpu-pathtracer`. One small WGSL ABI adapter returns its pointer-based intersection result to TSL; it contains no lighting or sampling algorithm. UV-space rasterization follows zalo's [Three.js ProgressiveLightMapGPU](../submodules/three.js/examples/jsm/misc/ProgressiveLightMapGPU.js), with Three.js's `potpack` rectangle packer. The baker traces actual geometry for shadowing and diffuse transport rather than accumulating jittered shadow maps.

Each visible mesh gets owned geometry and a separate `uv1` allocation, including instances that share a source geometry. Connected triangles with the same signed dominant projection axis form charts. The packer includes three-pixel gutters and reduces density to fit a power-of-two atlas capped at 2,048 pixels. This economical unwrap is not a general production UV unwrapper: folded or intersecting connected surfaces can overlap within a projected chart.

Two UV-space MRT passes record world position/normal and diffuse albedo/emission, keeping each pass within default WebGPU attachment limits. Position is float32; irradiance and feedback are float16. Textures, material color, metalness and emissive intensity are sampled in linear space. Diffuse transport excludes the metallic component. Gutter dilation covers all sampled surface attributes as well as lighting. Secondary MRT attachments explicitly clear alpha to zero; otherwise empty atlas pixels incorrectly become valid samples.

A direct-irradiance seed samples point, spot, directional and rectangular lights with BVH shadows. Each bounce reads hit albedo, direct irradiance, previous indirect irradiance and emission through interpolated atlas UVs. Cosine-weighted sampling cancels the Lambertian PDF; emission contributes π times radiance. The lightmap stores irradiance, and Three.js supplies the receiver's diffuse BRDF. Direct light remains live and is not applied twice. Feedback uses a decreasing average weight with a 4% floor to allow multibounce propagation during the finite bake.

Mesh/light transforms, visibility, geometry changes, material versions/colors, instance-matrix updates and skeleton poses conservatively invalidate the entire bake. A rebuild restores source geometry/materials before preparing a replacement. Skinned and instanced meshes are baked as static snapshots; continuously changing geometry can keep restarting the bake. Disposal restores source visibility, geometry and materials and releases owned targets, materials and BVH storage.

Vite's dependency optimizer excludes the Three.js/BVH/path-tracer packages so the browser builds these graphs with one TSL runtime. Prebundling the BVH library previously introduced a second graph stack and hoisted the hit-UV calculation ahead of traversal. The live pixel assertion catches the resulting missing indirect light.

Generated Dawn WGSL confirms a single 16-sample loop with traversal followed by barycentric UV reconstruction inside that loop: [bounce shader](history/light-bake/bounce.wgsl), [seed shader](history/light-bake/seed.wgsl).

## Current limits

This is an experimental static diffuse baker, not the entire proposed production baking system. Work is bounded by ray count and atlas size, not a measured millisecond budget. It does not yet implement variance-based stopping, tile prioritization, regional invalidation, a persistent cache, directional lightmaps, adaptive chart density or streaming.

Environment diffuse lighting remains in the existing live material pipeline. Rays escaping the BVH currently contribute zero to the bake; HDR environment visibility and environment-mediated diffuse bounces are not baked. This is a material limitation for exterior scenes, especially `higharc_dogwood`. Alpha-tested and transmissive geometry currently casts opaque BVH shadows; normal maps, layered BRDF transport and indirect specular are outside this diffuse estimator. Live SSR still handles the existing specular approximation. Skinned objects are snapshots, not a dynamic-lighting solution.

## Validation

All 42 fidelity scenes rendered with native Dawn WebGPU at their native sizes, 192 frames, and the final 1,024-sample bake. The checked-in candidate AVIFs are available in `fidelity-results/`; comparison metrics are regenerated by `fidelity-kit process`. [The complete quality report](history/light-bake/quality.json) compares existing tracked `three-new` beauty images to the candidate at a maximum permitted PSNR loss of 0.1 dB.

- Blender Cycles: **39/40 comparisons pass**. Two probe-wall scenes have no tracked Blender reference. `higharc_dogwood` drops from 15.417 to 14.442 dB.
- GPU path tracer: **38/42 comparisons pass**. Failures are `gi-room-low-albedo`, `gi-room-open-low-albedo`, `gi-room-open-high-albedo` and `gltf-littlest-tokyo`.
- The room scenes improve against Blender while regressing against the GPU path tracer. Their diffuse-model/reference disagreement warrants investigation; neither reference's failures are hidden or removed from the gate. The full fidelity gate is therefore **not passed**.

| Scene                             | Existing SSGI vs Blender |     Light bake vs Blender |
| --------------------------------- | -----------------------: | ------------------------: |
| Cornell box (`cornell-box-basic`) |                22.452 dB |                 28.364 dB |
| Closed low-albedo room            |                32.137 dB |                 50.336 dB |
| Closed high-albedo room           |                 9.663 dB |                 25.927 dB |
| Hierarchy discontinuity           |                44.498 dB |                 45.243 dB |
| Emissive enclosure crop           |                 5.396 dB | Exact decoded-image match |

`node scripts/light-bake-validate.mjs` verifies the GPU white furnace: an emissive unit-radiance enclosure produces receiver irradiance **3.140625** in all channels, within 0.03 of π. It also verifies the sample cap stops work, disposal restores scene resources, camera movement preserves the bake and a light-intensity change restarts it. Atlas unit tests cover distinct allocations for shared geometry, dense tessellation, nonuniform scale and failure cleanup.

All nine browser tests pass. The Chrome/WebGPU live test checks visible bounce light on a directly unlit box face, bake completion/status, camera orbit without rebaking, renderer switching and absence of browser/GPU errors. [Its screenshot](history/light-bake/live.png) records the result. The in-app browser had no connected browser session; live validation used the repository's Playwright Chrome fallback.

Reproduce:

```sh
pnpm build
node scripts/light-bake-validate.mjs
pnpm --filter @ss-fidelity/playground exec playwright test -g 'progressive light bake'
pnpm cli render --renderers three-new-light-bake --frames 192
pnpm exec fidelity-kit process fidelity-results --quiet
pnpm cli quality-gate three-new three-new-light-bake --out /tmp/light-bake-quality.json
pnpm cli bench --renderers 'three-new,three-new-light-probe-ddgi,three-new-light-bake' --scenes 'cornell-box-basic,gi-room-high-albedo,higharc_dogwood' --width 1280 --height 720 --warmup 192 --measure 120 --duration 0.1 --repeats 3 --batch 20 --out /tmp/light-bake-benchmark.json
```

The quality-gate command intentionally reports the four GPU-reference regressions above. Performance results and their measurement scope are recorded below.

## Baked-frame performance

Three repetitions per scene/renderer on the Apple M3 MacBook Air, 1,280 × 720, 192 warmup frames followed by 120 measured frames in batches of 20. Renderer order alternates and each repetition uses a fresh process. Values are the mean of repetition means for completed-work wall time; they are not GPU timestamp durations or browser display cadence. No other GPU test ran during these final measurements. Bake/setup costs are excluded from steady-state timing.

| Scene                 |      SSGI |      DDGI | Light bake | Speedup vs SSGI | Speedup vs DDGI |
| --------------------- | --------: | --------: | ---------: | --------------: | --------------: |
| `cornell-box-basic`   | 63.519 ms | 16.421 ms |  15.428 ms |           4.12× |           1.06× |
| `higharc_dogwood`     |  3.489 ms |  1.467 ms |   1.115 ms |           3.13× |           1.32× |
| `gi-room-high-albedo` | 10.743 ms |  1.836 ms |   1.803 ms |           5.96× |           1.02× |

The baked renderer is faster in these three measured workloads. The smaller Cornell/room margin over DDGI needs more hardware and scenes before claiming a general performance advantage. The full 192-frame candidate captures (including progressive bake work, excluding renderer setup) took approximately 0.4–3.6 seconds per scene in the native suite. Browser startup and compilation remain additional costs.

Full timings, hardware/runtime provenance and samples: [benchmark.json](history/light-bake/benchmark.json).

Repository checks passed: build, TypeScript, lint (existing warnings), and all 166 unit tests with coverage. The dependency audit reports three existing high-severity advisories in the path-tracer submodule’s Puppeteer dependencies (`extract-zip` and `basic-ftp`); no dependencies or lockfile were changed.
