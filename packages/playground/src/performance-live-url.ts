import type { CameraPose } from './performance-navigation';

export interface LiveUrlState {
  scene: string;
  renderer: string;
  /** A running view starts again when the page reloads. */
  run: boolean;
  /** Only meaningful while `run`: the pose of the running scene. */
  pose?: CameraPose;
}

const vector = (value: string | null) => {
  const numbers = value?.split(',').map(Number);
  return numbers?.length === 3 && numbers.every(Number.isFinite) ? numbers : undefined;
};

/** Unknown or malformed values fall back to the defaults. */
export function parseLiveUrl(search: string, scenes: string[], renderers: string[], defaults: LiveUrlState) {
  const params = new URLSearchParams(search);
  const scene = params.get('scene');
  const renderer = params.get('renderer');
  const position = vector(params.get('camera'));
  const target = vector(params.get('target'));
  return {
    scene: scene && scenes.includes(scene) ? scene : defaults.scene,
    renderer: renderer && renderers.includes(renderer) ? renderer : defaults.renderer,
    run: params.get('run') === '1',
    pose: position && target ? { position, target } : undefined,
  } satisfies LiveUrlState;
}

const round = (values: number[]) => values.map((value) => Number(value.toFixed(4))).join(',');

export function serializeLiveUrl({ scene, renderer, run, pose }: LiveUrlState) {
  const params = new URLSearchParams({ scene, renderer });
  if (run) params.set('run', '1');
  if (run && pose) {
    params.set('camera', round(pose.position));
    params.set('target', round(pose.target));
  }
  return `?${params}`;
}
