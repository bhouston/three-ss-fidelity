import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUrlStateWriter } from './url-state';

describe('URL state history', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('replaces at most once per second during continuous movement and saves the final pose', () => {
    let pose = 0;
    const writes: { mode: string; pose: number; time: number }[] = [];
    const state = createUrlStateWriter((mode) => writes.push({ mode, pose, time: performance.now() }));
    state.camera();
    for (pose = 1; pose <= 25; pose++) {
      vi.advanceTimersByTime(100);
      state.camera();
    }
    pose = 25;
    vi.advanceTimersByTime(500);
    expect(writes.map(({ mode }) => mode)).toEqual(['replace', 'replace', 'replace', 'replace']);
    expect(writes.map(({ time }) => time)).toEqual([0, 1000, 2000, 3000]);
    expect(writes.at(-1)?.pose).toBe(25);
    vi.advanceTimersByTime(2000);
    expect(writes).toHaveLength(4);
  });

  it('pushes settings immediately, cancels pending camera writes, and preserves the throttle', () => {
    const write = vi.fn();
    const state = createUrlStateWriter(write);
    state.camera();
    vi.advanceTimersByTime(100);
    state.camera();
    state.settings();
    expect(write.mock.calls).toEqual([['replace'], ['push']]);
    vi.advanceTimersByTime(200);
    state.camera();
    vi.advanceTimersByTime(699);
    expect(write).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(write.mock.calls).toEqual([['replace'], ['push'], ['replace']]);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('cancels stale writes when navigating history or leaving the page', () => {
    const write = vi.fn();
    const state = createUrlStateWriter(write);
    state.camera();
    state.camera();
    state.cancel();
    vi.advanceTimersByTime(1000);
    expect(write.mock.calls).toEqual([['replace']]);
  });
});
