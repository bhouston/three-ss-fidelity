// Exports of the three.js fork (submodules/three.js, ssgi-traa-redesign) that @types/three lacks.
import 'three/tsl'; // makes this file a module, so the declarations below augment instead of replace
declare module 'three/tsl' {
  export const builtinRadianceContext: (radianceNode: unknown, node?: unknown) => unknown;
}

declare module 'three/addons/tsl/display/TemporalReprojectNode.js' {
  export const previousFrameGeometry: (depthNode: unknown, normalNode: unknown) => unknown;
}
