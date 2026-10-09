import { expect, it } from 'vitest';
import { requireHardwareGPU } from './hardware.js';
it.each(['', 'SwiftShader Device', 'llvmpipe', 'lavapipe', 'Microsoft Basic Render Driver', 'WARP', 'CPU adapter'])(
  'blocks unavailable or software GPU %s',
  (value) => {
    expect(() => requireHardwareGPU(value)).toThrow('Rendering verification blocked');
  },
);
it.each(['ANGLE (NVIDIA GeForce GTX 1050 Direct3D11)', 'Intel Gen12', 'AMD Radeon', 'Apple M2'])(
  'permits hardware adapter %s',
  (value) => {
    expect(() => requireHardwareGPU(value)).not.toThrow();
  },
);
