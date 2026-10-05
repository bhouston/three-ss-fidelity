import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { listSceneNames } from '@ss-fidelity/scenes';
import { liveRendererPresets } from './performance-presets';
import { createPerformanceSession } from './performance-session';
import { createLiveTelemetry } from './performance-telemetry';
import type { FrameMetric, SetupMetric } from './performance-telemetry';
import { FrameChart, SetupChart } from './performance-charts';
import '../../../submodules/performance-kit/packages/viewer/src/style.css';
import './performance-live.css';

function LiveViewer() {
  const scenes = listSceneNames();
  const [scene, setScene] = useState('cornell-box-basic');
  const [renderer, setRenderer] = useState<string>('three-current');
  const [active, setActive] = useState<{ scene: string; renderer: string }>();
  const [status, setStatus] = useState('Choose a scenario and renderer, then start.');
  const [loading, setLoading] = useState(false);
  const [setup, setSetup] = useState<SetupMetric>();
  const [frames, setFrames] = useState<FrameMetric[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const stop = useRef<() => void>(() => {});
  const generation = useRef(0);
  useEffect(() => {
    const cleanup = () => {
      generation.current++;
      stop.current();
    };
    window.addEventListener('pagehide', cleanup);
    return () => {
      window.removeEventListener('pagehide', cleanup);
      cleanup();
    };
  }, []);

  async function start() {
    const run = ++generation.current;
    stop.current();
    host.current!.replaceChildren();
    setSetup(undefined);
    setFrames([]);
    setActive({ scene, renderer });
    setLoading(true);
    setStatus('Loading scene and preparing the first frame…');
    const telemetry = createLiveTelemetry(
      (metric) => {
        if (generation.current === run) setSetup(metric);
      },
      (frame) => {
        if (generation.current === run) setFrames((previous) => [...previous.slice(-299), frame]);
      },
    );
    try {
      const preset = liveRendererPresets.find((item) => item.id === renderer)!;
      const session = await createPerformanceSession(
        { scene, renderer: preset.renderer, experiment: preset.experiment, width: 1920, height: 1080, seed: 1 },
        telemetry.reporter,
        host.current!,
        true,
      );
      if (generation.current !== run) {
        session.dispose();
        return;
      }
      let animation = 0;
      let previous = performance.now();
      const timer = window.setInterval(() => telemetry.sample(), 1000);
      stop.current = () => {
        cancelAnimationFrame(animation);
        clearInterval(timer);
        session.dispose();
      };
      const tick = (time: number) => {
        try {
          session.draw((time - previous) / 1000);
          previous = time;
          animation = requestAnimationFrame(tick);
        } catch (error) {
          stop.current();
          setStatus(`Render failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      animation = requestAnimationFrame(tick);
      setStatus('Running');
    } catch (error) {
      if (generation.current === run)
        setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (generation.current === run) setLoading(false);
    }
  }
  const pending = active && (active.scene !== scene || active.renderer !== renderer);
  return (
    <>
      <header className="header">
        <div className="header-inner">
          <span className="brand">SS Fidelity / Live Benchmark</span>
          <a href="/">Diagnostic playground</a>
          <span className="result-count">1920 × 1080</span>
        </div>
      </header>
      <main className="live-main">
        <section className="live-panel live-controls">
          <label>
            Scenario
            <select aria-label="Scenario" value={scene} onChange={(event) => setScene(event.target.value)}>
              {scenes.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            Renderer
            <select aria-label="Renderer" value={renderer} onChange={(event) => setRenderer(event.target.value)}>
              {liveRendererPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <button disabled={loading} onClick={() => void start()}>
            Start Benchmark
          </button>
          {pending && <span>Selection changed. Click Start Benchmark to apply.</span>}
        </section>
        <section className="live-panel">
          <div className="live-summary">
            <h2>{active ? `${active.scene} / ${active.renderer}` : '3D view'}</h2>
            <output>{status}</output>
          </div>
          <div className="live-viewport" ref={host} />
          <p className="live-hint">
            Drag to orbit · scroll to zoom · click the view, then use WASD or arrow keys to move. Each start resets the
            camera and charts.
          </p>
        </section>
        <FrameChart frames={frames} />
        <SetupChart setup={setup} />
      </main>
    </>
  );
}

export function mountLiveViewer() {
  document.title = 'SS Fidelity · Live Benchmark';
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  createRoot(root).render(<LiveViewer />);
}
