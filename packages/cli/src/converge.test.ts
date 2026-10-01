import { describe, expect, it } from 'vitest';
import type { RawImage } from './compare.js';
import { meanBias, summarize } from './converge.js';

const image = (value: number): RawImage => ({ data: Buffer.alloc(4 * 3, value), width: 2, height: 2 });

describe('converge metrics', () => {
  it('reports signed brightness bias relative to the reference', () => {
    expect(meanBias(image(100), image(90))).toBeCloseTo(-0.1);
    expect(meanBias(image(100), image(100))).toBe(0);
  });

  it('summarizes a move-then-stop capture curve', () => {
    const frames = [0, 16, 255, 256];
    const values = [40, 80, 99, 100];
    const { samples, summary } = summarize(
      image(100),
      frames.map((frame, i) => ({ frame, image: image(values[i]!) })),
    );
    expect(samples).toHaveLength(4);
    expect(summary.atStop).toBeCloseTo(20 * Math.log10(255 / 60));
    expect(summary.after16).toBeCloseTo(20 * Math.log10(255 / 20));
    expect(summary.final).toBeNull();
    expect(summary.finalBias).toBe(0);
    expect(summary.flicker).toBeCloseTo(20 * Math.log10(255));
  });

  it('needs the last two captures to be consecutive frames', () => {
    const captures = [0, 16, 250, 256].map((frame) => ({ frame, image: image(100) }));
    expect(() => summarize(image(100), captures)).toThrow(/consecutive/);
  });
});
