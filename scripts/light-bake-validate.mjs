// Run after pnpm build. GPU physics checks use the same Dawn backend as fidelity captures.
import assert from 'node:assert/strict';
import * as headless from '../packages/cli/dist/headless/webgpu.js';
headless.install();
const { Scene, Mesh, PlaneGeometry, MeshStandardMaterial, Vector3, DataUtils } =
  await import('../packages/renderers/node_modules/three/build/three.core.js');
const { WebGPURenderer } = await import('../packages/renderers/node_modules/three/build/three.webgpu.js');
const { ProgressiveLightBake } = await import('../packages/renderers/dist/light-bake/ProgressiveLightBake.js');
const scene = new Scene(),
  walls = new MeshStandardMaterial({ color: 0, emissive: 0xffffff, emissiveIntensity: 1 });
for (const [position, normal] of [
  [
    [1, 0, 0],
    [-1, 0, 0],
  ],
  [
    [-1, 0, 0],
    [1, 0, 0],
  ],
  [
    [0, 1, 0],
    [0, -1, 0],
  ],
  [
    [0, -1, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, 1],
    [0, 0, -1],
  ],
  [
    [0, 0, -1],
    [0, 0, 1],
  ],
]) {
  const mesh = new Mesh(new PlaneGeometry(2, 2), walls);
  mesh.position.fromArray(position);
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...normal));
  scene.add(mesh);
}
const receiver = new Mesh(new PlaneGeometry(0.5, 0.5), new MeshStandardMaterial({ color: 0xffffff }));
receiver.rotation.x = -Math.PI / 2;
scene.add(receiver);
const renderer = new WebGPURenderer({ canvas: headless.createCanvas(32, 32) });
await renderer.init();
const baker = new ProgressiveLightBake(renderer, scene, { density: 8, samples: 64, samplesPerFrame: 4 });
for (let i = 0; i < 16; i++) baker.step();
assert.equal(baker.phase, 'converged');
assert.equal(baker.step(), false);
const chart = baker.atlas.charts.find((candidate) => candidate.geometry === receiver.geometry);
const x = Math.floor(chart.x + 3 + chart.innerW / 2),
  y = Math.floor(chart.y + 3 + chart.innerH / 2);
const pixels = await renderer.readRenderTargetPixelsAsync(baker.display, x, y, 1, 1);
const rgb = Array.from(pixels.slice(0, 3), DataUtils.fromHalfFloat);
for (const channel of rgb) assert.ok(Math.abs(channel - Math.PI) < 0.03, `Expected irradiance π; got ${rgb}`);
const originalGeometry = baker.atlas.entries.find((e) => e.mesh === receiver).originalGeometry;
baker.dispose();
assert.equal(receiver.geometry, originalGeometry);
assert.equal(receiver.material.lightMap, null);
renderer.dispose();
console.log(
  JSON.stringify({ whiteFurnaceIrradiance: rgb, expected: Math.PI, stopsAtSampleCap: true, restoresScene: true }),
);

// Exercise invalidation through the public renderer, including TRAA integration.
const { createRenderer, completeRenderer, createRendererFrameDriver } =
  await import('../packages/renderers/dist/index.js');
const { getScene, disposeSceneInstance } = await import('../packages/scenes/dist/index.js');
const { createNodeSceneContext } = await import('../packages/scenes/dist/node.js');
const setup = await getScene('gi-room-low-albedo').create(createNodeSceneContext());
const live = await createRenderer('three-new-light-bake', headless.createCanvas(32, 32), setup, {
  width: 32,
  height: 32,
});
const advance = createRendererFrameDriver(live.renderer);
const frame = async (index) => {
  advance({ index, timeSeconds: index / 60, deltaSeconds: 1 / 60, phase: 'warmup' });
  live.render();
  await completeRenderer(live.renderer);
};
for (let i = 0; i < 64; i++) await frame(i);
assert.equal(live.lightBake.phase, 'converged');
assert.equal(live.lightBake.samples, 1024);
setup.camera.position.x += 0.1;
setup.camera.updateMatrixWorld(true);
await frame(64);
assert.equal(live.lightBake.phase, 'converged', 'Camera movement must preserve surface lighting');
let lamp;
setup.scene.traverse((object) => {
  if (object.isLight) lamp = object;
});
assert.ok(lamp);
lamp.intensity *= 2;
await frame(65);
assert.equal(live.lightBake.phase, 'accumulating', 'Lighting changes must restart the bake');
assert.equal(live.lightBake.samples, 16);
live.dispose();
disposeSceneInstance(setup);
console.log(JSON.stringify({ cameraPreservesBake: true, lightChangeInvalidatesBake: true }));
process.exit(0);
