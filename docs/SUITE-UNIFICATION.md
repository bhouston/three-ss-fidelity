# Three.js fidelity suite unification

Tracking: [three-fidelity #234](https://github.com/bhouston/three-fidelity/issues/234).

The unified suite retains the screen-space, live and performance harness and imports the sibling path-tracer coverage. Existing filenames and URLs remain valid. Experimental renderers stay disabled by default.

- [x] Grouped, searchable and scrollable renderer selection, comparison presets, and scene families.
- [x] WebGPU path-tracer adapter, completed samples, optional noise stopping, explicit Blender reference settings, and isolated capture queues.
- [ ] Khronos and demo-model scene families with LDraw/Collada loaders and asset provenance.
- [ ] Historical result import with explicit scene/renderer identity mappings and regenerated metrics.
- [ ] Consolidated CI/deployment and sibling retirement after parity validation.

Renderer categories are References, Screen-space, Baked lighting and probes, and Experiments. Comparison presets change compared renderers and reference together, preserving the choice in the URL. Scene categories are independent of tags and benchmark collections; scenes can share tags without belonging to the same family.

The sibling pins the same path-tracer revision but uses stock Three.js instead of this suite's fork. Integration must retain a single Three.js installation and verify the new adapter against that fork. A wavefront update is not a completed sample; capture completion must use per-pixel completed sample counts. Noise stopping is a capture policy, separate from throughput benchmarks.

Matching scene names are insufficient evidence of matching workloads. In particular, sibling demo interiors are normalized and staged differently from this suite's original-scale interiors. Imported artifacts receive distinct scene IDs unless their camera, lighting, dimensions, assets and material transformations are verified equivalent. Legacy renderer IDs are mapped explicitly; historical images retain provenance and are never silently overwritten.

## Progressive capture

The new renderer ID is `three-gpu-pathtracer-webgpu-experimental`. It is disabled by default and has no representative benchmark entries: wavefront updates are not completed full-image samples. Historical `three-gpu-pathtracer-webgpu` images remain excluded rather than being relabeled.

Both browser and native capture use `captureProgressive` from the runtime package. Fixed-sample capture remains the default (`--noise-threshold 0`); opt into display-space noise stopping with `--noise-threshold 0.005 --min-samples 128`. The noise estimator compares checkpoints near half the current sample count and checks the 99th-percentile 16-pixel tile. The sample cap remains `--samples`. A no-progress timeout allows asynchronous shader compilation and detects stalled rendering.

Blender export enables area lights, physical-camera depth of field and independent texture backgrounds, uses seed 1 and disables denoising. `--cycles-noise-threshold` opts into adaptive sampling. `--blender-device auto` permits one CPU capture alongside one GPU capture; explicit cpu/gpu modes select a lane. Scenes requiring GPU procedural-environment export remain on the GPU lane, and explicit CPU export requests fail before using a GPU there. CPU rendering runs at lower process priority in the native host.

Quality gates accept `--reference` and `--policy psnr|rmse`. The default remains per-scene PSNR with a 0.1 dB limit; RMSE uses relative mean regression with a default 0.01 limit. RMSE is derived from normalized RGB PSNR, including identical-image handling.

Hardware smoke validation used NVIDIA GeForce GTX 1050, native D3D12 WebGPU and ANGLE D3D11 WebGL, plus NVIDIA-backed Chrome. Both browser and native tracers captured exactly two completed samples at 32 by 32. Browser noise stopping reached 10 samples of a 32-sample cap with a deliberately loose threshold of 1, demonstrating the policy rather than measuring quality. This does not establish full-suite parity. The imported WebGPU adapter still approximates gradient backgrounds with their center color, so those comparisons need separate visual validation.

Blender 4.5.3 CPU reference capture also passed at 32 by 32 with two samples, using the pinned adapter and strict diagnostics.
