// glTF models of three.js examples webgl_loader_gltf, webgl_loader_gltf_compressed and webgl_animation_keyframes, restaged
// for the WebGPU screen-space pipeline: each model is normalized to unit size on a glossy floor disc, lit only by an HDR
// environment (also the background) and framed from the example's viewing direction.
import {
  ACESFilmicToneMapping,
  AnimationMixer,
  Box3,
  CircleGeometry,
  EquirectangularReflectionMapping,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { SceneContext, SceneDefinition, SceneEffects, SceneSetup } from './types.js';

const WIDTH = 640;
const HEIGHT = 480;

/** Animation time (seconds) at which animated models are frozen, identical for every renderer. */
const POSE_TIME = 2;

const effects: SceneEffects = {
  // world-space sampling, sized for the unit-size models
  ssgi: {
    sliceCount: 4,
    stepCount: 16,
    radius: 0.25,
    thickness: 0.05,
    giIntensity: (Math.PI * Math.PI) / 2,
    useScreenSpaceSampling: false,
  },
  ssr: { maxDistance: 1, thickness: 0.03 },
  antialias: 'traa',
  temporalDenoise: true,
  toneMapping: ACESFilmicToneMapping,
  toneMappingExposure: 1,
  frames: 128,
};

interface GLTFExample {
  name: string;
  description: string;
  /** Relative to three.js examples/. */
  model: string;
  hdr: string;
  fov: number;
  /** From the model's center toward the camera (the example's camera relative to its OrbitControls target). */
  view: Vector3;
  /** Camera distance relative to fitting the model's largest dimension (the webgl_loader_gltf fitCameraToSelection). */
  fitOffset: number;
}

async function createGLTFExample(example: GLTFExample, ctx: SceneContext): Promise<SceneSetup> {
  const scene = new Scene();
  const hdr = await ctx.loadHDR(`textures/equirectangular/${example.hdr}`);
  hdr.mapping = EquirectangularReflectionMapping;
  scene.environment = hdr;
  scene.background = hdr;

  const gltf = await ctx.loadGLTF(example.model);
  const model = gltf.scene;
  const clip = gltf.animations[0];
  if (clip) {
    const mixer = new AnimationMixer(model);
    mixer.clipAction(clip).play();
    mixer.setTime(POSE_TIME);
  }

  // unit size, standing on the floor at the origin
  let box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());
  model.scale.multiplyScalar(1 / Math.max(size.x, size.y, size.z));
  box = new Box3().setFromObject(model);
  const center = box.getCenter(new Vector3());
  model.position.sub(new Vector3(center.x, box.min.y, center.z));
  scene.add(model);

  const floor = new Mesh(new CircleGeometry(1.5, 64), new MeshStandardMaterial({ color: 0x808080, roughness: 0.4 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const target = new Vector3(0, (box.max.y - box.min.y) / 2, 0);
  const distance = example.fitOffset / (2 * Math.tan((example.fov * Math.PI) / 360));
  const camera = new PerspectiveCamera(example.fov, WIDTH / HEIGHT, distance / 100, distance * 100);
  camera.position.copy(target).addScaledVector(example.view.clone().normalize(), distance);
  camera.lookAt(target);

  return { scene, camera, target, effects, aoRadius: 0.25 };
}

const examples: GLTFExample[] = [
  {
    name: 'gltf-damaged-helmet',
    description: 'webgl_loader_gltf: DamagedHelmet on a glossy floor, ferndale studio HDR lighting.',
    model: 'models/gltf/DamagedHelmet/glTF/DamagedHelmet.gltf',
    hdr: 'ferndale_studio_04_1k.hdr',
    fov: 45,
    view: new Vector3(-1.8, 0.6, 2.9),
    fitOffset: 1.8,
  },
  {
    name: 'gltf-coffeemat',
    description:
      'webgl_loader_gltf_compressed: coffeemat.glb (meshopt geometry, KTX2 textures) on a glossy floor, ferndale studio HDR lighting.',
    model: 'models/gltf/coffeemat.glb',
    hdr: 'ferndale_studio_04_1k.hdr',
    fov: 45,
    view: new Vector3(-10, 10, 16),
    fitOffset: 1.5,
  },
  {
    name: 'gltf-littlest-tokyo',
    description: `webgl_animation_keyframes: LittlestTokyo.glb (Draco) frozen at t=${POSE_TIME}s on a glossy floor, spruit sunrise HDR lighting.`,
    model: 'models/gltf/LittlestTokyo.glb',
    hdr: 'spruit_sunrise_1k.hdr',
    fov: 40,
    view: new Vector3(5, 1.3, 8),
    fitOffset: 1.4,
  },
];

export const gltfExampleScenes: SceneDefinition[] = examples.map((example) => ({
  name: example.name,
  description: example.description,
  width: WIDTH,
  height: HEIGHT,
  create: (ctx) => createGLTFExample(example, ctx),
}));
