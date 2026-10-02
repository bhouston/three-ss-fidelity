// Independent DDGI-style extension of the Three.js SH bake addon. See docs/DDGI_RESEARCH.md.
import {
  AnalyticLightNode,
  HalfFloatType,
  LinearFilter,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  Vector3,
} from 'three/webgpu';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import {
  array,
  cameraPosition,
  float,
  Fn,
  getShIrradianceAt,
  If,
  ivec2,
  ivec3,
  normalWorld,
  positionWorld,
  screenCoordinate,
  texture,
  texture3D,
  textureLoad,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { ATLAS_COLUMNS, DISTANCE_RESOLUTION, IRRADIANCE_RESOLUTION } from './visibility.js';

const signNonzero = (value) => value.greaterThanEqual(0).select(1, -1);
const encodeOct = (direction) => {
  const p = direction.div(direction.abs().x.add(direction.abs().y).add(direction.abs().z));
  return p.z
    .lessThan(0)
    .select(vec2(p.y.abs().oneMinus().mul(signNonzero(p.x)), p.x.abs().oneMinus().mul(signNonzero(p.y))), p.xy)
    .mul(0.5)
    .add(0.5);
};
const atlasUV = (index, uv, interior, rows) => {
  const tile = interior + 2;
  return vec2(index.mod(ATLAS_COLUMNS), index.div(ATLAS_COLUMNS).floor())
    .mul(tile)
    .add(uv.mul(interior).add(1))
    .div(vec2(ATLAS_COLUMNS * tile, rows * tile));
};

/** Each fragment reads eight probes, with one offset, one visibility and one irradiance fetch each. */
export class DDGIProbeNode extends AnalyticLightNode {
  static get type() {
    return 'DDGIProbeNode';
  }
  constructor(light = null) {
    super(light);
    this._min = uniform(new Vector3());
    this._res = uniform(new Vector3());
    this._spacing = uniform(new Vector3());
    this._distanceScale = uniform(1);
    this._intensity = uniform(1);
  }
  update() {
    const light = this.light;
    this._min.value.copy(light.boundingBox.min);
    this._res.value.copy(light.resolution);
    this._spacing.value.copy(light.ddgi.spacing);
    this._distanceScale.value = light.ddgi.distanceScale;
    this._intensity.value = light.intensity;
  }
  setup(builder) {
    const light = this.light;
    if (!light.irradianceTarget) return;
    const data = textureLoad(light.ddgi.probeData);
    const distance = texture(light.ddgi.distanceTexture);
    const irradiance = texture(light.irradianceTarget.texture);
    const rows = light.ddgi.rows;
    const res = this._res,
      spacing = this._spacing,
      min = this._min;
    const result = Fn(() => {
      const clearance = spacing.x.min(spacing.y).min(spacing.z);
      // Much smaller than the basic addon's half-cell bias. Both biases are in world-space cell units.
      const biased = positionWorld
        .add(normalWorld.mul(clearance.mul(0.08)))
        .add(cameraPosition.sub(positionWorld).normalize().mul(clearance.mul(0.02)))
        .toVar();
      const gridPosition = biased.sub(min).div(spacing).clamp(vec3(0), res.sub(1)).toVar();
      const base = gridPosition.floor().min(res.sub(2)).toVar();
      const alpha = gridPosition.sub(base).clamp(0, 1).toVar();
      const total = vec3(0).toVar(),
        weights = float(0).toVar();
      const normalUV = encodeOct(normalWorld).toVar();
      for (let corner = 0; corner < 8; corner++) {
        const offset = vec3(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
        const cell = base.add(offset).toVar();
        const index = cell.x.add(cell.y.mul(res.x)).add(cell.z.mul(res.x).mul(res.y)).toVar();
        const relocation = data.load(ivec2(cell.x, cell.y.add(cell.z.mul(res.y)))).toVar();
        const probePosition = min.add(cell.mul(spacing)).add(relocation.xyz).toVar();
        const toReceiver = biased.sub(probePosition).toVar();
        const length = toReceiver.length().max(1e-6).toVar();
        const direction = toReceiver.div(length).toVar();
        const moments = distance.sample(atlasUV(index, encodeOct(direction), DISTANCE_RESOLUTION, rows)).rg.toVar();
        const queryDistance = length.div(this._distanceScale).toVar();
        const variance = moments.y.sub(moments.x.mul(moments.x)).max(1e-6).toVar();
        const delta = queryDistance.sub(moments.x).max(0).toVar();
        const visibility = variance
          .div(variance.add(delta.mul(delta)))
          .pow(3)
          .toVar();
        const toProbe = probePosition.sub(positionWorld).normalize();
        const wrap = normalWorld.dot(toProbe).mul(0.5).add(0.5).pow(2).add(0.2);
        const blend = offset.mul(alpha).add(offset.oneMinus().mul(alpha.oneMinus()));
        const weight = blend.x.mul(blend.y).mul(blend.z).mul(wrap).mul(visibility).mul(relocation.w).toVar();
        const value = irradiance.sample(atlasUV(index, normalUV, IRRADIANCE_RESOLUTION, rows)).rgb;
        total.addAssign(value.mul(weight));
        weights.addAssign(weight);
      }
      // No unoccluded fallback when every probe is invalid/blocked. Tiny weights fade to black.
      return total.div(weights.max(1e-6)).mul(this._intensity);
    })();
    builder.context.irradiance.addAssign(result);
  }
}

/** Convert nine SH coefficients to a seam-padded directional irradiance atlas on the GPU. */
function irradianceConversion(shTexture, resolution, count) {
  const sh = texture3D(shTexture);
  const tile = IRRADIANCE_RESOLUTION + 2;
  const output = Fn(() => {
    const pixel = screenCoordinate.floor().toVar();
    const index = pixel.x
      .div(tile)
      .floor()
      .add(pixel.y.div(tile).floor().mul(ATLAS_COLUMNS))
      .min(count - 1)
      .toVar();
    const ix = index.mod(resolution.x),
      iy = index.div(resolution.x).floor().mod(resolution.y);
    const iz = index.div(resolution.x * resolution.y).floor();
    const x = pixel.x.mod(tile).sub(1).toVar(),
      y = pixel.y.mod(tile).sub(1).toVar();
    If(x.lessThan(0), () => {
      x.assign(0);
      y.assign(float(IRRADIANCE_RESOLUTION - 1).sub(y));
    });
    If(x.greaterThanEqual(IRRADIANCE_RESOLUTION), () => {
      x.assign(IRRADIANCE_RESOLUTION - 1);
      y.assign(float(IRRADIANCE_RESOLUTION - 1).sub(y));
    });
    If(y.lessThan(0), () => {
      y.assign(0);
      x.assign(float(IRRADIANCE_RESOLUTION - 1).sub(x));
    });
    If(y.greaterThanEqual(IRRADIANCE_RESOLUTION), () => {
      y.assign(IRRADIANCE_RESOLUTION - 1);
      x.assign(float(IRRADIANCE_RESOLUTION - 1).sub(x));
    });
    const oct = vec2(x, y).add(0.5).div(IRRADIANCE_RESOLUTION).mul(2).sub(1).toVar();
    const z = oct.x.abs().add(oct.y.abs()).oneMinus().toVar();
    const folded = vec2(oct.y.abs().oneMinus().mul(signNonzero(oct.x)), oct.x.abs().oneMinus().mul(signNonzero(oct.y)));
    const normal = vec3(z.lessThan(0).select(folded, oct), z).normalize();
    const components = [];
    for (let subvolume = 0; subvolume < 7; subvolume++) {
      const packed = sh.load(ivec3(ix, iy, iz.add(1 + subvolume * (resolution.z + 2)))).toVar();
      components.push(packed.x, packed.y, packed.z, packed.w);
    }
    const coefficients = array(Array.from({ length: 9 }, (_, i) => vec3(...components.slice(i * 3, i * 3 + 3))));
    return vec4(getShIrradianceAt(normal, coefficients).max(vec3(0)), 1);
  })();
  return { sh, output };
}

export class DDGIProbeGrid extends LightProbeGrid {
  constructor(fitted, ddgi) {
    super(...fitted.size.toArray(), ...fitted.resolution.toArray());
    this.type = 'DDGIProbeGrid';
    this.position.copy(fitted.center);
    this.ddgi = ddgi;
    const tile = IRRADIANCE_RESOLUTION + 2;
    this.irradianceTarget = new RenderTarget(ATLAS_COLUMNS * tile, ddgi.rows * tile, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this._conversion = null;
    this._conversionQuad = new QuadMesh(new NodeMaterial());
  }
  getProbePosition(ix, iy, iz, target) {
    super.getProbePosition(ix, iy, iz, target);
    const index = ix + iy * this.resolution.x + iz * this.resolution.x * this.resolution.y;
    const offsets = this.ddgi.offsets;
    return target.add(new Vector3(offsets[index * 4], offsets[index * 4 + 1], offsets[index * 4 + 2]));
  }
  _updateBounceGrid(renderer, scene, pass, start) {
    super._updateBounceGrid(renderer, scene, pass, start);
    if (pass > 0 && start === 0) {
      const snapshot = this._bounceGrid;
      snapshot._lightNode = DDGIProbeNode;
      snapshot.ddgi = this.ddgi;
      snapshot.irradianceTarget = this.irradianceTarget;
      this.convertIrradiance(renderer, snapshot.texture);
    }
  }
  convertIrradiance(renderer, source = this.texture) {
    if (!this._conversion) {
      this._conversion = irradianceConversion(
        source,
        this.resolution,
        this.resolution.x * this.resolution.y * this.resolution.z,
      );
      this._conversionQuad.material.fragmentNode = this._conversion.output;
    }
    this._conversion.sh.value = source;
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel();
    try {
      renderer.setRenderTarget(this.irradianceTarget);
      this._conversionQuad.render(renderer);
    } finally {
      renderer.setRenderTarget(target, face, mip);
    }
  }
  dispose() {
    super.dispose();
    this.irradianceTarget.dispose();
    this._conversionQuad.material.dispose();
    this.ddgi.dispose();
  }
}
DDGIProbeGrid.registerNode(DDGIProbeNode);
