# Complex scene fixtures

These models retain their original materials, cameras, scene hierarchy, and material
texture coordinates. `scripts/preunwrap-scenes.mjs` adds a scene-wide, nonoverlapping
`TEXCOORD_1` lightmap atlas, duplicates shared mesh instances so each has a unique
atlas region, and removes zero-area geometry triangles. Geometry is recompressed
with Draco using lossless floating-point attributes after unwrapping. Existing
textures are retained without recompression. A uniform power-of-two scale applied
only to xatlas input avoids its absolute tiny-triangle cutoff. Any remaining
collapsed UV triangles retain their original geometry and receive separate padded
islands in a reserved atlas strip; the manifest records these repairs.

Each glTF scene includes `extras.lightmapAtlas = { version: 1, size: 2048, padding }`.
Native packing uses eight pixels of padding; scenes requiring a repair strip record
the conservative minimum of seven pixels after rescaling. This metadata identifies
the common atlas resolution and minimum chart padding. An arbitrary
secondary UV channel without this metadata is not necessarily a scene-wide atlas.
The generation manifest records input/output SHA-256 hashes and geometry validation
counts. Charts allocate space according to local dimensions and the maximum world
scale of each node, matching glTF Transform's scene grouping.

Regenerate from the sibling project's populated submodules:

```sh
node scripts/preunwrap-scenes.mjs ../three-gpu-pathtracer-fidelity/submodules
```

The script isolates each model in its own process to avoid shared native atlas
state affecting results, and removes unused geometry accessors before writing.
It uses the reusable [glTF Transform SDK](https://gltf-transform.dev/)
`unwrap()` transform and [watlas](https://github.com/toji/watlas)'s xatlas packing.
The equivalent glTF Transform CLI supports `unwrap --texcoord 1 --group-by scene`;
this script also handles instances, fixes degenerate geometry, controls packing,
and writes the atlas metadata used by the baker.

## Attribution and licenses

These assets are third-party content and are not covered by this repository's MIT
license. Their licenses permit redistribution and modification. CC BY assets require
crediting the author, linking the license, and indicating modifications; retain this
file and the `licenses/` directory when redistributing the fixtures. The modifications
to all models are the UV atlas generation and geometry compression described above.

| File                      | Model                 | Author         | License                                                       | Original source                                                                                                    |
| ------------------------- | --------------------- | -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| bedroom.glb               | Bedroom               | SlykDrako      | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | [Bitterli rendering resources](https://benedikt-bitterli.me/resources/)                                            |
| breakfast-room.glb        | The Breakfast Room    | Wig42          | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)     | [Bitterli rendering resources](https://benedikt-bitterli.me/resources/)                                            |
| coffee-maker.glb          | Coffee Maker          | cekuhnen       | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)     | [Bitterli rendering resources](https://benedikt-bitterli.me/resources/)                                            |
| contemporary-bathroom.glb | Contemporary Bathroom | Mareck         | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | [Bitterli rendering resources](https://benedikt-bitterli.me/resources/)                                            |
| country-kitchen.glb       | Country Kitchen       | Jay-Artist     | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)     | [Bitterli rendering resources](https://benedikt-bitterli.me/resources/)                                            |
| grey-and-white-room.glb   | The Grey & White Room | Wig42          | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)     | [Bitterli rendering resources](https://benedikt-bitterli.me/resources/)                                            |
| headphone-with-stand.glb  | Headphone with stand  | Halil Kantarci | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)     | [Sketchfab](https://sketchfab.com/3d-models/headphone-with-stand-4ffedc9bffad4a549f6e0a46b0f92b05)                 |
| transmission-test.glb     | Transmission Test     | Adobe (2020)   | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/TransmissionTest) |

The first seven source files were copied from the sibling project's
[`3d-demo-data`](https://github.com/gkjohnson/3d-demo-data) submodule, which already
converted their geometry to Draco and their textures to WebP. The upstream attribution
documents are preserved in `licenses/`. The headphone's CC BY 4.0 license was confirmed
through the [original Sketchfab model API](https://api.sketchfab.com/v3/models/4ffedc9bffad4a549f6e0a46b0f92b05).
TransmissionTest came from the sibling project's `glTF-Sample-Assets` submodule;
its upstream license notice is also retained. Its model is CC0, while its accompanying
license documentation is CC BY 4.0. Licenses do not grant rights to logos or trademarks.
