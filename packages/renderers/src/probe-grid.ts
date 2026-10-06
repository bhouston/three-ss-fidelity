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

/**
 * Bake reflected/emitted diffuse radiance; leave the existing environment term applied exactly once.
 * With `background`, resolve after the first small batch and keep baking between rendered frames, so the
 * partially baked grid lights the live view; otherwise resolve once the grid is fully baked.
 */
export async function bakeProbeGrid(
  renderer: WebGPURenderer,
  scene: Scene,
  ddgi = false,
  background?: ProbeBakeBackground,
): Promise<() => void> {
  const fitted = fitProbeGrid(scene);
  const { DDGIProbeGrid } = ddgi ? await import('./ddgi/DDGIProbeGrid.js') : { DDGIProbeGrid: undefined };
  const visibility = ddgi ? await (await import('./ddgi/visibility.js')).bakeVisibility(scene, fitted) : undefined;
  const grid =
    visibility && DDGIProbeGrid
      ? new DDGIProbeGrid(fitted, visibility)
      : new LightProbeGrid(
          fitted.size.x,
          fitted.size.y,
          fitted.size.z,
          fitted.resolution.x,
          fitted.resolution.y,
          fitted.resolution.z,
        );
  grid.position.copy(fitted.center);
  scene.add(grid);
  const started = performance.now();
  // Smaller batches keep frames responsive while the bake shares the GPU with rendering.
  const batch = background ? 8 : 32;
  const steps: { pass: number; start: number }[] = [];
  for (let pass = 0; pass <= PROBE_BAKE.bounces; pass++)
    for (let start = 0; start < fitted.count; start += batch) steps.push({ pass, start });
  const near =
    Math.min(...fitted.size.toArray().map((value, axis) => value / (fitted.resolution.getComponent(axis) - 1))) * 0.01;
  let next = 0;
  let cancelled = false;
  const bakeStep = () => {
    const { pass, start } = steps[next++]!;
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
        far: fitted.size.length() * 2,
        start,
        count: Math.min(batch, fitted.count - start),
        pass,
      });
    } finally {
      scene.background = originalBackground;
      scene.backgroundNode = originalBackgroundNode;
      scene.backgroundIntensity = originalBackgroundIntensity;
    }
    // The DDGI atlas is derived from the SH grid; refresh it so partial results are visible.
    if (visibility && background && 'convertIrradiance' in grid) grid.convertIrradiance(renderer);
  };
  const advance = async () => {
    while (next < steps.length && !cancelled) {
      bakeStep();
      // Bound queued GPU work, and yield so live startup and frames can keep running.
      await completeRenderer(renderer);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      background?.onProgress(next / steps.length);
    }
    if (cancelled) return;
    if (visibility && 'convertIrradiance' in grid) {
      grid.convertIrradiance(renderer);
      await completeRenderer(renderer);
    }
    console.info(
      `SH probe grid: ${fitted.resolution.toArray().join('x')} (${fitted.count} probes), ${PROBE_BAKE.bounces + 1} passes, bake ${(performance.now() - started).toFixed(0)} ms`,
    );
  };
  try {
    if (background) {
      // The first batch allocates the grid's textures, so lights using it can be built before it returns.
      bakeStep();
      await completeRenderer(renderer);
      background.onProgress(next / steps.length);
      advance().catch((error) => {
        if (!cancelled) background.onError(error);
      });
    } else await advance();
  } catch (error) {
    grid.removeFromParent();
    grid.dispose();
    throw error;
  }
  return () => {
    cancelled = true;
    grid.removeFromParent();
    grid.dispose();
  };
}
