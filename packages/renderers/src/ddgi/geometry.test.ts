import { BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Scene, Vector3 } from 'three';
import { expect, it, vi } from 'vitest';
import {
  geometrySnapshot,
  momentVisibility,
  octBorderTexel,
  VISIBILITY_BIAS,
  octDecode,
  relocateProbe,
} from './geometry.js';

it('moves a probe out of a nearby solid, but rejects a deeply embedded probe', () => {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  const geometry = geometrySnapshot(scene);
  const spacing = new Vector3(1, 1, 1);
  const near = relocateProbe(new Vector3(0.97, 0, 0), spacing, geometry.trace);
  expect(near.valid).toBe(true);
  expect(near.position.x).toBeGreaterThan(1);
  expect(near.offset.length()).toBeLessThanOrEqual(0.45);
  const deep = relocateProbe(new Vector3(), spacing, geometry.trace);
  expect(deep.valid).toBe(false);
  expect(deep.offset.length()).toBe(0);
  geometry.dispose();
});
it('keeps clearance from front faces and moves floor probes into the lit hemisphere', () => {
  const scene = new Scene();
  const floor = new Mesh(new PlaneGeometry(10, 10), new MeshBasicMaterial());
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const geometry = geometrySnapshot(scene);
  for (const y of [-0.02, 0.02]) {
    const probe = relocateProbe(new Vector3(0, y, 0), new Vector3(1, 1, 1), geometry.trace);
    expect(probe.valid).toBe(true);
    expect(probe.position.y).toBeGreaterThanOrEqual(0.11);
    expect(probe.offset.length()).toBeLessThanOrEqual(0.45);
  }
  geometry.dispose();
});
it('snapshots instance transforms, hidden geometry and geometric back faces correctly', () => {
  const scene = new Scene();
  const instances = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 2);
  instances.position.x = 10;
  instances.setMatrixAt(0, new Matrix4().makeTranslation(2, 0, 0));
  instances.setMatrixAt(1, new Matrix4().makeTranslation(5, 0, 0));
  scene.add(instances);
  const hidden = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  hidden.position.x = 11;
  hidden.visible = false;
  scene.add(hidden);
  const original = Array.from(instances.instanceMatrix.array);
  const geometry = geometrySnapshot(scene);
  const front = geometry.trace(new Vector3(10, 0, 0), new Vector3(1, 0, 0), 10)!;
  expect(front.distance).toBeCloseTo(1.5);
  expect(front.backface).toBe(false);
  expect(geometry.trace(new Vector3(12, 0, 0), new Vector3(1, 0, 0), 10)!.backface).toBe(true);
  expect(Array.from(instances.instanceMatrix.array)).toEqual(original);
  geometry.dispose();
});
it('uses directional variance to suppress receivers behind a blocker', () => {
  expect(momentVisibility(0.1, 0.2, 0.04)).toBe(1);
  expect(momentVisibility(0.2 + VISIBILITY_BIAS, 0.2, 1e-6)).toBe(1); // slack for texel-footprint depth error
  expect(momentVisibility(0.8, 0.2, 0.041)).toBeLessThan(1e-6);
  expect(momentVisibility(0.8, 0.2, 0.2)).toBeGreaterThan(momentVisibility(0.8, 0.2, 0.041));
  expect(momentVisibility(0.8, 0.2, 0.03)).toBeGreaterThanOrEqual(0);
});
it('decodes the sphere and mirrors all octahedral seams including corners', () => {
  expect(octDecode(0, 0).toArray()).toEqual([0, 0, 1]);
  expect(octDecode(1, 1).z).toBeCloseTo(-1);
  for (let y = -1; y <= 16; y++)
    for (let x = -1; x <= 16; x++) {
      const [sx, sy] = octBorderTexel(x, y, 16);
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThan(16);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThan(16);
    }
  expect(octBorderTexel(-1, 3, 16)).toEqual([0, 12]);
  expect(octBorderTexel(3, -1, 16)).toEqual([12, 0]);
  expect(octBorderTexel(-1, -1, 16)).toEqual([15, 15]);
});

it('preserves outward winding when a mesh is mirrored', () => {
  const scene = new Scene();
  const box = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  box.scale.x = -1;
  scene.add(box);
  const original = box.geometry.index!.array.slice();
  const geometry = geometrySnapshot(scene);
  expect(geometry.trace(new Vector3(2, 0, 0), new Vector3(-1, 0, 0), 10)!.backface).toBe(false);
  expect(geometry.trace(new Vector3(), new Vector3(1, 0, 0), 10)!.backface).toBe(true);
  expect(box.geometry.index!.array).toEqual(original);
  geometry.dispose();
});

it.each([false, true])('snapshots mixed indexing without changing borrowed geometry (instanced: %s)', (instanced) => {
  const scene = new Scene();
  const material = new MeshBasicMaterial();
  const indexed = new BoxGeometry();
  const nonIndexed = new BoxGeometry().toNonIndexed();
  const originalPositions = nonIndexed.attributes.position!.array.slice();
  const originalIndex = indexed.index!.array.slice();
  const sourceDispose = vi.spyOn(nonIndexed, 'dispose');
  const box = new Mesh(indexed, material);
  box.position.x = 2;
  const other = instanced ? new InstancedMesh(nonIndexed, material, 2) : new Mesh(nonIndexed, material);
  other.position.x = 5;
  if (other instanceof InstancedMesh) {
    other.setMatrixAt(0, new Matrix4());
    other.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, 0));
  }
  // Exercise both the indexed-first and non-indexed-first merge paths.
  for (const order of [
    [box, other],
    [other, box],
  ]) {
    scene.clear();
    scene.add(...order);
    const snapshot = geometrySnapshot(scene);
    for (const x of instanced ? [2, 5, 8] : [2, 5]) {
      const hit = snapshot.trace(new Vector3(x - 1, 0, 0), new Vector3(1, 0, 0), 1)!;
      expect(hit.distance).toBeCloseTo(0.5);
      expect(hit.backface).toBe(false);
      expect(snapshot.trace(new Vector3(x, 0, 0), new Vector3(1, 0, 0), 1)!.backface).toBe(true);
    }
    snapshot.dispose();
  }
  expect(other.geometry).toBe(nonIndexed);
  expect(nonIndexed.index).toBeNull();
  expect(nonIndexed.attributes.position!.array).toEqual(originalPositions);
  expect(indexed.index!.array).toEqual(originalIndex);
  expect(sourceDispose).not.toHaveBeenCalled();
});
