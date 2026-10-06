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
it('bakes one grid per bounce at rising resolution, each showing only after it finishes', async () => {
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
  // returns once the coarsest grid is baked and visible; finer levels continue in the background
  expect(state.grids[0]!.visible).toBe(true);
  expect(scene.background).toBe(background);
  await vi.waitFor(() => expect(progress.at(-1)).toBe(1), { timeout: 10_000 });
  expect(state.grids).toHaveLength(3);
  const counts = state.grids.map((grid) => grid.bake.mock.calls.reduce((n, call) => n + call[2].count, 0));
  expect(counts[0]).toBeLessThan(counts[1]!);
  expect(counts[1]).toBeLessThanOrEqual(counts[2]!);
  expect(counts[2]).toBe(fitProbeGrid(scene).count);
  // every level is a direct-light pass; bounces come from the previous level being visible
  // the coarse grid iterates its own bounce passes; finer ones are single direct passes on top of it
  expect(new Set(state.grids[0]!.bake.mock.calls.map((call) => call[2].pass))).toEqual(new Set([0, 1, 2]));
  for (const grid of state.grids.slice(1)) for (const call of grid.bake.mock.calls) expect(call[2].pass).toBe(0);
  expect(state.grids.map((grid) => grid.dispose.mock.calls.length)).toEqual([1, 1, 0]);
  expect(scene.children).toEqual([expect.anything(), state.grids[2]]);
  expect(state.grids[2]!.visible).toBe(true);
  expect(scene.background).toBe(background);
  release();
  expect(state.grids[2]!.dispose).toHaveBeenCalledTimes(1);
});
it('stops baking when released mid-way', async () => {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const release = await bakeProbeGrid({} as never, scene, false, { onProgress: () => {}, onError: () => {} });
  release();
  const bakes = state.grids.map((grid) => grid.bake.mock.calls.length);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(state.grids.map((grid) => grid.bake.mock.calls.length)).toEqual(bakes);
  expect(state.grids.at(-1)!.dispose).toHaveBeenCalledTimes(1);
});
it('reports background bake failures through onError', async () => {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const errors: unknown[] = [];
  await bakeProbeGrid({} as never, scene, false, { onProgress: () => {}, onError: (e) => errors.push(e) });
  state.fail = true;
  await vi.waitFor(() => expect(errors).toHaveLength(1));
});
