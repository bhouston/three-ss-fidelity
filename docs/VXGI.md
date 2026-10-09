# Voxel Cone Tracing

The `vxgi` renderer is named **Voxel Cone Tracing** in the registry and playground. It uses the pinned Three.js fork's upstream [VXGI Sponza pipeline](https://threejs.org/examples/webgpu_vxgi_sponza.html): an opaque depth/normal/velocity pre-pass, voxel cone tracing, AO and diffuse irradiance injected through `builtinGIContext`, and upstream TRAA. Scene lights, shadows, environment, camera, exposure, and tone mapping retain the suite's settings.

The renderer uses upstream defaults: 128 voxels along the longest scene axis, three diffuse cones, a 40-degree cone aperture, and one cached bounce. GI intensity is 1, rather than the Sponza example's artistic boost of 1.5. It adds diffuse GI and AO; specular reflections use the scene's existing material/environment lighting. No SSGI or SSR is added.

Voxelization is cached for static scene geometry. Camera motion does not require rebuilding it. Dynamic geometry requires explicitly invalidating the volume; the fidelity scenes freeze animated assets at their canonical pose. Automatic scene bounds mean large outdoor scenes have coarser world-space voxels than small rooms. Thin walls, detailed geometry, and mirrors can expose light leakage, coarse occlusion, and the limits of diffuse cone tracing.

All 55 registered fidelity scenes have beauty captures at their registry dimensions and frame counts. The default benchmark collection includes VXGI on its existing scenes; the representative collection includes only its existing four scenes. To reproduce:

```powershell
pnpm build
node scripts/build-render-server.mjs
# With the playground development server running:
pnpm render --renderer vxgi
pnpm performance:representative --machine window001 --session 2026-10-07-02-18 --renderer vxgi --seed 17 --recycle 1 --cooldown-ms 2000
pnpm fidelity:build
```

The representative measurements were added on October 8, 2026 (America/Toronto) to the existing comparison session. Each uses 1920 x 1080, DPR 1, hardware WebGPU, one second of warmup, at least ten seconds of GPU-completed throughput measurement, vsync off, and an end-of-run AVIF. Chrome is recycled between every VXGI workload. Initial voxelization and compilation are recorded during initialization rather than included in steady-state FPS. Existing techniques were measured earlier; these are single observations, not simultaneous measurements or equal-quality comparisons.

| Scene             | VXGI FPS |
| ----------------- | -------: |
| Breakfast room -w |   200.33 |
| Cornell basic     |   217.06 |
| Dogwood           |   254.20 |
| Coffee maker      |   169.86 |

Hardware is the existing `window001` machine's NVIDIA RTX 3060 Ti. See [the existing renderer measurements](performance/REPRESENTATIVE-WINDOWS001.md) for the other techniques. The committed metrics and screenshots are under `performance-results/window001/2026-10-07-02-18/vxgi/`.
