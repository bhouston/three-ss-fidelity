/** Camera movement replaces the current entry; settings changes start a new one. */
export function createUrlStateWriter(write: (mode: 'push' | 'replace') => void) {
  let lastCameraWrite = -Infinity;
  let pending: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    clearTimeout(pending);
    pending = undefined;
  }

  function replaceCamera() {
    pending = undefined;
    lastCameraWrite = performance.now();
    write('replace');
  }

  return {
    camera() {
      if (pending !== undefined) return;
      const remaining = 1000 - (performance.now() - lastCameraWrite);
      if (remaining <= 0) replaceCamera();
      else pending = setTimeout(replaceCamera, Math.ceil(remaining));
    },
    settings() {
      cancel();
      write('push');
    },
    cancel,
  };
}
