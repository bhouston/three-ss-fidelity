import * as pathtracer from 'three-gpu-pathtracer';
import { expect, it } from 'vitest';
import { traceDirectOnly } from './pathtracer.js';

// exported by three-gpu-pathtracer but missing from its type declarations
declare module 'three-gpu-pathtracer' {
  export class PhysicalPathTracingMaterial {
    fragmentShader: string;
    needsUpdate: boolean;
  }
}

it('patches the path tracing shader to stop at the second surface hit', () => {
  const material = new pathtracer.PhysicalPathTracingMaterial();
  traceDirectOnly(material);
  expect(material.fragmentShader).toContain('SURFACE_HIT && ! state.firstRay');
  expect(() => traceDirectOnly({ fragmentShader: 'void main() {}', needsUpdate: false })).toThrow('shader changed');
});
