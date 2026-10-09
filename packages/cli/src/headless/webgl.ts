// Headless WebGL2 (ANGLE via @onirenaud/node-webgl).
import { requireHardwareGPU } from './hardware.js';
import { createCanvas as createWebGLCanvas, installDOM } from '@onirenaud/node-webgl';

/** Installs the DOM shims (window, document, Image, ...); must run before three is imported. */
export function install(): void {
  installDOM();
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = createWebGLCanvas(width, height);
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  const extension = gl?.getExtension('WEBGL_debug_renderer_info');
  const description = gl ? String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)) : '';
  requireHardwareGPU(description);
  return canvas as unknown as HTMLCanvasElement;
}

/** RGBA8, top row first. */
export async function readPixels(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const { data } = (canvas as unknown as ReturnType<typeof createWebGLCanvas>).getImageData();
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** WebGL renderers here don't use the animation loop. */
export function animationFrame(_time?: number): void {}
