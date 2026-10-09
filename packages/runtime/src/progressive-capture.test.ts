import { expect, test } from 'vitest';
import { captureProgressive } from './progressive-capture.js';
test('counts GPU-completed samples, caps wavefront work and avoids fixed-mode checkpoint reads', async () => {
  let submitted = 0,
    completed = 0,
    limit = 0,
    reads = 0;
  const result = await captureProgressive(
    {
      draw() {
        submitted++;
      },
      async complete() {
        completed = Math.min(limit, Math.floor(submitted / 4));
      },
      completed: async () => completed,
      limit(value) {
        limit = value;
      },
    },
    {
      samples: 5,
      width: 1,
      height: 1,
      async readPixels() {
        reads++;
        return new Uint8Array(4);
      },
      async yield() {},
    },
  );
  expect(submitted).toBe(20);
  expect(result.samples).toBe(5);
  expect(reads).toBe(0);
});
test('rejects backwards counts and honours cancellation', async () => {
  let count = 2;
  const session = {
    draw() {
      count--;
    },
    async complete() {},
    completed: () => count,
  };
  const options = {
    samples: 4,
    width: 1,
    height: 1,
    async readPixels() {
      return new Uint8Array(4);
    },
    async yield() {},
  };
  await expect(captureProgressive(session, options)).rejects.toThrow('Invalid renderer sample count');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(captureProgressive(session, { ...options, signal: controller.signal })).rejects.toThrow('cancelled');
});

test('permits asynchronous shader startup and detects sustained stalls', async () => {
  let updates = 0,
    clock = 0;
  const options = {
    samples: 2,
    width: 1,
    height: 1,
    async readPixels() {
      return new Uint8Array(4);
    },
    async yield() {
      clock++;
    },
    now: () => clock,
    stallTimeoutMs: 2000,
  };
  const result = await captureProgressive(
    {
      draw() {
        updates++;
      },
      async complete() {},
      completed: () => Math.max(0, updates - 1000),
    },
    options,
  );
  expect(result.samples).toBe(2);
  expect(updates).toBe(1002);
  clock = 0;
  await expect(
    captureProgressive({ draw() {}, async complete() {}, completed: () => 0 }, { ...options, stallTimeoutMs: 3 }),
  ).rejects.toThrow('stall timeout');
});
