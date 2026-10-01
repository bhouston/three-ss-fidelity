// Asset-free SSR diagnostics: isolate screen-space reflection behavior from lighting/GI by making every
// reflected object purely emissive (black base, roughness 1) and every receiver's diffuse black (metal, or
// black dielectric), so the only thing that differs between renderers is the reflection itself.
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import type { SceneDefinition, SceneEffects, SceneEnvironment, SceneSetup } from './types.js';

const WIDTH = 480;
const HEIGHT = 360;

// Distinct, non-clipping linear hues so each emitter is unambiguous in a reflection.
const RED: [number, number, number] = [0.85, 0.05, 0.05];
const GREEN: [number, number, number] = [0.05, 0.8, 0.1];
const BLUE: [number, number, number] = [0.05, 0.15, 0.85];
const YELLOW: [number, number, number] = [0.8, 0.75, 0.05];

function effects(maxDistance: number, thickness: number): SceneEffects {
  return {
    ssr: { quality: 0.5, blurQuality: 1, maxDistance, intensity: 1, thickness, binaryRefine: false },
    temporalDenoise: false,
    toneMapping: NoToneMapping,
    toneMappingExposure: 1,
    frames: 16,
  };
}

// Large BackSide sphere with a smooth vertical two-tone gradient (top brighter), dim relative to emitters so
// ray-miss fallback is visible but never dominates a reflection of an emitter.
function environment(): SceneEnvironment {
  const radius = 50;
  const geometry = new SphereGeometry(radius, 32, 16);
  const position = geometry.attributes.position!;
  const top = new Color().setRGB(0.3, 0.3, 0.34);
  const bottom = new Color().setRGB(0.1, 0.1, 0.12);
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = position.getY(i) / radius / 2 + 0.5; // -1..1 -> 0..1
    const c = bottom.clone().lerp(top, t);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const scene = new Scene();
  scene.add(new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, side: BackSide })));
  return { scene, sigma: 0.05 };
}

function emissiveMaterial([r, g, b]: [number, number, number]): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: 1,
    emissive: new Color().setRGB(r, g, b),
  });
}

/** White metal receiver: diffuse is irrelevant at metalness 1, so color only shapes the specular tint. */
function metal(roughness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness });
}

/** Black dielectric receiver (default IOR 1.5): no diffuse GI, only the Fresnel specular lobe SSR must find. */
function dielectric(roughness: number): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({ color: 0x000000, metalness: 0, roughness });
}

/** Non-reflective black floor for the wall/sphere scenes, where the floor is not the surface under test. */
function matte(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0x000000, metalness: 0, roughness: 1 });
}

function addEmitter(
  scene: Scene,
  geometry: BufferGeometry,
  color: [number, number, number],
  position: [number, number, number],
  name: string,
): void {
  const mesh = new Mesh(geometry, emissiveMaterial(color));
  mesh.position.set(...position);
  mesh.name = name;
  scene.add(mesh);
}

/**
 * Box, sphere, cylinder and a taller box at varied heights, standing on a floor at y=0, kept close to the
 * camera: a mirror floor's reflection of a point occupies roughly height * distance / cameraHeight floor-space
 * units, so distant or low-camera framings squeeze reflections into a sliver of pixels near the horizon.
 */
function standardEmitters(scene: Scene): void {
  addEmitter(scene, new BoxGeometry(0.6, 0.6, 0.6), RED, [-1.0, 0.3, -0.4], 'box-red');
  addEmitter(scene, new SphereGeometry(0.35, 24, 16), GREEN, [0, 0.35, -0.9], 'sphere-green');
  addEmitter(scene, new CylinderGeometry(0.25, 0.25, 0.9, 24), BLUE, [1.0, 0.45, -0.5], 'cylinder-blue');
  addEmitter(scene, new BoxGeometry(0.4, 1.1, 0.4), YELLOW, [0.4, 0.55, -1.4], 'box-yellow-tall');
}

function floor(scene: Scene, material: Material): void {
  const mesh = new Mesh(new PlaneGeometry(10, 10), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'receiver-floor';
  scene.add(mesh);
}

function baseSetup(
  cameraPos: [number, number, number],
  target: [number, number, number],
  fov: number,
  maxDistance: number,
  thickness: number,
): SceneSetup {
  const scene = new Scene();
  const camera = new PerspectiveCamera(fov, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(...cameraPos);
  const targetVector = new Vector3(...target);
  camera.lookAt(targetVector);
  return {
    scene,
    camera,
    target: targetVector,
    effects: effects(maxDistance, thickness),
    gradientBackground: { center: new Color().setRGB(0.22, 0.22, 0.24), edge: new Color().setRGB(0.14, 0.14, 0.16) },
    environment: environment(),
  };
}

function mirror(receiver: Material): SceneSetup {
  const setup = baseSetup([0, 2.3, 3.2], [0, 0.3, -0.8], 50, 6, 0.05);
  floor(setup.scene, receiver);
  standardEmitters(setup.scene);
  return setup;
}

function grazing(): SceneSetup {
  const setup = baseSetup([0, 0.9, 3.6], [0, 0.3, -0.8], 50, 8, 0.05);
  floor(setup.scene, metal(0));
  standardEmitters(setup.scene);
  return setup;
}

function offscreen(): SceneSetup {
  const setup = baseSetup([0, 1.6, 2.6], [0, 0.3, -0.8], 35, 8, 0.05);
  floor(setup.scene, metal(0));
  standardEmitters(setup.scene);
  // Outside the frustum entirely: only the floor reflection can reveal it, testing screen-space ray misses.
  addEmitter(setup.scene, new BoxGeometry(0.5, 0.5, 0.5), YELLOW, [0, 0.5, 4.5], 'box-behind-camera');
  return setup;
}

function occlusion(): SceneSetup {
  const setup = baseSetup([0, 1.8, 3.0], [0, 0.4, -0.8], 45, 6, 0.05);
  floor(setup.scene, metal(0));
  addEmitter(setup.scene, new BoxGeometry(0.7, 1.3, 0.4), GREEN, [0, 0.65, -1.3], 'box-far');
  addEmitter(setup.scene, new BoxGeometry(0.9, 0.7, 0.5), RED, [0, 0.35, -0.5], 'box-near');
  addEmitter(setup.scene, new CylinderGeometry(0.025, 0.025, 1.2, 12), BLUE, [0.2, 0.6, -0.9], 'pole-thin');
  return setup;
}

function wall(): SceneSetup {
  const setup = baseSetup([0, 1.6, 4.5], [0, 1.2, -2], 45, 6, 0.05);
  floor(setup.scene, matte());
  const wallMesh = new Mesh(new PlaneGeometry(8, 4), metal(0.05));
  wallMesh.position.set(0, 2, -3);
  wallMesh.name = 'receiver-wall';
  setup.scene.add(wallMesh);
  addEmitter(setup.scene, new BoxGeometry(0.6, 0.6, 0.6), RED, [-1.4, 0.9, -1.5], 'box-red');
  addEmitter(setup.scene, new SphereGeometry(0.35, 24, 16), GREEN, [0.2, 1.0, -1.2], 'sphere-green');
  addEmitter(setup.scene, new CylinderGeometry(0.25, 0.25, 0.9, 24), BLUE, [1.5, 0.9, -1.6], 'cylinder-blue');
  return setup;
}

function sphere(): SceneSetup {
  const setup = baseSetup([0, 2.2, 5], [0, 1.2, 0], 45, 6, 0.05);
  floor(setup.scene, matte());
  const sphereMesh = new Mesh(new SphereGeometry(1.2, 48, 32), metal(0.1));
  sphereMesh.position.set(0, 1.2, 0);
  sphereMesh.name = 'receiver-sphere';
  setup.scene.add(sphereMesh);
  addEmitter(setup.scene, new BoxGeometry(0.5, 0.5, 0.5), RED, [-2.2, 0.7, 1.2], 'box-red');
  addEmitter(setup.scene, new SphereGeometry(0.3, 20, 14), GREEN, [2.0, 0.9, 0.8], 'sphere-green');
  addEmitter(setup.scene, new CylinderGeometry(0.2, 0.2, 0.8, 20), BLUE, [0, 0.85, 2.4], 'cylinder-blue');
  addEmitter(setup.scene, new BoxGeometry(0.4, 1.0, 0.4), YELLOW, [-1.6, 1.0, 2.0], 'box-yellow');
  return setup;
}

/**
 * Mirror floor reflecting glossy metal objects (a chrome sphere, a rough-0.3 gold box rotated 45°) that themselves
 * reflect an overhead panel (out of frame, and whose own floor reflection is below the frame) and low emitters. The
 * floor sees the metals from below and the camera sees them from above, so a reflection of a metal differs strongly
 * from the camera's view of it: this isolates the view dependence of SSR hit radiance.
 */
function metalHit(): SceneSetup {
  const setup = baseSetup([0, 2.3, 3.2], [0, 0.3, -0.8], 50, 6, 0.05);
  floor(setup.scene, metal(0));
  // floating, so each reflection is separated from its object and shows the object's underside
  const chrome = new Mesh(new SphereGeometry(0.4, 48, 32), metal(0));
  chrome.position.set(-0.65, 0.75, -0.9);
  chrome.name = 'receiver-chrome-sphere';
  setup.scene.add(chrome);
  const gold = new Mesh(
    new BoxGeometry(0.6, 0.6, 0.6),
    new MeshStandardMaterial({ color: new Color().setRGB(1, 0.78, 0.34), metalness: 1, roughness: 0.3 }),
  );
  gold.position.set(0.7, 0.7, -0.9);
  gold.rotation.set(0, Math.PI / 4, 0);
  gold.name = 'receiver-gold-box';
  setup.scene.add(gold);
  addEmitter(setup.scene, new BoxGeometry(2.4, 0.05, 1.2), [0.9, 0.85, 0.7], [0, 3, 1.2], 'panel-overhead');
  addEmitter(setup.scene, new BoxGeometry(2.2, 0.04, 0.6), RED, [0, 0.02, -0.9], 'tile-red-low');
  addEmitter(setup.scene, new CylinderGeometry(0.15, 0.15, 1.2, 24), BLUE, [0.05, 0.6, -1.9], 'cylinder-blue');
  addEmitter(setup.scene, new SphereGeometry(0.2, 20, 14), GREEN, [-1.6, 0.2, -0.3], 'sphere-green');
  return setup;
}

function diagnostic(name: string, description: string, create: () => SceneSetup): SceneDefinition {
  return { name, description, width: WIDTH, height: HEIGHT, create: async () => create() };
}

export const ssrDiagnosticScenes: SceneDefinition[] = [
  diagnostic(
    'ssr-diag-mirror',
    'Mirror metal floor (roughness 0) with emissive box/sphere/cylinder emitters at ~30° elevation.',
    () => mirror(metal(0)),
  ),
  ...[10, 30, 60].map((percent) =>
    diagnostic(`ssr-diag-rough-${percent}`, `Same mirror layout with floor roughness ${percent / 100}.`, () =>
      mirror(metal(percent / 100)),
    ),
  ),
  ...[0, 30].map((percent) =>
    diagnostic(
      `ssr-diag-dielectric-${percent}`,
      `Same layout with a black dielectric floor (metalness 0, roughness ${percent / 100}, IOR 1.5): tests Fresnel and whether SSR reflects non-metals.`,
      () => mirror(dielectric(percent / 100)),
    ),
  ),
  diagnostic(
    'ssr-diag-grazing',
    'Mirror floor viewed at a low ~8° grazing angle: stretching, Fresnel, depth precision.',
    grazing,
  ),
  diagnostic(
    'ssr-diag-offscreen',
    'Mirror floor with emitters partly above the frame and one entirely behind the camera: ray misses / edge fade / environment fallback.',
    offscreen,
  ),
  diagnostic(
    'ssr-diag-occlusion',
    'An emitter partially hidden behind a closer emitter, plus a 0.05-wide emissive pole: thickness and hidden-geometry handling.',
    occlusion,
  ),
  diagnostic(
    'ssr-diag-wall',
    'Vertical metal mirror wall (roughness 0.05) reflecting emitters, over a matte black floor.',
    wall,
  ),
  diagnostic(
    'ssr-diag-sphere',
    'Large metal sphere (roughness 0.1) surrounded by emitters, over a matte black floor: curved normals.',
    sphere,
  ),
  diagnostic(
    'ssr-diag-metal-hit',
    'Mirror floor reflecting a chrome sphere and a rough-0.3 gold box that themselves reflect an overhead panel and low emitters: view-dependent radiance at SSR hits.',
    metalHit,
  ),
];
