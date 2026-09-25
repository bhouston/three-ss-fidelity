// Node scene context: reads assets from disk, decodes glTF images with sharp and runs the Draco decoder in-thread.
import { readFile } from 'node:fs/promises';
import { resolveObjectURL } from 'node:buffer';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { DataTexture } from 'three';
import type { Texture } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import type { SceneContext } from './types.js';

/** `submodules/three.js/examples/`, found through the (single, workspace) `three` package. */
export const threeExamplesDir = fileURLToPath(new URL('../examples/', import.meta.resolve('three')));

async function readUrl(url: string): Promise<Buffer> {
  if (url.startsWith('blob:')) {
    const blob = resolveObjectURL(url);
    if (!blob) throw new Error(`Unknown blob URL ${url}`);
    return Buffer.from(await blob.arrayBuffer());
  }
  return readFile(url.startsWith('file:') ? fileURLToPath(url) : url);
}

/** Minimal TextureLoader stand-in: decodes to an RGBA8 DataTexture (the loader then sets flipY, sampler, color space). */
const imageLoader = {
  load(url: string, onLoad: (texture: Texture) => void, _onProgress: unknown, onError: (error: unknown) => void): void {
    readUrl(url)
      .then((buffer) => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }))
      .then(({ data, info }) => {
        const texture = new DataTexture(new Uint8Array(data), info.width, info.height);
        texture.needsUpdate = true;
        onLoad(texture);
      })
      .catch(onError);
  },
};

/** Runs DRACOLoader's worker source on the main thread (node has no Web Worker). */
class InlineWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private readonly scope: { onmessage?: (event: { data: unknown }) => void; postMessage: (data: unknown) => void };
  private readonly ready: Promise<void>;

  constructor(url: string) {
    this.scope = { postMessage: (data) => this.onmessage?.({ data }) };
    this.ready = readUrl(url).then((source) => {
      // oxlint-disable-next-line typescript/no-implied-eval -- the worker source is DRACOLoader's own code
      new Function('self', 'require', source.toString())(this.scope, createRequire(import.meta.url));
    });
  }

  postMessage(data: unknown): void {
    void this.ready.then(() => this.scope.onmessage?.({ data }));
  }

  terminate(): void {}
}

class NodeDRACOLoader extends DRACOLoader {
  // decoder paths default to file: URLs next to DRACOLoader.js; node's fetch can't load those
  _loadLibrary(url: string, responseType: string): Promise<string | ArrayBuffer> {
    return readUrl(url).then((buffer) =>
      responseType === 'text' ? buffer.toString('utf8') : new Uint8Array(buffer).buffer,
    );
  }
}

export function createNodeSceneContext(examplesDir = threeExamplesDir): SceneContext {
  (globalThis as { self?: unknown }).self ??= globalThis; // GLTFLoader reads self.URL
  (globalThis as { Worker?: unknown }).Worker ??= InlineWorker;

  const loader = new GLTFLoader().setDRACOLoader(new NodeDRACOLoader());
  // first in line, ahead of EXT_texture_webp (whose support detection needs a DOM Image); sharp decodes webp too
  (loader as unknown as { pluginCallbacks: ((parser: GLTFParser) => unknown)[] }).pluginCallbacks.unshift(
    (parser: GLTFParser) => ({
      name: 'ss_fidelity_node_images',
      loadTexture(textureIndex: number) {
        const textureDef = parser.json.textures[textureIndex];
        const source = textureDef.extensions?.EXT_texture_webp?.source ?? textureDef.source;
        return parser.loadTextureImage(textureIndex, source, imageLoader as never);
      },
    }),
  );

  return {
    async loadGLTF(assetPath) {
      const file = path.join(examplesDir, assetPath);
      return loader.parseAsync(new Uint8Array(await readFile(file)).buffer, `${path.dirname(file)}/`);
    },
  };
}
