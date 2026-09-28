import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveInside } from './file-response.server';
import { RESULT_FILES, listScenes } from './results.server';

describe('listScenes', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ss-fidelity-results-'));
    await mkdir(path.join(dir, 'full', 'beauty'), { recursive: true });
    await writeFile(path.join(dir, 'full', 'beauty', 'three-new.avif'), 'avif');
    await writeFile(
      path.join(dir, 'full', 'beauty', 'metrics-three-new.json'),
      JSON.stringify({ scene: 'full', psnr: 31.5 }),
    );
    await writeFile(path.join(dir, 'full', 'beauty', 'three-current.avif'), 'avif');
    await writeFile(path.join(dir, 'full', 'beauty', 'delta-three-current.avif'), 'avif');
    await writeFile(
      path.join(dir, 'full', 'beauty', 'metrics-three-current.json'),
      JSON.stringify({ scene: 'full', psnr: 24.3 }),
    );
    await mkdir(path.join(dir, 'broken', 'beauty'), { recursive: true });
    await writeFile(path.join(dir, 'broken', 'beauty', 'metrics-three-new.json'), '{not json');
    await mkdir(path.join(dir, 'older', 'beauty'), { recursive: true });
    await writeFile(path.join(dir, 'older', 'beauty', 'three-new.avif'), 'avif');
    await mkdir(path.join(dir, '.hidden'));
    await writeFile(path.join(dir, 'stray.txt'), '');
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('unions result dirs with the registry and tolerates missing / invalid files', async () => {
    const scenes = await listScenes([{ name: 'full', description: 'd' }, { name: 'unrendered' }], 'beauty', dir);
    const byName = Object.fromEntries(scenes.map((scene) => [scene.name, scene]));
    expect(Object.keys(byName).toSorted()).toEqual(['broken', 'full', 'older', 'unrendered']);
    expect(byName.full?.description).toBe('d');
    expect(byName.full?.renderers['three-new']?.metrics?.psnr).toBe(31.5);
    expect(byName.full?.renderers['three-new']?.image).toMatch(
      /^\/api\/results\/full\/beauty\/three-new\.avif\?v=\d+$/,
    );
    expect(byName.full?.reference).toBeUndefined();
    expect(byName.full?.renderers['three-current']?.image).toMatch(
      /^\/api\/results\/full\/beauty\/three-current\.avif\?v=\d+$/,
    );
    expect(byName.full?.renderers['three-current']?.delta).toMatch(
      /^\/api\/results\/full\/beauty\/delta-three-current\.avif\?v=\d+$/,
    );
    expect(byName.full?.renderers['three-current']?.metrics?.psnr).toBe(24.3);
    expect(byName.broken?.renderers['three-new']?.metrics).toBeUndefined();
    expect(byName.older?.renderers['three-new']?.image).toBeDefined();
    expect(byName.older?.renderers['three-current']).toBeUndefined();
    expect(byName.unrendered?.renderers).toEqual({});
  });

  it('only serves the recognized result filenames', () => {
    expect(RESULT_FILES).toContain('three-current.avif');
    expect(RESULT_FILES).toContain('delta-three-current.avif');
    expect(RESULT_FILES).toContain('metrics-three-current.json');
    expect(RESULT_FILES).toContain('three-new.avif');
    expect(RESULT_FILES).toContain('three-current.avif');
    expect(RESULT_FILES).not.toContain('unrelated.avif');
  });

  it('returns nothing for a missing results dir', async () => {
    expect(await listScenes([], 'beauty', path.join(dir, 'nope'))).toEqual([]);
  });
});

it('resolveInside rejects paths escaping the root', () => {
  expect(resolveInside('/root', 'a/b.glb')).toBe(path.resolve('/root/a/b.glb'));
  expect(resolveInside('/root', '../etc/passwd')).toBeUndefined();
  expect(resolveInside('/root', 'a/../../x')).toBeUndefined();
  expect(resolveInside('/root', '/etc/passwd')).toBeUndefined();
  expect(resolveInside('/root', '')).toBeUndefined();
});
