import { createReporter } from 'performance-kit-reporter';

const reporter = createReporter();
if (!reporter.enabled) {
  // Standalone use is an interactive viewer; no harness messages or result files.
  void import('./performance-live').then(({ mountLiveViewer }) => mountLiveViewer());
} else {
  void runAutomated().catch((error) => reporter.fail(error));
}

async function runAutomated() {
  const { createPerformanceSession } = await import('./performance-session');
  const session = await createPerformanceSession(reporter.params, reporter, document.body);
  let animation = 0;
  const tick = () => {
    if (!reporter.running) return;
    try {
      session.draw();
      animation = requestAnimationFrame(tick);
    } catch (error) {
      reporter.fail(error);
    }
  };
  animation = requestAnimationFrame(tick);
  reporter.onCapture(async () => {
    await session.complete();
    session.draw();
    await session.complete();
    return session.canvas;
  });
  window.addEventListener(
    'pagehide',
    () => {
      cancelAnimationFrame(animation);
      reporter.dispose();
      session.dispose();
    },
    { once: true },
  );
}
