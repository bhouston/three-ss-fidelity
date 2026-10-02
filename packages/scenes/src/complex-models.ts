import {
  ACESFilmicToneMapping,
  Box3,
  CircleGeometry,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import { extractLights } from './gltf-examples.js';
import type { SceneContext, SceneDefinition, SceneSetup } from './types.js';

const WIDTH = 640;
const HEIGHT = 480;
// Toward the sun in source coordinates, entering each room's window wall.
const windowSun: Record<string, { direction: [number, number, number]; portals?: string[] }> = {
  bedroom: { direction: [0.3, 0.6, -1], portals: ['mesh_69_instance_0', 'mesh_69_instance_1'] },
  'breakfast-room': { direction: [1, 0.5, 0.2] },
  'contemporary-bathroom': { direction: [-1, 0.7, 0.2], portals: ['Light_0001'] },
  'country-kitchen': { direction: [0.3, 0.7, -1], portals: ['mesh_295'] },
  'grey-and-white-room': { direction: [-1, 0.6, 0.2] },
};
const models = [
  {
    name: 'khronos-transmission-test',
    file: 'transmission-test',
    description: 'Khronos transmission, roughness and thickness reference grid.',
  },
  {
    name: 'model-bedroom',
    file: 'bedroom',
    description: 'Bitterli bedroom interior with glass and indirect illumination.',
  },
  {
    name: 'model-breakfast-room',
    file: 'breakfast-room',
    description: 'Bitterli breakfast room with detailed furniture and daylight.',
  },
  { name: 'model-coffee-maker', file: 'coffee-maker', description: 'Bitterli coffee maker with transmissive glass.' },
  {
    name: 'model-contemporary-bathroom',
    file: 'contemporary-bathroom',
    description: 'Bitterli contemporary bathroom with glass and reflective fixtures.',
  },
  {
    name: 'model-country-kitchen',
    file: 'country-kitchen',
    description: 'Bitterli country kitchen with detailed furniture and materials.',
  },
  {
    name: 'model-grey-and-white-room',
    file: 'grey-and-white-room',
    description: 'Bitterli grey and white room with reflective and transmissive surfaces.',
  },
  {
    name: 'model-headphone-with-stand',
    file: 'headphone-with-stand',
    description: 'Headphone and stand with curved surfaces and glossy materials.',
    floor: true,
  },
];

async function createModel(entry: (typeof models)[number], ctx: SceneContext): Promise<SceneSetup> {
  const scene = new Scene();
  const gltf = await ctx.loadGLTF(`suite-assets/complex-scenes/${entry.file}.glb`);
  const model = gltf.scene;
  // Keep source dimensions: embedded cameras, transmission thickness and attenuation use these units.
  const bounds = new Box3().setFromObject(model);
  const center = bounds.getCenter(new Vector3());
  const span = bounds.getSize(new Vector3()).length();
  if (!Number.isFinite(span) || span <= 0) throw new Error(`Empty model: ${entry.file}`);
  model.traverse((child) => {
    if ((child as Mesh).isMesh) {
      const mesh = child as Mesh;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // Raster shadow maps treat transmission as opaque. Let glass admit direct sunlight.
      child.castShadow = !materials.every(
        (material) => 'transmission' in material && Number(material.transmission) > 0,
      );
      // Daylight and the sun replace the source area emitters covering window openings.
      if (windowSun[entry.file]?.portals?.includes(child.name)) child.visible = false;
      child.receiveShadow = true;
    }
  });
  scene.add(model);

  const interior = windowSun[entry.file];
  const hdr = await ctx.loadHDR(
    `textures/equirectangular/${interior ? 'blouberg_sunrise_2_1k.hdr' : 'ferndale_studio_04_1k.hdr'}`,
  );
  hdr.mapping = EquirectangularReflectionMapping;
  scene.environment = hdr;
  scene.background = hdr;
  const lights = extractLights(hdr);
  if (interior) {
    const sun = new DirectionalLight(0xffedce, 5);
    sun.name = 'window-sun';
    sun.position.fromArray(interior.direction);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    lights.push(sun);
  }
  for (const light of lights) {
    light.position
      .normalize()
      .multiplyScalar(span * 2)
      .add(center);
    light.target.position.copy(center);
    light.shadow.camera.left = light.shadow.camera.bottom = -span;
    light.shadow.camera.right = light.shadow.camera.top = span;
    light.shadow.camera.near = span * 0.01;
    light.shadow.camera.far = span * 4;
    light.shadow.normalBias = span * 0.001;
    scene.add(light, light.target);
  }

  let embedded: PerspectiveCamera | undefined;
  model.traverse((child) => {
    if (!embedded && (child as PerspectiveCamera).isPerspectiveCamera) embedded = child as PerspectiveCamera;
  });
  const camera = new PerspectiveCamera(embedded?.fov ?? 45, WIDTH / HEIGHT, span * 0.001, span * 20);
  const target = center.clone();
  if (embedded) {
    embedded.getWorldPosition(camera.position);
    embedded.getWorldQuaternion(camera.quaternion);
    target.copy(camera.position).addScaledVector(camera.getWorldDirection(new Vector3()), span * 0.3);
  } else {
    const direction = entry.file === 'transmission-test' ? new Vector3(0, 0, 1) : new Vector3(-1, 0.35, 1);
    camera.position.copy(center).addScaledVector(direction.normalize(), span * 1.2);
    camera.lookAt(target);
  }
  if (entry.floor) {
    const floor = new Mesh(
      new CircleGeometry(span * 0.8, 64),
      new MeshStandardMaterial({ color: 0x808080, roughness: 0.3 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(center.x, bounds.min.y - span * 0.001, center.z);
    floor.receiveShadow = true;
    scene.add(floor);
  }
  return {
    scene,
    camera,
    target,
    effects: {
      ssgi: {
        sliceCount: 4,
        stepCount: 16,
        radius: span * 0.15,
        thickness: span * 0.01,
        giIntensity: Math.PI ** 2 / 2,
        useScreenSpaceSampling: false,
      },
      ssr: { maxDistance: span, thickness: span * 0.01 },
      temporalDenoise: true,
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 1,
      frames: 128,
    },
  };
}

export const complexModelScenes: SceneDefinition[] = models.map((entry) => ({
  name: entry.name,
  description: entry.description,
  width: WIDTH,
  height: HEIGHT,
  create: (ctx) => createModel(entry, ctx),
}));
