This viewer compares [three.js](https://threejs.org/) screen-space effects against path-traced reference renders. The suite tests screen-space global illumination (SSGI), reflections (SSR), ambient occlusion (AO), and temporal reprojection anti-aliasing (TRAA), so you can inspect visual differences and track improvements across scenes.

**Available renderers:**

- `three-gpu-pathtracer` — Reference path tracer — [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer), providing a path-traced reference for the comparisons.
- `blender` — Reference path tracer — [Blender Cycles](https://www.blender.org/), providing an additional reference renderer.
- `three-current` — Rasterizer — Stock [three.js](https://threejs.org/) with its screen-space effects, used as the baseline.
- `three-new` — Rasterizer — The [experimental three.js pipeline](https://github.com/bhouston/three-ss-fidelity/blob/main/docs/THREE-NEW.md), with improvements to SSGI, SSR, and temporal filtering.
- `three-new-light-probe` — Rasterizer with an automatically fitted, static SH diffuse probe grid replacing SSGI. See [probe research](https://github.com/bhouston/three-ss-fidelity/blob/main/docs/LIGHT_PROBE_RESEARCH.md) for bake cost, quality and limitations.
- `three-new-ssr-temporal-validated` — Experimental SSR reconstruction with per-tap history validation.
- `three-new-ssr-temporal-gaussian` — The same validation with a wider Gaussian clipping neighborhood.
- `three-gpu-pathtracer-webgpu` — Path tracer — The experimental [WebGPU path tracer](https://github.com/bhouston/three-gpu-pathtracer), for comparison with the reference renderers.

Use the viewer controls to choose a reference renderer and an output: **Beauty**, **Direct**, or **Ambient occlusion**. Select a scene for a closer look. Delta images and error metrics help identify differences; some renderer/output combinations may not have results yet.

Screen-space techniques only have access to the information visible to the camera, while path tracers can account for off-screen geometry and additional light bounces. Some visual differences are expected, especially for reflections, indirect illumination, and disoccluded regions.

The temporal profiles include native-resolution beauty renders for all suite scenes accumulated over 128 frames. Compare them against `three-new` or the path-traced reference. These are settled captures; use the live viewer experiments to inspect noise and trails during movement. See [the temporal research](https://github.com/bhouston/three-ss-fidelity/blob/main/docs/SSR_TEMPORAL_RESEARCH.md) for methodology and limitations.
