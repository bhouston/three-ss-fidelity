// A closed room lit only by sun through a window onto a tilted mirror: the bright patch on the floor exists solely
// because the mirror reflects the sun, so renderers that ignore light bounced off mirrors leave it dark.
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import type { SceneDefinition, SceneInstance } from './types.js';

const WIDTH = 640;
const HEIGHT = 480;

function createMirrorSun(): SceneInstance {
  const camera = new PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 4, 13);
  const target = new Vector3(-1, 2, 0);
  camera.lookAt(target);

  const scene = new Scene();
  scene.background = new Color(0x000000);

  const white = new MeshStandardMaterial({ color: 0xdddddd, roughness: 1 });
  const solid = (width: number, height: number, depth: number, x: number, y: number, z: number) => {
    const mesh = new Mesh(new BoxGeometry(width, height, depth), white);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  };
  // 10 x 6 x 10 room open toward the camera; the right wall has a window (y 2..4, z -1..1) facing the sun
  solid(10, 0.2, 10, 0, -0.1, 0); // floor
  solid(10, 0.2, 10, 0, 6.1, 0); // ceiling
  solid(10, 6, 0.2, 0, 3, -5.1); // back wall
  solid(0.2, 6, 10, -5.1, 3, 0); // left wall
  solid(0.2, 2, 10, 5.1, 1, 0); // right wall below the window
  solid(0.2, 2, 10, 5.1, 5, 0); // right wall above the window
  solid(0.2, 2, 4, 5.1, 3, -3); // right wall beside the window
  solid(0.2, 2, 4, 5.1, 3, 3);

  // mirror on the left wall, tilted down so the reflected sun lands on the floor
  const mirror = new Mesh(
    new PlaneGeometry(3, 3),
    new MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0 }),
  );
  mirror.position.set(-4.98, 2.5, 0);
  mirror.lookAt(mirror.position.x + Math.cos(0.35), mirror.position.y - Math.sin(0.35), 0);
  mirror.receiveShadow = true;
  scene.add(mirror);

  const sun = new DirectionalLight(0xfff2dd, 4);
  sun.position.set(30, 1.5, 0);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.camera.far = 80;
  scene.add(sun, sun.target);
  scene.add(new AmbientLight(0xffffff, 0.02));

  return {
    scene,
    camera,
    target,
    effects: {
      ssgi: { sliceCount: 8, stepCount: 32, radius: 32, thickness: 4, giIntensity: (Math.PI * Math.PI) / 2 },
      ssr: { maxDistance: 20 },
      temporalDenoise: true,
      toneMapping: NoToneMapping,
      toneMappingExposure: 1,
      frames: 128,
    },
  };
}

export const mirrorSunScenes: SceneDefinition[] = [
  {
    name: 'mirror-sun-room',
    description: 'Room lit by sun through a window onto a tilted mirror; the floor patch is reflected sunlight.',
    width: WIDTH,
    height: HEIGHT,
    create: async () => createMirrorSun(),
  },
];
