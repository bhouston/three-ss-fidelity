import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { compareImages } from './compare.js';

const solid = (r: number, g: number, b: number) =>
  sharp({ create: { width: 4, height: 2, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();

describe('compareImages', () => {
  it('reports null PSNR, zero error and a black delta for identical images', async () => {
    const image = await solid(10, 128, 200);
    const { metrics, width, height, deltaPng } = await compareImages(image, image);
    expect(metrics).toEqual({ psnr: null, rmse: 0, mae: 0, maxError: 0 });
    expect([width, height]).toEqual([4, 2]);
    const { data } = await sharp(deltaPng).raw().toBuffer({ resolveWithObject: true });
    expect(data.every((v) => v === 0)).toBe(true);
  });

  it('computes metrics for a known difference', async () => {
    // one channel off by 51 in every pixel: per-channel errors are [51, 0, 0]
    const { metrics, deltaPng } = await compareImages(await solid(100, 100, 100), await solid(151, 100, 100));
    const mse = (51 * 51) / 3;
    expect(metrics.psnr).toBeCloseTo(10 * Math.log10((255 * 255) / mse), 10);
    expect(metrics.rmse).toBeCloseTo(Math.sqrt(mse) / 255, 10);
    expect(metrics.mae).toBeCloseTo(17 / 255, 10);
    expect(metrics.maxError).toBeCloseTo(0.2, 10);
    const { data } = await sharp(deltaPng).raw().toBuffer({ resolveWithObject: true });
    expect(data.some((v) => v > 0)).toBe(true);
  });

  it('rejects images of different sizes', async () => {
    const small = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    await expect(compareImages(small, await solid(0, 0, 0))).rejects.toThrow('size mismatch');
  });
});
