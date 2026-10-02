import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  SphereGeometry,
} from 'three';
import { prepareAtlas } from './atlas.js';

describe('surface atlas', () => {
  it('packs a precomputed scene atlas as one square and preserves proportions beside procedural geometry', () => {
    const scene = new Scene(),
      group = new Group(),
      material = new MeshStandardMaterial();
    group.userData.lightmapAtlas = { version: 1, size: 64 };
    const left = new PlaneGeometry(10, 2),
      right = new PlaneGeometry(1, 20),
      floor = new PlaneGeometry(2, 2);
    for (const [geometry, offset] of [
      [left, 0],
      [right, 0.5],
    ] as const) {
      const source = geometry.attributes.uv!;
      const uv = new Float32Array(source.count * 2);
      for (let i = 0; i < source.count; i++) {
        uv[i * 2] = offset + source.getX(i) * 0.4;
        uv[i * 2 + 1] = source.getY(i) * 0.8;
      }
      geometry.setAttribute('uv1', new BufferAttribute(uv, 2));
      group.add(new Mesh(geometry, material));
    }
    scene.add(group, new Mesh(floor, material));
    const before = Array.from(left.attributes.uv1!.array),
      atlas = prepareAtlas(scene, 16, 128);
    expect(atlas.charts).toHaveLength(2);
    const tile = atlas.charts.find((chart) => chart.precomputed)!;
    expect(tile.entries).toHaveLength(2);
    expect(tile.innerW).toBe(64);
    expect(tile.innerH).toBe(64);
    for (const entry of tile.entries) {
      const source = entry.originalGeometry.toNonIndexed(),
        uv = entry.geometry.attributes.uv1;
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeCloseTo((tile.x + 3.5 + source.attributes.uv1.getX(i) * 63) / atlas.size);
        expect(uv.getY(i)).toBeCloseTo((tile.y + 3.5 + source.attributes.uv1.getY(i) * 63) / atlas.size);
      }
      source.dispose();
    }
    const procedural = atlas.charts.find((chart) => !chart.precomputed)!;
    expect(
      tile.x + tile.w <= procedural.x ||
        procedural.x + procedural.w <= tile.x ||
        tile.y + tile.h <= procedural.y ||
        procedural.y + procedural.h <= tile.y,
    ).toBe(true);
    expect(Array.from(left.attributes.uv1!.array)).toEqual(before);
    for (const entry of atlas.entries) {
      entry.mesh.geometry = entry.originalGeometry;
      entry.geometry.dispose();
    }
    expect((group.children[0] as Mesh).geometry).toBe(left);
    left.dispose();
    right.dispose();
    floor.dispose();
    material.dispose();
  });

  it('uniformly downsizes a precomputed atlas to fit the budget including its outer gutter', () => {
    const scene = new Scene(),
      geometry = new PlaneGeometry(),
      material = new MeshStandardMaterial();
    geometry.setAttribute('uv1', geometry.attributes.uv!.clone());
    scene.userData.lightmapAtlas = { version: 1, size: 2048 };
    scene.add(new Mesh(geometry, material));
    const atlas = prepareAtlas(scene, 16, 128),
      chart = atlas.charts[0]!;
    expect(chart.precomputed).toBe(true);
    expect(atlas.size).toBeLessThanOrEqual(128);
    expect(chart.innerW).toBe(chart.innerH);
    const uv = atlas.entries[0]!.geometry.attributes.uv1!;
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(3.5 / atlas.size);
      expect(uv.getX(i)).toBeLessThanOrEqual((chart.w - 3.5) / atlas.size);
    }
    atlas.entries.forEach((entry) => entry.geometry.dispose());
    geometry.dispose();
    material.dispose();
  });

  it.each(['unmarked', 'out-of-range', 'nonfinite', 'wrong-count', 'degenerate', 'shared-instance', 'wrong-version'])(
    'falls back to projection for %s UVs without changing the original',
    (kind) => {
      const scene = new Scene(),
        geometry = new PlaneGeometry(),
        material = new MeshStandardMaterial();
      geometry.setAttribute('uv1', geometry.attributes.uv!.clone());
      if (kind !== 'unmarked') scene.userData.lightmapAtlas = { version: kind === 'wrong-version' ? 2 : 1, size: 64 };
      if (kind === 'out-of-range') geometry.attributes.uv1!.setX(0, 1.1);
      if (kind === 'nonfinite') geometry.attributes.uv1!.setY(0, NaN);
      if (kind === 'wrong-count') geometry.setAttribute('uv1', new BufferAttribute(new Float32Array(2), 2));
      if (kind === 'degenerate') geometry.attributes.uv1!.array.fill(0);
      const before = Array.from(geometry.attributes.uv1!.array);
      scene.add(new Mesh(geometry, material));
      if (kind === 'shared-instance') scene.add(new Mesh(geometry, material));
      const atlas = prepareAtlas(scene);
      expect(atlas.charts.every((chart) => !chart.precomputed)).toBe(true);
      expect(atlas.charts).toHaveLength(kind === 'shared-instance' ? 2 : 1);
      expect(Array.from(geometry.attributes.uv1!.array)).toEqual(before);
      atlas.entries.forEach((entry) => entry.geometry.dispose());
      geometry.dispose();
      material.dispose();
    },
  );

  it('allows zero-area source faces without accepting missing UV coverage on real surfaces', () => {
    const scene = new Scene(),
      geometry = new BufferGeometry(),
      material = new MeshStandardMaterial();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 3),
    );
    geometry.setAttribute('uv1', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), 2));
    scene.userData.lightmapAtlas = { version: 1, size: 64, padding: 8 };
    scene.add(new Mesh(geometry, material));
    const atlas = prepareAtlas(scene);
    expect(atlas.charts[0]!.precomputed).toBe(true);
    atlas.entries.forEach((entry) => {
      entry.mesh.geometry = entry.originalGeometry;
      entry.geometry.dispose();
    });
    geometry.attributes.position!.setXYZ(4, 1, 0, 0);
    geometry.attributes.position!.setXYZ(5, 0, 1, 0);
    const fallback = prepareAtlas(scene);
    expect(fallback.charts.every((chart) => !chart.precomputed)).toBe(true);
    fallback.entries.forEach((entry) => entry.geometry.dispose());
    geometry.dispose();
    material.dispose();
  });

  it('retains the pixel grid of a sole padded precomputed atlas', () => {
    const scene = new Scene(),
      geometry = new PlaneGeometry(),
      material = new MeshStandardMaterial();
    geometry.setAttribute('uv1', geometry.attributes.uv!.clone());
    scene.userData.lightmapAtlas = { version: 1, size: 64, padding: 8 };
    scene.add(new Mesh(geometry, material));
    const expected = geometry.toNonIndexed(),
      atlas = prepareAtlas(scene, 16, 64);
    expect(atlas.size).toBe(64);
    expect(Array.from(atlas.entries[0]!.geometry.attributes.uv1!.array)).toEqual(
      Array.from(expected.attributes.uv1!.array),
    );
    expect(atlas.entries[0]!.geometry).not.toBe(geometry);
    atlas.entries.forEach((entry) => entry.geometry.dispose());
    expected.dispose();
    geometry.dispose();
    material.dispose();
  });

  it('rejects downscaling that would erase known internal padding without replacing geometry', () => {
    const scene = new Scene(),
      geometry = new PlaneGeometry(),
      material = new MeshStandardMaterial();
    geometry.setAttribute('uv1', geometry.attributes.uv!.clone());
    scene.userData.lightmapAtlas = { version: 1, size: 2048, padding: 8 };
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    expect(() => prepareAtlas(scene, 16, 512)).toThrow('cannot preserve precomputed UV padding');
    expect(mesh.geometry).toBe(geometry);
    geometry.dispose();
    material.dispose();
  });

  it('reserves padding when combining a marked atlas with procedural geometry', () => {
    const scene = new Scene(),
      group = new Group(),
      geometry = new PlaneGeometry(),
      floor = new PlaneGeometry(),
      material = new MeshStandardMaterial();
    geometry.setAttribute('uv1', geometry.attributes.uv!.clone());
    group.userData.lightmapAtlas = { version: 1, size: 2048, padding: 8 };
    group.add(new Mesh(geometry, material));
    scene.add(group, new Mesh(floor, material));
    const atlas = prepareAtlas(scene, 16, 2048),
      tile = atlas.charts.find((chart) => chart.precomputed)!;
    expect(atlas.size).toBeLessThanOrEqual(2048);
    expect((tile.padding * (tile.innerW - 1)) / tile.resolution).toBeGreaterThanOrEqual(3);
    expect(tile.innerW).toBeLessThan(2048);
    atlas.entries.forEach((entry) => entry.geometry.dispose());
    geometry.dispose();
    floor.dispose();
    material.dispose();
  });

  it('falls back for every member of an incomplete shared atlas', () => {
    const scene = new Scene(),
      group = new Group(),
      material = new MeshStandardMaterial();
    group.userData.lightmapAtlas = { version: 1, size: 64 };
    const valid = new PlaneGeometry(),
      missing = new PlaneGeometry();
    valid.setAttribute('uv1', valid.attributes.uv!.clone());
    group.add(new Mesh(valid, material), new Mesh(missing, material));
    scene.add(group);
    const atlas = prepareAtlas(scene);
    expect(atlas.charts).toHaveLength(2);
    expect(atlas.charts.every((chart) => !chart.precomputed)).toBe(true);
    atlas.entries.forEach((entry) => entry.geometry.dispose());
    valid.dispose();
    missing.dispose();
    material.dispose();
  });

  it('leaves precomputed geometry untouched when packing fails', () => {
    const scene = new Scene(),
      geometry = new PlaneGeometry(),
      material = new MeshStandardMaterial();
    geometry.setAttribute('uv1', geometry.attributes.uv!.clone());
    scene.userData.lightmapAtlas = { version: 1, size: 64 };
    const mesh = new Mesh(geometry, material),
      before = Array.from(geometry.attributes.uv1!.array);
    scene.add(mesh);
    expect(() => prepareAtlas(scene, 16, 1)).toThrow('atlas exceeds chart budget');
    expect(mesh.geometry).toBe(geometry);
    expect(Array.from(geometry.attributes.uv1!.array)).toEqual(before);
    geometry.dispose();
    material.dispose();
  });

  it('gives shared geometry instances distinct UV space without changing the source geometry', () => {
    const scene = new Scene(),
      source = new BoxGeometry(2, 3, 4),
      material = new MeshStandardMaterial();
    const a = new Mesh(source, material),
      b = new Mesh(source, material);
    b.position.x = 4;
    scene.add(a, b);
    const atlas = prepareAtlas(scene);
    expect(atlas.charts).toHaveLength(12);
    expect(a.geometry).not.toBe(b.geometry);
    expect(source.attributes.uv1).toBeUndefined();
    for (const entry of atlas.entries) {
      const values = entry.geometry.attributes.uv1.array;
      expect(Array.from(values as Float32Array).every((v) => Number.isFinite(v) && v > 0 && v < 1)).toBe(true);
    }
    for (let i = 0; i < atlas.charts.length; i++)
      for (let j = i + 1; j < atlas.charts.length; j++) {
        const first = atlas.charts[i]!,
          second = atlas.charts[j]!;
        expect(
          first.x + first.w <= second.x ||
            second.x + second.w <= first.x ||
            first.y + first.h <= second.y ||
            second.y + second.h <= first.y,
        ).toBe(true);
      }
    atlas.entries.forEach((e) => e.geometry.dispose());
    source.dispose();
    material.dispose();
  });
  it('keeps densely tessellated surfaces within a finite atlas budget', () => {
    const scene = new Scene(),
      geometry = new SphereGeometry(1, 64, 32),
      material = new MeshStandardMaterial();
    scene.add(new Mesh(geometry, material));
    const atlas = prepareAtlas(scene, 16, 512);
    expect(atlas.charts.length).toBeLessThan(32);
    expect(atlas.size).toBeLessThanOrEqual(512);
    atlas.entries.forEach((e) => e.geometry.dispose());
    geometry.dispose();
    material.dispose();
  });
  it('accounts for nonuniform world scale and restores nothing on a failed preparation', () => {
    const scene = new Scene(),
      geometry = new PlaneGeometry(),
      material = new MeshStandardMaterial(),
      mesh = new Mesh(geometry, material);
    mesh.scale.set(10, 2, 1);
    scene.add(mesh);
    const atlas = prepareAtlas(scene, 8);
    const chart = atlas.charts[0]!;
    expect(chart.innerW).toBe(80);
    expect(chart.innerH).toBe(16);
    mesh.geometry = geometry;
    atlas.entries.forEach((e) => e.geometry.dispose());
    expect(() => prepareAtlas(scene, 8, 1)).toThrow('atlas exceeds chart budget');
    expect(mesh.geometry).toBe(geometry);
    geometry.dispose();
    material.dispose();
  });
});
