# SH probes with DDGI visibility and relocation

`three-new-light-probe-ddgi` is a separate renderer that extends the [basic SH probe grid](LIGHT_PROBE_RESEARCH.md) with directional distance moments, bounded relocation/classification, and visibility-aware eight-neighbor interpolation. Both renderers remain available. This is a **static DDGI-style bake**, not a dynamically updated RTXGI implementation. Camera motion reuses the field; changed geometry/lighting requires a new renderer session.

## Primary sources

- [Majercik, Guertin, Nowrouzezahrai and McGuire, Dynamic Diffuse Global Illumination with Ray-Traced Irradiance Fields, JCGT 8(2), 2019](https://jcgt.org/published/0008/02/01/): directional first/second distance moments and visibility-weighted probe interpolation address the basic grid's geometric leakage.
- [Majercik et al., Scaling Probe-Based Real-Time Dynamic Global Illumination for Production, 2020](https://research.nvidia.com/publication/2020-09_scaling-probe-based-real-time-dynamic-global-illumination-production-technical): practical bias, relocation/classification and production update controls.
- [NVIDIA RTXGI DDGIVolume documentation](https://github.com/NVIDIAGameWorks/RTXGI-DDGI/blob/main/docs/DDGIVolume.md) and [Shader API](https://github.com/NVIDIAGameWorks/RTXGI-DDGI/blob/main/docs/ShaderAPI.md): reference for the role of relocated positions and volume sampling. NVIDIA shader source was consulted to understand the representation; this code implements the paper's mathematical approach independently and does not copy SDK source.
- [Ramamoorthi and Hanrahan, SIGGRAPH 2001](https://lightfield.stanford.edu/papers/envmap/) and the pinned [Three.js Sponza addon](https://threejs.org/examples/webgpu_lightprobes_sponza.html): the existing nine-coefficient radiance bake remains the source of indirect lighting.
- [three-mesh-bvh StaticGeometryGenerator and MeshBVH](https://github.com/gkjohnson/three-mesh-bvh): the already installed dependency supplies world-space geometry snapshots and CPU ray queries; no native hardware ray-tracing API or new dependency is required.

## Geometry, relocation and moments

The existing fitter supplies at most 2,048 probes. A static geometry snapshot includes visible meshes, current skeletal/morph poses, world transforms and expanded instances. The generator handles mirrored winding. Hidden objects are excluded. Source geometry/materials are not changed. Geometric triangle winding determines front/back faces; both sides are traced. The snapshot ignores alpha-test holes, transmission and transparent-material semantics, treating triangles as opaque barriers. Coherent winding is required for inside classification; non-watertight or reversed meshes can still cause errors.

For relocation, each probe traces 64 deterministic equal-area sphere directions. More than 25% back-face hits marks a probe inside geometry. It tries to move beyond the closest back face, or away from a front face closer than 12% of the minimum cell spacing. At most four moves and a final classification are performed. Total movement is restricted to an ellipsoid with semiaxes 45% of cell spacing. Deeply embedded probes that cannot escape are inactive; they never contribute to interpolation. This is a bounded static heuristic inspired by production DDGI, not the full SDK relocation state machine. Inactive probes are still radiance-captured by the upstream bake addon, so it does not yet save capture work.

At each relocated position, four deterministic sub-texel rays per texel generate directional first and second distance moments in a 16×16 octahedral map. Ray lengths and moments are normalized by twice the cell diagonal. That covers neighboring receivers plus relocation while keeping RG16F precision useful near surfaces. Misses use the maximum distance. This local quadrature differs from original DDGI's angular convolution of stochastic ray samples; it is simple and effective on the measured barriers, but directional aliasing and finite variance can leave residual leaks.

Maps are packed into a 2D RG16F atlas with 32 tiles per row. Each tile has a mirrored one-texel border, including mirrored corners, so bilinear filtering crosses octahedral seams without sampling unrelated probes. Offset XYZ and active status use a nearest-fetched RGBA32F data texture. Geometry preparation runs once on the CPU/BVH and yields every 32 probes; radiance capture and SH projection remain GPU-resident.

## Runtime and recursive lighting

The capture positions use the same offsets as the final shader. Each indirect bounce uses the prior-pass SH snapshot, converted to a directional irradiance atlas, and applies the same visibility/relocation sampler during capture. Otherwise a visibility-aware final pass would still inherit light leaked into the field during the earlier bounces.

After a complete pass, seven packed SH fetches and the L2 irradiance polynomial generate an 8×8 directional irradiance map per probe on the GPU. A mirrored border makes each tile 10×10. This avoids fetching all seven SH subvolumes for each of eight neighbors on every surface. The final sampler needs **24 texture operations per surface**: eight offsets, eight distance moments and eight irradiance samples. The basic grid needs seven hardware trilinear SH reads, so visibility has a real per-frame cost. The directional irradiance atlas adds interpolation error relative to exact SH evaluation, but smooth L2 irradiance supports a compact representation and the measured scenes remain competitive.

The query position has a normal bias of 8% and a view bias of 2% of minimum cell spacing, instead of the basic addon's half-cell normal offset. Trilinear weights refer to the original lattice; distance and normal weights use relocated world positions. A wrapped normal weight softens back-facing rejection. Directional visibility uses a one-sided Chebyshev bound `variance / (variance + delta²)`, cubed to sharpen rejection; variance has a small nonnegative floor for half-float rounding. Active-state, normal, visibility and trilinear weights multiply, then irradiance is normalized by their sum. When all probes are invalid or essentially occluded, the result fades to black. We deliberately do not substitute an unoccluded fallback field, which could reintroduce the leakage this experiment measures.

SH irradiance is already convolved and physically scaled; the implementation adds no extra 2π factor or SSGI artistic intensity. The base renderer's environment treatment, finite three-pass radiance bake, SSR/TRAA, lack of separate contact AO, and static geometry limitations remain. In particular, the scene's environment diffuse term is still unoccluded and can dominate an interior; this change addresses the probe contribution, not every lighting path in Three.js.

## Cost and assessment

For 2,025 probes: a 576×1152 RG16F distance atlas is 2,654,208 bytes; a 320×640 RGBA16F irradiance atlas is 1,638,400 bytes; offsets/status use 32,400 bytes. Together that is about 4.12 MiB, plus roughly 0.25 MiB for the live/snapshot SH atlases and the upstream shared bake targets. CPU BVH and temporary geometry/interior arrays are additional startup memory, released after baking. CPU upload-buffer mirrors remain retained by the distance and offset DataTextures. These are calculated allocation sizes, not measured process/GPU residency peaks.

This is a good pragmatic implementation of the requested visibility/relocation features within Three.js: it retains both research baselines, checks real geometry, applies visibility recursively, handles octahedral seams, and uses compact directional irradiance to keep shading cost bounded. It is not optimal dynamic DDGI. A production solution would trace and update radiance/visibility on the GPU together, avoid capturing inactive probes, use adaptive update budgets and cascades, handle alpha/transmission consistently, and cache/reuse baked fields across sessions. More probes alone cannot guarantee thin-wall quality; moments approximate visibility and may still leak near angular discontinuities. A fully invisible compartment with no valid neighboring probes can become dark rather than receive a guessed fallback.

## Diagnostics and reproduction

`gi-probe-thin-wall` and `gi-probe-thick-wall` seal an emissive chamber away from an unlit chamber using opaque black partitions of thickness 0.06 and 0.6. The camera views the unlit receiver. The reference has no diffuse light path across that divider. A ray-cast mask identifies receiver-floor pixels more than 0.05 world units beyond the partition. The leakage script reports decoded linear luminance and reference error on that mask. These are AVIF/sRGB8-derived values, not raw HDR irradiance, and have an encoding floor.

```sh
pnpm build
pnpm cli render --scenes 'gi-probe-*' --renderers three-gpu-pathtracer --samples 4096
node scripts/hierarchical-experiments.mjs --experiments sh-probes,ddgi-probes --scenes gi-probe-thin-wall,gi-probe-thick-wall,gi-room-low-albedo,gi-room-high-albedo,gi-emitter-corner,ssgi-basic,gltf-coffeemat --skip-timing --out .output/ddgi-quality
node scripts/probe-leakage-metrics.mjs --out .output/ddgi-quality
pnpm cli render --renderers three-new-light-probe-ddgi --scenes ssgi-basic
```

## Measured quality and leakage

Apple M3 / macOS arm64, Node 26.3.0, base `b305673c43e` plus this recorded implementation. Fresh GPU processes, 128 settled frames at each scene's native resolution; the same stored 4,096-sample path-traced references are used for both probe variants. Results, reference hashes and native captures are archived in `history/ddgi/quality/` and published in the comparison viewer. Delta PNGs can be regenerated and are omitted from the archive. This compares decoded sRGB AVIF PSNR, not raw linear irradiance.

| Scene               | SSGI PSNR dB | Basic probes PSNR dB | DDGI probes PSNR dB |
| ------------------- | -----------: | -------------------: | ------------------: |
| gi-probe-thin-wall  |  perfect (∞) |                31.19 |               57.86 |
| gi-probe-thick-wall |  perfect (∞) |                37.82 |               60.70 |
| gi-room-low-albedo  |        43.66 |                33.85 |               33.82 |
| gi-room-high-albedo |        11.48 |                25.66 |               27.23 |
| gi-emitter-corner   |        25.42 |                37.17 |               39.73 |
| ssgi-basic          |        27.48 |                28.22 |               30.96 |
| gltf-coffeemat      |        26.87 |                29.06 |               28.98 |

DDGI improves substantially over basic probes on the partitions, high-albedo room, single emitter and SSGI example. Coffeemat loses about 0.08 dB against the basic grid while remaining better than SSGI. The low-albedo room remains about 9.84 dB below SSGI: geometric visibility does not resolve that transport error, and its cause has not been established by this experiment. The unlit chamber is exactly black with both the path tracer and SSGI; DDGI's small residual is not a perfect solution and the baseline-relative quality gates there correctly fail. The default SSGI renderer therefore remains important.

| Unlit receiver | Mask pixels | Basic mean linear luminance | DDGI mean linear luminance | Mean leakage reduction | DDGI maximum linear luminance |
| -------------- | ----------: | --------------------------: | -------------------------: | ---------------------: | ----------------------------: |
| Thin wall      |      88,926 |                 0.001323484 |                0.000002941 |                99.778% |                      0.005182 |
| Thick wall     |      83,984 |                 0.000431946 |                0.000007952 |                98.159% |                      0.004777 |

The reference and SSGI mask means are zero. Residual maximum brightness is larger than the mean, so the result should not be described as leak-free. Native images were visually inspected: the diagonal strip of false floor lighting in the basic grid nearly disappears with DDGI. The 0.6-unit partition relocates 779 probes and rejects 26; the thin wall relocates 702 and rejects none. The unit tests independently check deeply embedded probe rejection, escape/clearance, mirrored winding, instanced geometry and border identity.

Visibility preparation takes roughly 1.4–5.3 seconds on these scenes, depending on geometry and CPU scheduling; radiance baking remains the larger startup cost. The thin-wall capture logs 4.6 s geometry preparation and 19.9 s radiance baking; the high-albedo room logs 5.3 s and 26.4 s respectively. These are construction timings, including compilation/submission, not the steady-state cost.

## Validation

Build, type, lint and coverage tests pass. GPU captures cover all seven scenes above with both probe renderers. `pnpm audit --audit-level=high` reports the same three existing high Puppeteer-tooling advisories (extract-zip/basic-ftp); no dependency or lockfile changes. Existing shader lint and BVH/bundle build warnings remain.

Steady-state timing results follow after the separate sequential benchmark run.
