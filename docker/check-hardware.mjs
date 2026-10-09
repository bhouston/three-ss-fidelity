import { execFileSync } from 'node:child_process';
const renderer = process.argv[2];
if (!['three-gpu-pathtracer', 'three-gpu-pathtracer-webgpu-experimental'].includes(renderer))
  throw new Error('Select a canonical GPU path tracer');
const source =
  renderer === 'three-gpu-pathtracer'
    ? `import { install, createCanvas } from './dist/headless/webgl.js'; install(); createCanvas(16, 16); console.log('Hardware WebGL available'); process.exit(0);`
    : `import { install } from './dist/headless/webgpu.js'; install(); await navigator.gpu.requestAdapter(); console.log('Hardware WebGPU available'); process.exit(0);`;
execFileSync(process.execPath, ['--input-type=module', '-e', source], {
  cwd: new URL('../packages/cli/', import.meta.url),
  stdio: 'inherit',
});
