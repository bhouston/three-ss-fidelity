// Asset-free TRAA diagnostics: high-frequency, unlit/emissive content so the only thing that differs between
// renderers/frame-counts is antialiasing quality, not lighting or GI. Used to numerically measure the audited
// TRAANode.js gaps (bilinear history -> blur under motion, single-tap current sample -> residual jitter
// shimmer, RGB clip, no sharpening) against the path-traced reference.
import {
  BoxGeometry,
  Color,
  DataTexture,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  Vector3,
} from 'three';
import type { SceneDefinition, SceneEffects, SceneSetup } from './types.js';

const WIDTH = 480;
const HEIGHT = 360;

const effects: SceneEffects = {
  temporalDenoise: false,
  toneMapping: NoToneMapping,
  toneMappingExposure: 1,
  frames: 64,
};

/**
 * A 2x2 black/white texture repeated at high frequency with nearest filtering and no mipmaps: worst-case
 * screen-space aliasing (no texture-side prefiltering), so all antialiasing must come from the AA pass.
 */
function checkerTexture(): DataTexture {
  // prettier-ignore
  const data = new Uint8Array([
    235, 235, 235, 255,   20, 20, 20, 255,
     20,  20,  20, 255,  235, 235, 235, 255,
  ]);
  const texture = new DataTexture(data, 2, 2, RGBAFormat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.repeat.set(48, 48);
  texture.needsUpdate = true;
  return texture;
}

/** Emissive-only material (black base, roughness 1): renders identically as pure radiance on the rasterizer's PBR
 * shading (no lights in these scenes) and the path tracer's emission, per the ssr-diagnostics.ts pattern. */
function emissive(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0x000000, metalness: 0, roughness: 1, emissive: color });
}

/** A sub-pixel-width bright line: exercises reconstruction of geometry thinner than a texel. */
function thinLine(x: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(0.015, 2.4, 0.015), emissive(0xffffff));
  mesh.position.set(x, 1.0, -1.6);
  mesh.name = `thin-line-${x}`;
  return mesh;
}

function checkerFloorMaterial(): MeshStandardMaterial {
  const material = emissive(0xffffff);
  material.emissiveMap = checkerTexture();
  return material;
}

function checkerScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0x000000);

  const plane = new Mesh(new PlaneGeometry(10, 10), checkerFloorMaterial());
  plane.rotation.x = -Math.PI / 2.6; // oblique, receding into the distance: high-frequency detail near the horizon
  plane.position.set(0, -0.3, -2.5);
  plane.name = 'checker-floor';
  scene.add(plane);

  for (const x of [-1.6, -0.8, -0.2, 0.2, 0.8, 1.6]) scene.add(thinLine(x));

  return scene;
}

function checkerSetup(): SceneSetup {
  const camera = new PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 1.1, 2.6);
  const target = new Vector3(0, 0.4, -1.8);
  camera.lookAt(target);
  return { scene: checkerScene(), camera, target, effects, aoRadius: 1 };
}

/** A static background checker plane plus an opaque foreground slab that CLI `--motion-object` slides across it. */
function disocclusionSetup(): SceneSetup {
  const scene = new Scene();
  scene.background = new Color(0x000000);

  const plane = new Mesh(new PlaneGeometry(10, 6), checkerFloorMaterial());
  plane.position.set(0, 0.8, -2.2);
  plane.name = 'checker-wall';
  scene.add(plane);

  // Home (rest) position is x=0; `--motion-object slider-box:2` starts it at x=+2 and slides it back over moveFrames,
  // uncovering (disoccluding) the checker pattern it swept over.
  const slider = new Mesh(new BoxGeometry(1.4, 2.2, 0.2), emissive(0xd23c3c));
  slider.position.set(0, 0.8, -1.0);
  slider.name = 'slider-box';
  scene.add(slider);

  const camera = new PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 0.9, 2.6);
  const target = new Vector3(0, 0.8, -2.2);
  camera.lookAt(target);
  return { scene, camera, target, effects, aoRadius: 1 };
}

function diagnostic(name: string, description: string, create: () => SceneSetup): SceneDefinition {
  return { name, description, width: WIDTH, height: HEIGHT, create: async () => create() };
}

export const traaDiagnosticScenes: SceneDefinition[] = [
  diagnostic(
    'traa-checker',
    'Oblique high-frequency checker floor (no mipmaps) plus sub-pixel-width bright lines, TRAA: static convergence and pan/orbit blur test.',
    checkerSetup,
  ),
  diagnostic(
    'traa-disocclusion',
    'Static checker wall with an opaque slab that CLI --motion-object slides across it, TRAA: disocclusion ghosting test.',
    disocclusionSetup,
  ),
];
