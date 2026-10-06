import { Box3, Color, Vector3, type Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { completeRenderer } from './profiling.js';

export const PROBE_BUDGET = 2048;
export const PROBE_BAKE = { cubemapSize: 16, sampleCount: 512, bounces: 2 } as const;

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

/** Same bounds at half the probes per axis (about 1/8 the work), for a quick interpolated preview. */
function coarsen(fitted: Fitted): Fitted {
  const resolution = fitted.resolution
    .clone()
    .multiplyScalar(0.5)
    .ceil()
    .max(new Vector3(2, 2, 2));
  return { ...fitted, resolution, count: resolution.x * resolution.y * resolution.z };
}

/**
 * Bake reflected/emitted diffuse radiance; leave the existing environment term applied exactly once.
 * With `background`, resolve after the first small batch and keep baking between rendered frames: a coarse
 * plain-SH grid lights the live view first, then the full grid bakes hidden and replaces it when finished.
 * Otherwise resolve once the full grid is baked.
 */
export async function bakeProbeGrid(
  renderer: WebGPURenderer,
  scene: Scene,
  ddgi = false,
  background?: ProbeBakeBackground,
): Promise<() => void> {
  const fitted = fitProbeGrid(scene);
  const grids: (LightProbeGrid & { convertIrradiance?: (renderer: WebGPURenderer) => void })[] = [];
  const createGrid = (fit: Fitted, visibility?: unknown, DDGIProbeGrid?: new (...args: never[]) => unknown) => {
    const grid = (
      visibility && DDGIProbeGrid
        ? new (DDGIProbeGrid as new (fit: Fitted, visibility: unknown) => LightProbeGrid)(fit, visibility)
        : new LightProbeGrid(fit.size.x, fit.size.y, fit.size.z, fit.resolution.x, fit.resolution.y, fit.resolution.z)
    ) as (typeof grids)[number];
    grid.position.copy(fit.center);
    scene.add(grid);
    grids.push(grid);
    return grid;
  };
  let cancelled = false;
  const release = () => {
    cancelled = true;
    for (const grid of grids) {
      grid.removeFromParent();
      grid.dispose();
    }
  };
  const started = performance.now();
  // Smaller batches keep frames responsive while the bake shares the GPU with rendering.
  const batch = background ? 8 : 32;
  let done = 0;
  let total = 0;
  const stepCount = (fit: Fitted) => (PROBE_BAKE.bounces + 1) * Math.ceil(fit.count / batch);
  const makeStage = (grid: (typeof grids)[number], fit: Fitted) => {
    const steps: { pass: number; start: number }[] = [];
    for (let pass = 0; pass <= PROBE_BAKE.bounces; pass++)
      for (let start = 0; start < fit.count; start += batch) steps.push({ pass, start });
    const near =
      Math.min(...fit.size.toArray().map((value, axis) => value / (fit.resolution.getComponent(axis) - 1))) * 0.01;
    return { grid, fit, steps, near, next: 0 };
  };
  type Stage = ReturnType<typeof makeStage>;
  const bakeStep = (stage: Stage) => {
    const { pass, start } = stage.steps[stage.next++]!;
    const originalBackground = scene.background;
    const originalBackgroundNode = scene.backgroundNode;
    const originalBackgroundIntensity = scene.backgroundIntensity;
    // Another grid's light must not be captured as indirect light into this one.
    const hidden = grids.filter((grid) => grid !== stage.grid && grid.visible);
    for (const grid of hidden) grid.visible = false;
    try {
      // A presentation gradient/color is not an emitter. Capturing the environment here as well as
      // applying material IBL would double-count escaped radiance. Surface shading still uses IBL.
      // Restored after every batch so frames rendered between batches keep their real background.
      scene.backgroundNode = null;
      scene.background = new Color(0);
      scene.backgroundIntensity = 1;
      stage.grid.bake(renderer, scene, {
        cubemapSize: PROBE_BAKE.cubemapSize,
        sampleCount: PROBE_BAKE.sampleCount,
        near: stage.near,
        far: stage.fit.size.length() * 2,
        start,
        count: Math.min(batch, stage.fit.count - start),
        pass,
      });
    } finally {
      for (const grid of hidden) grid.visible = true;
      scene.background = originalBackground;
      scene.backgroundNode = originalBackgroundNode;
      scene.backgroundIntensity = originalBackgroundIntensity;
    }
  };
  const run = async (stage: Stage) => {
    while (stage.next < stage.steps.length && !cancelled) {
      bakeStep(stage);
      done++;
      // Bound queued GPU work, and yield so live startup and frames can keep running.
      await completeRenderer(renderer);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      background?.onProgress(done / total);
    }
  };
  // Build the full grid (DDGI: visibility first), bake it hidden, then show it and drop the preview.
  const bakeFull = async () => {
    const { DDGIProbeGrid } = ddgi ? await import('./ddgi/DDGIProbeGrid.js') : { DDGIProbeGrid: undefined };
    const visibility = ddgi ? await (await import('./ddgi/visibility.js')).bakeVisibility(scene, fitted) : undefined;
    if (cancelled) return;
    const grid = createGrid(fitted, visibility, DDGIProbeGrid);
    if (background) grid.visible = false;
    if (!background) total = stepCount(fitted);
    await run(makeStage(grid, fitted));
    if (cancelled) return;
    if (grid.convertIrradiance) {
      grid.convertIrradiance(renderer);
      await completeRenderer(renderer);
    }
    if (background) {
      grid.visible = true;
      const [preview] = grids.splice(0, 1);
      preview!.removeFromParent();
      preview!.dispose();
    }
    console.info(
      `SH probe grid: ${fitted.resolution.toArray().join('x')} (${fitted.count} probes), ${PROBE_BAKE.bounces + 1} passes, bake ${(performance.now() - started).toFixed(0)} ms`,
    );
  };
  try {
    if (!background) await bakeFull();
    else {
      const previewFit = coarsen(fitted);
      const preview = makeStage(createGrid(previewFit), previewFit);
      // Count the full stage up front so progress never runs backwards.
      total = stepCount(previewFit) + stepCount(fitted);
      // The first batch allocates the grid's textures, so lights using it can be built before it returns.
      bakeStep(preview);
      done++;
      await completeRenderer(renderer);
      background.onProgress(done / total);
      run(preview)
        .then(bakeFull)
        .catch((error) => {
          if (!cancelled) background.onError(error);
        });
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}
