# Breakfast room normal bias comparison

`model-breakfast-room-no-normal-bias` reuses the original breakfast room's geometry,
materials, camera, light, shadow-map resolution, and effects. The only changed
setting is `light.shadow.normalBias`: zero instead of approximately 0.0210694
scene units (`span * 0.001`). The original scene retains its existing bias.

Captured at 640 × 480 with 128 Three.js frames and 1,024 path-traced samples:

```sh
pnpm build
pnpm cli render --scenes model-breakfast-room-no-normal-bias \
  --renderers three-current,three-gpu-pathtracer --samples 1024
```

The two images are committed under
`fidelity-results/model-breakfast-room-no-normal-bias/beauty/`.
An additional local render of `model-breakfast-room` with `three-current`
provided the original-bias comparison.

Zero normal bias exposes substantial self-shadowing acne on the wall, table, and
chairs. On the flat wall, the broad blind-shadow bands visually remain closely
aligned with the path-traced reference in both versions. This experiment does
not establish that removing normal bias fixes the reported displacement, or
that Three.js has a shadow-map pixel-origin bug. It preserves the A/B scene for
further visual inspection without changing the original scene or renderer.
