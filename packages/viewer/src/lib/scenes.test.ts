import { describe, expect, it } from 'vitest';
import {
  filterScenes,
  formatCamera,
  parseCamera,
  parseSort,
  sortScenes,
  type SceneMetrics,
  type SceneSummary,
} from './scenes';

const scene = (name: string, psnr?: number | null, description?: string): SceneSummary => ({
  name,
  description,
  renderers: psnr === undefined ? {} : { 'three-new': { metrics: { psnr } as SceneMetrics } },
});

const names = (scenes: SceneSummary[]) => scenes.map((s) => s.name);

describe('sortScenes', () => {
  const scenes = [scene('c', 30), scene('a', 20), scene('b'), scene('d', null), scene('e', 20)];

  it('sorts by name', () => {
    expect(names(sortScenes(scenes, 'name'))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('sorts worst PSNR first; identical (null) is best; missing metrics last', () => {
    expect(names(sortScenes(scenes, 'psnr'))).toEqual(['a', 'e', 'c', 'd', 'b']);
    expect(names(sortScenes(scenes, 'psnr-desc'))).toEqual(['d', 'c', 'a', 'e', 'b']);
  });
});

describe('filterScenes', () => {
  const scenes = [scene('ssgi-basic', 1, 'Cornell box'), scene('ssr-steampunk-camera'), scene('ssgi-metallic')];

  it('matches every term against name and description', () => {
    expect(names(filterScenes(scenes, 'ssgi'))).toEqual(['ssgi-basic', 'ssgi-metallic']);
    expect(names(filterScenes(scenes, 'ssgi cornell'))).toEqual(['ssgi-basic']);
    expect(names(filterScenes(scenes, '  '))).toHaveLength(3);
  });
});

it('parseSort falls back to name', () => {
  expect(parseSort('psnr')).toBe('psnr');
  expect(parseSort('bogus')).toBe('name');
});

describe('parseCamera', () => {
  it('round-trips a position + target', () => {
    const camera = parseCamera('1,2.5,-3,0,0.25,0');
    expect(camera).toEqual({ position: [1, 2.5, -3], target: [0, 0.25, 0] });
    expect(formatCamera(camera!)).toBe('1,2.5,-3,0,0.25,0');
    expect(formatCamera({ position: [1 / 3, 0, 0], target: [0, 0, 0] })).toBe('0.3333,0,0,0,0,0');
  });

  it('rejects anything but six finite numbers', () => {
    for (const value of [undefined, 3, '', '1,2,3', '1,2,3,4,5,6,7', '1,2,3,4,5,x', '1,2,3,4,5,Infinity']) {
      expect(parseCamera(value)).toBeUndefined();
    }
  });
});
