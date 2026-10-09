# Imported path-tracer scenes and assets

Source: bhouston/three-gpu-pathtracer-fidelity at 2521bd4978e59c173946e3816bdf21915d2d2bb9. The 200 definitions retain original cameras, lighting, dimensions and material transformations. All imported IDs use a distinct pt- prefix, including names shared with the screen-space suite. packages/scenes/src/pathtracer/scene-map.json is the complete source-to-canonical identity map.

Scene families comprise 85 Khronos fidelity scenarios, 56 additional glTF scenarios, 38 staged demo models, 14 LEGO models and seven GI fixtures. A staged interior remains distinct from an original-scale screen-space interior.

Initialize native assets with git-dedup submodule update --init. Asset commits are pinned in .gitmodules gitlinks and packages/scenes/src/asset-paths.ts: Khronos glTF-Sample-Assets f36bfdabd1031c3cf6689a50570b8cdf3678b49c; 3d-demo-data 9149f69c729cae652f2cd4b25f25e726f54efa6a; ldraw-parts-library 1f24cac1821b9a86a5a84cd3a40291aad24679b3. git-dedup shares their object data across worktrees.

Browser model loaders use revision-pinned raw.githubusercontent.com URLs, retaining relative texture/buffer references. This requires network access and avoids embedding the multi-gigabyte libraries in GitHub Pages. Repository-owned environments and glTF/LDraw fixtures are served under suite-assets/. An unavailable asset fails capture explicitly. Native captures read the pinned local libraries.

The asset repositories retain upstream licenses and model-specific attribution (Khronos Models/* metadata and licenses, 3d-demo-data model metadata, LDraw library licensing). Copied environment and fixture files retain their source paths from the sibling at the revision above; redistribution terms come from the original upstream assets rather than the suite's code license. Do not assume all sample assets are MIT. The copied scene code retains the sibling MIT license, recorded in assets/pathtracer-source-LICENSE.

Run pnpm build, then node --expose-gc scripts/validate-imported-scenes.mjs to load all imported definitions. Pass canonical IDs to restrict it. This validates scene construction and asset decoding; hardware rendering checks are separate. Unit tests always validate identity/dimensions, GI fixtures, URL mapping and a self-contained textured Collada fixture. LDraw library validation runs when initialized.
