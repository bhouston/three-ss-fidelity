/** Display order: the reference, the stock baseline, then the improved renderer. */
export const RENDERERS = ['three-gpu-pathtracer', 'three-current', 'three-new'] as const;
export type RendererName = (typeof RENDERERS)[number];

/** Every screen-space renderer: everything but the path-traced reference. */
export const SCREEN_SPACE_RENDERERS = RENDERERS.filter(
  (name): name is Exclude<RendererName, 'three-gpu-pathtracer'> => name !== 'three-gpu-pathtracer',
);

export function isRendererName(value: string): value is RendererName {
  return (RENDERERS as readonly string[]).includes(value);
}

/** Mirrors `passNames` of @ss-fidelity/renderers; results live in results/<scene>/<pass>/. */
export const PASSES = ['beauty', 'direct', 'ao'] as const;
export type PassName = (typeof PASSES)[number];

export function isPassName(value: unknown): value is PassName {
  return (PASSES as readonly unknown[]).includes(value);
}

export function parsePass(value: unknown): PassName {
  return isPassName(value) ? value : 'beauty';
}

/** The `pass` search param: omitted from URLs for the default (beauty). */
export function passSearch(pass: PassName): PassName | undefined {
  return pass === 'beauty' ? undefined : pass;
}

export interface SceneMetrics {
  scene: string;
  pass?: string;
  reference: string;
  test: string;
  width: number;
  height: number;
  /** `null` means the images are identical. */
  psnr: number | null;
  rmse: number;
  mae: number;
  maxError: number;
  generatedAt: string;
}

/** One screen-space renderer's result images + metrics for a scene/pass; absent fields mean the file doesn't exist. */
export interface RendererResult {
  image?: string;
  delta?: string;
  metrics?: SceneMetrics;
}

export interface SceneSummary {
  name: string;
  description?: string;
  /** Path-traced reference image URL; absent when the file does not exist. */
  reference?: string;
  /** Keyed by screen-space renderer name; a renderer missing from a scene's results is simply absent here. */
  renderers: Partial<Record<Exclude<RendererName, 'three-gpu-pathtracer'>, RendererResult>>;
}

export const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'psnr', label: 'PSNR (worst first)' },
  { value: 'psnr-desc', label: 'PSNR (best first)' },
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number]['value'];

export function parseSort(value: unknown): SortValue {
  return SORT_OPTIONS.some((option) => option.value === value) ? (value as SortValue) : 'name';
}

/** Sorts by three-new's PSNR (the renderer being improved). Identical images (`psnr: null`) rank as best; scenes without it rank last. */
function psnrRank(scene: SceneSummary): number | undefined {
  const psnr = scene.renderers['three-new']?.metrics?.psnr;
  if (psnr === undefined) return undefined;
  return psnr ?? Number.POSITIVE_INFINITY;
}

const byName = (a: SceneSummary, b: SceneSummary) => a.name.localeCompare(b.name, undefined, { numeric: true });

export function sortScenes(scenes: SceneSummary[], sort: SortValue): SceneSummary[] {
  if (sort === 'name') return scenes.toSorted(byName);
  const direction = sort === 'psnr' ? 1 : -1;
  return scenes.toSorted((a, b) => {
    const left = psnrRank(a);
    const right = psnrRank(b);
    if (left === undefined || right === undefined) {
      return left === right ? byName(a, b) : left === undefined ? 1 : -1;
    }
    return left === right ? byName(a, b) : (left < right ? -1 : 1) * direction;
  });
}

export function filterScenes(scenes: SceneSummary[], filter: string): SceneSummary[] {
  const terms = filter
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (terms.length === 0) return scenes;
  return scenes.filter((scene) => {
    const haystack = `${scene.name} ${scene.description ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function formatMetric(value: number | null | undefined, digits = 2): string {
  if (value === null) return '∞';
  return value === undefined ? '–' : value.toFixed(digits);
}
/** Same thresholds as material-fidelity: ≤20 dB error, ≤24 dB warning. */
export function psnrClassName(metrics: SceneMetrics | undefined): string {
  const psnr = metrics?.psnr;
  if (psnr == null) return '';
  if (psnr <= 20) return 'bg-red-100/80 text-red-950 dark:bg-red-950/30 dark:text-red-100';
  if (psnr <= 24) return 'bg-orange-100/80 text-orange-950 dark:bg-orange-950/30 dark:text-orange-100';
  return '';
}
