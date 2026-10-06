const query = new URLSearchParams(location.search);
if (!query.has('performanceKitRunId') && !query.has('fidelityKitMode')) {
  void import('./performance-live').then(({ mountLiveViewer }) => mountLiveViewer());
} else {
  void Promise.all([import('fidelity-kit/browser/host'), import('./performance-session')]).then(
    ([{ mountRenderHost }, { createPerformanceSession }]) => mountRenderHost(createPerformanceSession),
  );
}
