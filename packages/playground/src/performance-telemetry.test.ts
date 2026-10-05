import { expect, it, vi } from 'vitest';
import { createLiveTelemetry } from './performance-telemetry';

it('publishes completed setup phases once and excludes compilation from live frame measurements', () => {
  let time = 0;
  const setup = vi.fn();
  const frames = vi.fn();
  const telemetry = createLiveTelemetry(setup, frames, () => time);
  time = 100;
  telemetry.reporter.phaseEnd('load');
  telemetry.reporter.phaseStart('process');
  time = 150;
  telemetry.reporter.phaseEnd('process');
  telemetry.reporter.phaseStart('compile');
  expect(telemetry.reporter.frameBegin()).toBe(-1);
  telemetry.reporter.frameEnd(-1);
  telemetry.sample();
  expect(frames).not.toHaveBeenCalled();
  time = 300;
  telemetry.reporter.phaseEnd('compile');
  telemetry.reporter.ready();
  expect(setup).toHaveBeenCalledExactlyOnceWith({
    totalMs: 300,
    phases: [
      { name: 'load', startMs: 0, durationMs: 100 },
      { name: 'process', startMs: 100, durationMs: 50 },
      { name: 'compile', startMs: 150, durationMs: 150 },
    ],
  });
  for (let index = 0; index < 60; index++) {
    time = 300 + (index * 1000) / 60;
    const token = telemetry.reporter.frameBegin();
    time += 2;
    telemetry.reporter.frameEnd(token);
  }
  time = 1300;
  telemetry.sample();
  expect(frames).toHaveBeenLastCalledWith({ seconds: 1, fps: 60, cpuMs: 2 });
  time = 2300;
  telemetry.sample();
  expect(frames).toHaveBeenLastCalledWith({ seconds: 2, fps: 0, cpuMs: 0 });
  expect(setup).toHaveBeenCalledTimes(1);
});

it('a new live session resets the setup and frame clocks', () => {
  let time = 5000;
  const setup = vi.fn();
  const frames = vi.fn();
  const telemetry = createLiveTelemetry(setup, frames, () => time);
  time += 20;
  telemetry.reporter.phaseEnd('load');
  telemetry.reporter.ready();
  time += 1000;
  telemetry.sample();
  expect(setup.mock.calls[0]![0].totalMs).toBe(20);
  expect(frames).toHaveBeenCalledExactlyOnceWith({ seconds: 1, fps: 0, cpuMs: 0 });
});
