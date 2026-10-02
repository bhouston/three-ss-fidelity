import type { StartupSnapshot, StartupPhase } from './startup';

const node = (id: string) => document.getElementById(id)!;
export const startupTime = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);
const phaseLabels: Record<StartupPhase, string> = {
  cleanup: 'Previous renderer cleanup',
  scene: 'Scene loading + asset fetch/decode',
  renderer: 'Renderer + environment setup',
  'first-render': 'First frame: CPU setup + submission',
  'gpu-wait': 'GPU wait: compilation, uploads + rendering',
};
function row(body: HTMLElement, values: string[]) {
  const item = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement('td');
    cell.textContent = value;
    item.append(cell);
  }
  body.append(item);
}

export function resetStartup() {
  for (const id of ['startup-total', 'startup-scene', 'startup-renderer', 'startup-gpu']) node(id).textContent = '—';
  for (const id of ['startup-stages', 'startup-passes']) node(id).replaceChildren();
  node('startup-context').textContent = 'Starting a fresh scene load…';
  node('startup-shaders').textContent = '';
  node('startup-coverage').textContent = '';
}

export function showStartup(snapshot: StartupSnapshot) {
  node('startup').dataset.state = snapshot.state;
  node('startup-status').textContent =
    snapshot.state === 'loading'
      ? `${phaseLabels[snapshot.phase as StartupPhase] ?? 'Loading'}…`
      : snapshot.state === 'failed'
        ? 'Load failed'
        : `${startupTime(snapshot.totalMs)} to first completed frame`;
  node('startup-total').textContent = startupTime(snapshot.totalMs);
  for (const phase of ['scene', 'renderer', 'gpu-wait'] as const) {
    node(phase === 'gpu-wait' ? 'startup-gpu' : `startup-${phase}`).textContent =
      snapshot.phases[phase] === undefined ? '—' : startupTime(snapshot.phases[phase]);
  }
  node('startup-context').textContent =
    `${snapshot.scene} / ${snapshot.renderer} · Fresh renderer on each load.` +
    (snapshot.error ? ` ${snapshot.error}` : ' Driver caches may reuse compilation work.');
  const stages = node('startup-stages');
  stages.replaceChildren();
  if (snapshot.pageMs) row(stages, ['Page + JavaScript loading (initial visit)', startupTime(snapshot.pageMs)]);
  for (const phase of Object.keys(phaseLabels) as StartupPhase[]) {
    const ms = snapshot.phases[phase];
    row(stages, [phaseLabels[phase], ms === undefined ? 'Pending' : startupTime(ms)]);
  }
  row(stages, ['Other: controls, UI + scheduling', startupTime(snapshot.otherMs)]);
  node('startup-shaders').textContent = snapshot.shaderReport
    ? `Across ${snapshot.frames} initial frames: shader generation: ${startupTime(snapshot.shaderGenerationMs)} · Shader-module API: ${startupTime(snapshot.shaderModuleMs)} · Pipeline API: ${startupTime(snapshot.pipelineMs)} (${snapshot.pipelines} calls). These overlap renderer/frame work and are not additional startup stages. Exact GPU compiler time is not exposed by the browser; work can be deferred into the GPU wait.`
    : snapshot.state === 'loading' && snapshot.renderer !== 'three-gpu-pathtracer'
      ? 'Collecting shader generation and pipeline calls…'
      : 'Shader-level breakdown is unavailable for this renderer. First-frame CPU and GPU completion timings still include its startup work.';
  node('startup-coverage').textContent =
    `${snapshot.frames} initial frame${snapshot.frames === 1 ? '' : 's'} captured` +
    (snapshot.capturing
      ? ' · Watching early history initialization…'
      : ' · Capture finished; live rendering continues.') +
    (snapshot.historyWaitMs === undefined
      ? ''
      : ` Additional early-frame GPU wait: ${startupTime(snapshot.historyWaitMs)} (after the first frame).`) +
    ' Pass timings are CPU/API observations, not per-shader GPU compilation durations.';
  const passes = node('startup-passes');
  passes.replaceChildren();
  for (const pass of snapshot.passes)
    row(passes, [
      pass.name,
      startupTime(pass.generationMs),
      startupTime(pass.pipelineMs),
      String(pass.pipelines),
      pass.fragmentBytes ? `${(pass.fragmentBytes / 1024).toFixed(1)} KB` : '—',
    ]);
  (node('startup-json') as HTMLButtonElement).disabled = snapshot.state === 'loading';
}
