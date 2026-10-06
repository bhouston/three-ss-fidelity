import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BoxGeometry, Color, Light, Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';
import { bakeProbeGrid, fitProbeGrid } from './probe-grid.js';

describe('automatic probe placement', () => {
  it.each([
    [1, 1, 1],
    [100, 1, 2],
    [1, 100, 1],
    [10, 0.01, 10],
  ])('bounds the budget for aspect ratio %j', (x, y, z) => {
    const scene = new Scene();
    const mesh = new Mesh(new BoxGeometry(x, y, z), new MeshBasicMaterial());
    mesh.position.set(4, 5, 6);
    scene.add(mesh);
    const fitted = fitProbeGrid(scene);
    expect(fitted.count).toBeLessThanOrEqual(2048);
    expect(fitted.count).toBeGreaterThan(1800);
    expect(fitted.resolution.toArray().every((n) => Number.isInteger(n) && n >= 2)).toBe(true);
    expect(fitted.center.toArray()).toEqual([4, 5, 6]);
    expect(fitted.size.x).toBeGreaterThan(x);
    expect(fitted.size.y).toBeGreaterThan(y);
    expect(fitted.size.z).toBeGreaterThan(z);
  });
  it('handles a plane and excludes invisible geometry', () => {
    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(10, 10), new MeshBasicMaterial()));
    const hidden = new Mesh(new BoxGeometry(1000, 1000, 1000), new MeshBasicMaterial());
    hidden.visible = false;
    scene.add(hidden);
    const fitted = fitProbeGrid(scene, 512);
    expect(fitted.size.z).toBeGreaterThan(0);
    expect(fitted.size.x).toBeCloseTo(10.4);
    expect(fitted.count).toBeLessThanOrEqual(512);
  });
  it('rejects empty geometry and invalid budgets', () => {
    expect(() => fitProbeGrid(new Scene())).toThrow('visible scene geometry');
    expect(() => fitProbeGrid(new Scene(), 7)).toThrow('budget');
    expect(() => fitProbeGrid(new Scene(), NaN)).toThrow('budget');
  });
});

const state = vi.hoisted(() => ({
  fail: false,
  grids: [] as { visible: boolean; dispose: ReturnType<typeof vi.fn>; bake: ReturnType<typeof vi.fn> }[],
}));
vi.mock('three/addons/lighting/LightProbeGrid.js', () => ({
  LightProbeGrid: class extends Light {
    override dispose = vi.fn();
    bake = vi.fn(() => {
      if (state.fail) throw new Error('capture failed');
    });
    constructor() {
      super();
      state.grids.push(this);
    }
  },
}));
vi.mock('./profiling.js', () => ({ completeRenderer: vi.fn(async () => {}) }));
beforeEach(() => {
  state.fail = false;
  state.grids = [];
});

it('bakes complete bounce passes, restores background and releases the grid', async () => {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const background = new Color('red');
  scene.background = background;
  const release = await bakeProbeGrid({} as never, scene);
  const grid = state.grids[0]!;
  const calls = grid.bake.mock.calls;
  for (const pass of [0, 1, 2]) {
    const ranges = calls.map((call) => call[2]).filter((options) => options.pass === pass);
    expect(ranges[0].start).toBe(0);
    expect(ranges.reduce((n, options) => n + options.count, 0)).toBe(fitProbeGrid(scene).count);
  }
  expect(scene.background).toBe(background);
  release();
  expect(grid.dispose).toHaveBeenCalledTimes(1);
  expect(scene.children).toHaveLength(1);
});
it('restores borrowed scene state and removes failed captures', async () => {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const background = new Color('red');
  scene.background = background;
  scene.backgroundIntensity = 2;
  state.fail = true;
  await expect(bakeProbeGrid({} as never, scene)).rejects.toThrow('capture failed');
  expect(scene.background).toBe(background);
  expect(scene.backgroundIntensity).toBe(2);
  expect(scene.children).toHaveLength(1);
  expect(state.grids[0]!.dispose).toHaveBeenCalledTimes(1);
});
it('previews with a coarse grid, bakes the full grid hidden, then swaps them', async () => {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const background = new Color('red');
  scene.background = background;
  const progress: number[] = [];
  const release = await bakeProbeGrid({} as never, scene, false, {
    onProgress: (fraction) => progress.push(fraction),
    onError: (error) => {
      throw error;
    },
  });
  const [preview] = state.grids;
  expect(state.grids).toHaveLength(1);
  expect(progress[0]).toBeLessThan(1);
  expect(scene.background).toBe(background);
  await vi.waitFor(() => expect(progress.at(-1)).toBe(1), { timeout: 10_000 });
  const [, full] = state.grids;
  expect(preview!.dispose).toHaveBeenCalledTimes(1);
  expect(scene.children).toContain(full);
  expect(scene.children).not.toContain(preview);
  expect(full!.visible).toBe(true);
  expect(full!.bake.mock.calls.reduce((n, call) => n + (call[2].pass === 0 ? call[2].count : 0), 0)).toBe(
    fitProbeGrid(scene).count,
  );
  // the preview never sees the full grid's light and vice versa
  expect(preview!.bake.mock.calls.length).toBeLessThan(full!.bake.mock.calls.length);
  expect(scene.background).toBe(background);
  release();
  expect(full!.dispose).toHaveBeenCalledTimes(1);
});
it('stops baking when released mid-way', async () => {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const release = await bakeProbeGrid({} as never, scene, false, { onProgress: () => {}, onError: () => {} });
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(state.grids).toHaveLength(1);
  expect(state.grids[0]!.dispose).toHaveBeenCalledTimes(1);
});
it('reports background bake failures through onError', async () => {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const errors: unknown[] = [];
  await bakeProbeGrid({} as never, scene, false, {
    onProgress: () => (state.fail = true),
    onError: (e) => errors.push(e),
  });
  await vi.waitFor(() => expect(errors).toHaveLength(1));
});
