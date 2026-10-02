import './style.css';
import { LiveStartup } from './startup';
import type { StartupSnapshot } from './startup';
import { resetStartup, showStartup } from './startup-view';
import { createUrlStateWriter } from './url-state';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createBrowserSceneContext,
  createOrbitWorkload,
  disposeSceneSetup,
  getScene,
  listSceneNames,
} from '@ss-fidelity/scenes';
import type { SceneSetup } from '@ss-fidelity/scenes';
import {
  completeRenderer,
  createRenderer,
  createRendererFrameDriver,
  createRendererStartupProfiler,
  hierarchyExperiments,
  rendererNames,
} from '@ss-fidelity/renderers';
import type { HierarchyExperiment, LiveRenderer, RendererName } from '@ss-fidelity/renderers';
import {
  benchmark,
  capture,
  compareEntries,
  parseReport,
  reportHtml,
  seededRandom,
  statistics,
  validateBenchmarkOptions,
} from '@ss-fidelity/runtime';
import type { BenchmarkOptions, BenchmarkReport, FrameContext, RenderSession, ReportEntry } from '@ss-fidelity/runtime';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const select = (id: string) => element<HTMLSelectElement>(id);
const value = (id: string) => Number(input(id).value);
const message = (text: string, error = false) => {
  element('message').textContent = text;
  element('message').classList.toggle('error', error);
};
const option = (id: string, label: string, content = label) => {
  const item = document.createElement('option');
  item.value = label;
  item.textContent = content;
  select(id).append(item);
};
for (const scene of listSceneNames()) option('scene', scene);
for (const renderer of rendererNames) option('renderer', renderer);
for (const experiment of hierarchyExperiments) option('experiment', experiment);
const params = new URLSearchParams(location.search);
select('scene').value =
  params.get('scene') && listSceneNames().includes(params.get('scene')!) ? params.get('scene')! : 'ssgi-basic';
select('renderer').value =
  params.get('renderer') && rendererNames.includes(params.get('renderer') as RendererName)
    ? params.get('renderer')!
    : 'three-new';

const stateIds = [
  'scene',
  'renderer',
  'experiment',
  'width',
  'height',
  'live-gpu',
  'protocol',
  'motion',
  'duration',
  'repeats',
  'warmup',
  'seed',
  'compare',
];
for (const id of stateIds) {
  const node = element<HTMLInputElement | HTMLSelectElement>(id);
  const saved = params.get(id);
  if (saved === null) continue;
  if (node instanceof HTMLInputElement && node.type === 'checkbox') node.checked = saved === '1';
  else if (!(node instanceof HTMLSelectElement) || [...node.options].some((item) => item.value === saved))
    node.value = saved;
}
function vectorParam(name: string): number[] | undefined {
  const values = params.get(name)?.split(',').map(Number);
  return values?.length === 3 && values.every(Number.isFinite) ? values : undefined;
}
let savedScene = select('scene').value;
let savedPosition = vectorParam('camera');
let savedTarget = vectorParam('target');
function saveState(mode: 'push' | 'replace') {
  const next = new URLSearchParams();
  for (const id of stateIds) {
    const node = element<HTMLInputElement | HTMLSelectElement>(id);
    next.set(
      id,
      node instanceof HTMLInputElement && node.type === 'checkbox' ? (node.checked ? '1' : '0') : node.value,
    );
  }
  // The previous scene can still emit OrbitControls changes before the next load.
  if (savedScene === select('scene').value) {
    if (savedPosition) next.set('camera', savedPosition.join(','));
    if (savedTarget) next.set('target', savedTarget.join(','));
  }
  const url = `?${next}`;
  if (url === location.search) return;
  history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url + location.hash);
}
const urlState = createUrlStateWriter(saveState);
for (const id of stateIds)
  element(id).addEventListener('input', () => {
    if (id === 'scene') {
      savedPosition = undefined;
      savedTarget = undefined;
    }
    urlState.settings();
  });
window.addEventListener('popstate', () => {
  urlState.cancel();
  // Reuse startup restoration for every setting, the scene, and the camera pose.
  location.reload();
});

const ctx = createBrowserSceneContext('/');
let active:
  | {
      session: RenderSession;
      live: LiveRenderer;
      setup: SceneSetup;
      canvas: HTMLCanvasElement;
      advance(frame: FrameContext): void;
    }
  | undefined;
let controls: OrbitControls | undefined;
let animation = 0;
let controller: AbortController | undefined;
let report: BenchmarkReport | undefined;
let reportUrl: string | undefined;
let busy = false;
let interactiveIndex = 0;
let previousTime = 0;
let intervalFrames = 0;
let intervalStart = 0;
const rollingIntervals: number[] = [];
const rollingCpu: number[] = [];
const rollingPasses = new Map<string, Map<number, number>>();
let resolvingLiveGpu = false;
let lastInstrumentUpdate = 0;
let gpuError = '';
let startupCapture: LiveStartup | undefined;
let startupSnapshot: StartupSnapshot | undefined;
let startupLoadId = 0;
let initialLoad = true;

function resetInstruments() {
  rollingIntervals.length = 0;
  rollingCpu.length = 0;
  rollingPasses.clear();
  resolvingLiveGpu = false;
  gpuError = '';
  lastInstrumentUpdate = 0;
  for (const id of ['gauge-fps', 'gauge-mean', 'gauge-p95', 'gauge-cpu']) element(id).textContent = '—';
  element('live-passes').replaceChildren();
}
function instrument(time: number, interval: number, cpu: number) {
  if (interval > 0) rollingIntervals.push(interval);
  rollingCpu.push(cpu);
  if (rollingIntervals.length > 120) rollingIntervals.shift();
  if (rollingCpu.length > 120) rollingCpu.shift();
  const current = active;
  const profiler = current?.live.profiler;
  if (profiler?.status === 'supported' && !resolvingLiveGpu && !gpuError) {
    resolvingLiveGpu = true;
    void profiler
      .resolve()
      .then((samples) => {
        if (active !== current) return;
        for (const sample of samples) {
          if (sample.metric === 'gpu.pass-sum') continue; // different query streams may resolve different frame ranges
          const values = rollingPasses.get(sample.metric) ?? new Map<number, number>();
          values.set(sample.frame, (values.get(sample.frame) ?? 0) + sample.value);
          while (values.size > 120) values.delete(values.keys().next().value!);
          rollingPasses.set(sample.metric, values);
        }
      })
      .catch((error) => {
        if (active === current) gpuError = String(error);
      })
      .finally(() => {
        if (active === current) resolvingLiveGpu = false;
      });
  }
  if (time - lastInstrumentUpdate < 250) return;
  lastInstrumentUpdate = time;
  const bake = current?.live.lightBake;
  element('bake-status').hidden = !bake;
  element('bake-status').textContent = bake
    ? bake.phase === 'converged'
      ? 'Indirect lighting baked'
      : `Baking indirect lighting · ${Math.round(bake.progress * 100)}%`
    : '';
  if (rollingIntervals.length) {
    const timing = statistics(rollingIntervals);
    element('gauge-fps').textContent = (1000 / timing.mean).toFixed(1);
    element('gauge-mean').textContent = `${timing.mean.toFixed(2)} ms`;
    element('gauge-p95').textContent = `${timing.p95.toFixed(2)} ms`;
  }
  element('gauge-cpu').textContent = `${statistics(rollingCpu).mean.toFixed(2)} ms`;
  element('instrument-status').textContent =
    `Last ${rollingIntervals.length}/120 frames · ` +
    (gpuError
      ? `GPU unavailable: ${gpuError}`
      : !profiler
        ? 'GPU off'
        : profiler.status === 'unsupported'
          ? (profiler.reason ?? 'GPU unsupported')
          : `GPU sampled asynchronously · ${profiler.invalidSamples} invalid`);
  const body = element('live-passes');
  body.replaceChildren();
  const passes = [...rollingPasses]
    .map(([id, values]) => ({ id, timing: statistics([...values.values()]) }))
    .toSorted((a, b) => b.timing.mean - a.timing.mean);
  for (const pass of passes) {
    const row = document.createElement('tr');
    for (const content of [
      profiler?.metrics.find((metric) => metric.id === pass.id)?.label ?? pass.id,
      pass.timing.mean.toFixed(3),
      pass.timing.p95.toFixed(3),
      String(pass.timing.n),
    ]) {
      const cell = document.createElement('td');
      cell.textContent = content;
      row.append(cell);
    }
    body.append(row);
  }
}

function lock(locked: boolean) {
  busy = locked;
  for (const node of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    'aside input, aside select, aside button',
  )) {
    node.disabled = locked;
  }
  element<HTMLButtonElement>('cancel').disabled = !controller;
  element<HTMLButtonElement>('json').disabled = locked || !report;
  element<HTMLButtonElement>('html').disabled = locked || !report;
}
function stop() {
  startupCapture?.stop();
  cancelAnimationFrame(animation);
  controls?.dispose();
  controls = undefined;
  active?.session.dispose();
  active = undefined;
}
function nextFrame(signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cancelAnimationFrame(id);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('Cancelled'));
    };
    const id = requestAnimationFrame((time) => {
      signal?.removeEventListener('abort', abort);
      if (document.hidden) reject(new Error('Benchmark interrupted: tab is hidden'));
      else resolve(time);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function configuration() {
  const width = value('width'),
    height = value('height'),
    seed = value('seed');
  if (![width, height].every((size) => Number.isSafeInteger(size) && size > 0))
    throw new Error('Dimensions must be positive integers');
  if (!Number.isSafeInteger(seed)) throw new Error('Seed must be an integer');
  return {
    scene: select('scene').value,
    renderer: select('renderer').value as RendererName,
    experiment: select('experiment').value as HierarchyExperiment,
    width,
    height,
    seed,
  };
}
async function session(
  config: ReturnType<typeof configuration>,
  profile: boolean,
  motion: 'static' | 'orbit',
  startup?: LiveStartup,
) {
  const originalRandom = Math.random;
  const random = seededRandom(config.seed);
  Math.random = random;
  let setup: SceneSetup | undefined;
  let live: LiveRenderer | undefined;
  try {
    setup = startup
      ? await startup.measure('scene', () => getScene(config.scene).create(ctx))
      : await getScene(config.scene).create(ctx);
    Math.random = originalRandom;
    const canvas = document.createElement('canvas');
    canvas.width = config.width;
    canvas.height = config.height;
    element('viewport').replaceChildren(canvas);
    const create = () =>
      createRenderer(config.renderer, canvas, setup!, {
        width: config.width,
        height: config.height,
        trackTimestamp: profile,
        hierarchyExperiment: config.experiment,
      });
    live = startup ? await startup.measure('renderer', create) : await create();
    const renderer = live;
    const sceneSetup = setup;
    const advance = createRendererFrameDriver(renderer.renderer);
    const orbit = motion === 'orbit' ? createOrbitWorkload(sceneSetup, 120, 30) : undefined;
    let disposed = false;
    const result: RenderSession = {
      pipeline: {
        profiler: renderer.profiler,
        setSize: renderer.setSize.bind(renderer),
        dispose: renderer.dispose.bind(renderer),
        render(frame) {
          // Three allocates texture identities lazily while rendering. Rewinding its global RNG
          // can collide with persistent default textures, so seed scene generation only here.
          renderer.render(frame);
        },
      },
      beforeFrame(frame) {
        advance(frame);
        if (orbit) {
          orbit(frame.index);
          renderer.setCamera(sceneSetup.camera);
        }
      },
      complete: () => completeRenderer(renderer.renderer),
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          renderer.dispose();
        } finally {
          disposeSceneSetup(sceneSetup);
        }
      },
    };
    return { session: result, live: renderer, setup: sceneSetup, canvas, advance };
  } catch (error) {
    live?.dispose();
    if (setup) disposeSceneSetup(setup);
    throw error;
  } finally {
    Math.random = originalRandom;
  }
}
function animate(time: number) {
  if (!active || busy) return;
  try {
    const interval = previousTime ? time - previousTime : 0;
    const frame: FrameContext = {
      index: interactiveIndex++,
      timeSeconds: time / 1000,
      deltaSeconds: previousTime ? (time - previousTime) / 1000 : 1 / 60,
      phase: 'interactive',
    };
    previousTime = time;
    const cpuStart = performance.now();
    controls?.update();
    active.advance(frame);
    active.live.profiler?.beginFrame(frame.index);
    active.session.pipeline.render(frame);
    active.live.profiler?.endFrame();
    const startup = startupCapture;
    if (startup?.isCapturing && startup.rendered() >= 4)
      void startup.finish(() => completeRenderer(active!.live.renderer));
    instrument(time, interval, performance.now() - cpuStart);
    intervalFrames++;
    if (time - intervalStart > 500) {
      element('fps').textContent =
        `${((intervalFrames * 1000) / (time - intervalStart)).toFixed(1)} FPS · display cadence`;
      intervalStart = time;
      intervalFrames = 0;
    }
    animation = requestAnimationFrame(animate);
  } catch (error) {
    startupCapture?.fail(error);
    fail(error);
    stop();
  }
}
function fail(error: unknown) {
  message(error instanceof Error ? error.message : String(error), true);
  element('live-status').textContent = 'Needs attention';
}
async function load() {
  const started = performance.now();
  const pageMs = initialLoad ? started : 0;
  initialLoad = false;
  const loadId = ++startupLoadId;
  startupSnapshot = undefined;
  lock(true);
  stop();
  const cleanupMs = performance.now() - started;
  startupCapture = undefined;
  resetStartup();
  element('startup').dataset.state = 'loading';
  element('startup-status').textContent = 'Loading…';
  element<HTMLButtonElement>('startup-json').disabled = true;
  element('live-status').textContent = 'Loading';
  message('Loading scene assets…');
  let refresh: ReturnType<typeof setInterval> | undefined;
  try {
    const config = configuration();
    const startup = new LiveStartup(
      config.scene,
      config.renderer,
      createRendererStartupProfiler(config.renderer),
      (snapshot) => {
        if (startupLoadId !== loadId) return;
        startupSnapshot = snapshot;
        showStartup(snapshot);
      },
      () => performance.now(),
      started - pageMs,
      pageMs,
      cleanupMs,
      config,
    );
    startupCapture = startup;
    refresh = setInterval(() => {
      if (startupLoadId === loadId) showStartup(startup.snapshot());
    }, 100);
    active = await session(config, input('live-gpu').checked, 'static', startup);
    resetInstruments();
    const restoreCamera = savedScene === config.scene;
    if (restoreCamera && savedPosition) active.setup.camera.position.fromArray(savedPosition);
    controls = new OrbitControls(active.setup.camera, active.canvas);
    controls.target.fromArray((restoreCamera && savedTarget) || active.setup.target.toArray());
    controls.update();
    controls.enableDamping = true;
    controls.addEventListener('change', () => {
      if (!active || !controls) return;
      active.live.setCamera(active.setup.camera);
      savedScene = config.scene;
      savedPosition = active.setup.camera.position.toArray();
      savedTarget = controls.target.toArray();
      urlState.camera();
    });
    element('scene-title').textContent = `${config.scene} / ${config.renderer}`;
    message('Preparing the first frame and waiting for GPU completion…');
    const time = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const firstFrame: FrameContext = { index: 0, timeSeconds: time / 1000, deltaSeconds: 1 / 60, phase: 'interactive' };
    await startup.measure('first-render', () => {
      active!.session.beforeFrame?.(firstFrame);
      active!.live.profiler?.beginFrame(0);
      try {
        active!.session.pipeline.render(firstFrame);
      } finally {
        active!.live.profiler?.endFrame();
      }
      startup.rendered();
    });
    await startup.measure('gpu-wait', () => completeRenderer(active!.live.renderer));
    startup.ready();
    element('live-status').textContent = 'Interactive';
    message(getScene(config.scene).description);
    savedScene = config.scene;
    savedPosition = active.setup.camera.position.toArray();
    savedTarget = controls.target.toArray();
    urlState.camera();
    interactiveIndex = 1;
    previousTime = 0;
    intervalStart = performance.now();
    intervalFrames = 0;
  } catch (error) {
    startupCapture?.fail(error);
    stop();
    element('startup').dataset.state = 'failed';
    element('startup-status').textContent = 'Load failed';
    fail(error);
  } finally {
    clearInterval(refresh);
    lock(false);
    if (active) animation = requestAnimationFrame(animate);
  }
}
function showReport(next: BenchmarkReport) {
  report = next;
  element('empty').hidden = true;
  const iframe = element<HTMLIFrameElement>('report');
  iframe.hidden = false;
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  reportUrl = URL.createObjectURL(new Blob([reportHtml(next)], { type: 'text/html' }));
  iframe.src = reportUrl;
  element('report-id').textContent = `${next.entries.length} workloads · ${next.generatedAt}`;
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function runBenchmark() {
  const config = configuration();
  const repeats = value('repeats');
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('Repeats must be a positive integer');
  if (document.hidden) throw new Error('Keep the benchmark tab visible');
  const motion = select('motion').value as 'static' | 'orbit';
  const compare = input('compare').checked;
  if (compare && config.experiment !== 'baseline')
    throw new Error('Stock comparison requires the baseline experiment; use the CLI for single experimental profiles');
  const names: RendererName[] = compare ? ['three-current', 'three-new'] : [config.renderer];
  const options: BenchmarkOptions = {
    protocol: select('protocol').value as BenchmarkOptions['protocol'],
    durationMs: value('duration') * 1000,
    warmupFrames: value('warmup'),
    batchSize: 20,
    cycleFrames: motion === 'orbit' ? 120 : 1,
    stepSeconds: 1 / 60,
  };
  validateBenchmarkOptions(options);
  controller = new AbortController();
  const signal = controller.signal;
  const hidden = () => {
    if (document.hidden) controller?.abort(new Error('Benchmark interrupted: tab was hidden'));
  };
  document.addEventListener('visibilitychange', hidden);
  lock(true);
  stop();
  resetInstruments();
  element('instrument-status').textContent = 'Paused during repeatable measurement';
  element('live-status').textContent = 'Benchmarking';
  element('fps').textContent = 'Measuring';
  const next: BenchmarkReport = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    environment: { runtime: navigator.userAgent, devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency },
    provenance: {
      source: 'local browser playground',
      randomness: 'seeded scene generation; renderer-native sampling',
      revision: 'unavailable',
      order: 'alternating-renderer-order; fresh session per repetition',
    },
    entries: [],
  };
  try {
    for (let repetition = 0; repetition < repeats; repetition++)
      for (const name of repetition % 2 ? names.toReversed() : names) {
        signal.throwIfAborted();
        message(
          `${name}: repetition ${repetition + 1}/${repeats} · fresh scene, warmup, then ${value('duration')} seconds of measurement`,
        );
        let settings: unknown;
        const run = await benchmark(
          async () => {
            const created = await session({ ...config, renderer: name }, options.protocol === 'profile', motion);
            settings = structuredClone(created.setup.effects);
            return created.session;
          },
          options,
          {
            now: () => performance.now(),
            yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
            nextFrame: () => nextFrame(signal),
          },
          signal,
        );
        const existing = next.entries.find((entry) => entry.renderer === name);
        const entry: ReportEntry = {
          scene: config.scene,
          renderer: name,
          experiment: config.experiment,
          workload: {
            width: config.width,
            height: config.height,
            seed: config.seed,
            motion,
            orbitDegrees: 30,
            settings,
            history: 'fresh-session-then-warmup',
          },
          runs: [run],
        };
        if (existing) existing.runs.push(run);
        else next.entries.push(entry);
        showReport(next);
      }
    if (compare) {
      const comparison = compareEntries(
        next.entries.find((entry) => entry.renderer === 'three-current')!,
        next.entries.find((entry) => entry.renderer === 'three-new')!,
      );
      next.comparisons = [comparison];
      message(
        `Finished: ${comparison.speedup.mean.toFixed(3)}× speedup; repetition stddev ${comparison.speedup.stddev.toFixed(3)}. Greater than 1 means three-new is faster.`,
      );
    } else message('Benchmark complete. Download the report to preserve this run.');
    showReport(next);
    element('live-status').textContent = 'Report ready';
  } catch (error) {
    if (!signal.aborted) throw error;
    message(signal.reason instanceof Error ? signal.reason.message : 'Benchmark cancelled');
    element('live-status').textContent = 'Cancelled';
  } finally {
    document.removeEventListener('visibilitychange', hidden);
    controller = undefined;
    lock(false);
    element('fps').textContent = 'Load scene to resume';
    element('instrument-status').textContent = 'Paused · load a scene to resume';
  }
}
async function captureImage() {
  startupCapture?.stop();
  if (!active) throw new Error('Load a scene before capturing');
  const current = active;
  lock(true);
  cancelAnimationFrame(animation);
  message('Capturing a converged image at the current camera pose…');
  try {
    // Snapshot synchronously after the final submission; waiting first can discard the presented canvas texture.
    const copy = document.createElement('canvas');
    copy.width = current.canvas.width;
    copy.height = current.canvas.height;
    const frames = current.setup.effects.frames;
    const captureSession: RenderSession = {
      ...current.session,
      pipeline: {
        ...current.session.pipeline,
        render(frame) {
          current.session.pipeline.render(frame);
          if (frame?.index === frames - 1) copy.getContext('2d')!.drawImage(current.canvas, 0, 0);
        },
      },
    };
    const pixels = await capture(
      captureSession,
      { frames },
      async () => {
        return new Promise<Blob>((resolve, reject) =>
          copy.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas capture failed'))), 'image/png'),
        );
      },
      { yield: () => nextFrame().then(() => {}) },
    );
    download(pixels, `${select('scene').value}-${current.live.name}.png`);
    message('Captured PNG at the current camera pose.');
  } finally {
    lock(false);
    animation = requestAnimationFrame(animate);
  }
}
function action(id: string, task: () => Promise<void>) {
  element(id).addEventListener('click', () => {
    if (!busy) void task().catch(fail);
  });
}
action('load', load);
action('startup-json', async () => {
  if (startupSnapshot)
    download(
      new Blob([JSON.stringify(startupSnapshot, null, 2)], { type: 'application/json' }),
      `${startupSnapshot.scene}-${startupSnapshot.renderer}-startup.json`,
    );
});
input('live-gpu').addEventListener('change', () => {
  if (!busy) void load().catch(fail);
});
action('benchmark', runBenchmark);
action('capture', captureImage);
element('cancel').addEventListener('click', () => controller?.abort(new Error('Benchmark cancelled')));
action('json', async () => {
  if (report)
    download(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `benchmark-${report.id}.json`);
});
action('html', async () => {
  if (report) download(new Blob([reportHtml(report)], { type: 'text/html' }), `benchmark-${report.id}.html`);
});
input('report-file').addEventListener('change', () => {
  const file = input('report-file').files?.[0];
  if (file)
    void file
      .text()
      .then((text) => {
        showReport(parseReport(JSON.parse(text)));
        lock(false);
      })
      .catch(fail);
});
window.addEventListener('beforeunload', () => {
  urlState.cancel();
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  controller?.abort();
  stop();
});
void load();
