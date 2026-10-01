import { describe, expect, it } from 'vitest';
import { compareRgb, metricsPsnr, psnrDrop, type RawImage } from './compare.js';

const solid = (r: number, g: number, b: number, width = 4, height = 2): RawImage => ({
  data: Buffer.from(Array.from({ length: width * height }, () => [r, g, b]).flat()),
  width,
  height,
});

describe('compareRgb', () => {
  it('reports null PSNR and a black delta for identical images', () => {
    const image = solid(10, 128, 200);
    const { metrics, delta } = compareRgb(image, image);
    expect(metrics).toEqual({ psnr: null });
    expect([delta.width, delta.height]).toEqual([4, 2]);
    expect(delta.data.every((v) => v === 0)).toBe(true);
  });

  it('computes metrics for a known difference', () => {
    // one channel off by 51 in every pixel: per-channel errors are [51, 0, 0]
    const { metrics, delta } = compareRgb(solid(100, 100, 100), solid(151, 100, 100));
    const mse = (51 * 51) / 3;
    expect(metrics.psnr).toBeCloseTo(10 * Math.log10((255 * 255) / mse), 10);
    expect(delta.data.some((v) => v > 0)).toBe(true);
  });

  it('rejects images of different sizes', () => {
    expect(() => compareRgb(solid(0, 0, 0, 2, 2), solid(0, 0, 0, 4, 2))).toThrow('size mismatch');
  });
});

describe('PSNR quality gates', () => {
  it('accepts finite PSNR and the perfect-image sentinel', () => {
    expect(metricsPsnr({ psnr: 40 })).toBe(40);
    expect(metricsPsnr({ psnr: null })).toBe(Infinity);
    expect(metricsPsnr({ psnr: 0 })).toBe(0);
  });
  it('rejects missing or invalid PSNR', () => {
    for (const metrics of [{}, { psnr: NaN }, { psnr: -1 }, { psnr: Infinity }]) {
      expect(() => metricsPsnr(metrics)).toThrow();
    }
  });
  it('measures losses and improvements in dB', () => {
    expect(psnrDrop({ psnr: 40 }, { psnr: 39.95 })).toBeCloseTo(0.05);
    expect(psnrDrop({ psnr: 40 }, { psnr: 41 })).toBe(-1);
  });
  it('handles perfect baselines and candidates without NaN or hidden regressions', () => {
    expect(psnrDrop({ psnr: null }, { psnr: null })).toBe(0);
    expect(psnrDrop({ psnr: null }, { psnr: 40 })).toBe(Infinity);
    expect(psnrDrop({ psnr: 40 }, { psnr: null })).toBe(-Infinity);
  });
});
