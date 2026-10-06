import { Box3, Color, Vector3, type Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { completeRenderer } from './profiling.js';

export const PROBE_BUDGET = 2048;
export const PROBE_BAKE = { cubemapSize: 16, sampleCount: 512, bounces: 2 } as const;
/** Progressive mode: bounce passes on the cheap coarsest grid, so the first lit frames already hold bounces. */
const COARSE_PASSES = 3;

/** Spend a bounded budget on approximately equal world-space spacing, including flat scenes. */
export function fitProbeGrid(scene: Scene, budget = PROBE_BUDGET) {
  if (!Number.isSafeInteger(budget) || budget < 8) throw new RangeError('Probe budget must be an integer >= 8');
  const bounds = new Box3();
  scene.updateMatrixWorld(true);
  scene.traverseVisible((object) => {
    // Exclude camera/light helpers and include skinned/instanced meshes through Box3's implementation.
    if ((object as { isMesh?: boolean }).isMesh) bounds.union(new Box3().setFromObject(object, true));
  });
  if (bounds.isEmpty()) throw new Error('Probe grid needs visible scene geometry');
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  if (!size.toArray().every(Number.isFinite)) throw new Error('Probe grid bounds must be finite');
  const longest = Math.max(size.x, size.y, size.z, 1e-6);
  // Give planes a small volume and keep probes away from the exact outermost surfaces.
  const extent = size.toArray().map((value) => Math.max(value, longest * 0.05) * 1.04);
  const resolution = [2, 2, 2];
  for (;;) {
    const candidates = resolution
      .map((value, axis) => ({
        axis,
        spacing: extent[axis]! / (value - 1),
        count: resolution.reduce((product, n, i) => product * (n + (i === axis ? 1 : 0)), 1),
      }))
      .filter(({ count }) => count <= budget && count <= 8192);
    if (!candidates.length) break;
    candidates.sort((a, b) => b.spacing - a.spacing);
    resolution[candidates[0]!.axis]!++;
  }
  return {
    center,
    size: new Vector3(...extent),
    resolution: new Vector3(...resolution),
    count: resolution.reduce((product, n) => product * n, 1),
  };
}

export interface ProbeBakeBackground {
  onProgress(fraction: number): void;
  onError(error: unknown): void;
}

type Fitted = ReturnType<typeof fitProbeGrid>;
type Grid = LightProbeGrid & { convertIrradiance?: (renderer: WebGPURenderer) => void };

/** Same bounds with the probes per axis scaled down. */
function scaled(fitted: Fitted, scale: number): Fitted {
  const resolution = fitted.resolution
    .clone()
    .multiplyScalar(scale)
    .ceil()
    .max(new Vector3(2, 2, 2));
  return { ...fitted, resolution, count: resolution.x * resolution.y * resolution.z };
}

/**
 * Bake reflected/emitted diffuse radiance; leave the existing environment term applied exactly once.
 *
 * With `background`, resolve after the first batch of a coarse 1/4-resolution grid, which is visible while it
 * bakes its own bounce passes between rendered frames. Then 1/2 and full resolution grids follow: a grid is a
 * light, so each captures the previous (visible) level as its indirect light and holds one more bounce, and
 * replaces it when finished. Live bounce depth therefore exceeds the blocking bake's. Otherwise bake one full-resolution grid with the addon's own bounce passes and resolve when done.
 */
export async function bakeProbeGrid(
  renderer: WebGPURenderer,
  scene: Scene,
  ddgi = false,
  background?: ProbeBakeBackground,
): Promise<() => void> {
  const fitted = fitProbeGrid(scene);
  const grids: Grid[] = [];
  let cancelled = false;
  const release = () => {
    cancelled = true;
    for (const grid of grids.splice(0)) {
      grid.removeFromParent();
      grid.dispose();
    }
  };
  const started = performance.now();
  // Smaller batches keep frames responsive while the bake shares the GPU with rendering.
  const batch = background ? 8 : 32;
  const levels = PROBE_BAKE.bounces + 1;
  const levelFit = (level: number) => (level === levels - 1 ? fitted : scaled(fitted, 2 ** (level + 1 - levels)));
  const steps = (fit: Fitted, passes: number) => passes * Math.ceil(fit.count / batch);
  const levelPasses = (level: number) => (level === 0 ? COARSE_PASSES : 1);
  const total = background
    ? Array.from({ length: levels }, (_, level) => steps(levelFit(level), levelPasses(level))).reduce((a, b) => a + b)
    : steps(fitted, levels);
  let firstBatch = () => {};
  const ready = new Promise<void>((resolve) => (firstBatch = resolve));
  let done = 0;

  const createGrid = async (fit: Fitted, final: boolean) => {
    const { DDGIProbeGrid } = ddgi && final ? await import('./ddgi/DDGIProbeGrid.js') : { DDGIProbeGrid: undefined };
    const visibility =
      ddgi && final ? await (await import('./ddgi/visibility.js')).bakeVisibility(scene, fitted) : undefined;
    if (cancelled) return;
    const grid = (
      visibility && DDGIProbeGrid
        ? new DDGIProbeGrid(fit, visibility)
        : new LightProbeGrid(fit.size.x, fit.size.y, fit.size.z, fit.resolution.x, fit.resolution.y, fit.resolution.z)
    ) as Grid;
    grid.position.copy(fit.center);
    scene.add(grid);
    grids.push(grid);
    return grid;
  };
  /** Bake `passes` bounce passes of one grid in small batches, restoring the background after each. */
  const bakeGrid = async (grid: Grid, fit: Fitted, passes: number) => {
    const near =
      Math.min(...fit.size.toArray().map((value, axis) => value / (fit.resolution.getComponent(axis) - 1))) * 0.01;
    for (let pass = 0; pass < passes; pass++) {
      for (let start = 0; start < fit.count && !cancelled; start += batch) {
        const originalBackground = scene.background;
        const originalBackgroundNode = scene.backgroundNode;
        const originalBackgroundIntensity = scene.backgroundIntensity;
        try {
          // A presentation gradient/color is not an emitter. Capturing the environment here as well as
          // applying material IBL would double-count escaped radiance. Surface shading still uses IBL.
          // Restored after every batch so frames rendered between batches keep their real background.
          scene.backgroundNode = null;
          scene.background = new Color(0);
          scene.backgroundIntensity = 1;
          grid.bake(renderer, scene, {
            cubemapSize: PROBE_BAKE.cubemapSize,
            sampleCount: PROBE_BAKE.sampleCount,
            near,
            far: fit.size.length() * 2,
            start,
            count: Math.min(batch, fit.count - start),
            pass,
          });
        } finally {
          scene.background = originalBackground;
          scene.backgroundNode = originalBackgroundNode;
          scene.backgroundIntensity = originalBackgroundIntensity;
        }
        done++;
        // Bound queued GPU work, and yield so live startup and frames can keep running.
        await completeRenderer(renderer);
        firstBatch();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        background?.onProgress(done / total);
      }
    }
    if (cancelled) return;
    if (grid.convertIrradiance) {
      grid.convertIrradiance(renderer);
      await completeRenderer(renderer);
    }
  };
  /** Bake level `level` hidden, then show it and drop the level before it. */
  const bakeLevel = async (level: number) => {
    const fit = levelFit(level);
    const grid = await createGrid(fit, level === levels - 1);
    if (!grid) return;
    // The coarsest grid is shown while it bakes; its tiny size makes the partial fill short-lived.
    grid.visible = level === 0;
    await bakeGrid(grid, fit, levelPasses(level));
    if (cancelled) return;
    grid.visible = true;
    const [previous] = grids.splice(0, grids.length - 1);
    previous?.removeFromParent();
    previous?.dispose();
  };
  const finish = () =>
    console.info(
      `SH probe grid: ${fitted.resolution.toArray().join('x')} (${fitted.count} probes), ${levels} passes, bake ${(performance.now() - started).toFixed(0)} ms`,
    );
  try {
    if (background) {
      const chain = (async () => {
        for (let level = 0; level < levels && !cancelled; level++) await bakeLevel(level);
        if (!cancelled) finish();
      })();
      // Resolve after the first batch (the grid's textures exist); a failure before then rejects.
      await Promise.race([ready, chain]);
      chain.catch((error) => {
        if (!cancelled) background.onError(error);
      });
    } else {
      const grid = await createGrid(fitted, true);
      await bakeGrid(grid!, fitted, levels);
      if (!cancelled) finish();
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}
