# Virtual point light GI

`three-new-vpl` adds a separately selectable, view-independent diffuse GI method. It represents surfaces as virtual emitters and gathers their light with reservoir importance sampling (RIS) and BVH visibility. It keeps the existing direct lighting, environment lighting, stochastic SSR and TRAA. Select **Virtual Point Lights (RIS)** in the fidelity viewer or `three-new-vpl` in the Live Lab and CLI.

```sh
pnpm cli render --renderers three-new-vpl --frames 192
pnpm live
```

## Research and design choice

Keller's [Instant Radiosity (1997)](https://doi.org/10.1145/258734.258769) turns light-path surface interactions into virtual lights, allowing indirect transport to be evaluated as many-light direct illumination. Position, outgoing normal and reflected energy matter: an ordinary omnidirectional `PointLight` misses the emitter cosine and does not give the correct estimator normalization. This is the idea described in [Three.js issue #14047](https://github.com/mrdoob/three.js/issues/14047), and its [progressive-rendering umbrella issue](https://github.com/mrdoob/three.js/issues/14051).

Raster surface captures provide another way to construct the virtual lights. Reflective shadow maps capture lit surfaces from a light's view; the authors' [VPL course slides](https://cg.ivd.kit.edu/publications/2009/vpl.pdf) explain RSMs, indirect visibility and multibounce extensions. This implementation captures the whole surface atlas instead, evaluates its source irradiance with the existing GPU light/BVH seed, and updates reflected radiance between iterations. The source seed uses one visibility evaluation for fixed point/spot/directional lights; it keeps sixteen samples when rectangular lights require position sampling. It therefore uses a surface discretization rather than Keller's photon random walks. The atlas is both a VPL pool and receiver cache; sharing it with the existing baker does not make the transport estimator the same. The original baker samples receiver hemisphere directions and traces bounce intersections. This method samples surface emitters and traces connections to them.

A current direction is reservoir resampling of virtual lights. [ReSTIR (2020)](https://research.nvidia.com/index.php/publication/2020-07_spatiotemporal-reservoir-resampling-real-time-ray-tracing-dynamic-direct) selects weighted candidates and reuses reservoirs spatially and temporally. It is a general sampling technique, independent of the choice of VPL representation. [ReSTIR GI (2021)](https://research.nvidia.com/publication/2021-06_restir-gi-path-resampling-real-time-path-tracing) resamples indirect paths from path tracing. Owen Rooney's implementation notes on [geometry-sampled virtual lights](https://otrooney.github.io/global-illumination/2024/09/20/restir-gsgi.html) and [photon-mapped virtual lights](https://otrooney.github.io/global-illumination/2024/10/01/restir-pmgi.html) demonstrate both combinations. A [TU Delft research project](https://repository.tudelft.nl/record/uuid:ddb7ccdd-289b-48a4-bffa-541840f9cfbf) and [TU Wien's March 2026 many-light GI seminar](https://www.cg.tuwien.ac.at/courses/konversatorium/ReSTIR-Many-Light-Global-Illumination) also study VPLs with ReSTIR. These establish a research direction, not a universally best production solution.

The implementation adopts RIS to reduce visibility-ray work. It does **not** implement ReSTIR's neighbor/history reservoir reuse, reconnection corrections, or a photon mapper. That distinction is reflected in the viewer label. Full ReSTIR is a possible extension once the surface estimator and visibility behavior are measured.

Three.js precedent is strongest in the proposals above. The upstream [ProgressiveLightMapGPU source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/misc/ProgressiveLightMapGPU.js) supplies relevant progressive UV-space raster infrastructure, but is not a VPL GI implementation. A current community [three-realtime-rt renderer](https://github.com/GoldwinXS/three-realtime-rt) documents BVH GI, emissive lights and ReSTIR many-light sampling; it is related integration precedent, not evidence that upstream Three.js ships VPL GI. No code from that renderer was copied. Our BVH traversal comes from the already installed `three-mesh-bvh` WebGPU implementation.

## Estimator

Each valid atlas texel has world position, geometric normal, diffuse albedo, emission and world area `A`. The UV-space raster pass computes area as `length(cross(dFdx(positionWorld), dFdy(positionWorld)))`. Normals and area use a float32 attachment so areas are neither clamped to one nor quantized as color alpha. Together with float32 position, this fits WebGPU's default 32-byte attachment budget.

For receiver `x` and VPL `y`, the unshadowed irradiance contribution is:

```text
L(y) = rho(y) * [E_direct(y) + E_indirect_previous(y)] / pi + L_emission(y)
f(x,y) = L(y) * A(y) * max(dot(nx, d), 0) * max(dot(ny, -d), 0)
         / max(distance_squared, epsilon_squared)
near_weight = max(1 - distance_squared / radius_squared, 0)^2
f_far(x,y) = f(x,y) * (1 - near_weight)
d = normalize(y - x)
```

The renderer splits transport smoothly by distance. The radius is the larger of eight receiver texel widths and 5% of the scene diagonal. `near_weight` is estimated with one cosine-weighted hemisphere BVH ray per reservoir. RIS estimates the complementary far weight. Their sum preserves the original transport contribution, while the far weight cancels the inverse-square singularity as distance approaches zero. [Novak et al.'s bias-compensation research](https://jannovak.info/publications/SSBC/index.html) explains why simply clamping VPLs loses near-field energy. Our complementary split addresses that problem using geometry rays rather than their hierarchical screen-space algorithm. It does not claim to reproduce that paper's implementation.

The initial footprint-clamped prototype produced isolated bright corner samples. The hybrid replaces that clamp, and an analytic perpendicular-emitter check validates the concave transport rather than relying only on an image blur.

Each iteration shares a progressive R2 candidate pool across receivers so source texture reads stay coherent; each receiver computes its own RIS weights and selection. Each reservoir draws eight candidates uniformly over the complete atlas (`pdf = 1 / atlas_size²`). Invalid texels and zero-contribution samples have zero weight but still count toward the eight trials. Weight is `luminance(f_far) / pdf`. Streaming reservoir selection uses a deterministic hash variate separate from the R2 candidate sequence. Shared candidates can produce correlated light blotches at short distances; the default 5% near-field radius sends that transport to the complementary hemisphere estimator. The selected far candidate contributes `f_selected / luminance(f_selected) * weight_sum / 8`, multiplied by visibility. Visibility is evaluated only after selection, once per nonempty reservoir, with an exact BVH segment ray. Offsetting both endpoints along their outward normals avoids self-shadowing and excludes the emitter surface. All geometry participates in indirect occlusion, independently of direct shadow-map flags.

Sixteen reservoirs per covered receiver texel per iteration produce 128 candidates and at most sixteen connection visibility rays, plus sixteen local hemisphere rays. The default runs 128 iterations: 2,048 reservoirs and 16,384 candidate trials per receiver. It averages irradiance with the baker's decreasing weight and 4% adaptation floor, allowing source radiance to propagate multiple bounces. Completion means the finite work budget ended; it is not a variance test. Cached irradiance is applied through Three.js's lightmap BRDF, excluding live direct light so it is not applied twice.

Scene/light changes conservatively rebuild the surface state. Camera motion preserves it. Disposal restores borrowed scene geometry, materials and snapshot visibility. Initialization, direct-light evaluation, resource management, surface capture and gutter dilation use the existing `ProgressiveLightBake` infrastructure. Only its transport graph and normal/area capture differ. Shading and sampling use TSL; the existing small WGSL adapter handles the BVH pointer-result ABI.

## Limits

This is a progressive static diffuse GI renderer. Surface caching makes post-convergence frames cheap, but convergence is substantially more expensive than the cosine-ray baker on some scenes because each candidate performs multiple texture fetches. Sparse or poorly packed atlases waste proposal trials. Strong localized sources and near corners can remain noisy; the 4% feedback floor limits effective averaging. Surface discretization, atlas projection overlaps, opaque alpha/transmission handling and omitted normal-map/glossy transport remain. Environment diffuse lighting stays live, but is not reflected into the VPL source seed. Instanced/skinned geometry uses the shared static snapshot mechanism; animated changes can continually restart accumulation.

Use `--frames 192` for final comparisons: 128 lighting iterations plus 64 stable frames for TRAA. Some scene presets request fewer frames and will intentionally capture partial convergence if this override is omitted. High quality is a target to assess against both references, not a claim that this method beats baking on every scene.

## Validation results

The native Dawn GPU checks in [physics.json](history/vpl/physics.json) verify unit-radiance furnace irradiance (3.06445 versus pi), complete indirect occlusion (zero), and perpendicular-emitter concave transport (1.50488 versus the analytic 1.51725, about 0.8% low). A fixed point-light seed gives 0.999023 versus the analytic 0.999044. They also verify budget completion, camera preservation, light-change invalidation and scene restoration. Run `scripts/vpl-validate.mjs` to reproduce these checks.

At 192 frames, Cornell (`ssgi-basic`) gives 34.6135 dB against Blender versus SSGI's 22.4524 dB and the cosine-ray bake's 28.3534 dB. Against the GPU path tracer, it gives 26.2604 dB versus SSGI's 27.4811 dB and the bake's 30.6960 dB. These are decoded sRGB8 AVIF comparisons; the disagreement between references is a reason to publish both rather than declare one method uniformly better.

The complete 58-scene [comparison report](history/vpl/quality.json) uses a 0.1 dB maximum-drop allowance against SSGI. VPL passes 55/58 comparisons against Blender and 46/58 against the GPU path tracer. This is **not** a uniform fidelity-gate pass; the report lists every regression. Emissive corner/enclosure scenes improve strongly, while environment-lit, animated, and some low-albedo scenes remain weaker. Existing renderers stay available.

Build, types, lint and 242 unit tests pass. Native GPU transport/lifecycle checks and both live browser tests (VPL and the original bake) pass. The browser verifies accumulation, visible bounce illumination, camera movement without a reset, and clean renderer switching; [live capture](history/vpl/live.png). Dependency audit reports two existing high-severity `extract-zip` advisories through Puppeteer; this feature does not change dependencies.

The isolated [native benchmark](history/vpl/benchmark.json) ([HTML report](history/vpl/benchmark.html)) compares cached rendering at 640×480 after 192 warmup frames, with 120 measured frames and three fresh, alternating-order repetitions per scene. Median VPL/bake speedups are 0.998× in Cornell and 1.002× in the high-albedo room: effectively equal after accumulation. This does **not** establish faster convergence. The [single-capture times](history/vpl/capture-times.json) include compilation and accumulation and vary sharply with surface-atlas size; they are not a repeated speed benchmark. Fresh 192-frame captures took 5.3 s for VPL versus 3.3 s for baking in Cornell, and 1.0 s versus 0.6 s in the high-albedo room. The work budgets differ (2,048 VPL reservoirs plus near rays versus 1,024 bake rays per receiver), so these are default-policy costs, not equal-quality convergence times.

## Reproduction

```sh
pnpm build
node scripts/vpl-validate.mjs
pnpm --filter @ss-fidelity/playground exec playwright test -g 'virtual point light GI'
pnpm cli render --renderers three-new-vpl --frames 192
pnpm exec fidelity-kit process fidelity-results --quiet
node scripts/vpl-quality.mjs
# For the generic gate, temporarily enable three-new in fidelity.json before processing.
pnpm cli quality-gate three-new three-new-vpl --out /tmp/vpl-quality-gate.json
pnpm cli bench --renderers three-new-light-bake,three-new-vpl \
  --scenes ssgi-basic,gi-room-high-albedo --width 640 --height 480 \
  --warmup 192 --measure 120 --duration 0.1 --repeats 3 --batch 20 \
  --out /tmp/vpl-benchmark.json
```
