import { BufferAttribute, BufferGeometry, Mesh, Scene } from 'three';
import { expect, it } from 'vitest';
import { widenVertexColors } from './pathtracer.js';

it('widens RGB vertex colors to RGBA with alpha 1', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('color', new BufferAttribute(new Uint8Array([255, 0, 0, 0, 255, 0]), 3, true));
  const scene = new Scene().add(new Mesh(geometry));
  widenVertexColors(scene);
  const color = geometry.getAttribute('color');
  expect(color.itemSize).toBe(4);
  expect(Array.from(color.array)).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
});
