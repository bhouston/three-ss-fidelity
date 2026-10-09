# Historical path-tracer comparisons

The sibling snapshot at 2521bd4978e59c173946e3816bdf21915d2d2bb9 contains 545 AVIF images across 200 scenes: 193 Blender references, 159 WebGL Legacy captures and 193 WebGPU New captures. All are imported byte-for-byte, including missing-capture gaps. Existing screen-space outputs remain unchanged.

migration/pathtracer-history.json records every original path, canonical path, dimensions, byte count and SHA-256 hash. WebGL Legacy maps to three-gpu-pathtracer; WebGPU New maps to three-gpu-pathtracer-webgpu-experimental. Blender retains its ID. Every imported scene uses its distinct pt- identity from the scene map. Retired three-gpu-pathtracer-webgpu images from the original screen-space suite are neither overwritten nor relabeled.

The source revision identifies the saved snapshot. Per-image generation revisions, sample counts and generator settings were not recorded; these images remain historical comparisons. Import integrity and newly regenerated comparison metrics do not establish current-adapter rendering parity.

Run pnpm build, then node scripts/verify-pathtracer-history.mjs. The test suite verifies every imported byte and identity. The unified website regenerates metrics using its current metric implementations. The manifest's source paths and scene/renderer mappings also drive the sibling site's legacy link redirects.
