import { PMREMGenerator, RenderPipeline, UnsignedByteType, WebGPURenderer } from 'three/webgpu';
import {
  builtinGIContext,
  color,
  mrt,
  normalView,
  packNormalToRGB,
  pass,
  sample,
  screenUV,
  unpackRGBToNormal,
  velocity,
} from 'three/tsl';
import { vxgi } from 'three/addons/lighting/vxgi/VXGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import type { SceneInstance } from '@three-fidelity/scenes';
import type { LiveRenderer, RendererOptions } from './types.js';
import { configureRenderer, createLivePipeline, prepareScene } from './helpers.js';

/** Upstream VXGI example pipeline, with unit GI intensity for fidelity comparisons. */
export async function createVXGIRenderer(
  canvas: HTMLCanvasElement,
  setup: SceneInstance,
  { width, height, trackTimestamp = false }: RendererOptions,
): Promise<LiveRenderer> {
  const { scene, camera, effects } = setup;
  const renderer = new WebGPURenderer({ canvas, antialias: false, trackTimestamp });
  renderer.shadowMap.enabled = true;
  configureRenderer(renderer, effects);
  await renderer.init();
  const releaseScene = prepareScene(setup, {
    createGradient: ({ center, edge }) => screenUV.distance(0.5).remap(0, 0.5).mix(color(center), color(edge)),
    bakeEnvironment(environment) {
      const generator = new PMREMGenerator(renderer);
      try {
        return generator.fromScene(environment.scene, environment.sigma);
      } finally {
        generator.dispose();
      }
    },
  });
  const pipeline = new RenderPipeline(renderer);
  const prePass = pass(scene, camera);
  prePass.name = 'VXGI Pre-Pass';
  prePass.transparent = false;
  prePass.setMRT(mrt({ output: packNormalToRGB(normalView), velocity }));
  prePass.getTexture('output').type = UnsignedByteType;
  const normal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
  const depth = prePass.getTextureNode('depth');
  const gi = vxgi(depth, normal, scene, camera);
  const scenePass = pass(scene, camera);
  scenePass.contextNode = builtinGIContext(gi.getAONode().sample(screenUV).r, gi.getGINode().sample(screenUV).rgb);
  pipeline.outputNode = traa(scenePass, depth, prePass.getTextureNode('velocity'), camera);
  const live = createLivePipeline({
    name: 'vxgi',
    renderer,
    camera,
    render() {
      pipeline.render();
    },
    disposeGraph() {
      pipeline.dispose();
      gi.dispose();
      prePass.dispose();
      scenePass.dispose();
      releaseScene();
    },
  });
  live.setSize(width, height);
  return live;
}
