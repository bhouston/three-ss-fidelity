// Child process entry of `cli render`: renders scenes with one renderer. Each GPU backend (dawn, ANGLE) gets its own
// process, and dawn keeps the event loop alive, so the process exits explicitly.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { PassName, RendererName } from '@ss-fidelity/renderers';

export interface RenderJob {
  renderer: RendererName;
  scenes: string[];
  passes: PassName[];
  outDir: string;
  /** Screen-space renderer frames; defaults to each scene's effects.frames. */
  frames?: number;
  /** three-gpu-pathtracer samples. */
  samples: number;
  /**
   * Temporal evaluation: the camera orbits the scene target by `degrees` (about world Y) back to the scene's pose over
   * `moveFrames` rendered frames, then stays still. One image per entry of `captures` (frames at rest after arriving;
   * 0 = the arrival frame) is written as `<renderer>@m<frames>.avif`. Replaces the usual single image.
   */
  /** Screen-space renderers: NewSSRNode's debug view instead of the image, written as `<renderer>@<ssrDebug>.avif`. */
  ssrDebug?: 'hits' | 'hitcolor';
  motion?: { degrees: number; moveFrames: number; captures: number[]; object?: { name: string; dx: number } };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Replaces Math.random with a fixed-seed generator (mulberry32): every render is reproducible. */
function seedRandom(seed = 1): void {
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The only WebGL renderer left: everything else, including both path tracers, runs on WebGPURenderer. */
function usesWebGL(renderer: RendererName): boolean {
  return renderer === 'three-gpu-pathtracer';
}

/** Path tracers report accumulated samples (job.samples); screen-space renderers report accumulated frames. */
function usesSamples(renderer: RendererName): boolean {
  return renderer === 'three-gpu-pathtracer' || renderer === 'three-gpu-pathtracer-webgpu';
}

async function main(job: RenderJob): Promise<void> {
  const screenSpace = !usesSamples(job.renderer);
  const headless = usesWebGL(job.renderer) ? await import('./headless/webgl.js') : await import('./headless/webgpu.js');
  headless.install();
  const { createRenderer, passEffects } = await import('@ss-fidelity/renderers');
  const { getScene } = await import('@ss-fidelity/scenes');
  const { createNodeSceneContext } = await import('@ss-fidelity/scenes/node');
  const { renderPath } = await import('./paths.js');
  const { RESULT_AVIF } = await import('./compare.js');
  const ctx = createNodeSceneContext();

  for (const name of job.scenes) {
    for (const pass of job.passes) {
      await render(name, pass);
    }
  }

  async function render(name: string, pass: PassName): Promise<void> {
    const { width, height, create } = getScene(name);
    const start = performance.now();
    seedRandom(); // before the scene and renderer draw any random numbers
    const setup = await create(ctx);
    const canvas = headless.createCanvas(width, height);
    const renderer = await createRenderer(job.renderer, canvas, setup, { width, height, pass, ssrDebug: job.ssrDebug });
    if (job.motion) return renderMotion(name, pass, setup, renderer, canvas, job.outDir, job.motion);
    const target = screenSpace ? (job.frames ?? passEffects(setup, pass).frames) : job.samples;
    const renderStart = performance.now();
    while (renderer.frames < target) {
      headless.animationFrame();
      renderer.render();
      await new Promise((resolve) => setImmediate(resolve)); // lets async shader compilation progress
    }
    const pixels = await headless.readPixels(canvas);
    const renderMs = performance.now() - renderStart;
    const file = renderPath(name, pass, job.ssrDebug ? `${job.renderer}@${job.ssrDebug}` : job.renderer, job.outDir);
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .avif(RESULT_AVIF)
      .toFile(file);
    renderer.dispose();
    console.log(
      `${name} | ${pass} | ${job.renderer}: ${target} ${screenSpace ? 'frames' : 'samples'} in ${seconds(renderMs)} (setup ${seconds(renderStart - start)}) -> ${path.relative(process.cwd(), file)}`,
    );
  }
}

/** See {@link RenderJob.motion}. */
async function renderMotion(
  name: string,
  pass: PassName,
  // oxlint-disable-next-line typescript/no-explicit-any
  setup: any,
  // oxlint-disable-next-line typescript/no-explicit-any
  renderer: any,
  canvas: HTMLCanvasElement,
  outDir: string,
  { degrees, moveFrames, captures, object }: NonNullable<RenderJob['motion']>,
): Promise<void> {
  const headless = await import('./headless/webgpu.js');
  const { renderPath } = await import('./paths.js');
  const { RESULT_AVIF } = await import('./compare.js');
  const { camera, target } = setup;
  const offset = camera.position.clone().sub(target);
  const quaternion = camera.quaternion.clone();
  const { Quaternion, Vector3 } = await import('three');
  const up = new Vector3(0, 1, 0);
  // optionally, a named object also slides back to its home position by `dx` along world x (ghosting test)
  const moving = object ? setup.scene.getObjectByName(object.name) : undefined;
  if (object && !moving) throw new Error(`${name}: no object named "${object.name}"`);
  const home = moving?.position.x;
  const pose = (angle: number, t: number) => {
    if (moving) {
      moving.position.x = home! + object!.dx * t;
      moving.updateMatrixWorld();
    }
    const turn = new Quaternion().setFromAxisAngle(up, angle);
    camera.position.copy(offset).applyQuaternion(turn).add(target);
    camera.quaternion.copy(turn).multiply(quaternion);
    camera.updateMatrixWorld();
    renderer.setCamera(camera);
  };
  const start = performance.now();
  const last = Math.max(...captures);
  for (let f = -moveFrames; f <= last; f++) {
    // smoothstep ease-in/out from `degrees` to 0, reaching the reference pose exactly at f = 0
    const t = Math.min(1, Math.max(0, -f / moveFrames));
    const eased = t * t * (3 - 2 * t);
    pose(((degrees * Math.PI) / 180) * eased, eased);
    headless.animationFrame();
    renderer.render();
    await new Promise((resolve) => setImmediate(resolve));
    if (!captures.includes(f)) continue;
    const file = renderPath(name, pass, `${renderer.name}@m${f}`, outDir);
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(await headless.readPixels(canvas), { raw: { width: canvas.width, height: canvas.height, channels: 4 } })
      .removeAlpha()
      .avif(RESULT_AVIF)
      .toFile(file);
  }
  renderer.dispose();
  console.log(
    `${name} | ${pass} | ${renderer.name}: motion ${degrees}° over ${moveFrames} frames in ${seconds(performance.now() - start)}`,
  );
}

try {
  await main(JSON.parse(process.argv[2]!) as RenderJob);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
