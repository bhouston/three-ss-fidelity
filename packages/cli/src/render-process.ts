// Child process entry of `cli render`: renders scenes with one renderer. Each GPU backend (dawn, ANGLE) gets its own
// process, and dawn keeps the event loop alive, so the process exits explicitly.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { capture, seededRandom } from '@ss-fidelity/runtime';
import type { HierarchyExperiment, RendererName } from '@ss-fidelity/renderers';

/** A renderer job can also target Blender Cycles, a second ground-truth renderer that isn't a `LiveRenderer`
 * (it renders in one batch call via `renderBlender`, not `createRenderer`'s incremental frame loop). */
export type JobRendererName = RendererName | 'blender';

export interface RenderJob {
  hierarchyExperiment?: HierarchyExperiment;
  /** Override native scene dimensions for resolution-dependent experiments. */
  width?: number;
  height?: number;
  renderer: JobRendererName;
  scenes: string[];
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
  Math.random = seededRandom(seed);
}

/** The only WebGL renderers: everything else runs on WebGPURenderer. Blender needs
 * a WebGL canvas too, only to bake `setup.environment` into a cube map before exporting it as an equirect EXR. */
function usesWebGL(renderer: JobRendererName): boolean {
  return renderer === 'three-gpu-pathtracer' || renderer === 'blender';
}

/** Path tracers report accumulated samples (job.samples); screen-space renderers report accumulated frames. */
function usesSamples(renderer: JobRendererName): boolean {
  return renderer === 'three-gpu-pathtracer';
}

async function main(job: RenderJob): Promise<void> {
  const screenSpace = !usesSamples(job.renderer);
  const headless = usesWebGL(job.renderer) ? await import('./headless/webgl.js') : await import('./headless/webgpu.js');
  headless.install();
  const { createRenderer, hierarchyImageName, completeRenderer, createRendererFrameDriver } =
    await import('@ss-fidelity/renderers');
  const { getScene, disposeSceneSetup } = await import('@ss-fidelity/scenes');
  const { createNodeSceneContext } = await import('@ss-fidelity/scenes/node');
  const { renderPath } = await import('./paths.js');
  const { RESULT_AVIF } = await import('./compare.js');
  const ctx = createNodeSceneContext();
  const outputName = hierarchyImageName(job.renderer, job.hierarchyExperiment);

  for (const name of job.scenes) await render(name);

  async function render(name: string): Promise<void> {
    const definition = getScene(name);
    const { create } = definition;
    const width = job.width ?? definition.width;
    const height = job.height ?? definition.height;
    if (![width, height].every((size) => Number.isInteger(size) && size > 0)) {
      throw new Error('Render dimensions must be positive integers');
    }
    const start = performance.now();
    seedRandom(); // before the scene and renderer draw any random numbers
    const setup = await create(ctx);
    const canvas = headless.createCanvas(width, height);
    if (job.renderer === 'blender') return renderBlenderJob(name, setup, canvas, width, height, start);
    const renderer = await createRenderer(job.renderer, canvas, setup, {
      width,
      height,
      ssrDebug: job.ssrDebug,
      hierarchyExperiment: job.hierarchyExperiment,
    });
    if (job.motion) return renderMotion(name, setup, renderer, canvas, job.outDir, job.motion, outputName);
    const target = screenSpace ? (job.frames ?? setup.effects.frames) : job.samples;
    const renderStart = performance.now();
    const advance = createRendererFrameDriver(renderer.renderer);
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error('Render cancelled by SIGINT'));
    const terminate = () => controller.abort(new Error('Render cancelled by SIGTERM'));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    let pixels: Uint8Array;
    try {
      pixels = await capture(
        {
          pipeline: renderer,
          beforeFrame: advance,
          complete: () => completeRenderer(renderer.renderer),
          dispose() {},
        },
        {
          frames: Math.ceil(target),
          accumulated: job.renderer === 'three-gpu-pathtracer' ? { count: () => renderer.frames } : undefined,
        },
        () => headless.readPixels(canvas),
        {
          yield: () => new Promise((resolve) => setImmediate(resolve)),
        },
        controller.signal,
      );
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      renderer.dispose();
      disposeSceneSetup(setup);
    }
    const renderMs = performance.now() - renderStart;
    const file = renderPath(name, job.ssrDebug ? `${outputName}@${job.ssrDebug}` : outputName, job.outDir);
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .avif(RESULT_AVIF)
      .toFile(file);
    console.log(
      `${name} | ${outputName}: ${target} ${screenSpace ? 'frames' : 'samples'} in ${seconds(renderMs)} (setup ${seconds(renderStart - start)}) -> ${path.relative(process.cwd(), file)}`,
    );
  }

  /** Blender is a single batch render, not a `LiveRenderer` with an incremental frame loop: its own branch. */
  // oxlint-disable-next-line typescript/no-explicit-any -- headless SceneSetup import is dynamic (see main())
  async function renderBlenderJob(
    name: string,
    setup: any,
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    start: number,
  ): Promise<void> {
    if (job.motion) throw new Error('blender: --motion is not supported');
    if (job.ssrDebug) throw new Error('blender: --ssr-debug is not supported');
    const { renderScene, exportEnvironment, outputSettings } = await import('fidelity-kit-blender/three');
    const { bakeEnvironment } = await import('fidelity-kit-three-gpu-pathtracer');
    const { WebGLRenderer } = await import('three');
    const renderStart = performance.now();
    // Procedural environments are suite scene data: explicitly bake the same IBL as the path tracer.
    const baker = new WebGLRenderer({ canvas });
    let environment;
    try {
      const texture = setup.environment ? bakeEnvironment(baker, setup.environment.scene) : null;
      if (texture) {
        try {
          environment = {
            bytes: await exportEnvironment(texture),
            intensity: setup.scene.environmentIntensity,
            rotation: setup.scene.environmentRotation.toArray().slice(0, 3) as [number, number, number],
          };
        } finally {
          texture.dispose();
        }
      }
    } finally {
      baker.dispose();
    }
    const gradient = setup.gradientBackground;
    const result = await renderScene({
      scene: setup.scene,
      camera: setup.camera,
      width,
      height,
      samples: job.samples,
      bounces: 8,
      environment,
      background: gradient
        ? { type: 'gradient', center: gradient.center.toArray(), edge: gradient.edge.toArray() }
        : setup.scene.background === null
          ? { type: 'color', color: [0, 0, 0] }
          : undefined,
      ...outputSettings({ ...setup.effects, outputColorSpace: 'srgb' }),
      // Existing suite references omit ambient light and approximate unsupported glTF features.
      unsupported: 'warn',
    });
    const pixels = result.pixels;
    const renderMs = performance.now() - renderStart;
    const file = renderPath(name, 'blender', job.outDir);
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .avif(RESULT_AVIF)
      .toFile(file);
    console.log(
      `${name} | blender: ${job.samples} samples in ${seconds(renderMs)} (setup ${seconds(renderStart - start)}) -> ${path.relative(process.cwd(), file)}`,
    );
  }
}

/** See {@link RenderJob.motion}. */
async function renderMotion(
  name: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  setup: any,
  // oxlint-disable-next-line typescript/no-explicit-any
  renderer: any,
  canvas: HTMLCanvasElement,
  outDir: string,
  { degrees, moveFrames, captures, object }: NonNullable<RenderJob['motion']>,
  outputName: string,
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
    const file = renderPath(name, `${outputName}@m${f}`, outDir);
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(await headless.readPixels(canvas), { raw: { width: canvas.width, height: canvas.height, channels: 4 } })
      .removeAlpha()
      .avif(RESULT_AVIF)
      .toFile(file);
  }
  renderer.dispose();
  console.log(
    `${name} | ${outputName}: motion ${degrees}° over ${moveFrames} frames in ${seconds(performance.now() - start)}`,
  );
}

try {
  await main(JSON.parse(process.argv[2]!) as RenderJob);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
