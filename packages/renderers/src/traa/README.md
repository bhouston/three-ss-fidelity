# TRAA shader loops

TRAANode.js and TAAUtils.js are vendored from the MIT-licensed [three.js fork](https://github.com/bhouston/three.js/tree/83c310af72715ae558beea12d169f00c62ea48eb/examples/jsm/tsl), commit `83c310af72715ae558beea12d169f00c62ea48eb`.

The local changes replace the JavaScript loops that generate the 3×3 depth neighborhood and eight variance-clipping neighbors with TSL `Loop` nodes. The depth traversal and variance accumulation order are preserved. Shader-local variables store the center texel before either neighborhood loop, each variance neighbor before it contributes to both moments, the reprojected view-space depth before perspective conversion, and the motion factor reused across branches. The remaining TRAA behavior follows the fork, including progressive accumulation.

`clipAABB`, `flickerReduction`, and `subpixelCorrection` already use TSL function layouts, so each has a reusable shader function. The other depth and variance helpers have one call site each in the resolve shader; function layouts would not eliminate duplicated bodies there.
