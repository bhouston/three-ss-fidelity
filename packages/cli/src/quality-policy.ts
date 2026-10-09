/** Relative mean-RMSE regression, matching the sibling suite. Null PSNR denotes identical images. */
export function relativeMeanRmse(rows: { baselinePsnr: number | null; candidatePsnr: number | null }[]) {
  if (!rows.length) throw new Error('No quality rows');
  const rmse = (psnr: number | null) => (psnr === null ? 0 : 10 ** (-psnr / 20));
  const baseline = rows.reduce((sum, row) => sum + rmse(row.baselinePsnr), 0) / rows.length;
  const candidate = rows.reduce((sum, row) => sum + rmse(row.candidatePsnr), 0) / rows.length;
  return {
    baseline,
    candidate,
    regression: baseline === 0 ? (candidate === 0 ? 0 : Infinity) : (candidate - baseline) / baseline,
  };
}
