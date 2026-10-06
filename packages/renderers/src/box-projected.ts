// Box-projected reflections: one cube map captured at the centre of the scene bounds, prefiltered by roughness
// (PMREM), looked up along the reflected ray's intersection with the bounds box instead of the raw direction.
import { Box3, CubeCamera, HalfFloatType, Vector3, type Object3D, type WebGLCubeRenderTarget } from 'three';
import { CubeRenderTarget, PMREMGenerator, type WebGPURenderer } from 'three/webgpu';
import {
  cameraPosition,
  max,
  min,
  normalWorld,
  pmremTexture,
  positionWorld,
  reflect,
  roughness,
  uniform,
} from 'three/tsl';

// biome-ignore lint/suspicious/noExplicitAny: TSL nodes are untyped
type AnyNode = any;

/** Direction from the capture centre to where the ray `origin + t*dir` leaves the box (t > 0 from inside). */
export function boxProjectDirection(origin: Vector3, dir: Vector3, box: Box3, center: Vector3): Vector3 {
  const tFar = (axis: 'x' | 'y' | 'z') =>
    Math.max((box.min[axis] - origin[axis]) / dir[axis], (box.max[axis] - origin[axis]) / dir[axis]);
  const t = Math.min(tFar('x'), tFar('y'), tFar('z'));
  return origin.clone().addScaledVector(dir, t).sub(center);
}

export function sceneBounds(scene: Object3D): Box3 {
  const bounds = new Box3();
  scene.updateMatrixWorld(true);
  scene.traverseVisible((object) => {
    if ((object as { isMesh?: boolean }).isMesh) bounds.union(new Box3().setFromObject(object, true));
  });
  return bounds;
}

export class BoxProjectedProbe {
  readonly radiance: AnyNode;
  private cubeTarget = new CubeRenderTarget(256, { type: HalfFloatType });
  private readonly cubeCamera = new CubeCamera(0.05, 1e4, this.cubeTarget);
  private readonly generator: PMREMGenerator;
  private pmrem;
  private readonly box = new Box3();
  private readonly center = new Vector3();
  private readonly boxMin = uniform(new Vector3());
  private readonly boxMax = uniform(new Vector3());
  private readonly captureCenter = uniform(new Vector3());

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: Object3D,
  ) {
    this.generator = new PMREMGenerator(renderer);
    this.capture();
    this.pmrem = this.generator.fromCubemap(this.cubeTarget.texture);
    const dir = reflect(positionWorld.sub(cameraPosition).normalize(), normalWorld.normalize());
    // same roughness blend as EnvironmentNode so rough surfaces don't gather light from behind their tangent plane
    const mixed = roughness.pow(4).mix(dir, normalWorld).normalize();
    const tMax = max(this.boxMax.sub(positionWorld).div(mixed), this.boxMin.sub(positionWorld).div(mixed));
    const t = min(min(tMax.x, tMax.y), tMax.z);
    const projected = positionWorld.add(mixed.mul(t)).sub(this.captureCenter);
    this.radiance = pmremTexture(this.pmrem.texture, projected, roughness);
  }

  /** Re-renders the scene from the bounds centre and prefilters it; call after the lighting changed. */
  update() {
    // fresh targets per capture: re-rendering into a target that was already sampled destroys its texture mid-frame
    this.cubeTarget.dispose();
    this.cubeTarget = new CubeRenderTarget(256, { type: HalfFloatType });
    this.cubeCamera.renderTarget = this.cubeTarget as unknown as WebGLCubeRenderTarget;
    this.capture();
    const previous = this.pmrem;
    this.pmrem = this.generator.fromCubemap(this.cubeTarget.texture);
    this.radiance.value = this.pmrem.texture;
    previous.dispose();
  }

  private capture() {
    this.box.copy(sceneBounds(this.scene));
    if (this.box.isEmpty()) this.box.set(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    this.box.getCenter(this.center);
    this.boxMin.value.copy(this.box.min);
    this.boxMax.value.copy(this.box.max);
    this.captureCenter.value.copy(this.center);
    this.cubeCamera.position.copy(this.center);
    this.cubeCamera.update(this.renderer, this.scene);
  }

  dispose() {
    this.cubeTarget.dispose();
    this.pmrem.dispose();
    this.generator.dispose();
  }
}
