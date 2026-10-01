This viewer compares [three.js](https://threejs.org/) screen-space effects against path-traced reference renders. The suite tests screen-space global illumination (SSGI), reflections (SSR), ambient occlusion (AO), and temporal reprojection anti-aliasing (TRAA), so you can inspect visual differences and track improvements across scenes.

**Available renderers:**

- `three-gpu-pathtracer` — Reference path tracer — [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer), providing a path-traced reference for the comparisons.
- `blender` — Reference path tracer — [Blender Cycles](https://www.blender.org/), providing an additional reference renderer.
- `three-current` — Rasterizer — Stock [three.js](https://threejs.org/) with its screen-space effects, used as the baseline.
- `three-new` — Rasterizer — The [experimental three.js pipeline](https://github.com/bhouston/three-ss-fidelity/blob/main/docs/THREE-NEW.md), with improvements to SSGI, SSR, and temporal filtering.
- `three-new-ssgi-half` / `three-new-ssgi-third` — Experimental reduced-resolution SSGI and temporal filtering, reconstructed using depth and normals. SSR and scene rendering retain their original resolution.
- `three-gpu-pathtracer-webgpu` — Path tracer — The experimental [WebGPU path tracer](https://github.com/bhouston/three-gpu-pathtracer), for comparison with the reference renderers.

Use the viewer controls to choose a reference renderer and an output: **Beauty**, **Direct**, or **Ambient occlusion**. Select a scene for a closer look. Delta images and error metrics help identify differences; some renderer/output combinations may not have results yet.

Screen-space techniques only have access to the information visible to the camera, while path tracers can account for off-screen geometry and additional light bounces. Some visual differences are expected, especially for reflections, indirect illumination, and disoccluded regions.