// TRAA velocity for planar mirrors. A mirror pixel shows reflected content, which moves like the *virtual* point behind
// the mirror, not like the mirror surface the stock velocity node reports; reprojecting its history with the surface
// velocity smears and ghosts the reflection whenever the camera moves.
import { Matrix4 } from 'three';
import { Node } from 'three/webgpu';
import { positionView, screenUV, uniform, vec2, vec4, velocity as stockVelocity } from 'three/tsl';

// The fork's TSL nodes are ahead of @types/three.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyNode = any;
const velocity: AnyNode = stockVelocity;

/**
 * Velocity of the content a mirror pixel shows. The reflector's depth gives the virtual camera's distance to the
 * reflected point, so the point lies at that distance along the main camera's ray through this pixel. It is static
 * (the mirror and the reflected scene don't move), so its velocity is just the camera's reprojection of it.
 * Needs the reflector created with `depth: true`.
 */
export function reflectedVelocity(reflection: AnyNode): AnyNode {
  const base = reflection.reflector;
  const virtualProjectionInverse: AnyNode = uniform(new Matrix4());
  virtualProjectionInverse.onRenderUpdate(({ camera }: { camera: { matrixWorld: Matrix4 } }) => {
    const virtualCamera = base.virtualCameras.get(camera);
    if (virtualCamera) virtualProjectionInverse.value.copy(virtualCamera.projectionMatrix).invert();
  });
  const cameraWorld: AnyNode = uniform(new Matrix4());
  cameraWorld.onRenderUpdate(({ camera }: { camera: { matrixWorld: Matrix4 } }) =>
    cameraWorld.value.copy(camera.matrixWorld),
  );

  const uv = screenUV.flipX();
  const virtualClip = vec4(vec2(uv.x, uv.y).mul(2).sub(1), reflection.getDepthNode().r, 1);
  const virtualView = virtualProjectionInverse.mul(virtualClip);
  const reflected = positionView.normalize().mul(virtualView.xyz.div(virtualView.w).length());

  const current = velocity.currentProjectionMatrix.mul(vec4(reflected, 1));
  const previous = velocity.previousProjectionMatrix
    .mul(velocity.previousCameraViewMatrix)
    .mul(cameraWorld.mul(vec4(reflected, 1)));
  // `velocity` itself stays in the graph so its matrices are refreshed for this draw
  return current.xy.div(current.w).sub(previous.xy.div(previous.w)).add(velocity.mul(0));
}

/** The pre-pass velocity: a mirror material's own reflected velocity, the stock velocity for everything else. */
export class MirrorAwareVelocityNode extends Node {
  static get type() {
    return 'MirrorAwareVelocityNode';
  }

  constructor() {
    super('vec2');
  }

  override setup(builder: AnyNode) {
    return builder.material?.userData.mirrorVelocity ?? velocity;
  }
}
