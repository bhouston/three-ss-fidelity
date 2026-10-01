// Scenes of three.js examples/webgpu_postprocessing_ssr.html (steampunk camera over a metal disc).
import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { Material } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { SceneContext, SceneDefinition, SceneEffects, SceneSetup } from './types.js';

const WIDTH = 640;
const HEIGHT = 480;

const effects: SceneEffects = {
  ssr: { quality: 0.5, blurQuality: 1, maxDistance: 1, intensity: 1, thickness: 0.03, binaryRefine: false },
  temporalDenoise: false,
  toneMapping: ACESFilmicToneMapping,
  toneMappingExposure: 1,
  frames: 16,
};

/** @param roughness the example's "Model > roughness" slider; undefined keeps the authored roughness. */
async function createSteampunkCamera(ctx: SceneContext, roughness?: number): Promise<SceneSetup> {
  const camera = new PerspectiveCamera(35, WIDTH / HEIGHT, 0.1, 50);
  camera.position.set(3, 2, 3);
  const target = new Vector3(0, 0, 0); // OrbitControls default target
  camera.lookAt(target);

  const scene = new Scene();
  scene.environmentIntensity = 1.25;

  const gltf = await ctx.loadGLTF('models/gltf/steampunk_camera.glb');
  const model = gltf.scene;
  model.traverse((object) => {
    const material = (object as Mesh).material as Material | undefined;
    if (!material) return;
    if (material.name === 'Lense_Casing') material.transparent = true;
    material.side = FrontSide; // avoid overdrawing
    if (roughness !== undefined) (material as MeshStandardMaterial).roughness = roughness;
  });
  model.position.y = 0.1;
  scene.add(model);

  const floor = new Mesh(
    new CircleGeometry(2, 64),
    new MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.5 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.8;
  scene.add(floor);

  return {
    scene,
    camera,
    target,
    effects,
    gradientBackground: { center: new Color(0x888877), edge: new Color(0x776666) },
    environment: { scene: new RoomEnvironment(), sigma: 0.04 },
  };
}

const roughnessValues = [0, 0.25, 0.5, 1];

export const ssrScenes: SceneDefinition[] = [
  {
    name: 'ssr-steampunk-camera',
    description: 'SSR example: steampunk camera (authored roughness) over a metal disc, RoomEnvironment lighting.',
    width: WIDTH,
    height: HEIGHT,
    create: (ctx) => createSteampunkCamera(ctx),
  },
  ...roughnessValues.map((roughness) => ({
    name: `ssr-steampunk-camera-roughness-${Math.round(roughness * 100)}`,
    description: `SSR example with the model roughness slider at ${roughness}.`,
    width: WIDTH,
    height: HEIGHT,
    create: (ctx: SceneContext) => createSteampunkCamera(ctx, roughness),
  })),
];
