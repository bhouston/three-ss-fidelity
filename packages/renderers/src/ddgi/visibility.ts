import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  FloatType,
  LinearFilter,
  RGFormat,
  RGBAFormat,
  Vector3,
  type Scene,
} from 'three';
import type { fitProbeGrid } from '../probe-grid.js';
import { geometrySnapshot, octBorderTexel, octDecode, relocateProbe } from './geometry.js';

export const DISTANCE_RESOLUTION = 16;
export const IRRADIANCE_RESOLUTION = 8;
export const ATLAS_COLUMNS = 32;

/** CPU BVH visibility/relocation bake; radiance and SH projection remain on the GPU. */
export async function bakeVisibility(scene: Scene, fitted: ReturnType<typeof fitProbeGrid>) {
  const started = performance.now();
  const snapshot = geometrySnapshot(scene);
  const { x: nx, y: ny, z: nz } = fitted.resolution;
  const spacing = fitted.size.clone().divide(fitted.resolution.clone().subScalar(1));
  const min = fitted.center.clone().sub(fitted.size.clone().multiplyScalar(0.5));
  const distanceScale = spacing.length() * 2;
  const tile = DISTANCE_RESOLUTION + 2;
  const rows = Math.ceil(fitted.count / ATLAS_COLUMNS);
  const width = ATLAS_COLUMNS * tile,
    height = rows * tile;
  const moments = new Uint16Array(width * height * 2);
  const offsets = new Float32Array(fitted.count * 4);
  // Four deterministic sub-texel directions represent the directional distance distribution.
  const directions = Array.from({ length: DISTANCE_RESOLUTION ** 2 }, (_, i) => {
    const x = i % DISTANCE_RESOLUTION,
      y = Math.floor(i / DISTANCE_RESOLUTION);
    return [0.25, 0.75].flatMap((dy) =>
      [0.25, 0.75].map((dx) =>
        octDecode(((x + dx) / DISTANCE_RESOLUTION) * 2 - 1, ((y + dy) / DISTANCE_RESOLUTION) * 2 - 1),
      ),
    );
  });
  let relocated = 0,
    inactive = 0;
  try {
    for (let index = 0; index < fitted.count; index++) {
      const ix = index % nx,
        iy = Math.floor(index / nx) % ny,
        iz = Math.floor(index / (nx * ny));
      const origin = new Vector3(ix, iy, iz).multiply(spacing).add(min);
      const result = relocateProbe(origin, spacing, snapshot.trace);
      result.offset.toArray(offsets, index * 4);
      offsets[index * 4 + 3] = result.valid ? 1 : 0;
      if (result.offset.lengthSq() > 1e-10) relocated++;
      if (!result.valid) inactive++;
      const interior = new Float32Array(DISTANCE_RESOLUTION ** 2 * 2);
      for (let pixel = 0; pixel < directions.length; pixel++) {
        let mean = 0,
          second = 0;
        for (const direction of directions[pixel]!) {
          const hit = result.valid ? snapshot.trace(result.position, direction, distanceScale) : null;
          const distance = (hit?.distance ?? distanceScale) / distanceScale;
          mean += distance * 0.25;
          second += distance * distance * 0.25;
        }
        interior[pixel * 2] = mean;
        interior[pixel * 2 + 1] = second;
      }
      const tileX = (index % ATLAS_COLUMNS) * tile,
        tileY = Math.floor(index / ATLAS_COLUMNS) * tile;
      for (let y = 0; y < tile; y++)
        for (let x = 0; x < tile; x++) {
          const [sx, sy] = octBorderTexel(x - 1, y - 1, DISTANCE_RESOLUTION);
          const source = (sx + sy * DISTANCE_RESOLUTION) * 2;
          const target = (tileX + x + (tileY + y) * width) * 2;
          moments[target] = DataUtils.toHalfFloat(interior[source]!);
          moments[target + 1] = DataUtils.toHalfFloat(interior[source + 1]!);
        }
      if (index % 32 === 31) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    snapshot.dispose();
  }
  const distanceTexture = new DataTexture(moments, width, height, RGFormat, HalfFloatType);
  distanceTexture.minFilter = distanceTexture.magFilter = LinearFilter;
  distanceTexture.needsUpdate = true;
  const probeData = new DataTexture(offsets, nx, ny * nz, RGBAFormat, FloatType);
  probeData.needsUpdate = true;
  console.info(
    `DDGI visibility: ${relocated} relocated, ${inactive} inactive / ${fitted.count}, ${(performance.now() - started).toFixed(0)} ms`,
  );
  return {
    distanceTexture,
    probeData,
    offsets,
    spacing,
    distanceScale,
    rows,
    relocated,
    inactive,
    dispose() {
      distanceTexture.dispose();
      probeData.dispose();
    },
  };
}
