import { describe, expect, it } from 'vitest';
import { selectNames } from './select.js';

const names = ['cornell-box-basic', 'cornell-box-rounded', 'steampunk-camera', 'diag-mirror'];

describe('selectNames', () => {
  it('matches globs and comma lists in registry order', () => {
    expect(selectNames(names, '*', 'scene')).toEqual(names);
    expect(selectNames(names, 'cornell-box-*', 'scene')).toEqual(names.slice(0, 2));
    expect(selectNames(names, 'steampunk-camera, cornell-box-basic', 'scene')).toEqual(['cornell-box-basic', names[2]]);
  });

  it('throws when a pattern matches nothing', () => {
    expect(() => selectNames(names, 'cornell-box-*,nope', 'scene')).toThrow(/No scene matches "nope"/);
  });
});
