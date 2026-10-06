import { Box3, Vector3 } from 'three';
import { expect, it } from 'vitest';
import { boxProjectDirection } from './box-projected.js';

it('projects reflected rays onto the box walls', () => {
  const box = new Box3(new Vector3(-2, 0, -4), new Vector3(2, 3, 4));
  const center = box.getCenter(new Vector3());
  // from the centre the projection is the ray itself, scaled to the wall
  expect(boxProjectDirection(center, new Vector3(1, 0, 0), box, center).toArray()).toEqual([2, 0, 0]);
  // an off-centre point looking +x hits the +x wall at the same height, so the lookup tilts downward
  const hit = boxProjectDirection(new Vector3(0, 0.5, 0), new Vector3(1, 0, 0), box, center);
  expect(hit.toArray()).toEqual([2, -1, 0]);
});
