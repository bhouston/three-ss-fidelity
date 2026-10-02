import { BoxGeometry, Mesh, MeshBasicMaterial, Scene } from 'three';
import { expect, it, vi } from 'vitest';
import { fitProbeGrid } from '../probe-grid.js';
import { bakeVisibility, DISTANCE_RESOLUTION, ATLAS_COLUMNS } from './visibility.js';

it('bakes classified offsets and seam-identical half-float moments without mutating geometry', async () => {
  const scene = new Scene();
  const box = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  scene.add(box);
  const original = box.geometry.attributes.position!.array.slice();
  const data = await bakeVisibility(scene, fitProbeGrid(scene, 27));
  expect(data.inactive).toBeGreaterThan(0);
  expect(data.offsets[13 * 4 + 3]).toBe(0); // Deep center of the solid cube.
  expect(data.relocated).toBeGreaterThan(0);
  const image = data.distanceTexture.image;
  const moments = image.data as Uint16Array;
  const tile = DISTANCE_RESOLUTION + 2;
  expect(image.width).toBe(ATLAS_COLUMNS * tile);
  const value = (x: number, y: number, channel: number) => moments[(x + y * image.width) * 2 + channel];
  for (const channel of [0, 1]) {
    expect(value(0, 4, channel)).toBe(value(1, 13, channel));
    expect(value(0, 0, channel)).toBe(value(16, 16, channel));
  }
  expect(box.geometry.attributes.position!.array).toEqual(original);
  const distances = vi.spyOn(data.distanceTexture, 'dispose');
  const offsets = vi.spyOn(data.probeData, 'dispose');
  data.dispose();
  expect(distances).toHaveBeenCalledTimes(1);
  expect(offsets).toHaveBeenCalledTimes(1);
});
