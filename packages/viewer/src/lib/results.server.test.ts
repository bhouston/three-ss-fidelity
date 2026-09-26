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
    await writeFile(path.join(dir, 'full', 'beauty', 'three-ss.avif'), 'avif');
    await writeFile(path.join(dir, 'full', 'beauty', 'metrics.json'), JSON.stringify({ scene: 'full', psnr: 31.5 }));
    await writeFile(path.join(dir, 'full', 'beauty', 'three-ss-legacy.avif'), 'avif');
    await writeFile(path.join(dir, 'full', 'beauty', 'delta-three-ss-legacy.avif'), 'avif');
    await writeFile(
      path.join(dir, 'full', 'beauty', 'metrics-three-ss-legacy.json'),
      JSON.stringify({ scene: 'full', psnr: 24.3 }),
    );
    await mkdir(path.join(dir, 'broken', 'beauty'), { recursive: true });
    await writeFile(path.join(dir, 'broken', 'beauty', 'metrics.json'), '{not json');
    await mkdir(path.join(dir, 'older', 'beauty'), { recursive: true });
    await writeFile(path.join(dir, 'older', 'beauty', 'three-ss.avif'), 'avif');
    await mkdir(path.join(dir, '.hidden'));
    await writeFile(path.join(dir, 'stray.txt'), '');
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('unions result dirs with the registry and tolerates missing / invalid files', async () => {
    const scenes = await listScenes([{ name: 'full', description: 'd' }, { name: 'unrendered' }], 'beauty', dir);
    const byName = Object.fromEntries(scenes.map((scene) => [scene.name, scene]));
    expect(Object.keys(byName).toSorted()).toEqual(['broken', 'full', 'older', 'unrendered']);
    expect(byName.full?.description).toBe('d');
    expect(byName.full?.metrics?.psnr).toBe(31.5);
    expect(byName.full?.images.test).toMatch(/^\/api\/results\/full\/beauty\/three-ss\.avif\?v=\d+$/);
    expect(byName.full?.images.reference).toBeUndefined();
    expect(byName.full?.images.legacy).toMatch(/^\/api\/results\/full\/beauty\/three-ss-legacy\.avif\?v=\d+$/);
    expect(byName.full?.images.legacyDelta).toMatch(
      /^\/api\/results\/full\/beauty\/delta-three-ss-legacy\.avif\?v=\d+$/,
    );
    expect(byName.full?.legacyMetrics?.psnr).toBe(24.3);
    expect(byName.broken?.metrics).toBeUndefined();
    expect(byName.older?.images.test).toBeDefined();
    expect(byName.older?.images.legacy).toBeUndefined();
    expect(byName.older?.legacyMetrics).toBeUndefined();
    expect(Object.values(byName.unrendered?.images ?? {}).every((value) => value === undefined)).toBe(true);
  });

  it('only serves the recognized result filenames', () => {
    expect(RESULT_FILES).toContain('three-ss-legacy.avif');
    expect(RESULT_FILES).toContain('delta-three-ss-legacy.avif');
    expect(RESULT_FILES).toContain('metrics-three-ss-legacy.json');
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
