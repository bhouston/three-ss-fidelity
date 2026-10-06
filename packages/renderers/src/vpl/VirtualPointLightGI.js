import { FloatType } from 'three';
import { rayIntersectionResultStruct } from 'three-mesh-bvh/webgpu';
import {
  Fn,
  If,
  Loop,
  dFdx,
  dFdy,
  float,
  ivec2,
  mix,
  normalWorldGeometry,
  packNormalToRGB,
  positionWorld,
  screenCoordinate,
  texture,
  unpackRGBToNormal,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { ProgressiveLightBake } from '../light-bake/ProgressiveLightBake.js';

/** Surface VPLs with reservoir importance sampling and exact BVH segment visibility.
 * Shares surface capture/lifecycle with the baker; transport gathers virtual lights,
 * with complementary cosine-weighted rays for singular near-field transport.
 */
export class VirtualPointLightGI extends ProgressiveLightBake {
  constructor(renderer, scene, options = {}) {
    super(renderer, scene, { samples: 2048, samplesPerFrame: 16, ...options });
  }
  seedSampleCount() {
    // Only area-light positions vary across seed samples. Repeating identical
    // point/spot/directional visibility rays adds cost without changing irradiance.
    return this.lights.some((light) => light.isRectAreaLight) ? 16 : 1;
  }
  normalTextureType() {
    // World area in alpha must not be quantized/clamped to [0,1]. Two float32
    // attachments fit the default 32-byte per-sample WebGPU attachment budget.
    return FloatType;
  }
  normalOutput() {
    const area = dFdx(positionWorld).cross(dFdy(positionWorld)).length();
    return vec4(packNormalToRGB(normalWorldGeometry), area);
  }
  bakeGraph() {
    return Fn((builder) => {
      rayIntersectionResultStruct.setup(builder);
      const tracer = this.createTrace();
      const pixel = ivec2(screenCoordinate.xy);
      const p = this.position.load(pixel).toVar();
      const receiverNormal = this.normal.load(pixel).toVar();
      const n = unpackRGBToNormal(receiverNormal.xyz).normalize().toVar();
      // Complementary smooth distance partition: hemisphere rays handle the
      // singular near field; virtual-light connections handle the far field.
      const radius = receiverNormal.w
        .sqrt()
        .mul(8)
        .max(this.epsilon * 5000)
        .toVar();
      const radiusSquared = radius.mul(radius).toVar();
      const previous = this.previous.load(pixel).toVar();
      const sum = vec3(0).toVar();
      If(p.w.greaterThan(0), () => {
        const tangent = n.z
          .abs()
          .lessThan(0.999)
          .select(vec3(0, 0, 1), vec3(1, 0, 0))
          .cross(n)
          .normalize()
          .toVar();
        const bitangent = n.cross(tangent).toVar();
        Loop({ start: 0, end: this.samplesPerFrame, name: 'vplSample' }, ({ vplSample }) => {
          const localRandom = this.random(this.iteration.mul(this.samplesPerFrame).add(float(vplSample))).toVar();
          const phi = localRandom.y.mul(2 * Math.PI);
          const diskRadius = localRandom.x.sqrt();
          const localDirection = tangent
            .mul(diskRadius.mul(phi.cos()))
            .add(bitangent.mul(diskRadius.mul(phi.sin())))
            .add(n.mul(localRandom.x.oneMinus().sqrt()))
            .toVar();
          const localHit = tracer(p.xyz.add(n.mul(this.epsilon)), localDirection, radius).toVar();
          If(localHit.get('didHit').and(localHit.get('side').greaterThan(0)), () => {
            const indices = localHit.get('indices').toUVec4();
            const bary = localHit.get('barycoord').toVec3();
            const attrib = this.bvh.storage.attributes;
            const hitUV = attrib
              .element(indices.x)
              .get('uv1')
              .toVec2()
              .mul(bary.x)
              .add(attrib.element(indices.y).get('uv1').toVec2().mul(bary.y))
              .add(attrib.element(indices.z).get('uv1').toVec2().mul(bary.z))
              .toVar();
            const hitPosition = p.xyz
              .add(n.mul(this.epsilon))
              .add(localDirection.mul(localHit.get('dist')))
              .toVar();
            const localDistanceSquared = hitPosition.sub(p.xyz).dot(hitPosition.sub(p.xyz));
            const nearWeight = localDistanceSquared.div(radiusSquared).oneMinus().clamp().pow(2);
            const outgoing = this.albedo
              .sample(hitUV)
              .rgb.mul(texture(this.direct.texture).sample(hitUV).rgb.add(this.feedback.sample(hitUV).rgb))
              .add(this.emissive.sample(hitUV).rgb.mul(Math.PI));
            sum.addAssign(outgoing.mul(nearWeight));
          });
          const selectedPosition = vec3(0).toVar();
          const selectedNormal = vec3(0).toVar();
          const selectedContribution = vec3(0).toVar();
          const selectedTarget = float(0).toVar();
          // -1: a direct connection; otherwise the mirror whose image of the source was selected
          const selectedMirror = float(-1).toVar();
          const selectedImage = vec3(0).toVar();
          const selectedPlaneNormal = vec3(0).toVar();
          const selectedPlanePoint = vec3(0).toVar();
          const weightSum = float(0).toVar();
          // RIS: eight unshadowed candidates, one selected visibility ray. Empty
          // atlas texels remain zero-weight trials in the proposal distribution.
          Loop({ start: 0, end: 8, name: 'vplCandidate' }, ({ vplCandidate }) => {
            const index = this.iteration
              .mul(this.samplesPerFrame)
              .add(float(vplSample))
              .mul(8)
              .add(float(vplCandidate));
            // One progressive VPL candidate pool shared by all receivers.
            // Source fetches stay coherent; RIS weights/selection remain per receiver.
            const r = vec2(index.add(0.5).mul(0.754877666), index.add(0.5).mul(0.569840296)).fract().toVar();
            const q = ivec2(r.mul(this.atlas.size).floor());
            const source = this.position.load(q).toVar();
            const sourceNormal = this.normal.load(q).toVar();
            If(source.w.greaterThan(0).and(sourceNormal.w.greaterThan(0)), () => {
              const sn = unpackRGBToNormal(sourceNormal.xyz).normalize().toVar();
              const delta = source.xyz.sub(p.xyz).toVar();
              const distanceSquared = delta.dot(delta).toVar();
              const direction = delta.div(distanceSquared.max(1e-12).sqrt()).toVar();
              const cosines = n.dot(direction).max(0).mul(sn.dot(direction.negate()).max(0));
              const sourceUV = r.mul(this.atlas.size).floor().add(0.5).div(this.atlas.size);
              const radiance = this.albedo
                .sample(sourceUV)
                .rgb.mul(texture(this.direct.texture).sample(sourceUV).rgb.add(this.feedback.sample(sourceUV).rgb))
                .div(Math.PI)
                .add(this.emissive.sample(sourceUV).rgb);
              // Far weight cancels the inverse-square singularity; the near
              // ray above estimates precisely the complementary contribution.
              const nearWeight = distanceSquared.div(radiusSquared).oneMinus().clamp().pow(2);
              const contribution = radiance
                .mul(cosines)
                .mul(sourceNormal.w)
                .mul(nearWeight.oneMinus())
                .div(distanceSquared.max(1e-12))
                .toVar();
              const target = contribution.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
              const weight = target.mul(this.atlas.size * this.atlas.size).toVar();
              weightSum.addAssign(weight);
              const selectRandom = index
                .add(1)
                .mul(91.3458)
                .add(screenCoordinate.xy.toVec2().dot(vec2(17, 59)))
                .sin()
                .mul(47453.5453)
                .fract();
              If(target.greaterThan(0).and(selectRandom.mul(weightSum).lessThan(weight)), () => {
                selectedPosition.assign(source.xyz);
                selectedNormal.assign(sn);
                selectedContribution.assign(contribution);
                selectedTarget.assign(target);
                selectedMirror.assign(-1);
              });
              // Light that reaches the receiver through a planar mirror comes from the source's mirror image:
              // same estimator, with the path length, source orientation and tint of the reflected route.
              this.mirrors.forEach((mirror, mirrorIndex) => {
                const planeNormal = vec3(mirror.normal);
                const planePoint = vec3(mirror.point);
                const receiverSide = p.xyz.sub(planePoint).dot(planeNormal);
                const sourceSide = source.xyz.sub(planePoint).dot(planeNormal);
                If(receiverSide.greaterThan(this.epsilon).and(sourceSide.greaterThan(this.epsilon)), () => {
                  const image = source.xyz.sub(planeNormal.mul(sourceSide.mul(2))).toVar();
                  const imageNormal = sn.sub(planeNormal.mul(sn.dot(planeNormal).mul(2))).toVar();
                  const imageDelta = image.sub(p.xyz).toVar();
                  const imageDistanceSquared = imageDelta.dot(imageDelta).toVar();
                  const imageDirection = imageDelta.div(imageDistanceSquared.max(1e-12).sqrt()).toVar();
                  const imageCosines = n
                    .dot(imageDirection)
                    .max(0)
                    .mul(imageNormal.dot(imageDirection.negate()).max(0));
                  const imageNear = imageDistanceSquared.div(radiusSquared).oneMinus().clamp().pow(2);
                  const imageContribution = radiance
                    .mul(vec3(mirror.color.r, mirror.color.g, mirror.color.b))
                    .mul(imageCosines)
                    .mul(sourceNormal.w)
                    .mul(imageNear.oneMinus())
                    .div(imageDistanceSquared.max(1e-12))
                    .toVar();
                  const imageTarget = imageContribution.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
                  const imageWeight = imageTarget.mul(this.atlas.size * this.atlas.size).toVar();
                  weightSum.addAssign(imageWeight);
                  const imageRandom = index
                    .add(1 + 7919 * (mirrorIndex + 1))
                    .mul(91.3458)
                    .add(screenCoordinate.xy.toVec2().dot(vec2(17, 59)))
                    .sin()
                    .mul(47453.5453)
                    .fract();
                  If(imageTarget.greaterThan(0).and(imageRandom.mul(weightSum).lessThan(imageWeight)), () => {
                    selectedPosition.assign(source.xyz);
                    selectedNormal.assign(sn);
                    selectedContribution.assign(imageContribution);
                    selectedTarget.assign(imageTarget);
                    selectedMirror.assign(mirrorIndex);
                    selectedImage.assign(image);
                    selectedPlaneNormal.assign(planeNormal);
                    selectedPlanePoint.assign(planePoint);
                  });
                });
              });
            });
          });
          If(selectedTarget.greaterThan(0), () => {
            // Offset both ends into the respective outgoing hemispheres, then
            // trace just the connecting segment to exclude the emitter itself.
            const origin = p.xyz.add(n.mul(this.epsilon)).toVar();
            If(selectedMirror.lessThan(0), () => {
              const delta = selectedPosition.add(selectedNormal.mul(this.epsilon)).sub(origin).toVar();
              const distance = delta.length().toVar();
              If(distance.greaterThan(this.epsilon * 2), () => {
                const hit = tracer(origin, delta.div(distance), distance.sub(this.epsilon)).toVar();
                If(hit.get('didHit').not(), () => {
                  sum.addAssign(selectedContribution.mul(weightSum.div(selectedTarget.mul(8))));
                });
              });
            });
            If(selectedMirror.greaterThanEqual(0), () => {
              // Receiver -> mirror: the first surface along the ray to the image must be the mirror itself.
              const toImage = selectedImage.sub(origin).toVar();
              const imageDistance = toImage.length().toVar();
              const imageDirection = toImage.div(imageDistance.max(1e-12)).toVar();
              const first = tracer(origin, imageDirection, imageDistance).toVar();
              const reflection = origin.add(imageDirection.mul(first.get('dist'))).toVar();
              const onMirror = reflection
                .sub(selectedPlanePoint)
                .dot(selectedPlaneNormal)
                .abs()
                .lessThan(this.epsilon * 20);
              If(first.get('didHit').and(onMirror), () => {
                // Mirror -> source.
                const bounceOrigin = reflection.add(selectedPlaneNormal.mul(this.epsilon)).toVar();
                const toSource = selectedPosition.add(selectedNormal.mul(this.epsilon)).sub(bounceOrigin).toVar();
                const sourceDistance = toSource.length().toVar();
                const second = tracer(
                  bounceOrigin,
                  toSource.div(sourceDistance.max(1e-12)),
                  sourceDistance.sub(this.epsilon),
                ).toVar();
                If(second.get('didHit').not(), () => {
                  sum.addAssign(selectedContribution.mul(weightSum.div(selectedTarget.mul(8))));
                });
              });
            });
          });
        });
      });
      // Shared finite multibounce iteration policy: keep adapting source radiance.
      const weight = float(1).div(this.iteration.add(1)).max(0.04);
      return vec4(mix(previous.rgb, sum.div(this.samplesPerFrame), weight), p.w);
    })();
  }
}
