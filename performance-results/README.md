This viewer benchmarks [three.js](https://threejs.org/) real-time renderers. Inspect frame times, startup cost, GPU timing, and stability across Three-Base, Three-New, and the light bake, light probe, DDGI, SSR, and SSGI variants.

The first run set uses the Cornell box with a metallic sphere: **26 configurations with one repetition each**, recorded on an Apple M3 at 1920 × 1080 with vsync disabled. Each result includes raw timing data and an AVIF capture. Use search and the renderer and scene filters to find a configuration, then expand it to inspect CPU/GPU timelines, setup phases, and individual runs.

Read the [benchmark notes](https://github.com/bhouston/three-ss-fidelity/blob/main/docs/history/performance/METALLIC-CORNELL.md) for the measurement settings, variability, and reproduction commands. The [fidelity viewer](https://ss-fidelity.ben3d.ca/) shows the corresponding image quality comparisons.
