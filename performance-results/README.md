This viewer benchmarks [three.js](https://threejs.org/) real-time renderers. Inspect frame times, startup cost, GPU timing, and stability across Three-Base, Three-New, and the light bake, light probe, DDGI, SSR, and SSGI variants.

The current benchmark uses the Cornell box with a metallic sphere: **26 configurations, each run once**, recorded on an Apple M3 at 1920 × 1080 with vsync disabled. Each configuration saves compact metrics directly and captures its AVIF screenshot after the measured run. Measurement includes the first ready frames, without warmup. The viewer shares a time scale across visible timelines and shows frame values on hover; expand an entry for framerate and setup responsiveness histograms plus startup phase durations and total setup time.

Read the [benchmark notes](https://github.com/bhouston/three-ss-fidelity/blob/main/docs/history/performance/METALLIC-CORNELL.md) for historical measurements and reproduction context. The [fidelity viewer](https://ss-fidelity.ben3d.ca/) shows the corresponding image quality comparisons.

These results were refreshed on October 4, 2026 using the updated metrics-only benchmark. Exact browser, host, toolkit and timing metadata are recorded in each metrics file. The older warmup-based measurements in the historical notes describe a different measurement window.
