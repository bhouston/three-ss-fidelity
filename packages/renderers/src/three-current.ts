// three-current: unmodified three.js r186 from npm (the `three-r186` alias of three@0.186.1), wired like its
// stock examples: webgpu_postprocessing_ssgi.html (color * ao + diffuse * gi, TRAA) and
// webgpu_postprocessing_ssr.html (color + ssr), always resolved with TRAA (the ssr example's SMAA is not used).
// Scenes with both chain the SSGI composite into the SSR add.
// It is a fixed baseline: nothing here comes from the fork, so fork edits cannot move it.
import * as Fork from 'three';
import {
  AmbientLightNode,
  DirectionalLightNode,
  HemisphereLightNode,
  LightProbeNode,
  LinearSRGBColorSpace,
  PMREMGenerator,
  PointLightNode,
  RectAreaLightNode,
  RenderPipeline,
  SpotLightNode,
  UnsignedByteType,
  WebGPURenderer,
} from 'three-r186/webgpu';
import {
  color,
  diffuseColor,
  float,
  metalness,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  perspectiveDepthToViewZ,
  reference,
  roughness,
  sample,
  screenUV,
  smoothstep,
  unpackRGBToNormal,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three-r186/tsl';
import { ssgi } from 'three-r186/addons/tsl/display/SSGINode.js';
import { ssr } from 'three-r186/addons/tsl/display/SSRNode.js';
import { traa } from 'three-r186/addons/tsl/display/TRAANode.js';
import type { SceneSetup } from '@ss-fidelity/scenes';
import { passEffects } from './three-new.js';
import type { LiveRenderer, RendererOptions } from './types.js';

// Scene graphs come from the fork's `three` and are rendered by the npm copy. The renderer is duck-typed (isMesh,
// material.type, ...) except for lights, which it looks up by constructor, so the fork's light classes are
// registered with r186's light nodes.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyNode = any;
const forkLights: [AnyNode, AnyNode][] = [
  [PointLightNode, Fork.PointLight],
  [DirectionalLightNode, Fork.DirectionalLight],
  [SpotLightNode, Fork.SpotLight],
  [AmbientLightNode, Fork.AmbientLight],
  [HemisphereLightNode, Fork.HemisphereLight],
  [RectAreaLightNode, Fork.RectAreaLight],
  [LightProbeNode, Fork.LightProbe],
];

function createPipeline(renderer: WebGPURenderer, setup: SceneSetup, aoOutput: boolean): RenderPipeline {
  const { scene, camera, effects } = setup as AnyNode as {
    scene: AnyNode;
    camera: AnyNode;
    effects: SceneSetup['effects'];
  };
  const renderPipeline = new RenderPipeline(renderer);

  // only the attachments the stock examples use for this scene's effects
  const scenePass = pass(scene, camera);
  scenePass.setMRT(
    mrt({
      output,
      normal: packNormalToRGB(normalView),
      ...(effects.ssgi ? { diffuseColor } : {}),
      ...(effects.ssr ? { metalrough: vec2(metalness, roughness) } : {}),
      velocity,
    }),
  );
  const scenePassColor: AnyNode = scenePass.getTextureNode('output');
  const scenePassDepth: AnyNode = scenePass.getTextureNode('depth');
  const scenePassNormal: AnyNode = scenePass.getTextureNode('normal');
  scenePass.getTexture('normal').type = UnsignedByteType;
  const sceneNormal = sample((uv: AnyNode) => unpackRGBToNormal(scenePassNormal.sample(uv)));
  const antialias = (node: AnyNode): AnyNode =>
    traa(node, scenePassDepth, scenePass.getTextureNode('velocity'), camera);

  let composite: AnyNode = scenePassColor;
  if (effects.ssgi) {
    const giPass: AnyNode = ssgi(scenePassColor, scenePassDepth, sceneNormal, camera);
    giPass.sliceCount.value = effects.ssgi.sliceCount;
    giPass.stepCount.value = effects.ssgi.stepCount;
    giPass.giIntensity.value = effects.ssgi.giIntensity;
    giPass.useTemporalFiltering = effects.temporalDenoise;
    const { radius, thickness, aoIntensity, useScreenSpaceSampling, fade: fadeRange } = effects.ssgi;
    if (radius !== undefined) giPass.radius.value = radius;
    if (thickness !== undefined) giPass.thickness.value = thickness;
    if (aoIntensity !== undefined) giPass.aoIntensity.value = aoIntensity;
    if (useScreenSpaceSampling !== undefined) giPass.useScreenSpaceSampling.value = useScreenSpaceSampling;
    let ao: AnyNode = giPass.getAONode();
    let gi: AnyNode = giPass.getGINode().rgb;
    if (fadeRange) {
      // fade AO/GI out in the distance (webgpu_higharc_ao), as in ssgi.ts
      const near = reference('near', 'float', camera) as AnyNode;
      const far = reference('far', 'float', camera) as AnyNode;
      const viewDistance = perspectiveDepthToViewZ(scenePassDepth.sample(screenUV).r, near, far).negate();
      const fade = smoothstep(fadeRange.start, fadeRange.end, viewDistance);
      ao = mix(ao, float(1), fade);
      gi = gi.mul(fade.oneMinus());
    }
    if (aoOutput) {
      // the ssgi example's "AO" output (TRAA-resolved like its combined output); background pixels are unoccluded
      const background = scenePassDepth.sample(screenUV).r.greaterThanEqual(1);
      renderPipeline.outputNode = antialias(vec4(vec3(background.select(float(1), ao)), 1));
      return renderPipeline;
    }
    scenePass.getTexture('diffuseColor').type = UnsignedByteType;
    const scenePassDiffuse: AnyNode = scenePass.getTextureNode('diffuseColor');
    composite = vec4(scenePassColor.rgb.mul(ao).add(scenePassDiffuse.rgb.mul(gi)), scenePassColor.a);
  }
  if (effects.ssr) {
    const params = effects.ssr;
    scenePass.getTexture('metalrough').type = UnsignedByteType;
    const scenePassMetalRough: AnyNode = scenePass.getTextureNode('metalrough');
    const ssrPass: AnyNode = ssr(scenePassColor, scenePassDepth, sceneNormal, {
      metalnessNode: scenePassMetalRough.r,
      roughnessNode: scenePassMetalRough.g,
      camera,
      binaryRefine: params.binaryRefine ?? false,
    });
    ssrPass.maxDistance.value = params.maxDistance;
    if (params.quality !== undefined) ssrPass.quality.value = params.quality;
    if (params.blurQuality !== undefined) ssrPass.blurQuality = params.blurQuality;
    if (params.intensity !== undefined) ssrPass.intensity.value = params.intensity;
    if (params.thickness !== undefined) ssrPass.thickness.value = params.thickness;
    ssrPass.resolutionScale = effects.resolutionScale ?? 1;
    // SSR outputs premultiplied color: additive blend over the beauty
    composite = composite.add(ssrPass.rgb);
  }
  renderPipeline.outputNode = antialias(composite);
  return renderPipeline;
}

export async function createCurrentRenderer(
  canvas: HTMLCanvasElement,
  sceneSetup: SceneSetup,
  { width, height, pass: renderPass, trackTimestamp = false }: RendererOptions,
): Promise<LiveRenderer> {
  const setup = { ...sceneSetup, effects: passEffects(sceneSetup, renderPass) };
  const { scene, camera, effects } = setup;
  // SSGI + SSR + TRAA scenes need all five attachments (40 bytes/sample, over WebGPU's default 32)
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    trackTimestamp,
    requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
  } as AnyNode);
  for (const [lightNode, light] of forkLights) renderer.library.addLight(lightNode, light);
  renderer.shadowMap.enabled = true;
  if (renderPass === 'ao') renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = effects.toneMapping;
  renderer.toneMappingExposure = effects.toneMappingExposure;
  await renderer.init();

  const currentScene = scene as AnyNode;
  if (setup.gradientBackground) {
    const { center, edge } = setup.gradientBackground;
    currentScene.backgroundNode = screenUV.distance(0.5).remap(0, 0.5).mix(color(center), color(edge));
  }
  if (setup.environment) {
    const pmremGenerator = new PMREMGenerator(renderer);
    currentScene.environment = pmremGenerator.fromScene(
      setup.environment.scene as AnyNode,
      setup.environment.sigma,
    ).texture;
    pmremGenerator.dispose();
  }

  const renderPipeline = createPipeline(renderer, setup, renderPass === 'ao');
  let frames = 0;
  const handle: LiveRenderer = {
    name: 'three-current',
    renderer: renderer as AnyNode,
    get frames() {
      return frames;
    },
    render() {
      renderPipeline.render();
      frames++;
    },
    setSize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    setCamera(newCamera) {
      if (newCamera !== camera) camera.copy(newCamera);
    },
    dispose() {
      renderPipeline.dispose();
      renderer.dispose();
    },
  };
  handle.setSize(width, height);
  return handle;
}
