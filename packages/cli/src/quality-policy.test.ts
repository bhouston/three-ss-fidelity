import { expect, test } from 'vitest';
import { relativeMeanRmse } from './quality-policy.js';
test('relative mean RMSE handles exact matches and matches normalized PSNR math', () => {
  expect(relativeMeanRmse([{ baselinePsnr: null, candidatePsnr: null }]).regression).toBe(0);
  expect(relativeMeanRmse([{ baselinePsnr: null, candidatePsnr: 40 }]).regression).toBe(Infinity);
  expect(relativeMeanRmse([{ baselinePsnr: 40, candidatePsnr: 40 }]).regression).toBe(0);
  const value = relativeMeanRmse([{ baselinePsnr: 40, candidatePsnr: 20 }]);
  expect(value.baseline).toBeCloseTo(0.01);
  expect(value.candidate).toBeCloseTo(0.1);
  expect(value.regression).toBeCloseTo(9);
});
