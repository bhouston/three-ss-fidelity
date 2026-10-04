# Performance results

Raw performance-kit run sets live here, independently of fidelity capture images.

Use `pnpm performance:run` after starting `pnpm live`. The suite targets the real-time Three renderers, including Three-Base (`three-current`), Three-New and its light bake/probe variants. Blender and the path tracer are excluded.

Each invocation appends a self-describing manifest and timestamp-only run JSON under `runsets/`. Captures are PNGs beside the runs. Statistics are derived by the CLI and report when read. Commit selected real-GPU run sets when recording a performance investigation; generated output is ignored by default.
