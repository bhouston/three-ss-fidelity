// Exports of the three.js fork (submodules/three.js, ssgi-traa-redesign) that @types/three lacks.
import 'three/tsl'; // makes this file a module, so the declarations below augment instead of replace
declare module 'three/tsl' {
  export const builtinRadianceContext: (radianceNode: unknown, node?: unknown) => unknown;
}

declare module 'three/addons/tsl/display/TemporalReprojectNode.js' {
  export const previousFrameGeometry: (depthNode: unknown, normalNode: unknown) => unknown;
}

// WebGPU addon in the pinned fork; the published @types/three does not include it yet.
declare module 'three/addons/lighting/LightProbeGrid.js' {
  import { Light, Vector3 } from 'three';
  import type { WebGPURenderer } from 'three/webgpu';
  import type { Scene } from 'three';
  export class LightProbeGrid extends Light {
    constructor(width: number, height: number, depth: number, nx: number, ny: number, nz: number);
    resolution: Vector3;
    bake(
      renderer: WebGPURenderer,
      scene: Scene,
      options: {
        cubemapSize: number;
        sampleCount: number;
        near: number;
        far: number;
        start: number;
        count: number;
        pass: number;
      },
    ): void;
    dispose(): void;
  }
}
