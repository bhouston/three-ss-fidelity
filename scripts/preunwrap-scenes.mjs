import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco, unwrap } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import * as watlas from 'watlas';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? resolve(root, '../three-gpu-pathtracer-fidelity/submodules'));
const destination = resolve(root, 'assets/complex-scenes');
const names = [
  'bedroom',
  'breakfast-room',
  'coffee-maker',
  'contemporary-bathroom',
  'country-kitchen',
  'grey-and-white-room',
];
const models = [
  ...names.map((name) => [name, `3d-demo-data/models/bitterli-rendering-resources/${name}.glb`]),
  ['headphone-with-stand', '3d-demo-data/models/devices/headphone-with-stand.glb'],
  ['transmission-test', 'glTF-Sample-Assets/Models/TransmissionTest/glTF-Binary/TransmissionTest.glb'],
];
const size = 2048;
const padding = 8;
let generatedPadding = padding;
if (!process.argv[3]) {
  // xatlas retains native state between generations. Isolate each model to
  // make output independent of which other scenes were unwrapped before it.
  const generated = [];
  for (const [name] of models) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), source, name], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
    generated.push(...JSON.parse(await readFile(resolve(destination, 'manifest.json'), 'utf8')).models);
  }
  await writeFile(
    resolve(destination, 'manifest.json'),
    `${JSON.stringify({ generator: 'scripts/preunwrap-scenes.mjs', size, padding, models: generated }, null, 2)}\n`,
  );
  process.exit(0);
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
await watlas.Initialize();

// unwrap() delegates packing to this dependency. Expose fixed packing options
// without duplicating glTF Transform's attribute/seam remapping implementation.
class LightmapAtlas extends watlas.Atlas {
  addMesh(meshDecl) {
    // xatlas ignores triangle areas <= FLT_EPSILON in input units. Work in
    // larger units so small details survive this absolute cutoff. A power of
    // two avoids introducing rounding into the original float32 positions.
    const vertexPositionData = meshDecl.vertexPositionData.map((value) => value * 1024);
    super.addMesh({ ...meshDecl, vertexPositionData, epsilon: 0 });
  }
  generate() {
    super.generate({}, { resolution: size, padding, bilinear: true });
    if (this.atlasCount !== 1) throw new Error(`Expected one atlas, received ${this.atlasCount}`);
  }
}
const lightmapWatlas = { Initialize: watlas.Initialize, Atlas: LightmapAtlas };

async function preserveLegacyMetadata(inputPath, outputPath) {
  const sourceMetadata = await readFile(inputPath);
  const inputJSON = JSON.parse(sourceMetadata.subarray(20, 20 + sourceMetadata.readUInt32LE(12)).toString());
  if (!inputJSON.extensions?.KHR_xmp) return;
  // glTF Transform supports KHR_xmp_json_ld, while this older Adobe asset uses
  // KHR_xmp. Preserve its packets verbatim; they contain provenance only.
  const output = await readFile(outputPath);
  const oldJSONLength = output.readUInt32LE(12);
  const outputJSON = JSON.parse(output.subarray(20, 20 + oldJSONLength).toString());
  outputJSON.extensions = { ...outputJSON.extensions, KHR_xmp: inputJSON.extensions.KHR_xmp };
  outputJSON.asset.extensions = { ...outputJSON.asset.extensions, KHR_xmp: inputJSON.asset.extensions.KHR_xmp };
  outputJSON.extensionsUsed = [...new Set([...outputJSON.extensionsUsed, 'KHR_xmp'])];
  const encoded = Buffer.from(JSON.stringify(outputJSON));
  const length = Math.ceil(encoded.length / 4) * 4;
  const jsonChunk = Buffer.alloc(length, 0x20);
  encoded.copy(jsonChunk);
  const header = Buffer.from(output.subarray(0, 20));
  const binaryChunks = output.subarray(20 + oldJSONLength);
  header.writeUInt32LE(20 + length + binaryChunks.length, 8);
  header.writeUInt32LE(length, 12);
  await writeFile(outputPath, Buffer.concat([header, jsonChunk, binaryChunks]));
}

function removeDegenerateGeometry(document) {
  let removed = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) throw new Error('Only triangle primitives are supported');
      const positions = primitive.getAttribute('POSITION').getArray();
      const indices = primitive.getIndices()?.getArray() ?? Array.from({ length: positions.length / 3 }, (_, i) => i);
      const kept = [];
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 3;
        const b = indices[i + 1] * 3;
        const c = indices[i + 2] * 3;
        const ab = [
          positions[b] - positions[a],
          positions[b + 1] - positions[a + 1],
          positions[b + 2] - positions[a + 2],
        ];
        const ac = [
          positions[c] - positions[a],
          positions[c + 1] - positions[a + 1],
          positions[c + 2] - positions[a + 2],
        ];
        const area = Math.hypot(
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        );
        if (area === 0) {
          removed++;
          continue;
        }
        kept.push(indices[i], indices[i + 1], indices[i + 2]);
      }
      primitive.setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array(kept)));
    }
  }
  return removed;
}

function validate(document) {
  let triangles = 0;
  let degenerate = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const uv = primitive.getAttribute('TEXCOORD_1');
      const position = primitive.getAttribute('POSITION');
      if (!uv || uv.getCount() !== position.getCount()) throw new Error('Missing or incomplete TEXCOORD_1');
      for (const value of uv.getArray()) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid UV: ${value}`);
      }
      const indices = primitive.getIndices()?.getArray() ?? Array.from({ length: uv.getCount() }, (_, i) => i);
      const uvs = uv.getArray();
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 2;
        const b = indices[i + 1] * 2;
        const c = indices[i + 2] * 2;
        const area = (uvs[b] - uvs[a]) * (uvs[c + 1] - uvs[a + 1]) - (uvs[c] - uvs[a]) * (uvs[b + 1] - uvs[a + 1]);
        if (area === 0) degenerate++;
        triangles++;
      }
    }
  }
  return { triangles, degenerateUvTriangles: degenerate };
}

// Native float32 parameterization can collapse extremely thin triangles. Keep
// their geometry and material attributes; give each a padded island in a strip.
function repairCollapsedUVs(document) {
  const entries = [];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const uv = primitive.getAttribute('TEXCOORD_1').getArray();
      const indices = primitive.getIndices().getArray();
      const faces = [];
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 2,
          b = indices[i + 1] * 2,
          c = indices[i + 2] * 2;
        if ((uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1]) === 0) faces.push(i);
      }
      entries.push({ primitive, faces });
    }
  }
  const count = entries.reduce((total, entry) => total + entry.faces.length, 0);
  if (!count) return 0;
  const cell = 2 * padding + 4;
  const rows = Math.floor(size / cell);
  const columns = Math.ceil(count / rows);
  const strip = (columns * cell + padding) / size;
  if (strip > 0.1) throw new Error(`Too many collapsed triangles for repair: ${count}`);
  generatedPadding = Math.floor(padding * (1 - strip));
  for (const { primitive } of entries) {
    const accessor = primitive.getAttribute('TEXCOORD_1');
    const array = accessor.getArray().slice();
    for (let i = 0; i < array.length; i += 2) array[i] *= 1 - strip;
    primitive.setAttribute('TEXCOORD_1', accessor.clone().setArray(array));
  }
  let next = 0;
  for (const { primitive, faces } of entries) {
    if (!faces.length) continue;
    const vertexCount = primitive.getAttribute('POSITION').getCount();
    const indices = primitive.getIndices().getArray().slice();
    const remap = [],
      coordinates = [];
    for (const face of faces) {
      const x = (size * (1 - strip) + padding + Math.floor(next / rows) * cell + padding) / size;
      const y = ((next % rows) * cell + padding) / size;
      coordinates.push(x, y, x + 3 / size, y, x, y + 3 / size);
      for (let k = 0; k < 3; k++) {
        remap.push(indices[face + k]);
        indices[face + k] = vertexCount + remap.length - 1;
      }
      next++;
    }
    for (const semantic of primitive.listSemantics()) {
      const accessor = primitive.getAttribute(semantic);
      const original = accessor.getArray();
      const width = accessor.getElementSize();
      const expanded = new original.constructor(original.length + remap.length * width);
      expanded.set(original);
      for (let i = 0; i < remap.length; i++)
        expanded.set(original.subarray(remap[i] * width, (remap[i] + 1) * width), original.length + i * width);
      if (semantic === 'TEXCOORD_1') expanded.set(coordinates, original.length);
      primitive.setAttribute(semantic, accessor.clone().setArray(expanded));
    }
    primitive.setIndices(primitive.getIndices().clone().setArray(indices));
  }
  return count;
}

await mkdir(destination, { recursive: true });
const manifest = [];
for (const [name, relativePath] of models) {
  if (process.argv[3] && name !== process.argv[3]) continue;
  console.log(`Unwrapping ${name}...`);
  const inputPath = resolve(source, relativePath);
  const document = await io.read(inputPath);
  // Mesh instances must occupy distinct atlas regions. Clone primitives too:
  // Property.clone() intentionally retains child references.
  const assigned = new Set();
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (assigned.has(mesh)) {
      const clone = mesh.clone();
      for (const primitive of clone.listPrimitives()) {
        clone.removePrimitive(primitive).addPrimitive(primitive.clone());
      }
      node.setMesh(clone);
    }
    assigned.add(mesh);
  }
  const removedDegenerateGeometryTriangles = removeDegenerateGeometry(document);
  await document.transform(unwrap({ watlas: lightmapWatlas, texcoord: 1, overwrite: true, groupBy: 'scene' }));
  const repairedCollapsedUvTriangles = repairCollapsedUVs(document);
  for (const scene of document.getRoot().listScenes()) {
    scene.setExtras({ ...scene.getExtras(), lightmapAtlas: { version: 1, size, padding: generatedPadding } });
  }
  console.log('Before compression:', validate(document));
  // Lossless floating attributes avoid collapsing tiny lightmap charts.
  await document.transform(draco({ quantizeTexcoord: 0, quantizePosition: 0, quantizeNormal: 0 }));
  for (const accessor of document.getRoot().listAccessors()) {
    if (accessor.listParents().every((parent) => parent === document.getRoot())) accessor.dispose();
  }
  const outputPath = resolve(destination, `${name}.glb`);
  await io.write(outputPath, document);
  await preserveLegacyMetadata(inputPath, outputPath);
  const validation = validate(await io.read(outputPath));
  if (validation.degenerateUvTriangles)
    throw new Error(`${name}: ${validation.degenerateUvTriangles} collapsed UV triangles`);
  const entry = {
    name,
    source: relativePath,
    sourceSha256: createHash('sha256')
      .update(await readFile(inputPath))
      .digest('hex'),
    outputSha256: createHash('sha256')
      .update(await readFile(outputPath))
      .digest('hex'),
    removedDegenerateGeometryTriangles,
    repairedCollapsedUvTriangles,
    padding: generatedPadding,
    ...validation,
  };
  manifest.push(entry);
  console.log(
    `${name}: ${validation.triangles} triangles, ${validation.degenerateUvTriangles} degenerate UV triangles`,
  );
}
await writeFile(
  resolve(destination, 'manifest.json'),
  `${JSON.stringify({ generator: 'scripts/preunwrap-scenes.mjs', size, padding, models: manifest }, null, 2)}\n`,
);
