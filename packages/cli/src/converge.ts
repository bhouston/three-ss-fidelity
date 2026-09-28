import { compareRgb, type RawImage } from './compare.js';

/** One capture of a move-then-stop run, scored against the path-traced reference. */
export interface ConvergeSample {
  /** Frames at rest after the camera arrived at the reference pose (0 = the arrival frame). */
  frame: number;
  rmse: number;
  /** Mean signed error over all pixels and channels relative to the reference's mean: -0.05 = 5 % too dark. */
  bias: number;
}

export interface ConvergeSummary {
  /** RMSE on the arrival frame: quality while moving. */
  atStop: number;
  /** RMSE 16 frames after stopping: how fast it converges. */
  after16: number;
  /** RMSE on the last capture: converged quality. */
  final: number;
  /** Brightness bias on the last capture. */
  finalBias: number;
  /** RMSE between the last two captures: residual flicker once still. */
  flicker: number;
}

export interface ConvergeFile {
  scene: string;
  renderer: string;
  motion: { degrees: number; moveFrames: number };
  samples: ConvergeSample[];
  summary: ConvergeSummary;
  generatedAt: string;
}

/** Signed mean error of `test` against `reference`, relative to the reference's mean. */
export function meanBias(reference: RawImage, test: RawImage): number {
  let sumRef = 0;
  let sumDiff = 0;
  for (let i = 0; i < reference.data.length; i++) {
    sumRef += reference.data[i]!;
    sumDiff += test.data[i]! - reference.data[i]!;
  }
  return sumRef === 0 ? 0 : sumDiff / sumRef;
}

/** Scores captures (sorted by frame; the last two must be consecutive frames) against the reference. */
export function summarize(
  reference: RawImage,
  captures: { frame: number; image: RawImage }[],
): { samples: ConvergeSample[]; summary: ConvergeSummary } {
  const samples = captures.map(({ frame, image }) => ({
    frame,
    rmse: compareRgb(reference, image).metrics.rmse,
    bias: meanBias(reference, image),
  }));
  const at = (frame: number) => {
    const sample = samples.find((s) => s.frame === frame);
    if (!sample) throw new Error(`No capture at frame ${frame}`);
    return sample;
  };
  const last = captures.at(-1)!;
  const previous = captures.at(-2)!;
  if (last.frame !== previous.frame + 1) throw new Error('The last two captures must be consecutive frames');
  return {
    samples,
    summary: {
      atStop: at(0).rmse,
      after16: at(16).rmse,
      final: at(last.frame).rmse,
      finalBias: at(last.frame).bias,
      flicker: compareRgb(previous.image, last.image).metrics.rmse,
    },
  };
}
