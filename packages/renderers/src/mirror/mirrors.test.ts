import { BoxGeometry, Mesh, MeshStandardMaterial, PlaneGeometry, SphereGeometry } from 'three';
import { expect, it } from 'vitest';
import { detectMirrorFaces } from './mirrors.js';

const mirrorMaterial = () => new MeshStandardMaterial({ metalness: 1, roughness: 0 });

it('finds a flat polished metal plane and its world-space normal', () => {
  const floor = new Mesh(new PlaneGeometry(10, 10).rotateX(-Math.PI / 2), mirrorMaterial());
  const faces = detectMirrorFaces(floor);
  expect(faces).toHaveLength(1);
  expect(faces[0]!.normal.y).toBeCloseTo(1);
  expect(faces[0]!.triangles).toHaveLength(2);
});

it('finds both large faces of a thin slab but not its bevels', () => {
  const slab = new Mesh(new BoxGeometry(2, 1, 0.01), mirrorMaterial());
  expect(detectMirrorFaces(slab).map((f) => f.normal.z)).toEqual(expect.arrayContaining([1, -1]));
  expect(detectMirrorFaces(slab)).toHaveLength(2);
});

it('ignores curved, rough and non-metal surfaces', () => {
  expect(detectMirrorFaces(new Mesh(new SphereGeometry(1, 16, 12), mirrorMaterial()))).toHaveLength(0);
  expect(
    detectMirrorFaces(new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ metalness: 1, roughness: 0.4 }))),
  ).toHaveLength(0);
  expect(
    detectMirrorFaces(new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ metalness: 0, roughness: 0 }))),
  ).toHaveLength(0);
});

it('lets a mirror name opt in a texture-driven material', () => {
  const texturedGlass = new MeshStandardMaterial({ metalness: 1, roughness: 1 });
  texturedGlass.roughnessMap = {} as never;
  const mesh = new Mesh(new PlaneGeometry(1, 1), texturedGlass);
  expect(detectMirrorFaces(mesh)).toHaveLength(0);
  mesh.name = 'Mirror';
  expect(detectMirrorFaces(mesh)).toHaveLength(1);
});
