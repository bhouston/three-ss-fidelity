# Chrome WebGPU issues on Linux (NVIDIA, Vulkan)

These issues block valid browser performance measurements on the `build001` benchmark machine. Each was reproduced with [`scripts/chrome-webgpu-linux-probe.mjs`](../../scripts/chrome-webgpu-linux-probe.mjs), which uses a plain WebGPU page with no three.js code. Measurements come from runs of that script; issue 6 lists results from three runs because it is not fully deterministic.

**Working configuration on this machine:** headful Chrome, vsync on, and no extra GPU flags. Headful Chrome selects the NVIDIA GPU by default, keeps frame backpressure, and reads back correct pixels.

| #   | Issue                                                                                     | Severity for benchmarking                                       | Workaround                                                                   |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Headless Chrome uses SwiftShader (software) for WebGPU and WebGL unless Vulkan is forced  | Results are meaningless or rejected                             | Headless only: `--enable-features=Vulkan --use-angle=vulkan`; or run headful |
| 2   | First `navigator.gpu.requestAdapter()` after launch returns `null` with Vulkan enabled    | three.js silently falls back to its WebGL2 backend              | Retry `requestAdapter()` once after launch (warm-up)                         |
| 3   | Headless rendering has no frame backpressure, even with vsync on                          | Frame rate and GPU queue are both wrong; captures time out      | None in headless; run headful                                                |
| 4   | `--disable-frame-rate-limit` removes backpressure, even headful                           | Uncapped (vsync-off) frame rates cannot be measured             | None found; keep the frame-rate limit                                        |
| 5   | A deep GPU queue blocks `canvas.toBlob()` and `onSubmittedWorkDone()` for tens of seconds | End-of-run screenshots time out and the page main thread stalls | Consequence of 3 and 4                                                       |
| 6   | Headful Chrome with `--enable-features=Vulkan` returns corrupted pixels from `toBlob()`   | Screenshots are noise although the on-screen frame is correct   | Do not pass `--enable-features=Vulkan` when headful                          |

## Environment

| Component | Version                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| OS        | Ubuntu 26.04.1 LTS, kernel 7.0.0-38-generic, GNOME on Wayland                                        |
| CPU       | AMD Ryzen 9 5950X                                                                                    |
| GPU       | NVIDIA GeForce GTX 1050 (Pascal), driver 580.178.04, Vulkan 1.4.312                                  |
| Display   | 1920×1080 at 59.96 Hz                                                                                |
| Browser   | Google Chrome for Testing 148.0.7778.97 (bundled with Puppeteer 24.43.1)                             |
| Launch    | Puppeteer `headless: true` (new headless) or `headless: false`, always with `--enable-unsafe-webgpu` |

The base flags in every case are `--enable-unsafe-webgpu --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`. "Vulkan flags" means `--enable-features=Vulkan --use-angle=vulkan`. "vsync off" means `--disable-gpu-vsync --disable-frame-rate-limit`, which is what performance-kit passes when a suite sets `"vsync": "off"`.

## 1. Headless Chrome defaults to SwiftShader

With default flags, headless Chrome selects the SwiftShader CPU device for both WebGPU and WebGL, even though `chrome://gpu` lists the NVIDIA GPU as a discrete Vulkan adapter.

```text
default flags  requestAdapter() -> google/swiftshader (3 of 3 attempts)
               WebGL2 renderer  -> ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)
Vulkan flags   requestAdapter() -> null, nvidia/pascal, nvidia/pascal
               WebGL2 renderer  -> ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA GeForce GTX 1050), NVIDIA)
```

`--enable-features=Vulkan` alone still gives SwiftShader; `--use-angle=vulkan` is also required. Headful Chrome on the same machine selects the NVIDIA adapter with default flags, and there `--enable-features=Vulkan` must be avoided because of issue 6. performance-kit rejects software adapters, so without these flags every workload fails as a software-GPU result.

With the Vulkan flags, headless `chrome://gpu` also logs `Failed to initialize vulkan surface` (from `skia_output_device_vulkan.cc`). It then reports GPU compositing as disabled and "WebGPU: Hardware accelerated but at reduced performance".

**Expected:** headless Chrome uses the hardware GPU when one is available, as it does headful and on macOS.

## 2. First adapter request returns `null`

With the Vulkan flags in headless mode, the first `navigator.gpu.requestAdapter()` in a newly launched browser returns `null`. Every later request, on any page or origin, returns the NVIDIA adapter in about 20 ms. This happened in every trial (3 of 3 browser launches).

```text
requestAdapter() attempt 1 -> null
requestAdapter() attempt 2 -> nvidia/pascal   (100 ms later, same page)
new page, other origin, attempt 1 -> nvidia/pascal (21 ms)
```

The result depends only on whether the request is the first one; adapter options don't matter. Whichever request is made first, with no options, `powerPreference: 'high-performance'` or `featureLevel: 'compatibility'`, returns `null`. The GPU process appears to answer before Dawn finishes enumerating Vulkan adapters.

**Impact:** three.js `WebGPURenderer` sees no adapter, logs `WebGPU is not available, running under WebGL2 backend`, and measures the wrong API. Nothing fails, so this is easy to miss.

**Expected:** `requestAdapter()` waits for adapter enumeration instead of returning `null` while the GPU process is still starting.

## 3. No frame backpressure in headless mode

In headless mode, `requestAnimationFrame` keeps firing at 60 Hz even when the GPU cannot keep up, so submitted WebGPU work queues up without limit. Headful Chrome correctly slows `requestAnimationFrame` to the GPU's real rate.

Each case below renders a 1920×1080 full-screen shader for 3 seconds, submitting one frame per `requestAnimationFrame`. "Queued work" is how long `device.queue.onSubmittedWorkDone()` takes after the loop stops.

| Case (Vulkan flags)                 | Light shader (GPU about 290 fps): rAF fps, queued work | Heavy shader (GPU about 22 fps): rAF fps, queued work |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Headful, vsync on                   | 59.9 fps, 6 ms                                         | **22.1 fps, 94 ms** (correct)                         |
| Headless, vsync on                  | 60.4 fps, 7 ms                                         | **60.2 fps, 5,323 ms** (no backpressure)              |
| Headful, `--disable-gpu-vsync` only | 60.2 fps, 6 ms                                         | 22.2 fps, 93 ms                                       |
| Headful, vsync off (both flags)     | **511.5 fps, 2,372 ms**                                | no result within 60 s                                 |
| Headless, vsync off (both flags)    | **492.7 fps, 2,121 ms**                                | no result within 60 s                                 |

In headless mode with vsync on, the heavy shader runs `requestAnimationFrame` at 60 fps while the GPU completes about 22 fps. After 3 seconds, 5.3 seconds of GPU work is still queued, and the backlog keeps growing as long as rendering continues.

**Impact:** any frame-rate measurement in headless Linux reports the submission rate, not the rendering rate. Over a 10-second benchmark the queue grows by tens of seconds.

**Expected:** headless mode applies the same backpressure as headful presentation, since frames are still produced through the compositor. Alternatively, `getCurrentTexture()` could block once a fixed number of frames are in flight, as a native swapchain does.

## 4. `--disable-frame-rate-limit` removes backpressure

With `--disable-frame-rate-limit`, headful or headless, `requestAnimationFrame` runs as fast as the CPU can submit (about 500 fps here) with no limit on queued GPU work. With the light shader the GPU completes about 290 fps, so 2.1 to 2.4 seconds of work is left queued after 3 seconds. With the heavy shader the queue grows so fast that the page never reports a result within 60 seconds.

`--disable-gpu-vsync` on its own keeps backpressure but leaves `requestAnimationFrame` capped at the 60 Hz display rate. On this machine no combination of flags both uncaps the frame rate and keeps the GPU queue bounded.

**Impact:** "vsync off" frame rates above the display refresh, which the macOS benchmark records, cannot be measured on Linux. A benchmark that reports `requestAnimationFrame` rate under these flags measures CPU submission speed.

**Expected:** with the frame-rate limit disabled, the next frame still waits for the previous one's GPU work, or for a bounded number of frames in flight, instead of queuing without limit.

## 5. A deep GPU queue stalls readback

`canvas.toBlob()` on the WebGPU canvas, and `device.queue.onSubmittedWorkDone()`, have to wait for all queued work. Under issues 3 and 4 that takes tens of seconds. In the real benchmark, the renderer iframe's main thread stopped responding to DevTools `Runtime.evaluate` calls for more than 4.5 seconds while a `toBlob()` was pending. The 60-second capture wait then timed out and performance-kit discarded the run, recording `status: "timeout"` and `Timeout waiting for capture`.

On an idle queue `toBlob()` returns in 40 to 70 ms in every mode. The headful PNGs in the backpressure probe were about twice the size of the headless ones (1.52 MB against 0.71 MB for the same frame), because those headful runs used `--enable-features=Vulkan` and their pixels were corrupted noise (issue 6), which compresses poorly.

**Expected:** this is mostly a consequence of issues 3 and 4. It's still worth noting that a pending `toBlob()` blocks the main thread rather than resolving asynchronously.

## 6. Corrupted `toBlob()` pixels with `--enable-features=Vulkan` in headful mode

In headful Chrome with `--enable-features=Vulkan`, `canvas.toBlob()` on a WebGPU canvas returns an image of coloured noise and moiré patterns. The frame shown on screen at the same time is correct, and so are the frame rates. The canvas is configured as three.js `WebGPURenderer` does by default: format `rgba8unorm` (the preferred format here), `alphaMode: 'premultiplied'`, `usage: RENDER_ATTACHMENT | COPY_SRC` and standard tone mapping. Opaque alpha mode and `RENDER_ATTACHMENT` usage alone give the same corruption.

The probe renders a known 960×540 gradient, calls `toBlob()` after `onSubmittedWorkDone()`, and compares sampled pixels with the expected values; a mean absolute error under 3 (of 255) is rounding. It checks the PNG twice: decoded in Node, and decoded in the page through `createImageBitmap()` and a 2D canvas `getImageData()`.

| Case                                          | `toBlob()` PNG, 3 runs | In-page decode, 3 runs | Mean error when corrupted |
| --------------------------------------------- | ---------------------- | ---------------------- | ------------------------- |
| Headful, default flags                        | correct 3/3            | correct 3/3            |                           |
| Headful, `--use-angle=vulkan`                 | correct 3/3            | correct 3/3            |                           |
| Headful, `--enable-features=Vulkan`           | **corrupted 3/3**      | **corrupted 3/3**      | 106.8                     |
| Headful, both Vulkan flags                    | **corrupted 3/3**      | **corrupted 3/3**      | 106.8                     |
| Headful, both Vulkan flags, X11 (not Wayland) | **corrupted 2/3**      | **corrupted 3/3**      | 106.8                     |
| Headless, both Vulkan flags                   | correct 3/3            | correct 3/3            |                           |

The corruption follows `--enable-features=Vulkan`, not ANGLE's Vulkan backend, and happens on both Wayland and X11. On X11 the PNG was sometimes correct while the in-page decode of that same PNG was still corrupted, so a second readback path, image decode and 2D canvas `getImageData()`, is affected as well. A corrupted PNG is also much larger (122,685 against 15,816 bytes) because noise compresses poorly.

In the three.js benchmark the same thing happened: the run's on-screen frame was a correct Cornell box, while the captured `screenshot.avif` was noise. Dropping the flag fixed every capture.

**Expected:** pixels read back from a canvas match what is presented, whichever Skia/GPU backend is enabled.

## Effect on this repository's benchmarks

- **Mitigated in performance-kit:**
  - `run --chrome-arg` passes extra Chrome flags, such as the headless Vulkan flags for issue 1, and records them in `environment.chromeFlags`.
  - The launch probe retries `requestAdapter()`, which works around issue 2 and records the real adapter.
  - `run --vsync on|off` overrides a suite's vsync mode and records it in `config.vsync`.
- **How `build001` is measured:** `--headful --vsync on` with no extra flags. This avoids issues 1, 3, 4, 5 and 6, but frame rates are capped at the 59.96 Hz display rate. In the October 2026 run no workload exceeded 36 fps, so the cap did not limit any result.
- **Still different from macOS:** the MacBook Air M3 results use vsync off. The `build001` results are valid on their own, but their `config.vsync` differs. The renderer could add its own backpressure, for example by bounding frames in flight, to allow uncapped measurement here; that would change the method for every machine.

## Reproduce

```sh
pnpm install
node scripts/chrome-webgpu-linux-probe.mjs adapter       # issues 1 and 2
node scripts/chrome-webgpu-linux-probe.mjs backpressure  # issues 3 to 5 (opens headful windows)
node scripts/chrome-webgpu-linux-probe.mjs readback      # issue 6 (opens headful windows)
node scripts/chrome-webgpu-linux-probe.mjs all --chrome /path/to/chrome
```

The backpressure and readback probes open browser windows on the current display for the headful cases. The backpressure probe takes about five minutes, the readback probe about one. Note that the headful backpressure cases pass both Vulkan flags, so their PNGs are affected by issue 6; this does not change their frame timings.

## Unrelated tooling issue found at the same time

`npx puppeteer browsers install chrome` downloaded Chrome 148 under Node 26.10.0 but left an incomplete extraction with no `chrome` executable and reported no error. Later attempts failed with `IncompleteInstallationError`. Unzipping `chrome-linux64.zip` from `storage.googleapis.com/chrome-for-testing-public/148.0.7778.97/linux64/` into `~/.cache/puppeteer/chrome/linux-148.0.7778.97/` worked. This looks like a problem in Puppeteer's zip extraction rather than in Chrome.
