import {
  Fn,
  If,
  abs,
  clamp,
  dot,
  exp,
  float,
  floor,
  max,
  perspectiveDepthToViewZ,
  pow,
  reference,
  screenUV,
  textureSize,
  unpackRGBToNormal,
  vec2,
  vec4,
} from 'three/tsl';

// Joint bilateral reconstruction of a reduced-resolution GI/AO signal. Geometry stays at full
// resolution for ray visibility and for the reconstruction guide; no averaged silhouette depths.
export function bilateralUpsample(gi, ao, depth, normal, camera) {
  const near = reference('near', 'float', camera);
  const far = reference('far', 'float', camera);
  return Fn(() => {
    const size = vec2(textureSize(gi, 0));
    const depthSize = vec2(textureSize(depth, 0));
    const position = screenUV.mul(size).sub(0.5);
    const center = floor(position.add(0.5));
    const viewZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, near, far);
    const n = unpackRGBToNormal(normal.sample(screenUV)).normalize();
    const sum = vec4(0).toVar();
    const weightSum = float(0).toVar();
    const bestWeight = float(0).toVar();
    const nearestUV = clamp(center, vec2(0), size.sub(1)).add(0.5).div(size);
    const fallback = vec4(gi.sample(nearestUV).rgb, ao.sample(nearestUV).r).toVar();
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        const pixel = clamp(center.add(vec2(x, y)), vec2(0), size.sub(1));
        const uv = pixel.add(0.5).div(size);
        // Match SSGINode's receiver texel selection, including non-divisible target dimensions.
        const guideUV = floor(uv.mul(depthSize).sub(0.25)).add(0.5).div(depthSize);
        const z = perspectiveDepthToViewZ(depth.sample(guideUV).r, near, far);
        const sampleNormal = unpackRGBToNormal(normal.sample(guideUV)).normalize();
        const distance = pixel.sub(position);
        const spatial = exp(dot(distance, distance).mul(-0.5));
        const geometry = exp(
          abs(z.sub(viewZ))
            .div(max(abs(viewZ).mul(0.02), 0.01))
            .negate(),
        ).mul(pow(max(dot(n, sampleNormal), 0), 32));
        const weight = spatial.mul(geometry);
        const signal = vec4(gi.sample(uv).rgb, ao.sample(uv).r);
        sum.addAssign(signal.mul(weight));
        weightSum.addAssign(weight);
        If(weight.greaterThan(bestWeight), () => {
          bestWeight.assign(weight);
          fallback.assign(signal);
        });
      }
    }
    // Thin surfaces can have no matching receiver in the coarse grid. Use the best available
    // sample rather than divide by zero or inject black GI / black AO.
    return weightSum.greaterThan(1e-6).select(sum.div(max(weightSum, 1e-6)), fallback);
  })();
}
