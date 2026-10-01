// Asset-free experiments: isolate light transport from textures, SSR, ambient light and tone mapping.
import {
  BoxGeometry,
  Color,
  Mesh,
  MeshPhysicalMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  Vector3,
} from 'three';
import type { SceneDefinition, SceneEffects, SceneSetup, SSGIEffect } from './types.js';

const WIDTH = 480;
const HEIGHT = 360;

function effects(overrides: Partial<SSGIEffect> = {}): SceneEffects {
  return {
    ssgi: { sliceCount: 2, stepCount: 8, giIntensity: Math.PI ** 2 / 2, ...overrides },
    temporalDenoise: true,
    toneMapping: NoToneMapping,
    toneMappingExposure: 1,
    frames: 128,
  };
}

function material(albedo: number, emission = 0): MeshPhysicalMaterial {
  // Numeric RGB values are linear. IOR 1 minimizes the specular lobe; the path tracer still uses
  // Disney diffuse rather than raster Lambert, so these are transport diagnostics, not exact BRDF tests.
  return new MeshPhysicalMaterial({
    color: new Color().setRGB(albedo, albedo, albedo),
    emissive: new Color().setRGB(emission, emission, emission),
    roughness: 1,
    ior: 1,
  });
}

function plane(
  scene: Scene,
  name: string,
  width: number,
  height: number,
  surface: MeshPhysicalMaterial,
  position: [number, number, number],
  rotation: [number, number, number],
): void {
  const mesh = new Mesh(new PlaneGeometry(width, height), surface);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
}

function setup(fov = 65): SceneSetup {
  const scene = new Scene();
  scene.background = new Color(0);
  const camera = new PerspectiveCamera(fov, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 4, 4);
  const target = new Vector3(0, 0, 0);
  camera.lookAt(target);
  return { scene, camera, target, effects: effects(), aoRadius: 4 };
}

function floor(scene: Scene, surface: MeshPhysicalMaterial): void {
  plane(scene, 'receiver-floor', 10, 10, surface, [0, 0, 0], [-Math.PI / 2, 0, 0]);
}

function walls(scene: Scene, surface: MeshPhysicalMaterial): void {
  plane(scene, 'back', 10, 6, surface, [0, 3, -5], [0, 0, 0]);
  plane(scene, 'front', 10, 6, surface, [0, 3, 5], [0, Math.PI, 0]);
  plane(scene, 'left', 10, 6, surface, [-5, 3, 0], [0, Math.PI / 2, 0]);
  plane(scene, 'right', 10, 6, surface, [5, 3, 0], [0, -Math.PI / 2, 0]);
  plane(scene, 'ceiling', 10, 10, surface, [0, 6, 0], [Math.PI / 2, 0, 0]);
}

function corner(overrides: Partial<SSGIEffect> = {}): SceneSetup {
  const result = setup(55);
  result.camera.position.set(0, 6, 10);
  result.target.set(0, 2, 0);
  result.camera.lookAt(result.target);
  floor(result.scene, material(0.5));
  // Black albedo prevents diffuse feedback from the receiver. All floor illumination comes from
  // the one visible emitting wall: a missing second diffuse bounce cannot explain an energy deficit.
  plane(result.scene, 'emitter', 10, 6, material(0, 0.5), [0, 3, -5], [0, 0, 0]);
  result.effects = effects(overrides);
  return result;
}

// High-frequency radiance next to a depth discontinuity: catches color bleeding that a smooth wall hides.
function hierarchyDiscontinuity(): SceneSetup {
  const result = corner({ sliceCount: 8, stepCount: 32, radius: 32 });
  result.scene.remove(result.scene.getObjectByName('emitter')!);
  for (let x = 0; x < 16; x++) {
    const stripe = material(0);
    stripe.emissive.setRGB(x % 2 ? 0.8 : 0, x % 2 ? 0 : 0.8, 0);
    plane(result.scene, `emitter-stripe-${x}`, 10 / 16, 6, stripe, [-5 + ((x + 0.5) * 10) / 16, 3, -5], [0, 0, 0]);
  }
  const blocker = new Mesh(new BoxGeometry(0.08, 5, 0.08), material(0));
  blocker.name = 'thin-blocker';
  blocker.position.set(0, 2.5, -3);
  result.scene.add(blocker);
  return result;
}

function enclosure(fov: number): SceneSetup {
  const result = setup(fov);
  floor(result.scene, material(0.5));
  walls(result.scene, material(0, 0.5));
  // Same geometry and center camera ray for both views. Narrow FOV sees only the unlit receiver,
  // while the path tracer can still hit the emitting walls outside the image.
  return result;
}

function diffuseRoom(albedo: number, open = false): SceneSetup {
  const result = setup(90);
  const surface = material(albedo);
  floor(result.scene, surface);
  walls(result.scene, surface);
  if (open) {
    // These two entire planes are outside this camera's view. Remove actual geometry, not just
    // primary-ray visibility, so the path tracer loses their bounce contribution too.
    for (const name of ['front', 'ceiling']) {
      const wall = result.scene.getObjectByName(name) as Mesh;
      result.scene.remove(wall);
      wall.geometry.dispose();
    }
  }
  const light = new PointLight(0xffffff, 12);
  light.position.set(0, 5, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  result.scene.add(light);
  return result;
}

function diagnostic(name: string, description: string, create: () => SceneSetup): SceneDefinition {
  return { name, description, width: WIDTH, height: HEIGHT, create: async () => create() };
}

export const giDiagnosticScenes: SceneDefinition[] = [
  diagnostic(
    'gi-hierarchy-discontinuity',
    'Alternating red/green emissive stripes behind a thin black occluder: radiance-mip bleeding.',
    hierarchyDiscontinuity,
  ),
  diagnostic(
    'gi-emitter-corner',
    'Single-bounce control: gray floor lit only by a visible black-albedo emissive wall.',
    () => corner(),
  ),
  diagnostic('gi-emitter-corner-dense', 'Same single-bounce corner, with 8 slices / 32 steps instead of 2 / 8.', () =>
    corner({ sliceCount: 8, stepCount: 32 }),
  ),
  diagnostic('gi-emitter-corner-thick', 'Same single-bounce corner, with thickness 4 instead of 1.', () =>
    corner({ thickness: 4 }),
  ),
  diagnostic(
    'gi-emitter-enclosure-wide',
    'Gray floor surrounded by five equal-radiance emitting walls; wide view sees some emitters.',
    () => enclosure(100),
  ),
  diagnostic(
    'gi-emitter-enclosure-crop',
    'Identical emitting enclosure and center camera ray, cropped to show only the receiver floor.',
    () => enclosure(20),
  ),
  diagnostic(
    'gi-room-low-albedo',
    'Closed empty room with linear albedo 0.2 and one point light; weak higher-bounce contribution.',
    () => diffuseRoom(0.2),
  ),
  diagnostic('gi-room-high-albedo', 'Same closed room with linear albedo 0.8; strong higher-bounce contribution.', () =>
    diffuseRoom(0.8),
  ),
  diagnostic(
    'gi-room-open-low-albedo',
    'Albedo 0.2 room with the off-screen front wall and ceiling physically removed.',
    () => diffuseRoom(0.2, true),
  ),
  diagnostic(
    'gi-room-open-high-albedo',
    'Albedo 0.8 room with the off-screen front wall and ceiling physically removed.',
    () => diffuseRoom(0.8, true),
  ),
];
