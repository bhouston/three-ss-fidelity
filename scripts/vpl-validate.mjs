// Run after pnpm build. GPU physics checks use the same Dawn backend as fidelity captures.
import assert from 'node:assert/strict';
import * as headless from '../packages/cli/dist/headless/webgpu.js';
headless.install();
const { Scene, Mesh, PlaneGeometry, MeshStandardMaterial, PointLight, Vector3, DataUtils } =
  await import('../packages/renderers/node_modules/three/build/three.core.js');
const { WebGPURenderer } = await import('../packages/renderers/node_modules/three/build/three.webgpu.js');
const { VirtualPointLightGI } = await import('../packages/renderers/dist/vpl/VirtualPointLightGI.js');
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
const baker = new VirtualPointLightGI(renderer, scene, { density: 16, samples: 4096, samplesPerFrame: 32 });
for (let i = 0; i < 128; i++) baker.step();
assert.equal(baker.phase, 'converged');
assert.equal(baker.step(), false);
const chart = baker.atlas.charts.find((candidate) => candidate.geometry === receiver.geometry);
const x = Math.floor(chart.x + 3 + chart.innerW / 2),
  y = Math.floor(chart.y + 3 + chart.innerH / 2);
const pixels = await renderer.readRenderTargetPixelsAsync(baker.display, x, y, 1, 1);
const rgb = Array.from(pixels.slice(0, 3), DataUtils.fromHalfFloat);
for (const channel of rgb) assert.ok(Math.abs(channel - Math.PI) < 0.15, `Expected irradiance π; got ${rgb}`);
// Replacing the emitters with a closed black enclosure must block every VPL.
const originalGeometry = baker.atlas.entries.find((e) => e.mesh === receiver).originalGeometry;
baker.dispose();
assert.equal(receiver.geometry, originalGeometry);
assert.equal(receiver.material.lightMap, null);
const blockerMaterial = new MeshStandardMaterial({ color: 0 });
for (const [position, normal] of [
  [
    [0.4, 0, 0],
    [-1, 0, 0],
  ],
  [
    [-0.4, 0, 0],
    [1, 0, 0],
  ],
  [
    [0, 0.4, 0],
    [0, -1, 0],
  ],
  [
    [0, -0.4, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, 0.4],
    [0, 0, -1],
  ],
  [
    [0, 0, -0.4],
    [0, 0, 1],
  ],
]) {
  const mesh = new Mesh(new PlaneGeometry(0.8, 0.8), blockerMaterial);
  mesh.position.fromArray(position);
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...normal));
  scene.add(mesh);
}
const blocked = new VirtualPointLightGI(renderer, scene, { density: 16, samples: 256, samplesPerFrame: 16 });
for (let i = 0; i < 16; i++) blocked.step();
const blockedChart = blocked.atlas.charts.find((c) => c.geometry === receiver.geometry);
const blackPixels = await renderer.readRenderTargetPixelsAsync(
  blocked.display,
  Math.floor(blockedChart.x + 3 + blockedChart.innerW / 2),
  Math.floor(blockedChart.y + 3 + blockedChart.innerH / 2),
  1,
  1,
);
const blockedRGB = Array.from(blackPixels.slice(0, 3), DataUtils.fromHalfFloat);
assert.ok(
  blockedRGB.every((v) => v === 0),
  `Opaque enclosure must block VPLs: ${blockedRGB}`,
);
blocked.dispose();
// Analytic concave transport: differential horizontal receiver beside a
// perpendicular 2x2 unit-radiance emitter. This stresses the VPL singularity.
const cornerScene = new Scene();
const emitter = new Mesh(new PlaneGeometry(2, 2), walls);
emitter.rotation.y = Math.PI / 2;
cornerScene.add(emitter);
const cornerReceiver = new Mesh(new PlaneGeometry(0.04, 0.04), new MeshStandardMaterial({ color: 0xffffff }));
cornerReceiver.rotation.x = -Math.PI / 2;
cornerReceiver.position.x = 0.05;
cornerScene.add(cornerReceiver);
const corner = new VirtualPointLightGI(renderer, cornerScene, { density: 32, samples: 4096, samplesPerFrame: 32 });
for (let i = 0; i < 128; i++) corner.step();
const cornerChart = corner.atlas.charts.find((c) => c.geometry === cornerReceiver.geometry);
const cx = Math.floor(cornerChart.x + 3 + (cornerChart.innerW - 1) / 2);
const cy = Math.floor(cornerChart.y + 3 + (cornerChart.innerH - 1) / 2);
const cornerPosition = await renderer.readRenderTargetPixelsAsync(corner.gbuffer, cx, cy, 1, 1);
assert.equal(cornerPosition[3], 1, 'Concave receiver must cover the sampled atlas texel');
const distance = cornerPosition[0];
assert.ok(distance > 0, 'Concave fixture receiver lies in front of emitter');
const zLower = -1 - cornerPosition[2],
  zUpper = 1 - cornerPosition[2];
const rootDistance = Math.sqrt(1 + distance * distance);
const cornerExpected =
  (Math.atan(zUpper / distance) - Math.atan(zLower / distance)) / 2 -
  (distance / (2 * rootDistance)) * (Math.atan(zUpper / rootDistance) - Math.atan(zLower / rootDistance));
const cornerPixels = await renderer.readRenderTargetPixelsAsync(corner.display, cx, cy, 1, 1);
const cornerRGB = Array.from(cornerPixels.slice(0, 3), DataUtils.fromHalfFloat);
assert.ok(
  cornerRGB.every((v) => Math.abs(v - cornerExpected) < 0.12),
  `Concave transport: expected ${cornerExpected}; got ${cornerRGB}`,
);
corner.dispose();
// Static point-light seed must retain physical inverse-square/cosine irradiance
// when duplicate source samples are eliminated.
const pointScene = new Scene();
const pointReceiver = new Mesh(new PlaneGeometry(0.5, 0.5), new MeshStandardMaterial());
pointReceiver.rotation.x = -Math.PI / 2;
const pointLight = new PointLight(0xffffff, 4);
pointLight.position.y = 2;
pointScene.add(pointReceiver, pointLight);
const pointGI = new VirtualPointLightGI(renderer, pointScene, { density: 16, samples: 1, samplesPerFrame: 1 });
pointGI.step();
const pc = pointGI.atlas.charts.find((c) => c.geometry === pointReceiver.geometry);
const px = Math.floor(pc.x + 3 + (pc.innerW - 1) / 2),
  py = Math.floor(pc.y + 3 + (pc.innerH - 1) / 2);
const pp = await renderer.readRenderTargetPixelsAsync(pointGI.gbuffer, px, py, 1, 1);
const pointDistance = Math.sqrt(pp[0] ** 2 + (2 - pp[1]) ** 2 + pp[2] ** 2);
const pointExpected = (4 * (2 - pp[1])) / pointDistance ** 3;
const pointPixels = await renderer.readRenderTargetPixelsAsync(pointGI.direct, px, py, 1, 1);
const pointRGB = Array.from(pointPixels.slice(0, 3), DataUtils.fromHalfFloat);
assert.ok(
  pointRGB.every((v) => Math.abs(v - pointExpected) < 0.002),
  `Static point seed: expected ${pointExpected}; got ${pointRGB}`,
);
pointGI.dispose();
renderer.dispose();
console.log(
  JSON.stringify({
    whiteFurnaceIrradiance: rgb,
    concaveIrradiance: cornerRGB,
    concaveExpected: cornerExpected,
    staticPointIrradiance: pointRGB,
    staticPointExpected: pointExpected,
    blockedIrradiance: blockedRGB,
    expected: Math.PI,
    stopsAtSampleCap: true,
    restoresScene: true,
  }),
);

// Exercise invalidation through the public renderer, including TRAA integration.
const { createRenderer, completeRenderer, createRendererFrameDriver } =
  await import('../packages/renderers/dist/index.js');
const { getScene, disposeSceneInstance } = await import('../packages/scenes/dist/index.js');
const { createNodeSceneContext } = await import('../packages/scenes/dist/node.js');
const setup = await getScene('gi-room-low-albedo').create(createNodeSceneContext());
const live = await createRenderer('three-new-vpl', headless.createCanvas(32, 32), setup, {
  width: 32,
  height: 32,
});
const advance = createRendererFrameDriver(live.renderer);
const frame = async (index) => {
  advance({ index, timeSeconds: index / 60, deltaSeconds: 1 / 60, phase: 'warmup' });
  live.render();
  await completeRenderer(live.renderer);
};
for (let i = 0; i < 128; i++) await frame(i);
assert.equal(live.lightBake.phase, 'converged');
assert.equal(live.lightBake.samples, 2048);
setup.camera.position.x += 0.1;
setup.camera.updateMatrixWorld(true);
await frame(128);
assert.equal(live.lightBake.phase, 'converged', 'Camera movement must preserve surface lighting');
let lamp;
setup.scene.traverse((object) => {
  if (object.isLight) lamp = object;
});
assert.ok(lamp);
lamp.intensity *= 2;
await frame(129);
assert.equal(live.lightBake.phase, 'accumulating', 'Lighting changes must restart the bake');
assert.equal(live.lightBake.samples, 16);
live.dispose();
disposeSceneInstance(setup);
console.log(JSON.stringify({ cameraPreservesBake: true, lightChangeInvalidatesBake: true }));
process.exit(0);
