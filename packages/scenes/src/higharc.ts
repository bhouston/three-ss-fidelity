// Scene of three.js examples/webgpu_higharc_ao.html (Dogwood house, sun + HDR sky) at its default parameters.
import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import type { SceneContext, SceneDefinition, SceneSetup } from './types.js';

const WIDTH = 640;
const HEIGHT = 480;

// The model is in meters; the original viewer works in inches, so its distances are scaled by this.
const INCH = 0.0254;

async function createDogwood(ctx: SceneContext): Promise<SceneSetup> {
  const scene = new Scene();

  const hdr = await ctx.loadHDR('textures/equirectangular/blouberg_sunrise_2_1k.hdr');
  hdr.mapping = EquirectangularReflectionMapping;
  scene.environment = hdr;
  scene.background = hdr;
  scene.environmentIntensity = 0.6;
  scene.backgroundIntensity = 0.6;

  const model = (await ctx.loadGLTF('models/gltf/Dogwood.glb')).scene;
  model.traverse((child) => {
    if ((child as Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  scene.add(model);

  const box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());
  const target = box.getCenter(new Vector3());
  const span = size.length();

  // initial pose; near/far as the example's animate() sets them for the orbit distance
  const distance = span * 1.2;
  const camera = new PerspectiveCamera(
    35,
    WIDTH / HEIGHT,
    Math.max(INCH, distance * 0.01),
    Math.max(span * 4, distance + span * 4),
  );
  camera.position.copy(target).add(new Vector3(0.8, 0.5, 1).normalize().multiplyScalar(distance));
  camera.lookAt(target);

  const ground = new Mesh(
    new PlaneGeometry(span * 20, span * 20),
    new MeshStandardMaterial({ color: 0xb0b0a8, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = box.min.y;
  ground.receiveShadow = true;
  scene.add(ground);

  // sun, with the shadow camera fitted to the model
  const sun = new DirectionalLight(0xfff4e5, 3);
  sun.position.copy(target).add(new Vector3(-0.5, 1, 0.6).normalize().multiplyScalar(span));
  sun.target.position.copy(target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -span * 0.6;
  sun.shadow.camera.right = sun.shadow.camera.top = span * 0.6;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = span * 2;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  return {
    scene,
    camera,
    target,
    effects: {
      // params: ssgi on, ssr off, quality 'medium', intensity 1, radius 120", resolutionScale 2
      ssgi: {
        sliceCount: 2,
        stepCount: 8,
        giIntensity: (1 * Math.PI * Math.PI) / 2,
        radius: 120 * INCH,
        thickness: 8 * INCH,
        aoIntensity: 1.5,
        useScreenSpaceSampling: false,
        fade: { start: 6000 * INCH, end: 14000 * INCH },
      },
      temporalDenoise: true,
      resolutionScale: 1 / 2,
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 1,
      frames: 128,
    },
  };
}

export const higharcScenes: SceneDefinition[] = [
  {
    name: 'higharc_dogwood',
    description:
      'HighArc example: Dogwood house under a sun and HDR sky, SSGI (half resolution) with temporal denoising.',
    width: WIDTH,
    height: HEIGHT,
    create: createDogwood,
  },
];
