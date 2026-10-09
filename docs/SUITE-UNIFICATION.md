# Three.js fidelity suite unification

Tracking: [three-fidelity #234](https://github.com/bhouston/three-fidelity/issues/234).

The unified suite retains the screen-space, live and performance harness and imports the sibling path-tracer coverage. Existing filenames and URLs remain valid. Experimental renderers stay disabled by default.

- [x] Grouped, searchable and scrollable renderer selection, comparison presets, and scene families.
- [ ] WebGPU path-tracer adapter, completed samples, optional noise stopping, explicit Blender reference settings, and isolated capture queues.
- [x] Khronos and demo-model scene families with LDraw/Collada loaders and asset provenance.
- [ ] Historical result import with explicit scene/renderer identity mappings and regenerated metrics.
- [ ] Consolidated CI/deployment and sibling retirement after parity validation.

Renderer categories are References, Screen-space, Baked lighting and probes, and Experiments. Comparison presets change compared renderers and reference together, preserving the choice in the URL. Scene categories are independent of tags and benchmark collections; scenes can share tags without belonging to the same family.

The sibling pins the same path-tracer revision but uses stock Three.js instead of this suite's fork. Integration must retain a single Three.js installation and verify the new adapter against that fork. A wavefront update is not a completed sample; capture completion must use per-pixel completed sample counts. Noise stopping is a capture policy, separate from throughput benchmarks.

Matching scene names are insufficient evidence of matching workloads. In particular, sibling demo interiors are normalized and staged differently from this suite's original-scale interiors. Imported artifacts receive distinct scene IDs unless their camera, lighting, dimensions, assets and material transformations are verified equivalent. Legacy renderer IDs are mapped explicitly; historical images retain provenance and are never silently overwritten.

Scene import and asset initialization details: [IMPORTED-ASSETS.md](IMPORTED-ASSETS.md). All 200 sibling definitions have distinct pt- IDs.
