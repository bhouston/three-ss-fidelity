import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Vector3 } from 'three';
import type { SceneInstance } from '@three-fidelity/scenes';
import type { LiveRenderer } from '@three-fidelity/renderers';

export interface CameraPose {
  position: number[];
  target: number[];
}
export interface NavigationOptions {
  /** Start from this pose instead of the scene's default camera. */
  initial?: CameraPose;
  onChange?(pose: CameraPose): void;
}

export function createNavigation(
  setup: SceneInstance,
  live: LiveRenderer,
  canvas: HTMLCanvasElement,
  { initial, onChange }: NavigationOptions = {},
) {
  const controls = new OrbitControls(setup.camera, canvas);
  if (initial) setup.camera.position.fromArray(initial.position);
  controls.target.fromArray(initial?.target ?? setup.target.toArray());
  controls.enableDamping = true;
  controls.update();
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Interactive 3D view. Drag to orbit, scroll to zoom, WASD or arrow keys to move.');
  const keys = new Set<string>();
  const directions = ['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'];
  const keydown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (!directions.includes(key)) return;
    event.preventDefault();
    keys.add(key);
  };
  const keyup = (event: KeyboardEvent) => {
    keys.delete(event.key.toLowerCase());
  };
  const clear = () => keys.clear();
  const focus = () => canvas.focus({ preventScroll: true });
  const changed = () => {
    live.setCamera(setup.camera);
    onChange?.({ position: setup.camera.position.toArray(), target: controls.target.toArray() });
  };
  canvas.addEventListener('keydown', keydown);
  canvas.addEventListener('keyup', keyup);
  canvas.addEventListener('blur', clear);
  canvas.addEventListener('pointerdown', focus);
  window.addEventListener('blur', clear);
  controls.addEventListener('change', changed);
  const forward = new Vector3();
  const right = new Vector3();
  const movement = new Vector3();
  const speed = Math.max(0.1, setup.camera.position.distanceTo(controls.target) * 0.5);
  return {
    update(deltaSeconds: number) {
      const longitudinal =
        Number(keys.has('w') || keys.has('arrowup')) - Number(keys.has('s') || keys.has('arrowdown'));
      const lateral = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'));
      if (longitudinal || lateral) {
        setup.camera.getWorldDirection(forward);
        right.crossVectors(forward, setup.camera.up).normalize();
        movement
          .copy(forward)
          .multiplyScalar(longitudinal)
          .addScaledVector(right, lateral)
          .normalize()
          .multiplyScalar(speed * Math.min(deltaSeconds, 0.1));
        setup.camera.position.add(movement);
        controls.target.add(movement);
      }
      controls.update();
    },
    dispose() {
      controls.removeEventListener('change', changed);
      controls.dispose();
      canvas.removeEventListener('keydown', keydown);
      canvas.removeEventListener('keyup', keyup);
      canvas.removeEventListener('blur', clear);
      canvas.removeEventListener('pointerdown', focus);
      window.removeEventListener('blur', clear);
    },
  };
}
