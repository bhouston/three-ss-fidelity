// Run after pnpm build: node scripts/bake-diagnostics.mjs <scene> [outDir] [--rays 256] [--samples 1024] [--vpl] [--top 25] [--probe NameA,NameB]
// Writes atlas-mask / lightmap / lightmap-log / ray-count PNGs and prints texel statistics.
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as headless from '../packages/cli/dist/headless/webgpu.js';
headless.install();
const sharp = createRequire(new URL('../packages/cli/package.json', import.meta.url))('sharp');
const { DataUtils } = await import('../packages/renderers/node_modules/three/build/three.core.js');
const { WebGPURenderer } = await import('../packages/renderers/node_modules/three/build/three.webgpu.js');
const { ProgressiveLightBake } = await import('../packages/renderers/dist/light-bake/ProgressiveLightBake.js');
const { VirtualPointLightGI } = await import('../packages/renderers/dist/vpl/VirtualPointLightGI.js');
const { completeRenderer } = await import('../packages/renderers/dist/index.js');
const { getScene, disposeSceneInstance } = await import('../packages/scenes/dist/index.js');
const { createNodeSceneContext } = await import('../packages/scenes/dist/node.js');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rays: { type: 'string', default: '256' },
    samples: { type: 'string', default: '1024' },
    vpl: { type: 'boolean' },
    top: { type: 'string', default: '25' },
    probe: { type: 'string', default: 'WhiteWood_0001,WhiteWood_0002,WhiteWood_0003' },
  },
});
const [sceneName, outDir = `bake-diagnostics/${positionals[0]}`] = positionals;
const rays = Number(values.rays);
await mkdir(outDir, { recursive: true });

const setup = await getScene(sceneName).create(createNodeSceneContext());
const renderer = new WebGPURenderer({ canvas: headless.createCanvas(32, 32) });
await renderer.init();
const Baker = values.vpl ? VirtualPointLightGI : ProgressiveLightBake;
const baker = new Baker(renderer, setup.scene, { samples: Number(values.samples) });
while (baker.step()) await completeRenderer(renderer);
const size = baker.atlas.size;
const read = (target, index) => renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size, index);
const position = await read(baker.gbuffer, 0);
const valid = (i) => position[i * 4 + 3] > 0;
const lightmap = Array.from(await read(baker.display), DataUtils.fromHalfFloat);
// The diagnostic pipeline compiles asynchronously, so early draws can be dropped; redraw until every valid texel's rays sum to `rays`.
let diag, counts;
for (let attempt = 0; attempt < 20; attempt++) {
  diag?.dispose();
  diag = baker.diagnoseRays(rays);
  await completeRenderer(renderer);
  counts = await read(diag);
  if (
    Array.from({ length: size * size }, (_, i) => i).every(
      (i) => !valid(i) || counts[i * 4] + counts[i * 4 + 1] + counts[i * 4 + 2] === rays,
    )
  )
    break;
  if (attempt === 19) throw new Error('Ray counters never completed');
}
const png = (name, rgb) =>
  sharp(
    Uint8Array.from(rgb, (v) => Math.max(0, Math.min(255, Math.round(v)))),
    { raw: { width: size, height: size, channels: 3 } },
  )
    .png()
    .toFile(path.join(outDir, `${name}.png`));
const texels = size * size;

// 1. atlas mask: white = valid texel, gray = chart padding/invalid inside a chart, black = unused atlas.
const mask = new Float32Array(texels * 3);
for (const c of baker.atlas.charts)
  for (let y = c.y; y < c.y + c.h; y++)
    for (let x = c.x; x < c.x + c.w; x++) mask.fill(60, (y * size + x) * 3, (y * size + x) * 3 + 3);
for (let i = 0; i < texels; i++) if (valid(i)) mask.fill(255, i * 3, i * 3 + 3);
await png('atlas-mask', mask);

// 2. lightmap: Reinhard + sRGB gamma, and log10 over [1e-4, 10].
const tone = new Float32Array(texels * 3),
  log = new Float32Array(texels * 3);
for (let i = 0; i < texels * 3; i++) {
  const v = Math.max(0, lightmap[((i - (i % 3)) / 3) * 4 + (i % 3)]);
  tone[i] = 255 * (v / (1 + v)) ** (1 / 2.2);
  log[i] = (255 * (Math.log10(Math.max(v, 1e-4)) + 4)) / 5;
}
await png('lightmap', tone);
await png('lightmap-log', log);

// 3. ray counters: R = escaped, G = front hit, B = back hit, W = inside hit (shown as separate image).
const channel = (k) =>
  Float32Array.from({ length: texels * 3 }, (_, i) => (255 * counts[((i / 3) | 0) * 4 + k]) / rays);
await png('rays-escaped', channel(0));
await png('rays-front', channel(1));
await png('rays-back', channel(2));
await png('rays-inside', channel(3));
const rgb = new Float32Array(texels * 3);
for (let i = 0; i < texels; i++) for (let k = 0; k < 3; k++) rgb[i * 3 + k] = (255 * counts[i * 4 + k]) / rays;
await png('rays-esc-front-back', rgb);

// Summary. "Dark" = valid texel whose lightmap max channel < 1e-3.
let validCount = 0;
const group = { dark: { n: 0, back: 0, inside: 0, escaped: 0 }, lit: { n: 0, back: 0, inside: 0, escaped: 0 } };
for (let i = 0; i < texels; i++) {
  if (!valid(i)) continue;
  validCount++;
  const g = group[Math.max(lightmap[i * 4], lightmap[i * 4 + 1], lightmap[i * 4 + 2]) < 1e-3 ? 'dark' : 'lit'];
  g.n++;
  g.escaped += counts[i * 4] / rays;
  g.back += counts[i * 4 + 2] / rays;
  g.inside += counts[i * 4 + 3] / rays;
}
// Per-mesh view: sample each triangle's centroid texel, group by mesh name, list the darkest meshes.
const meshes = new Map();
for (const { mesh, geometry } of baker.atlas.entries) {
  const uv = geometry.attributes.uv1,
    index = geometry.index;
  const m = meshes.get(mesh.name || mesh.uuid) ?? { n: 0, dark: 0, back: 0, inside: 0, escaped: 0 };
  meshes.set(mesh.name || mesh.uuid, m);
  for (let t = 0; t < (index ? index.count : uv.count) / 3; t++) {
    let u = 0,
      v = 0;
    for (let k = 0; k < 3; k++) {
      const j = index ? index.getX(t * 3 + k) : t * 3 + k;
      u += uv.getX(j) / 3;
      v += uv.getY(j) / 3;
    }
    const i = Math.min(size - 1, Math.floor(v * size)) * size + Math.min(size - 1, Math.floor(u * size));
    if (!valid(i)) continue;
    m.n++;
    m.dark += Math.max(lightmap[i * 4], lightmap[i * 4 + 1], lightmap[i * 4 + 2]) < 1e-3;
    m.escaped += counts[i * 4] / rays;
    m.back += counts[i * 4 + 2] / rays;
    m.inside += counts[i * 4 + 3] / rays;
  }
}
console.log('meshes by dark triangle-centroid count (darkFrac, escaped, back, inside):');
for (const [name, m] of [...meshes]
  .filter(([, m]) => m.n)
  .sort((a, b) => b[1].dark - a[1].dark)
  .slice(0, Number(values.top)))
  console.log(
    name.padEnd(40),
    m.n,
    [m.dark / m.n, m.escaped / m.n, m.back / m.n, m.inside / m.n].map((x) => x.toFixed(3)).join(' '),
  );
const chartTexels = baker.atlas.charts.reduce((sum, c) => sum + c.w * c.h, 0);
const mean = (g, k) => (g.n ? +(g[k] / g.n).toFixed(4) : null);
console.log(
  JSON.stringify(
    {
      scene: sceneName,
      baker: Baker.name,
      atlas: size,
      charts: baker.atlas.charts.length,
      rays,
      epsilon: baker.epsilon,
      validFractionOfAtlas: +(validCount / texels).toFixed(4),
      validFractionOfChartArea: +(validCount / chartTexels).toFixed(4),
      dark: {
        texels: group.dark.n,
        fractionOfValid: +(group.dark.n / validCount).toFixed(4),
        meanBackFace: mean(group.dark, 'back'),
        meanInsideHit: mean(group.dark, 'inside'),
        meanEscaped: mean(group.dark, 'escaped'),
      },
      lit: {
        texels: group.lit.n,
        meanBackFace: mean(group.lit, 'back'),
        meanInsideHit: mean(group.lit, 'inside'),
        meanEscaped: mean(group.lit, 'escaped'),
      },
    },
    null,
    2,
  ),
);

// CPU cross-check for the probe meshes: which mesh do hemisphere rays hit first, front or back, and how far?
// (Brute-force triangles of meshes whose bbox the ray crosses; the GPU objectIndex readback was unreliable.)
// Also compares winding normals with the room interior (heuristic: floor/rug centre, 1 m up).
const { Box3, Vector3, Ray, Triangle } = await import('../packages/renderers/node_modules/three/build/three.core.js');
const entries = baker.atlas.entries;
const label = (e) => e.mesh.name || e.mesh.uuid;
const room = new Box3();
for (const e of entries) if (/^(Floor|Rug)$/.test(label(e))) room.union(new Box3().setFromObject(e.mesh));
const center = room.getCenter(new Vector3()).add(new Vector3(0, 1, 0));
const tris = (e) => {
  const pos = e.geometry.attributes.position,
    index = e.geometry.index,
    out = [];
  for (let t = 0; t < (index ? index.count : pos.count) / 3; t++) {
    const id = (k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    out.push(
      new Triangle(
        ...[0, 1, 2].map((k) => new Vector3().fromBufferAttribute(pos, id(k)).applyMatrix4(e.mesh.matrixWorld)),
      ),
    );
  }
  return out;
};
const worldTris = new Map(entries.map((e) => [e, tris(e)]));
const boxes = new Map(entries.map((e) => [e, new Box3().setFromObject(e.mesh).expandByScalar(1e-4)]));
const facing = (e) =>
  +(
    worldTris.get(e).filter((t) => t.getNormal(new Vector3()).dot(center.clone().sub(t.a)) > 0).length /
    worldTris.get(e).length
  ).toFixed(3);
const normals = new Uint8Array(await read(baker.gbuffer, 1)); // unsigned-byte packed normal (non-VPL baker)
const rng = (k) => (((Math.sin(k * 12.9898) * 43758.5453) % 1) + 1) % 1;
for (const name of values.probe.split(',')) {
  const probe = entries.filter((e) => label(e) === name);
  const hist = new Map();
  let texelsUsed = 0,
    rayCount = 0;
  const nrmSelf = new Vector3(),
    dir = new Vector3(),
    tangent = new Vector3(),
    bitangent = new Vector3(),
    hitPoint = new Vector3();
  for (const e of probe) {
    const uv = e.geometry.attributes.uv1,
      index = e.geometry.index;
    const T = (index ? index.count : uv.count) / 3;
    for (let t = 0; t < T && texelsUsed < 100; t += Math.max(1, Math.floor(T / 100))) {
      let u = 0,
        v = 0;
      for (let k = 0; k < 3; k++) {
        const j = index ? index.getX(t * 3 + k) : t * 3 + k;
        u += uv.getX(j) / 3;
        v += uv.getY(j) / 3;
      }
      const i = Math.min(size - 1, Math.floor(v * size)) * size + Math.min(size - 1, Math.floor(u * size));
      if (!valid(i)) continue;
      texelsUsed++;
      nrmSelf.set(...[0, 1, 2].map((k) => (normals[i * 4 + k] / 255) * 2 - 1)).normalize();
      const origin = new Vector3(position[i * 4], position[i * 4 + 1], position[i * 4 + 2]).addScaledVector(
        nrmSelf,
        baker.epsilon,
      );
      tangent.set(0, 0, 1).cross(nrmSelf);
      if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0).cross(nrmSelf);
      tangent.normalize();
      bitangent.crossVectors(nrmSelf, tangent);
      for (let r = 0; r < 64; r++) {
        const a = rng(i * 64 + r),
          b = rng(i * 64 + r + 0.5),
          radius = Math.sqrt(a),
          phi = b * Math.PI * 2;
        dir
          .copy(tangent)
          .multiplyScalar(radius * Math.cos(phi))
          .addScaledVector(bitangent, radius * Math.sin(phi))
          .addScaledVector(nrmSelf, Math.sqrt(1 - a));
        const ray = new Ray(origin, dir.clone());
        let best = { dist: Infinity };
        for (const [e2, list] of worldTris) {
          if (!ray.intersectsBox(boxes.get(e2))) continue;
          for (const tri of list) {
            if (!ray.intersectTriangle(tri.a, tri.b, tri.c, false, hitPoint)) continue;
            const dist = hitPoint.distanceTo(origin);
            if (dist < best.dist) best = { dist, mesh: label(e2), back: tri.getNormal(new Vector3()).dot(dir) > 0 };
          }
        }
        rayCount++;
        const key = best.mesh ? `${best.mesh} ${best.back ? 'BACK' : 'front'}` : 'escaped';
        const h = hist.get(key) ?? { n: 0, dist: 0 };
        h.n++;
        h.dist += best.dist === Infinity ? 0 : best.dist;
        hist.set(key, h);
      }
    }
  }
  console.log(`\n${name} (CPU, ${texelsUsed} texels x 64 rays): winding-toward-room ${probe.map(facing)}`);
  for (const [key, h] of [...hist].sort((x, y) => y[1].n - x[1].n).slice(0, 8))
    console.log(`  ${key.padEnd(32)} share ${(h.n / rayCount).toFixed(3)} meanDist ${(h.dist / h.n).toFixed(4)}`);
}
baker.dispose();
diag.dispose();
renderer.dispose();
disposeSceneInstance(setup);
process.exit(0);
