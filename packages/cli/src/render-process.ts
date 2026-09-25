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
  /** three-ss frames; defaults to each scene's effects.frames. */
  frames?: number;
  /** three-gpu-pathtracer samples. */
  samples: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function main(job: RenderJob): Promise<void> {
  const headless =
    job.renderer === 'three-ss' ? await import('./headless/webgpu.js') : await import('./headless/webgl.js');
  headless.install();
  const { createRenderer, passEffects } = await import('@ss-fidelity/renderers');
  const { getScene } = await import('@ss-fidelity/scenes');
  const { createNodeSceneContext } = await import('@ss-fidelity/scenes/node');
  const { renderPath } = await import('./paths.js');
  const ctx = createNodeSceneContext();

  for (const name of job.scenes) {
    for (const pass of job.passes) {
      await render(name, pass);
    }
  }

  async function render(name: string, pass: PassName): Promise<void> {
    const { width, height, create } = getScene(name);
    const start = performance.now();
    const setup = await create(ctx);
    const canvas = headless.createCanvas(width, height);
    const renderer = await createRenderer(job.renderer, canvas, setup, { width, height, pass });
    await headless.ready();
    const target = job.renderer === 'three-ss' ? (job.frames ?? passEffects(setup, pass).frames) : job.samples;
    const renderStart = performance.now();
    while (renderer.frames < target) {
      renderer.render();
      await new Promise((resolve) => setImmediate(resolve)); // lets async shader compilation progress
    }
    const pixels = await headless.readPixels(canvas);
    const renderMs = performance.now() - renderStart;
    const file = renderPath(name, pass, job.renderer, job.outDir);
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .png()
      .toFile(file);
    renderer.dispose();
    console.log(
      `${name} | ${pass} | ${job.renderer}: ${target} ${job.renderer === 'three-ss' ? 'frames' : 'samples'} in ${seconds(renderMs)} (setup ${seconds(renderStart - start)}) -> ${path.relative(process.cwd(), file)}`,
    );
  }
}

try {
  await main(JSON.parse(process.argv[2]!) as RenderJob);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
