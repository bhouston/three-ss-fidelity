#!/usr/bin/env node
// GPU ablations for literature-informed SSR history reconstruction. Each case/profile gets a fresh
// process (issue #25); frame indices, seed, camera/object path and lossless PNG captures are identical.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const sharp = createRequire(path.join(root, 'packages/cli/package.json'))('sharp');

async function worker(job) {
  const headless = await import('../packages/cli/dist/headless/webgpu.js');
  headless.install();
  const { seededRandom } = await import('../packages/runtime/dist/index.js');
  Math.random = seededRandom(1);
  const { getScene, disposeSceneSetup } = await import('../packages/scenes/dist/index.js');
  const { createNodeSceneContext } = await import('../packages/scenes/dist/node.js');
  const { createRenderer, createRendererFrameDriver, completeRenderer } =
    await import('../packages/renderers/dist/index.js');
  const definition = getScene(job.scene);
  const width = Math.max(1, Math.round(definition.width * (job.scale ?? 1)));
  const height = Math.max(1, Math.round(definition.height * (job.scale ?? 1)));
  const setup = await definition.create(createNodeSceneContext());
  const canvas = headless.createCanvas(width, height);
  const live = await createRenderer('three-new', canvas, setup, { width, height, ssrTemporalProfile: job.profile });
  const advance = createRendererFrameDriver(live.renderer);
  const offset = setup.camera.position.clone().sub(setup.target);
  const quaternion = setup.camera.quaternion.clone();
  const up = offset.clone().set(0, 1, 0);
  const object = job.object ? setup.scene.getObjectByName(job.object.name) : undefined;
  if (job.object && !object) throw new Error(`Missing object ${job.object.name}`);
  const home = object?.position.x;
  const pose = (t) => {
    const turn = quaternion.clone().setFromAxisAngle(up, ((job.degrees * Math.PI) / 180) * t);
    setup.camera.position.copy(offset).applyQuaternion(turn).add(setup.target);
    setup.camera.quaternion.copy(turn).multiply(quaternion);
    setup.camera.updateMatrixWorld();
    if (object) {
      object.position.x = home + job.object.dx * t;
      object.updateMatrixWorld();
    }
    live.setCamera(setup.camera);
  };
  const times = [];
  let frameIndex = 0;
  const frame = async () => {
    advance({ frameIndex: frameIndex++, timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60 });
    const start = performance.now();
    live.render();
    await completeRenderer(live.renderer);
    times.push(performance.now() - start);
    await new Promise((resolve) => setImmediate(resolve));
  };
  await mkdir(job.dir, { recursive: true });
  try {
    pose(1);
    for (let i = 0; i < job.warmup; i++) await frame();
    times.length = 0; // shader compilation and cold history excluded from timing
    for (let f = -job.moveFrames; f <= 128; f++) {
      const t = Math.max(0, -f / job.moveFrames);
      pose(t * t * (3 - 2 * t));
      await frame();
      if ((f >= -16 && f <= 0) || [1, 4, 16, 64].includes(f) || f >= 112) {
        await sharp(await headless.readPixels(canvas), { raw: { width, height, channels: 4 } })
          .removeAlpha()
          .png()
          .toFile(path.join(job.dir, `${f}.png`));
      }
    }
    times.sort((a, b) => a - b);
    await writeFile(
      path.join(job.dir, 'run.json'),
      JSON.stringify(
        {
          ...job,
          width,
          height,
          renderAndCompletionMs: {
            median: times[Math.floor(times.length / 2)],
            p95: times[Math.floor(times.length * 0.95)],
          },
        },
        null,
        2,
      ),
    );
  } finally {
    live.dispose();
    disposeSceneSetup(setup);
  }
}

if (process.argv[2] === '--worker') {
  try {
    await worker(JSON.parse(process.argv[3]));
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.output/ssr-temporal' },
    scenes: { type: 'string', default: 'diag-mirror,diag-rough-30,diag-rough-60,steampunk-camera' },
    profiles: { type: 'string', default: 'baseline,validated,gaussian' },
    'reference-root': { type: 'string', default: 'fidelity-results' },
    'move-frames': { type: 'string', default: '60' },
    warmup: { type: 'string', default: '64' },
    scale: { type: 'string', default: '1' },
    ghost: { type: 'boolean', default: false },
  },
});
const moveFrames = Number(values['move-frames']);
const warmup = Number(values.warmup);
const scale = Number(values.scale);
if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error('scale must be in (0,1]');
if (!Number.isInteger(moveFrames) || moveFrames < 16 || !Number.isInteger(warmup) || warmup < 1)
  throw new Error('move-frames must be >=16; warmup must be a positive integer');
const profiles = values.profiles.split(',');
if (profiles.some((p) => !['baseline', 'validated', 'gaussian'].includes(p))) throw new Error('Unknown profile');
const out = path.resolve(root, values.out);
await mkdir(out, { recursive: true });
const { compareRgb, readRgb } = await import('../packages/cli/dist/compare.js');
const { meanBias } = await import('../packages/cli/dist/converge.js');
const report = {
  metadata: {
    moveFrames,
    warmup,
    seed: 1,
    scale,
    captureFormat: 'lossless PNG',
    limitations:
      'Moving captures are visual diagnostics. Frame differences during motion are not noise metrics. Reference PSNR is measured only at the matching final pose; scale<1 resizes the reference and is a preliminary diagnostic, not a native-resolution accuracy gate. Timing includes GPU completion, not readback; it is not a timestamp profile.',
  },
  cases: [],
};
for (const scene of values.scenes.split(',')) {
  const referencePath = path.resolve(root, values['reference-root'], scene, 'beauty/three-gpu-pathtracer.avif');
  let reference = await readRgb(referencePath); // fail early on missing references
  if (scale !== 1) {
    const { data, info } = await sharp(reference.data, {
      raw: { width: reference.width, height: reference.height, channels: 3 },
    })
      .resize(Math.max(1, Math.round(reference.width * scale)), Math.max(1, Math.round(reference.height * scale)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    reference = { data, width: info.width, height: info.height };
  }
  for (const profile of profiles) {
    const job = {
      scene,
      profile,
      dir: path.join(out, scene, profile),
      moveFrames,
      warmup,
      scale,
      degrees: values.ghost ? 0 : 20,
      ...(values.ghost ? { object: { name: 'sphere-green', dx: 1.5 } } : {}),
    };
    console.log(`${scene}: ${profile}${values.ghost ? ' (object motion)' : ''}`);
    const log = [];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', JSON.stringify(job)], {
        cwd: root,
      });
      child.stdout.on('data', (c) => log.push(c));
      child.stderr.on('data', (c) => log.push(c));
      child.on('error', reject);
      child.on('close', resolve);
    });
    await writeFile(path.join(out, `${scene}-${profile}.log`), Buffer.concat(log));
    if (code !== 0) throw new Error(`GPU case failed (${code}); see ${scene}-${profile}.log`);
    const captures = [];
    for (const frame of [0, 1, 4, 16, 64, 128]) {
      const image = await readRgb(path.join(job.dir, `${frame}.png`));
      captures.push({ frame, psnr: compareRgb(reference, image).metrics.psnr, bias: meanBias(reference, image) });
    }
    const still = await Promise.all(
      Array.from({ length: 17 }, (_, i) => readRgb(path.join(job.dir, `${112 + i}.png`))),
    );
    // Same pose throughout: temporal standard deviation is meaningful here, unlike moving frames.
    const deviations = Float64Array.from(still[0].data, (_, p) => {
      const mean = still.reduce((sum, img) => sum + img.data[p], 0) / still.length;
      return Math.sqrt(still.reduce((sum, img) => sum + (img.data[p] - mean) ** 2, 0) / still.length);
    });
    const sorted = deviations.toSorted();
    report.cases.push({
      scene,
      profile,
      captures,
      settledStdDev255: {
        mean: deviations.reduce((a, b) => a + b, 0) / deviations.length,
        p95: sorted[Math.floor(sorted.length * 0.95)],
      },
      run: JSON.parse(await readFile(path.join(job.dir, 'run.json'), 'utf8')),
    });
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    // Contact strip shows the last moving frames, arrival and recovery without lossy compression.
    const frames = [-16, -8, -1, 0, 16, 128];
    await sharp({
      create: { width: reference.width * frames.length, height: reference.height, channels: 3, background: 'black' },
    })
      .composite(frames.map((f, i) => ({ input: path.join(job.dir, `${f}.png`), left: i * reference.width, top: 0 })))
      .png()
      .toFile(path.join(job.dir, 'strip.png'));
  }
}
console.log(`Report: ${path.join(out, 'report.json')}`);
