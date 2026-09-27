// Headless WebGPU (dawn `webgpu` package) with a minimal canvas, ported from vitest-environment-webgpu-node.
import sharp from 'sharp';
import { create, globals } from 'webgpu';

const COPY_SRC = 0x01;
const RENDER_ATTACHMENT = 0x10;
const MAP_READ = 0x01;
const COPY_DST = 0x08;

/** Minimal GPUCanvasContext: getCurrentTexture() is a COPY_SRC texture the size of the canvas, kept until resized. */
class HeadlessCanvasContext {
  private config: GPUCanvasConfiguration | undefined;
  private texture: GPUTexture | undefined;

  constructor(readonly canvas: HeadlessCanvas) {}

  configure(config: GPUCanvasConfiguration): void {
    this.config = config;
    this.drop();
  }

  unconfigure(): void {
    this.config = undefined;
    this.drop();
  }

  getConfiguration(): GPUCanvasConfiguration | null {
    return this.config ?? null;
  }

  getCurrentTexture(): GPUTexture {
    const config = this.config;
    if (!config) throw new Error('getCurrentTexture() called before configure()');
    const { width, height } = this.canvas;
    if (this.texture && (this.texture.width !== width || this.texture.height !== height)) this.drop();
    this.texture ??= config.device.createTexture({
      size: [width, height],
      format: config.format,
      usage: (config.usage ?? RENDER_ATTACHMENT) | RENDER_ATTACHMENT | COPY_SRC,
      viewFormats: config.viewFormats,
    });
    return this.texture;
  }

  /** RGBA8, top row first (BGRA canvases are swizzled). */
  async readPixels(): Promise<Uint8Array> {
    const config = this.config;
    if (!config) throw new Error('readPixels() called before configure()');
    const { device, format } = config;
    const texture = this.getCurrentTexture();
    const { width, height } = texture;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * height, usage: MAP_READ | COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      data.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    buffer.unmap();
    buffer.destroy();
    if (format.startsWith('bgra')) {
      for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2]!, data[i]!];
    }
    return data;
  }

  private drop(): void {
    this.texture?.destroy();
    this.texture = undefined;
  }
}

/** Enough of HTMLCanvasElement for WebGPURenderer. */
class HeadlessCanvas {
  readonly context = new HeadlessCanvasContext(this);
  readonly style: Record<string, string> = {};

  constructor(
    public width: number,
    public height: number,
  ) {}

  get clientWidth(): number {
    return this.width;
  }

  get clientHeight(): number {
    return this.height;
  }

  getContext(id: string): HeadlessCanvasContext | null {
    return id === 'webgpu' ? this.context : null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, width: this.width, height: this.height };
  }

  setAttribute(): void {}
  getAttribute(): null {
    return null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

/** HTMLImageElement stand-in for data: URIs (SMAANode's lookup textures), decoded to RGBA8 with sharp. */
class HeadlessImage {
  width = 0;
  height = 0;
  complete = false;
  data: Uint8Array | undefined;
  onload: (() => void) | null = null;

  set src(url: string) {
    const base64 = url.slice(url.indexOf(',') + 1);
    const decoding = sharp(Buffer.from(base64, 'base64'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => {
        Object.assign(this, { data: new Uint8Array(data), width: info.width, height: info.height, complete: true });
        this.onload?.();
      })
      .finally(() => pendingImages.delete(decoding));
    pendingImages.add(decoding);
  }
}

const pendingImages = new Set<Promise<void>>();

/** Resolves once every HeadlessImage created so far has decoded (SMAANode's textures load asynchronously). */
export async function ready(): Promise<void> {
  await Promise.all(pendingImages);
}

/** Dawn only copies its own external images; upload HeadlessImage pixels directly. */
function patchCopyExternalImageToTexture(): void {
  const prototype = (globals as { GPUQueue: { prototype: GPUQueue } }).GPUQueue.prototype;
  const copy = prototype.copyExternalImageToTexture;
  prototype.copyExternalImageToTexture = function (source, destination, size) {
    const image = source.source as unknown;
    if (!(image instanceof HeadlessImage)) return copy.call(this, source, destination, size);
    if (source.flipY) throw new Error('HeadlessImage: flipY uploads are not supported');
    const { width, height, data } = image;
    this.writeTexture(destination, data!, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
  };
}

/** Installs dawn's WebGPU globals; must run before three is imported. */
export function install(): void {
  const scope = globalThis as Record<string, unknown>;
  Object.assign(scope, globals);
  // disable_timestamp_quantization: dawn rounds GPUQuerySet timestamp results to a coarse granularity by
  // default (a WebGPU spec mitigation against timing side-channels), which inflates `cli bench --gpu`'s
  // per-pass GPU timings well past wall-clock time when many short passes each round up. Safe in this
  // headless benchmark process (no browser sandbox to protect). allow_unsafe_apis is required to unlock it.
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: create(['enable-dawn-features=allow_unsafe_apis,disable_timestamp_quantization']),
    configurable: true,
  });
  scope.self ??= globalThis;
  scope.requestAnimationFrame ??= (callback: (time: number) => void) =>
    setTimeout(() => callback(performance.now()), 0);
  scope.cancelAnimationFrame ??= clearTimeout;
  scope.HTMLCanvasElement ??= HeadlessCanvas;
  scope.Image ??= HeadlessImage;
  patchCopyExternalImageToTexture();
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  return new HeadlessCanvas(width, height) as unknown as HTMLCanvasElement;
}

export function readPixels(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return (canvas as unknown as HeadlessCanvas).context.readPixels();
}
