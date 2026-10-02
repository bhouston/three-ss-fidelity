import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, PlaneGeometry, Scene, SphereGeometry } from 'three';
import { prepareAtlas } from './atlas.js';

describe('surface atlas', () => {
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
