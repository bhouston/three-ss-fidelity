import { expect, it } from 'vitest';
import { parseLiveUrl, serializeLiveUrl } from './performance-live-url';

const defaults = { scene: 'a', renderer: 'x', run: false };
const parse = (search: string) => parseLiveUrl(search, ['a', 'b'], ['x', 'y'], defaults);

it('round-trips a running view with its camera', () => {
  const state = { scene: 'b', renderer: 'y', run: true, pose: { position: [1, 2.5, -3], target: [0, 0.25, 0] } };
  expect(parse(serializeLiveUrl(state))).toEqual(state);
});
it('omits the camera unless running and rounds it', () => {
  const pose = { position: [1.23456789, 2, 3], target: [0, 0, 0] };
  expect(serializeLiveUrl({ scene: 'a', renderer: 'x', run: false, pose })).toBe('?scene=a&renderer=x');
  expect(serializeLiveUrl({ scene: 'a', renderer: 'x', run: true, pose })).toContain('camera=1.2346%2C2%2C3');
});
it('falls back to defaults for unknown or malformed values', () => {
  expect(parse('?scene=nope&renderer=nope&run=yes&camera=1,2&target=a,b,c')).toEqual({
    ...defaults,
    pose: undefined,
  });
  expect(parse('')).toEqual({ ...defaults, pose: undefined });
});
