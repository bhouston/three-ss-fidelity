import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  abs,
  bool,
  cross,
  distance,
  div,
  dot,
  float,
  fract,
  getScreenPosition,
  hash,
  getViewPosition,
  int,
  ivec2,
  exp2,
  textureLoad,
  textureSize,
  logarithmicDepthToViewZ,
  luminance,
  max,
  min,
  mix,
  mul,
  nodeObject,
  normalize,
  orthographicDepthToViewZ,
  passTexture,
  perspectiveDepthToViewZ,
  pmremTexture,
  reference,
  reflect,
  sub,
  texture,
  trunc,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  viewZToPerspectiveDepth,
  context,
  DFGLUT,
  cos,
  sin,
  sqrt,
  property,
  outputStruct,
} from 'three/tsl';
import {
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  NodeMaterial,
  NodeUpdateType,
  PerspectiveCamera,
  QuadMesh,
  RGFormat,
  RedFormat,
  RenderTarget,
  RendererUtils,
  Node,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { bindAnalyticNoise } from 'three/addons/tsl/utils/RNoise.js';
import {
  ENV_RAY_LENGTH,
  getSpecularDominantFactor,
  ggxReflectionSample,
} from 'three/addons/tsl/utils/SpecularHelpers.js';
import { boxBlur } from 'three/addons/tsl/display/boxBlur.js';
import ImportanceSampledEnvironment from 'three/addons/tsl/display/ImportanceSampledEnvironment.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();
let _rendererState;

/** Whether a ratio-estimator sample is finite (NaN fails every comparison). */
const isFiniteSample = (v) =>
  v.a
    .greaterThanEqual(0)
    .and(v.a.lessThan(1e30))
    .and(luminance(v.rgb).greaterThanEqual(0))
    .and(luminance(v.rgb).lessThan(1e30));
const toYCoCg = (c) => vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25)));
const fromYCoCg = (c) => vec3(c.x.add(c.y).sub(c.z), c.x.add(c.z), c.x.sub(c.y).sub(c.z));
const insideScreen = (coord) =>
  coord.x.greaterThan(0).and(coord.x.lessThan(1)).and(coord.y.greaterThan(0)).and(coord.y.lessThan(1));
const halfFloatTarget = (name) => {
  const t = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
  t.texture.name = name;
  return t;
};
/** World position -> UV in the frame of a view-projection matrix ((-1, -1) behind the camera). */
const projectToUV = (world, viewProjection) => {
  const clip = viewProjection.mul(vec4(world, 1)).toVar();
  const screen = clip.xy.div(clip.w).mul(0.5).add(0.5);
  return clip.w.greaterThan(0).select(vec2(screen.x, screen.y.oneMinus()), vec2(-1));
};

/** Levels of the Hi-Z min-depth pyramid (level 0 = trace resolution). */
const HIZ_LEVELS = 7;

// Maximum ray-march step count; `quality` (0..1) scales it to a fixed per-ray count.
const MAX_STEPS = 64;

// Offsets the per-pixel noise seeds of the second bounce past every primary seed (4 per pixel), exact in float32.
const SECONDARY_NOISE_SALT = 2 ** 23;

/**
 * @typedef {Object} NewSSRNodeOptions
 * @property {boolean} [stochastic=false] - When `false`, traces a single mirror reflection and softens roughness with a blur pass (first-generation SSR). When `true`, varies the reflection direction per pixel with stochastic GGX rays (second-generation SSR); higher quality on rough/glossy surfaces but noisier, so it expects a temporal/spatial denoiser downstream.
 * @property {Node<float>} [metalnessNode=null] - Per-pixel metalness. Drives GGX reflection sampling and, with `reflectNonMetals=false`, the non-metal early-out.
 * @property {Node<float>} [roughnessNode=null] - Per-pixel roughness. Drives GGX sampling and the blur mip selection.
 * @property {boolean} [reflectNonMetals=false] - Only used when `stochastic=false`. When `false`, non-metallic surfaces are discarded for a noticeable performance gain; set `true` to also reflect dielectrics (e.g. marble, polished wood, plastic).
 * @property {Texture} [environmentNode=null] - Equirectangular HDR environment map with CPU-side `image.data` (e.g. from RGBELoader). Not compatible with PMREM / `scene.environment` cubemaps. With `outputRadiance`, any environment map instead (typically `scene.environment`), sampled prefiltered like the materials do.
 * @property {boolean} [envImportanceSampling=false] - When `true`, precomputes env-luminance CDF tables and uses MIS for environment misses. Build-time only.
 * @property {Node} [diffuseNode=null] - Scene diffuse / base color. Defaults to `vec3(1)` in the shader when omitted.
 * @property {boolean} [binaryRefine=false] - Sub-step binary-search refinement of detected hits. Compile-time constant (baked into the shader at construction).
 * @property {boolean} [outputRadiance=false] - When `true`, outputs the complete incoming reflected radiance without the BRDF weighting (Fresnel, metalness): the screen-space hits, blended toward the prefiltered `environmentNode` on misses and fades. It replaces the environment radiance of the materials via `builtinRadianceContext()`, like FidelityFX SSSR. Compile-time constant.
 * @property {Node} [hitMaterialNode=null] - Texture node of the pre-pass metalness (r) and roughness (g). With `hitSpecularNode`, a hit's view-dependent specular is re-evaluated for the reflected ray's direction instead of the camera's (radiance + accumulate mode only).
 * @property {Node} [hitSpecularNode=null] - Texture node of the pre-pass specular color (rgb, F0 blended by metalness) and specular F90 (a).
 * @property {Camera} [camera=null] - Camera the scene is rendered with. Inferred from the color pass when omitted.
 */

/**
 * Post processing node for computing screen space reflections (SSR).
 *
 * Reference: {@link https://lettier.github.io/3d-game-shaders-for-beginners/screen-space-reflection.html}
 *
 * @augments Node
 * @three_import import { newSSR } from '@ss-fidelity/renderers/ssr/NewSSRNode.js';
 *
 * Vendored copy of three.js fork's NewSSRNode.js so SSR can be modified without touching the submodule.
 */
class NewSSRNode extends Node {
  static get type() {
    return 'NewSSRNode';
  }

  /**
   * Constructs a new SSR node.
   *
   * @param {Node<vec4>} colorNode - The node that represents the beauty pass.
   * @param {Node<float>} depthNode - A node that represents the beauty pass's depth.
   * @param {Node<vec3>} normalNode - A node that represents the beauty pass's normals.
   * @param {NewSSRNodeOptions} [options] - Optional inputs for material and environment data.
   */
  constructor(colorNode, depthNode, normalNode, options = {}) {
    super('vec4');

    const {
      stochastic = false,
      metalnessNode = null,
      roughnessNode = null,
      reflectNonMetals = false,
      environmentNode = null,
      envImportanceSampling = false,
      diffuseNode = null,
      binaryRefine = false,
      outputRadiance = false,
      accumulate = false,
      backDepthNode = null,
      hitMaterialNode = null,
      hitSpecularNode = null,
      radianceHistoryNode = null,
      temporalFilter = false,
      velocityNode = null,
      maxMarchSteps = null,
      hiZ = false,
      // three-new-ssr-fast options (see SSRFastOptions in types.ts). Every default below reproduces
      // three-new-ssr's reference behavior exactly, so leaving them unset changes nothing.
      clipRaysToScreen = false,
      binaryRefineSteps = 8,
      secondBounceRoughnessCutoff = null,
      secondBounceQuality = null,
    } = options;

    /**
     * perf(three-new-ssr-fast): march step density, 0..1, for the second (hit-specular) bounce only.
     * `null` (three-new-ssr) uses the same density as the primary ray (`quality`). Compile-time constant.
     *
     * @type {?number}
     */
    this._secondBounceQuality = secondBounceQuality;

    /**
     * perf(three-new-ssr-fast): precompute the ray parameter where the march leaves the screen once per
     * ray, so the per-step bounds test is a single comparison instead of four. Bit-identical output
     * (same exit point, only the arithmetic differs). Compile-time constant.
     *
     * @type {boolean}
     */
    this._clipRaysToScreen = clipRaysToScreen;

    /**
     * perf(three-new-ssr-fast): bisection steps for binary-refinement hit refinement (three-new-ssr
     * always uses 8). Fewer steps trade contact precision for speed. Compile-time constant.
     *
     * @type {number}
     */
    this._binaryRefineSteps = binaryRefineSteps;

    /**
     * perf(three-new-ssr-fast): when set, the second (hit-specular) screen-space bounce skips its march
     * and reads the prefiltered environment directly for hits whose roughness is at or above this value
     * (a wide GGX lobe on a rough hit is already poorly approximated by one screen-space sample, so the
     * march's cost there buys little). `null` (three-new-ssr) always traces. Compile-time constant.
     *
     * @type {?number}
     */
    this._secondBounceRoughnessCutoff = secondBounceRoughnessCutoff;

    /**
     * Pre-pass G-buffer of each pixel's specular material (see `hitMaterialNode` / `hitSpecularNode`).
     *
     * @type {?Node}
     */
    this.hitMaterialNode = hitMaterialNode;
    this.hitSpecularNode = hitSpecularNode;

    /**
     * Without `accumulate`: the previous frame's filtered SSR radiance, sampled at a hit's current-frame UV (so
     * already reprojected), which the hit-specular redirection subtracts in place of the running mean's resolve
     * (three-new-ssr-rt with an external temporal filter). May be assigned after construction, before the first
     * render.
     *
     * @type {?Node}
     */
    this.radianceHistoryNode = radianceHistoryNode;

    /**
     * Optional depth of the nearest back faces (a BackSide depth pre-pass). When set, a depth crossing is
     * also a hit whenever the ray is still in front of that back face, i.e. inside the solid between the
     * front and back surface, instead of only within the heuristic `thickness` of the front surface.
     *
     * @type {?Node<float>}
     */
    this.backDepthNode = backDepthNode;

    let camera = options.camera ?? null;

    /**
     * When `true`, the reflection direction is varied per pixel with stochastic GGX rays
     * (second-generation SSR). When `false`, a single mirror reflection is traced and
     * roughness is softened with a blur pass (first-generation SSR).
     *
     * @type {boolean}
     */
    this.stochastic = stochastic;

    /**
     * When `true`, env-luminance CDF tables are built and MIS is used for environment misses.
     * Fixed at construction time.
     *
     * @type {boolean}
     */
    this.envImportanceSampling = envImportanceSampling;

    /**
     * When `true`, the output is the complete incoming reflected radiance without the BRDF
     * weighting, falling back to the prefiltered environment map, for use as the indirect
     * specular radiance of the materials. Fixed at construction time.
     *
     * @type {boolean}
     */
    this.outputRadiance = outputRadiance;

    /**
     * The node that represents the beauty pass.
     *
     * @type {Node<vec4>}
     */
    this.colorNode = colorNode;

    /**
     * A node that represents the scene's diffuse color (typically the MRT `diffuseColor` attachment).
     * When `null`, the shader uses `vec3(1)`.
     *
     * @type {?Node<vec4>}
     */
    this.diffuseNode = diffuseNode !== null ? nodeObject(diffuseNode) : null;

    /**
     * A node that represents the beauty pass's depth.
     *
     * @type {Node<float>}
     */
    this.depthNode = depthNode;

    /**
     * A node that represents the beauty pass's normals.
     *
     * @type {Node<vec3>}
     */
    this.normalNode = normalNode;

    /**
     * Per-pixel metalness, used to drive the GGX reflection sampling and the non-metal
     * early-out. When `null`, the shader treats surfaces as non-metallic.
     *
     * @type {?Node<float>}
     */
    this.metalnessNode = metalnessNode;

    /**
     * Per-pixel roughness, used to drive the GGX reflection sampling and the blur mip
     * selection. When `null`, the shader treats surfaces as fully smooth.
     *
     * @type {?Node<float>}
     */
    this.roughnessNode = roughnessNode;

    /**
     * Only used when {@link NewSSRNode#stochastic} is `false`. When `false`, non-metallic
     * surfaces are discarded for a noticeable performance gain; set `true` to also
     * reflect dielectrics. Baked into the shader as a compile-time constant; assigning a
     * new value recompiles the SSR material.
     *
     * @type {boolean}
     * @default false
     */
    this._reflectNonMetals = reflectNonMetals;

    /**
     * The resolution scale. Valid values are in the range
     * `[0,1]`. `1` means best quality but also results in
     * more computational overhead. Setting to `0.5` means
     * the effect is computed in half-resolution.
     *
     * @type {number}
     * @default 1
     */
    this.resolutionScale = 1;

    /**
     * The `updateBeforeType` is set to `NodeUpdateType.FRAME` since the node renders
     * its effect once per frame in `updateBefore()`.
     *
     * @type {string}
     * @default 'frame'
     */
    this.updateBeforeType = NodeUpdateType.FRAME;

    /**
     * Controls how far a fragment can reflect. Increasing this value result in more
     * computational overhead but also increases the reflection distance.
     *
     * @type {UniformNode<float>}
     */
    this.maxDistance = uniform(1);

    /**
     * Controls the cutoff between what counts as a possible reflection hit and what does not.
     *
     * @type {UniformNode<float>}
     */
    this.thickness = uniform(0.1);

    /**
     * A multiplier for the overall reflection intensity. `1` leaves the
     * reflections unchanged, lower values dim them and higher values boost them.
     *
     * @type {UniformNode<float>}
     * @default 1
     */
    this.intensity = uniform(1);

    /**
     * Screen-edge fade width, in UV units. As a screen-space hit approaches a screen
     * border, the reflection is faded over this distance — either toward the environment
     * reflection ({@link NewSSRNode#screenEdgeFadeBlack} `false`) or to zero intensity
     * (`true`). `0` disables it.
     *
     * @type {UniformNode<float>}
     * @default 0.2
     */
    this.screenEdgeFade = uniform(0.2);

    /**
     * When `true`, SSR fades to zero near screen borders instead of blending toward
     * the environment map. Hits are faded by the reflection sample UV; misses are
     * faded by the surface pixel UV.
     *
     * Baked into the shader as a compile-time constant so the unused fade branch is
     * eliminated; assigning a new value recompiles the SSR material.
     *
     * @type {boolean}
     * @default false
     */
    this._screenEdgeFadeBlack = false;

    /**
     * Absolute env luminance cap. HDR env samples above this are scaled down (hue preserved).
     *
     * @type {UniformNode<float>}
     * @default 10
     */
    this.maxLuminance = uniform(10);

    /**
     * This parameter controls how detailed the raymarching process works.
     * The value ranges is `[0,1]` where `1` means best quality (the maximum number
     * of raymarching iterations/samples) and `0` means no samples at all.
     *
     * A quality of `0.5` is usually sufficient for most use cases. Try to keep
     * this parameter as low as possible. Larger values result in noticeable more
     * overhead.
     *
     * @type {UniformNode<float>}
     */
    this.quality = uniform(0.5);

    /**
     * Whether the noise pattern changes every frame or not. Animated noise is required
     * for temporal accumulation (e.g. `TemporalReprojectNode` or `TRAANode`) to converge.
     * Set it to `false` for a stable pattern, e.g. when only spatial denoising is used.
     *
     * @type {boolean}
     * @default true
     */
    this.useTemporalFiltering = true;

    /**
     * Mirror bias for the stochastic GGX sampling. Concentrates the reflected rays toward
     * the lobe's narrow (near-mirror) core, trading a small amount of bias for less noise.
     * `0` samples the full VNDF lobe; values toward `1` tighten the cone. Range `[0,1]`.
     *
     * @type {UniformNode<float>}
     * @default 0.5
     */
    this.mirrorBias = uniform(0.5);

    /**
     * The quality of the blur. Must be an integer in the range `[1,3]`.
     *
     * Baked into the blur shader as a compile-time constant so the `(size*2+1)²`
     * sample loop unrolls; assigning a new value recompiles the blur material.
     *
     * @type {number}
     * @default 2
     */
    this._blurQuality = 2;

    /**
     * Enables sub-step binary-search refinement of a detected hit. When on, a coarse
     * crossing is bisected toward the exact intersection (sharper hits, less step
     * aliasing) at the cost of extra depth samples. Baked into the shader as a
     * compile-time constant; assigning a new value rebuilds the SSR material.
     *
     * @type {boolean}
     * @default false
     */
    this._binaryRefine = binaryRefine;

    /**
     * Non-linear step distribution exponent. `1` = uniform steps; `> 1` concentrates
     * samples near the ray origin — where most short-range reflections are missed — and
     * spaces them out toward maxDistance, as `s = (i / steps) ^ stepExponent`.
     *
     * Baked into the shader as a compile-time constant so `pow()` folds to a few
     * multiplies; assigning a new value recompiles the SSR material. Only used by the
     * stochastic reflection path.
     *
     * @type {number}
     * @default 2
     */
    this._stepExponent = 2;

    /**
     * HDR environment map for screen-space misses. With {@link NewSSRNode#outputRadiance}, any
     * environment map (e.g. `scene.environment`); its rotation is not supported.
     *
     * @type {?Texture}
     */
    this.environmentNode = environmentNode;

    /**
     * A node that represents the history texture for multi-bounce reflections.
     *
     * @type {?Texture}
     */
    this.historyTexture = null;

    /**
     * A node that represents the velocity texture for reprojection.
     *
     * @type {?Node<vec2>}
     */
    this.velocityTexture = null;

    //

    if (camera === null) {
      if (this.colorNode.passNode && this.colorNode.passNode.isPassNode === true) {
        camera = this.colorNode.passNode.camera;
      } else {
        throw new Error('THREE.NewSSRNode: No camera found. ssr() requires a camera.');
      }
    }

    /**
     * The camera the scene is rendered with.
     *
     * @type {Camera}
     */
    this.camera = camera;

    /**
     * The spread of the blur. Automatically set when generating mips.
     *
     * @private
     * @type {UniformNode<int>}
     */
    this._blurSpread = uniform(1);

    /**
     * The mip level of the SSR texture the blur reads from. Automatically set when generating mips.
     *
     * @private
     * @type {UniformNode<float>}
     */
    this._blurSourceLevel = uniform(0);

    /**
     * Represents the projection matrix of the scene's camera.
     *
     * @private
     * @type {UniformNode<mat4>}
     */
    this._cameraProjectionMatrix = uniform(camera.projectionMatrix);

    /**
     * Represents the inverse projection matrix of the scene's camera.
     *
     * @private
     * @type {UniformNode<mat4>}
     */
    this._cameraProjectionMatrixInverse = uniform(camera.projectionMatrixInverse);

    /**
     * Represents the near value of the scene's camera.
     *
     * @private
     * @type {ReferenceNode<float>}
     */
    this._cameraNear = reference('near', 'float', camera);

    /**
     * Represents the far value of the scene's camera.
     *
     * @private
     * @type {ReferenceNode<float>}
     */
    this._cameraFar = reference('far', 'float', camera);

    this._cameraWorldMatrix = uniform(new Matrix4().copy(camera.matrixWorld));
    this._cameraWorldPosition = uniform(new Vector3().copy(camera.position));

    this._cameraViewMatrix = uniform(new Matrix4().copy(camera.matrixWorld));
    this._cameraViewMatrixInverse = uniform(new Matrix4().copy(camera.matrixWorldInverse));

    /**
     * The resolution of the pass.
     *
     * @private
     * @type {UniformNode<vec2>}
     */
    this._resolution = uniform(new Vector2());

    this._noiseIndex = uniform(0);

    /**
     * CDF-backed environment sampler. Created when {@link setEnvMap} is called.
     *
     * @private
     * @type {?ImportanceSampledEnvironment}
     */
    this._importanceEnvironment = null;

    /**
     * Intensity multiplier applied to environment-map reflections on screen-space
     * misses and at screen edges. Set it to `scene.environmentIntensity` to match the
     * environment reflections of the materials.
     *
     * @type {UniformNode<float>}
     * @default 1
     */
    this.environmentIntensity = uniform(1);

    /**
     * The render target the SSR is rendered into.
     *
     * @private
     * @type {RenderTarget}
     */
    /**
     * Real-time temporal filter (three-new-ssr-rt 'sssr', see SSR_TEMPORAL.md): instead of the running mean, each
     * frame's ratio-estimator terms go through a spatial ratio-estimator resolve over neighbouring pixels and a
     * temporal accumulation with surface and virtual-point (hit parallax) reprojection, variance clipping and a
     * roughness-dependent history length. Needs `stochastic`, `outputRadiance`, `hitMaterialNode` and `velocityNode`.
     *
     * @type {boolean}
     */
    this.temporalFilter = temporalFilter && stochastic && outputRadiance && !accumulate;

    /**
     * perf(three-new-ssr-rt): cap the dense march at this many steps per ray (compile-time constant). Rays longer
     * than that march with steps growing as `(i/n)^stepExponent` (never under one texel), so near contacts stay dense
     * and far hits rely on binary refinement plus the per-frame jitter. `null` keeps the uncapped dense march.
     *
     * @type {?number}
     */
    this._maxMarchSteps = maxMarchSteps;

    /**
     * perf(three-new-ssr-rt): hierarchical (Hi-Z) traversal instead of the dense march, radiance + stochastic mode
     * only (compile-time constant). A min-depth pyramid of the depth buffer at the trace resolution lets the ray skip
     * whole cells it passes in front of; at the finest level the dense march's hit test runs per texel. The pyramid
     * ping-pongs between two mip-chained targets (even levels in one, odd in the other), since a pass cannot sample
     * the texture it renders into.
     *
     * @type {boolean}
     */
    this._hiZ = hiZ && stochastic && outputRadiance;
    if (this._hiZ) {
      this._hiZTargets = [0, 1].map((i) => {
        const t = new RenderTarget(1, 1, {
          depthBuffer: false,
          type: FloatType,
          format: RedFormat,
          minFilter: NearestFilter,
          magFilter: NearestFilter,
        });
        t.texture.name = `NewSSRNode.HiZ${i}`;
        for (let level = 0; level < HIZ_LEVELS; level++) t.texture.mipmaps.push({});
        return t;
      });
      // one material per level (the source level is a constant): level 0 from the depth buffer, odd levels from
      // target 0, even levels from target 1
      this._hiZMaterials = Array.from({ length: HIZ_LEVELS }, () => new NodeMaterial());
      /** Traversal iteration budget per ray. */
      this.hiZIterations = 96;
    }
    this.velocityNode = velocityNode;

    this._ssrRenderTarget = new RenderTarget(1, 1, {
      depthBuffer: false,
      type: HalfFloatType,
      count: this.temporalFilter ? 2 : 1,
    });
    this._ssrRenderTarget.texture.name = 'NewSSRNode.SSR';
    if (this.temporalFilter) {
      // hit distance of this frame's ray (ENV_RAY_LENGTH on a miss), for the virtual-point reprojection, and the hit
      // object's own screen motion in pixels (beyond what the camera motion explains), to reject its stale history
      this._ssrRenderTarget.textures[1].name = 'NewSSRNode.Hit';
      this._ssrRenderTarget.textures[1].format = RGFormat;
      this._ratioField = property('vec4');
      this._hitDistanceField = property('vec2');
      this._spatialTarget = halfFloatTarget('NewSSRNode.Spatial');
      this._temporalTarget = halfFloatTarget('NewSSRNode.Temporal');
      this._historyTarget = halfFloatTarget('NewSSRNode.History');
      this._geometryTarget = halfFloatTarget('NewSSRNode.PreviousGeometry');
      // with resolutionScale < 1: the filtered result upsampled to full resolution, depth/normal aware
      this._upsampleTarget = halfFloatTarget('NewSSRNode.Upsample');
      this._upsampleMaterial = new NodeMaterial();
      this._spatialMaterial = new NodeMaterial();
      this._temporalMaterial = new NodeMaterial();
      this._historyCopyMaterial = new NodeMaterial();
      this._geometryMaterial = new NodeMaterial();
      this._previousViewProjection = uniform(new Matrix4());
      this._currentViewProjection = uniform(new Matrix4());
      this._previousCameraPosition = uniform(new Vector3());
      this._historyValid = uniform(0);
      this._unjitteredCamera = new PerspectiveCamera();
      /** Spatial resolve radius in pixels per unit GGX alpha (roughness²), capped at `spatialMaxRadius`. */
      this.spatialRadius = uniform(40);
      this.spatialMaxRadius = uniform(12);
      /** History length cap for mirrors and for roughness >= `historyRoughness`. */
      this.historyMin = uniform(4);
      this.historyMax = uniform(32);
      this.historyRoughness = uniform(0.4);
      /** Variance-clip box half-size in standard deviations, and where reflected objects move (`dynamicClipGamma`). */
      this.clipGamma = uniform(3);
      this.dynamicClipGamma = uniform(0.5);
      /** History length cap where reflected objects move. */
      this.dynamicHistory = uniform(2);
    }

    if (stochastic === false && roughnessNode !== null) {
      // The blur reads prefiltered mips of the SSR texture, so its taps don't skip texels.
      this._ssrRenderTarget.texture.generateMipmaps = true;
      this._ssrRenderTarget.texture.minFilter = LinearMipmapLinearFilter;
    }

    /**
     * The render target for the blurred SSR reflections.
     *
     * @private
     * @type {RenderTarget}
     */
    this._blurRenderTarget = new RenderTarget(1, 1, {
      depthBuffer: false,
      type: HalfFloatType,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
    });
    this._blurRenderTarget.texture.name = 'NewSSRNode.Blur';
    this._blurRenderTarget.texture.mipmaps.push({}, {}, {}, {}, {});

    /**
     * Static-camera progressive accumulation (stochastic radiance mode only): a plain running mean over
     * frames of the per-frame ratio-estimator terms `vec4(L·w, w)`, resolved to `rgb / a`. Unlike the
     * temporal reprojection/denoise chain it has no clamping, so it converges to the unbiased lobe average.
     * Restarts when the camera moves or the size changes. Fixed at construction time.
     *
     * @type {boolean}
     */
    this.accumulate = accumulate && stochastic && outputRadiance;
    this._accumTargets = this.accumulate
      ? [0, 1].map(() => new RenderTarget(1, 1, { depthBuffer: false, type: FloatType }))
      : null;
    this._resolveTarget = this.accumulate ? new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType }) : null;
    this._accumHistory = texture(null);
    this._accumAlpha = uniform(1);
    this._accumCount = 0;
    this._accumIndex = 0;
    this._accumCameraMatrix = new Matrix4();
    this._accumMaterial = new NodeMaterial();
    this._accumMaterial.name = 'NewSSRNode.Accumulate';
    this._resolveMaterial = new NodeMaterial();
    this._resolveMaterial.name = 'NewSSRNode.Resolve';
    this._resolveHistory = texture(null);

    /**
     * Frame counter driving the per-frame sample sequence (one increment per `updateBefore`).
     *
     * @private
     */
    this._frameIndex = uniform(0);
    this._frameCounter = 0;

    /**
     * The material that is used to render the effect.
     *
     * @private
     * @type {NodeMaterial}
     */
    this._ssrMaterial = new NodeMaterial();
    this._ssrMaterial.name = 'NewSSRNode.SSR';

    /**
     * The SSR fragment `Fn` and its shared context, captured in {@link NewSSRNode#setup}.
     * Re-invoking the `Fn` produces a fresh node graph, which is how the baked
     * compile-time constants are re-applied when they change (see {@link NewSSRNode#_buildSSRMaterial}).
     *
     * @private
     */
    this._ssrFn = null;
    this._sharedContext = null;

    /**
     * The blur material.
     *
     * @private
     * @type {NodeMaterial}
     */
    this._blurMaterial = new NodeMaterial();
    this._blurMaterial.name = 'NewSSRNode.Blur';

    /**
     * The copy material.
     *
     * @private
     * @type {NodeMaterial}
     */
    this._copyMaterial = new NodeMaterial();
    this._copyMaterial.name = 'NewSSRNode.Copy';

    /**
     * The result of the effect is represented as a separate texture node.
     *
     * @private
     * @type {PassTextureNode}
     */
    this._textureNode = passTexture(
      this,
      this.accumulate
        ? this._resolveTarget.texture
        : this.temporalFilter
          ? this._upsampleTarget.texture
          : this._ssrRenderTarget.texture,
    );

    let blurredTextureNode = null;

    if (this.stochastic === false && this.roughnessNode !== null) {
      const mips = this._blurRenderTarget.texture.mipmaps.length - 1;
      const r = this.roughnessNode;
      const lod = r.mul(r).mul(mips).clamp(0, mips);

      blurredTextureNode = passTexture(this, this._blurRenderTarget.texture).level(lod);
    }

    /**
     * Holds the blurred SSR reflections.
     *
     * @private
     * @type {?PassTextureNode}
     */
    this._blurredTextureNode = blurredTextureNode;

    if (environmentNode !== null && environmentNode.isTexture === true && outputRadiance === false) {
      this.setEnvMap(environmentNode);
    }
  }

  /**
   * Non-linear step distribution exponent (compile-time constant). See the backing
   * field for details. Assigning a new value recompiles the SSR material.
   *
   * @type {number}
   */
  get stepExponent() {
    return this._stepExponent;
  }

  set stepExponent(value) {
    if (value !== this._stepExponent) {
      this._stepExponent = value;
      this._buildSSRMaterial();
    }
  }

  /**
   * Blur kernel size (compile-time constant). Assigning a new value recompiles the
   * blur material.
   *
   * @type {number}
   */
  get blurQuality() {
    return this._blurQuality;
  }

  set blurQuality(value) {
    if (value !== this._blurQuality) {
      this._blurQuality = value;

      // The size is baked into the boxBlur node tree, so rebuild it (recompiles the material).
      if (this.stochastic === false) this._buildBlurMaterial();
    }
  }

  /**
   * Builds (or rebuilds) the blur material's node graph, baking the current
   * {@link NewSSRNode#blurQuality} as the kernel size so the sample loop unrolls.
   *
   * @private
   */
  _buildBlurMaterial() {
    this._blurMaterial.fragmentNode = boxBlur(texture(this._ssrRenderTarget.texture).level(this._blurSourceLevel), {
      size: this._blurQuality,
      separation: this._blurSpread,
    });
    this._blurMaterial.needsUpdate = true;
  }

  /**
   * Whether SSR fades to black near screen borders (compile-time constant). Assigning
   * a new value recompiles the SSR material.
   *
   * @type {boolean}
   */
  get screenEdgeFadeBlack() {
    return this._screenEdgeFadeBlack;
  }

  set screenEdgeFadeBlack(value) {
    if (value !== this._screenEdgeFadeBlack) {
      this._screenEdgeFadeBlack = value;
      this._buildSSRMaterial();
    }
  }

  /**
   * Whether sub-step binary-search hit refinement is enabled (compile-time constant).
   * Assigning a new value rebuilds the SSR material.
   *
   * @type {boolean}
   */
  get binaryRefine() {
    return this._binaryRefine;
  }

  set binaryRefine(value) {
    if (value !== this._binaryRefine) {
      this._binaryRefine = value;
      this._buildSSRMaterial();
    }
  }

  /**
   * Whether dielectrics are reflected in the non-stochastic path (compile-time constant).
   * Assigning a new value rebuilds the SSR material.
   *
   * @type {boolean}
   */
  get reflectNonMetals() {
    return this._reflectNonMetals;
  }

  set reflectNonMetals(value) {
    if (value !== this._reflectNonMetals) {
      this._reflectNonMetals = value;
      this._buildSSRMaterial();
    }
  }

  /**
   * Rebuilds the SSR material's node graph by re-invoking the fragment `Fn`, which
   * re-bakes the compile-time constants ({@link NewSSRNode#binaryRefine},
   * {@link NewSSRNode#stepExponent}, {@link NewSSRNode#screenEdgeFadeBlack}) at their current
   * values. A no-op until {@link NewSSRNode#setup} has captured the `Fn`.
   *
   * @private
   */
  _buildSSRMaterial() {
    if (this._ssrFn === null) return;

    this._ssrMaterial.contextNode = context(this._sharedContext);
    if (this.temporalFilter) {
      // MRT: ratio-estimator terms and hit distance
      this._ssrMaterial.colorNode = Fn(() => {
        this._ratioField.assign(this._ssrFn());
        return vec4(0);
      })();
      this._ssrMaterial.outputNode = outputStruct(this._ratioField, this._hitDistanceField);
    } else {
      this._ssrMaterial.fragmentNode = this._ssrFn();
    }
    this._ssrMaterial.needsUpdate = true;
  }

  /**
   * Returns the result of the effect as a texture node.
   *
   * @return {PassTextureNode} A texture node that represents the result of the effect.
   */
  getTextureNode() {
    return this.stochastic === false && this.roughnessNode !== null ? this._blurredTextureNode : this._textureNode;
  }

  /**
   * Sets the size of the effect.
   *
   * @param {number} width - The width of the effect.
   * @param {number} height - The height of the effect.
   */
  setSize(width, height) {
    if (this.temporalFilter) {
      // the upsample only runs at resolutionScale < 1; at full resolution the temporal result is used directly
      this._upsample = this.resolutionScale < 1;
      if (this._upsample) this._upsampleTarget.setSize(width, height);
      if (!this.accumulate) {
        this._textureNode.value = (this._upsample ? this._upsampleTarget : this._temporalTarget).texture;
      }
    }
    width = Math.round(this.resolutionScale * width);
    height = Math.round(this.resolutionScale * height);

    this._resolution.value.set(width, height);
    if (this._hiZ) for (const t of this._hiZTargets) t.setSize(width, height);
    this._ssrRenderTarget.setSize(width, height);
    this._blurRenderTarget.setSize(width, height);
    if (this.accumulate) {
      for (const target of this._accumTargets) target.setSize(width, height);
      this._resolveTarget.setSize(width, height);
    }
    if (this.temporalFilter) {
      if (this._spatialTarget.width !== width || this._spatialTarget.height !== height) this._historyValid.value = 0;
      for (const t of [this._spatialTarget, this._temporalTarget, this._historyTarget, this._geometryTarget]) {
        t.setSize(width, height);
      }
    }
  }

  /**
   * Wires the feedback inputs for multi-bounce reflections: the previous frame's
   * denoised result (`history`) and the velocity buffer used to reproject it
   * (`velocity`). `history` accepts the producing node (e.g. a
   * {@link RecurrentDenoiseNode}) — its output render target is used — or a raw
   * texture. Pass `null` for both to disable multi-bounce.
   *
   * @param {Texture} history
   * @param {Node<vec2>} velocity
   */
  setHistory(history, velocity) {
    this.historyTexture =
      history && typeof history.getRenderTarget === 'function' ? history.getRenderTarget().texture : history;
    this.velocityTexture = velocity;
  }

  /**
   * Sets the environment map for importance-sampled env lighting when
   * screen-space rays miss. Call this whenever the scene's env map changes.
   *
   * Uses {@link ImportanceSampledEnvironment} (CDF + MIS adapted from
   * [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer)).
   *
   * @param {Texture|null} hdr - The equirectangular HDR environment map, or null to disable.
   * @see {@link https://github.com/gkjohnson/three-gpu-pathtracer}
   */
  setEnvMap(hdr) {
    if (hdr === null) {
      if (this._importanceEnvironment !== null) {
        this._importanceEnvironment.clear();
        this._importanceEnvironment = null;
      }

      this._buildSSRMaterial();
      return;
    }

    if (hdr.image === undefined || hdr.image.data === undefined) {
      console.warn(
        'NewSSRNode: `environmentNode` / `setEnvMap()` expects an equirectangular HDR texture with CPU-side image data (e.g. RGBELoader). PMREM cubemaps and `scene.environment` are not supported.',
      );
      return;
    }

    if (this._importanceEnvironment === null) {
      this._importanceEnvironment = new ImportanceSampledEnvironment(this.envImportanceSampling);
    }

    this._importanceEnvironment.updateFrom(hdr);
    this._buildSSRMaterial();
  }

  /**
   * Intensity multiplier for the importance-sampled env contribution.
   * Only available after {@link setEnvMap} has been called.
   *
   * @type {?UniformNode<float>}
   */
  get envMapIntensity() {
    return this._importanceEnvironment !== null ? this._importanceEnvironment.intensity : null;
  }

  /**
   * This method is used to render the effect once per frame.
   *
   * @param {NodeFrame} frame - The current node frame.
   */
  updateBefore(frame) {
    const { renderer } = frame;

    this._cameraWorldMatrix.value.copy(this.camera.matrixWorld);
    this._cameraWorldPosition.value.copy(this.camera.position);

    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState);

    const ssrRenderTarget = this._ssrRenderTarget;
    const blurRenderTarget = this._blurRenderTarget;

    const size = renderer.getDrawingBufferSize(_size);

    _quadMesh.material = this._ssrMaterial;

    this.setSize(size.width, size.height);

    // Advance the noise with the frame so it stays in sync with the other temporal effects.
    this._noiseIndex.value = this.useTemporalFiltering === true ? frame.frameId : 0;

    // clear

    renderer.setMRT(null);
    renderer.setClearColor(0x000000, 0);

    // ssr

    if (this._hiZ) {
      for (let level = 0; level < HIZ_LEVELS; level++) {
        _quadMesh.material = this._hiZMaterials[level];
        renderer.setRenderTarget(this._hiZTargets[level % 2], 0, level);
        _quadMesh.name = `SSR [ Hi-Z ${level} ]`;
        _quadMesh.render(renderer);
      }
      _quadMesh.material = this._ssrMaterial;
    }

    renderer.setRenderTarget(ssrRenderTarget);
    _quadMesh.name = 'SSR [ Reflections ]';
    _quadMesh.render(renderer);

    this._frameIndex.value = this.useTemporalFiltering === true ? this._frameCounter++ : 0;

    if (this.accumulate) {
      // restart the running mean when the view changes (the CLI camera is static)
      const w = ssrRenderTarget.width;
      const h = ssrRenderTarget.height;
      if (!this._accumCameraMatrix.equals(this.camera.matrixWorld) || this._accumSize !== w * 100000 + h) {
        this._accumCameraMatrix.copy(this.camera.matrixWorld);
        this._accumSize = w * 100000 + h;
        this._accumCount = 0;
      }
      const read = this._accumTargets[this._accumIndex];
      const write = this._accumTargets[1 - this._accumIndex];
      this._accumAlpha.value = 1 / (this._accumCount + 1);
      this._accumCount++;
      this._accumHistory.value = read.texture;
      _quadMesh.material = this._accumMaterial;
      renderer.setRenderTarget(write);
      _quadMesh.name = 'SSR [ Accumulate ]';
      _quadMesh.render(renderer);
      this._resolveHistory.value = write.texture;
      _quadMesh.material = this._resolveMaterial;
      renderer.setRenderTarget(this._resolveTarget);
      _quadMesh.name = 'SSR [ Resolve ]';
      _quadMesh.render(renderer);
      this._accumIndex = 1 - this._accumIndex;
    }

    if (this.temporalFilter) {
      // this frame's camera without TRAA's sub-pixel jitter (like the velocity buffer)
      const unjittered = this._unjitteredCamera.copy(this.camera);
      if (unjittered.view !== null && unjittered.view.enabled) unjittered.clearViewOffset();
      unjittered.updateMatrixWorld();
      this._currentViewProjection.value.multiplyMatrices(unjittered.projectionMatrix, unjittered.matrixWorldInverse);
      const passes = [
        [this._spatialMaterial, this._spatialTarget, 'SSR [ Spatial Resolve ]'],
        [this._temporalMaterial, this._temporalTarget, 'SSR [ Temporal ]'],
        [this._historyCopyMaterial, this._historyTarget, 'SSR [ History ]'],
        [this._geometryMaterial, this._geometryTarget, 'SSR [ Previous Geometry ]'],
        ...(this._upsample ? [[this._upsampleMaterial, this._upsampleTarget, 'SSR [ Upsample ]']] : []),
      ];
      for (const [material, target, name] of passes) {
        _quadMesh.material = material;
        _quadMesh.name = name;
        renderer.setRenderTarget(target);
        _quadMesh.render(renderer);
      }
      this._previousViewProjection.value.copy(this._currentViewProjection.value);
      this._previousCameraPosition.value.setFromMatrixPosition(unjittered.matrixWorld);
      this._historyValid.value = 1;
    }

    // blur (optional)

    if (this.stochastic === false && this.roughnessNode !== null) {
      // blur mips but leave the base mip unblurred. Mip i blurs mip i - 1 of the SSR texture, with
      // taps one texel of that mip apart (the spread is in base-level texels).

      for (let i = 0; i < blurRenderTarget.texture.mipmaps.length; i++) {
        _quadMesh.material = i === 0 ? this._copyMaterial : this._blurMaterial;

        this._blurSourceLevel.value = Math.max(i - 1, 0);
        this._blurSpread.value = 2 ** Math.max(i - 1, 0);
        renderer.setRenderTarget(blurRenderTarget, 0, i);
        _quadMesh.name = 'SSR [ Blur Level ' + i + ' ]';
        _quadMesh.render(renderer);
      }
    }

    // restore

    RendererUtils.restoreRendererState(renderer, _rendererState);
  }

  /**
   * This method is used to setup the effect's TSL code.
   *
   * @param {NodeBuilder} builder - The current node builder.
   * @return {PassTextureNode}
   */
  setup(builder) {
    const uvNode = uv();

    const pointToLineDistance = Fn(([point, linePointA, linePointB]) => {
      // https://mathworld.wolfram.com/Point-LineDistance3-Dimensional.html

      return cross(point.sub(linePointA), point.sub(linePointB)).length().div(linePointB.sub(linePointA).length());
    });

    const pointPlaneDistance = Fn(([point, planePoint, planeNormal]) => {
      // https://mathworld.wolfram.com/Point-PlaneDistance.html
      // https://en.wikipedia.org/wiki/Plane_(geometry)
      // http://paulbourke.net/geometry/pointlineplane/

      // planeNormal is already normalized, so the denominator is 1.
      const d = mul(planeNormal.x, planePoint.x)
        .add(mul(planeNormal.y, planePoint.y))
        .add(mul(planeNormal.z, planePoint.z))
        .negate()
        .toVar();
      const distance = mul(planeNormal.x, point.x)
        .add(mul(planeNormal.y, point.y))
        .add(mul(planeNormal.z, point.z))
        .add(d);
      return distance;
    });

    const getViewZ = Fn(([depth]) => {
      let viewZNode;

      if (this.camera.isPerspectiveCamera) {
        viewZNode = perspectiveDepthToViewZ(depth, this._cameraNear, this._cameraFar);
      } else {
        viewZNode = orthographicDepthToViewZ(depth, this._cameraNear, this._cameraFar);
      }

      return viewZNode;
    });

    const sampleDepth = (uv) => {
      const depth = this.depthNode.sample(uv).r;

      if (builder.renderer.logarithmicDepthBuffer === true) {
        const viewZ = logarithmicDepthToViewZ(depth, this._cameraNear, this._cameraFar);

        return viewZToPerspectiveDepth(viewZ, this._cameraNear, this._cameraFar);
      }

      return depth;
    };

    // Per-pixel, per-frame decorrelated samples: a 4-D Kronecker (R-sequence, generalized golden ratio) sequence
    // over the frame index, Cranley-Patterson rotated by an independent PCG hash per pixel and dimension. Each
    // pixel sees a low-discrepancy sequence over frames with no correlation between dimensions (unlike the
    // analytic R² tile noise, whose four components derive from one scalar per pixel).
    const sampleMarchNoise = (uvCoord, frameIndex, salt = 0) => {
      const pixel = uvCoord.mul(this._resolution).floor();
      const seed = pixel.x.add(pixel.y.mul(this._resolution.x)).mul(4).add(salt);
      const rotation = vec4(hash(seed), hash(seed.add(1)), hash(seed.add(2)), hash(seed.add(3)));
      const g = 1.1673039782614187; // x^5 = x + 1
      const alpha = vec4(1 / g, 1 / g ** 2, 1 / g ** 3, 1 / g ** 4);
      return fract(rotation.add(alpha.mul(float(frameIndex))));
    };

    const computeScreenBorderFactor = Fn(([uvCoord, borderWidth]) => {
      const border = borderWidth.max(1e-4);

      // Distance to the nearest screen edge — uniform falloff at corners.
      const edgeDist = min(min(uvCoord.x, float(1).sub(uvCoord.x)), min(uvCoord.y, float(1).sub(uvCoord.y)));

      // Two smoothsteps for a softer ease-in-out than a single ramp.
      const t = edgeDist.smoothstep(0, border);

      return t.smoothstep(0, 1).pow(0.125);
    }).setLayout({
      name: 'computeScreenBorderFactor',
      type: 'float',
      inputs: [
        { name: 'uvCoord', type: 'vec2' },
        { name: 'borderWidth', type: 'float' },
      ],
    });

    const ssr = Fn(() => {
      const noise = sampleMarchNoise(uvNode, this._frameIndex).toVar();
      const uvPos = uvNode.toVar();

      const depth = sampleDepth(uvPos).toVar();

      // Skip background pixels (cleared far-plane depth); the target is cleared each frame.
      depth.greaterThanEqual(1.0).discard();

      const viewPosition = getViewPosition(uvPos, depth, this._cameraProjectionMatrixInverse).toVar();
      const worldPosition = this._cameraWorldMatrix.mul(vec4(viewPosition, 1.0)).xyz.toVar();
      const viewNormal = this.normalNode.rgb.normalize().toVar();

      const viewIncidentDir = (this.camera.isPerspectiveCamera ? normalize(viewPosition) : vec3(0, 0, -1)).toVar();

      // The node system samples the metalness/roughness textures at the current uv,
      // so no explicit sample() is needed here.
      const metalness = float(this.metalnessNode);

      // In radiance mode non-metals still need the environment, so they skip the trace below instead.
      const skipTrace = this.stochastic === false && this._reflectNonMetals === false;

      if (skipTrace && this.outputRadiance === false) {
        metalness.lessThanEqual(0.0).discard();
      }

      const roughness = float(this.roughnessNode);
      const glossiness = min(roughness.div(0.25), 1).oneMinus();
      // Only the fade-to-black miss path reads this, and that path is baked out otherwise.
      const surfaceBorderFactor = this.screenEdgeFadeBlack
        ? computeScreenBorderFactor(uvPos, this.screenEdgeFade)
        : null;
      const hitBorderWidth = this.screenEdgeFade.mul(glossiness);

      const V = viewIncidentDir.negate().normalize().toVar();

      let viewReflectDir, finalSampleWeight, specDominantFactor;
      let sampleRatioWeight = float(1);
      const albedo = vec3(1).toVar();
      let sampleEnvReflection = null;

      if (this.stochastic === false) {
        viewReflectDir = reflect(viewIncidentDir, viewNormal).normalize().toVar();
        finalSampleWeight = this.outputRadiance ? vec3(1) : vec3(metalness);
        specDominantFactor = float(1);
      } else {
        const Xi = noise.toVar();
        // Mirror-bias: pull `Xi.y` toward the cap top to tighten the GGX lobe and cut mid-roughness
        // noise. This is biased (the pdf/weight are not corrected), so a reference sets it to 0.
        Xi.y.assign(mix(Xi.y, 0.0, this.mirrorBias.mul(Xi.w.sqrt())));

        albedo.assign(this.diffuseNode !== null ? this.diffuseNode.sample(uvPos).rgb : vec3(1));
        // Silhouette pixels can have an interpolated normal facing (almost) away from the camera, where every VNDF
        // sample gets weight 0 (N·V <= 0) and the pixel resolves to black: bend the sampling normal to N·V >= 0.02.
        const NdotVRaw = dot(viewNormal, V);
        const sampleNormal = viewNormal
          .add(V.mul(float(0.02).sub(NdotVRaw).max(0)))
          .normalize()
          .toVar();
        const ggxSample = ggxReflectionSample(sampleNormal, V, roughness, metalness, albedo, Xi).toVar();

        // A below-horizon sample has G2 = 0 (NdotL clamps to 0), so its weight is already 0: no re-sampling.

        viewReflectDir = ggxSample.get('reflectDir').toVar();
        finalSampleWeight = this.outputRadiance ? vec3(1) : ggxSample.get('sampleWeight').toVar();
        // Radiance mode: ratio-estimator weight w = F·G2/G1 (luminance) of this VNDF sample; the pass outputs
        // vec4(L·w, w) and the accumulation resolves Σ L·w / Σ w, the lobe-normalized incoming radiance the
        // material multiplies by its pre-integrated DFG (which is E[w]).
        if (this.outputRadiance) sampleRatioWeight = luminance(ggxSample.get('sampleWeight')).toVar();
        specDominantFactor = getSpecularDominantFactor(ggxSample.get('NdotV'), roughness).toVar();

        sampleEnvReflection = () => {
          if (this._importanceEnvironment === null || this.outputRadiance) return vec3(0);

          const envColor = vec3(0).toVar();

          if (this.envImportanceSampling) {
            const Xi2 = bindAnalyticNoise(this._resolution, 59)(uvPos, this._noiseIndex);

            envColor.assign(
              this._importanceEnvironment.sampleEnvironmentMIS({
                cameraWorldMatrix: this._cameraWorldMatrix,
                viewReflectDir,
                N: viewNormal,
                V,
                alpha: ggxSample.get('alpha'),
                f0: ggxSample.get('f0'),
                Xi2,
              }),
            );
          } else {
            envColor.assign(
              this._importanceEnvironment.sampleEnvironmentBRDF({
                cameraWorldMatrix: this._cameraWorldMatrix,
                viewReflectDir,
                N: viewNormal,
                V,
                alpha: ggxSample.get('alpha'),
                f0: ggxSample.get('f0'),
              }),
            );
          }

          return envColor;
        };
      }

      // Radiance mode: the prefiltered environment radiance, sampled like the materials do (EnvironmentNode).
      // The GGX rays are already spread over the lobe, so they sample the unfiltered environment.
      const sampleEnvRadiance = () => {
        if (this.environmentNode === null) return vec3(0);

        const dir = this.stochastic ? viewReflectDir : mix(viewReflectDir, viewNormal, roughness.pow(4)).normalize();
        const worldDir = this._cameraWorldMatrix.mul(vec4(dir, 0)).xyz;

        return pmremTexture(this.environmentNode, worldDir, this.stochastic ? float(0) : roughness).mul(
          this.environmentIntensity,
        );
      };

      // Radiance mode: how much the hit replaces the environment, so fades blend toward it instead of black.
      const hitWeight = float(0).toVar();
      const hitDistance = float(ENV_RAY_LENGTH).toVar();
      const hitMotion = float(0).toVar();

      // Multi-bounce: fold in the previous frame's reflection at the hit point, reprojected by its
      // own motion. The (1 - history.a) decay damps the feedback. No-op until both textures are set.
      const reprojectHitPointHistory = (uvHit, color) => {
        if (!(this.historyTexture && this.velocityTexture)) return color;

        const velocity = this.velocityTexture.sample(uvHit).xy;
        const historyUV = uvHit.sub(velocity);
        const historyBounce = texture(this.historyTexture, historyUV).toVar();
        const sampleDecay = historyBounce.a.oneMinus();

        return color.add(historyBounce.rgb.mul(sampleDecay));
      };

      // Fades a screen-space hit near the screen borders, using the hit sample UV (where the
      // screen-space data was read). `screenEdgeFadeBlack` is baked, so the two modes branch in
      // JS: fade the reflection to black, or blend it toward the environment reflection.
      const applyHitEdgeFade = (reflectColor, uvS, hitBorderWidth) => {
        if (this.screenEdgeFadeBlack) {
          const hitBorderFactor = computeScreenBorderFactor(uvS, this.screenEdgeFade);
          reflectColor.rgb.mulAssign(hitBorderFactor);
        } else {
          const hitBorderFactor = computeScreenBorderFactor(uvS, hitBorderWidth);

          If(hitBorderFactor.lessThan(1), () => {
            reflectColor.rgb.assign(
              mix(sampleEnvReflection().mul(this.environmentIntensity), reflectColor.rgb, hitBorderFactor),
            );
          });
        }
      };

      // The scene pass shaded the hit pixel for the camera, so its specular is the radiance the hit reflects toward
      // the camera, while the reflected ray needs the radiance toward the reflecting point (-R). Swap the hit's
      // split-sum indirect specular for the camera direction (the radiance the scene pass used, i.e. the previous SSR
      // result at the hit pixel, times the DFG term at N·V_camera) for one evaluated for -R by a second screen-space
      // bounce. The view-independent part (emissive, diffuse) is kept.
      const previousRadianceTexture = this.accumulate
        ? texture(this._resolveTarget.texture)
        : this.temporalFilter
          ? (() => {
              // last frame's filtered output, reprojected to this frame by the surface motion
              const previous = texture(this._temporalTarget.texture);
              return {
                sample: (coord) => previous.sample(coord.sub(this.velocityNode.sample(coord).xy.mul(vec2(0.5, -0.5)))),
              };
            })()
          : this.radianceHistoryNode;
      const redirectHitSpecular = (uvHit, vPHit, color) => {
        const hitMaterial = this.hitMaterialNode.sample(uvHit);
        const hitSpecular = this.hitSpecularNode.sample(uvHit);
        const hitRoughness = hitMaterial.g;
        const Nh = this.normalNode.sample(uvHit).rgb.normalize().toVar();
        const Vcam = vPHit.normalize().negate();
        const Vray = viewReflectDir.negate();
        const NdotVcam = dot(Nh, Vcam).clamp(1e-4, 1);
        const NdotVray = dot(Nh, Vray);
        const fss = (NdotV) => {
          const dfg = DFGLUT({ roughness: hitRoughness, dotNV: NdotV });
          return hitSpecular.rgb.mul(dfg.x).add(hitSpecular.a.mul(dfg.y));
        };
        const radianceCam = previousRadianceTexture.sample(uvHit).rgb;
        // Second bounce: one VNDF sample of the hit's lobe for the view direction -R, traced in screen space. Its
        // weight F·G2/G1 makes L·w an unbiased estimate of the hit's specular toward -R.
        const Xi2 = sampleMarchNoise(uvNode, this._frameIndex, SECONDARY_NOISE_SALT).toVar();
        // A hidden-side hit (back-facing, or accepted only by the dual-layer test) has no normal of its own: assume the
        // hidden surface faces the ray.
        const hidden = NdotVray.lessThanEqual(0).or(hitInside);
        const Nb = hidden.select(Vray, Nh).toVar();
        const secondary = ggxReflectionSample(Nb, Vray, hitRoughness, float(1), hitSpecular.rgb, Xi2).toVar();
        const dir2 = secondary.get('reflectDir').toVar();
        const L2 = vec3(0).toVar();
        const sampleEnvForDir2 = () => {
          if (this.environmentNode !== null) {
            L2.assign(
              pmremTexture(this.environmentNode, this._cameraWorldMatrix.mul(vec4(dir2, 0)).xyz, float(0)).mul(
                this.environmentIntensity,
              ),
            );
          }
        };
        // perf(three-new-ssr-fast): for a hit rough enough that a single screen-space sample is already a
        // poor stand-in for its wide GGX lobe, skip the second bounce's march entirely and read the
        // prefiltered environment for the sampled direction instead (three-new-ssr always marches).
        const skipSecondMarch =
          this._secondBounceRoughnessCutoff !== null
            ? hitRoughness.greaterThanEqual(this._secondBounceRoughnessCutoff)
            : bool(false);
        If(skipSecondMarch, () => {
          sampleEnvForDir2();
        }).Else(() => {
          const second = trace(vPHit, Nb, dir2, viewReflectDir, uvHit, Xi2.z, this._secondBounceQuality);
          If(second.foundHit, () => {
            L2.assign(this.colorNode.sample(second.hitUvS).rgb);
          }).Else(() => {
            sampleEnvForDir2();
          });
        });
        const corrected = color
          .sub(radianceCam.mul(fss(NdotVcam)))
          .add(L2.mul(secondary.get('sampleWeight')))
          .max(0);
        return corrected;
      };

      // Marches a view-space ray from a surface point against the depth buffer. Returns whether it hit and the hit's
      // UV and depth (refined when `binaryRefine`). `incidentDir` is the direction the point was viewed along.
      // The parameters deliberately shadow the primary ray's names, which the march body was written against.
      /* oxlint-disable no-shadow */
      const trace = (
        viewPosition,
        viewNormal,
        viewReflectDir,
        incidentDir,
        uvPos,
        jitter,
        qualityOverride = null,
        hiZ = this._hiZ,
      ) => {
        /* oxlint-enable no-shadow */
        // perf(three-new-ssr-fast): the second bounce can march at a different (lower) step density than
        // the primary ray via `qualityOverride` (SSRFastOptions.secondBounceQuality); `null` uses `quality`.
        const marchQuality = qualityOverride === null ? this.quality.clamp() : float(qualityOverride).clamp();
        // Guard grazing or back-facing normals, which would make the ray infinite or reverse it.
        const maxReflectRayLen = this.maxDistance.div(dot(incidentDir.negate(), viewNormal).max(1e-3)).toVar();

        // Offset the march's origin along the surface normal, scaled by view depth, so the first few
        // steps of a ray leaving a curved or grazing surface don't immediately re-cross that same
        // surface's own depth-buffer samples (self-intersection speckle, worst on curved normals).
        const rayOrigin = viewPosition.add(viewNormal.mul(abs(viewPosition.z).mul(0.002).max(0.001))).toVar();

        const d1viewPosition = rayOrigin.add(viewReflectDir.mul(maxReflectRayLen)).toVar();

        // Camera type is fixed at build time, so guard the near-plane clamp with a JS branch
        // rather than a runtime uniform (the orthographic case compiles it out entirely).
        if (this.camera.isPerspectiveCamera) {
          If(d1viewPosition.z.greaterThan(this._cameraNear.negate()), () => {
            const t = sub(this._cameraNear.negate(), rayOrigin.z).div(viewReflectDir.z);
            d1viewPosition.assign(rayOrigin.add(viewReflectDir.mul(t)));
          });
        }

        const d0 = uvPos.mul(this._resolution).xy.toVar();
        const d1 = getScreenPosition(d1viewPosition, this._cameraProjectionMatrix).mul(this._resolution).toVar();

        const xLen = d1.x.sub(d0.x).toVar();
        const yLen = d1.y.sub(d0.y).toVar();

        // dominant-axis ray length in texels (used for the per-step floor below)
        const rayLen = max(xLen.abs(), yLen.abs()).max(1).toVar();

        // Blur traces a single mirror ray, so spend steps in proportion to the ray's screen-space
        // length (cheap for the short rays that dominate). Scatter needs a fixed, bounded count for
        // coherent stochastic sampling; each step then spans the whole ray as rayVec / totalStep.
        // Radiance mode marches every ray (mirror or stochastic) densely: one step per 1/quality texels.
        const denseMarch = this.stochastic === false || this.outputRadiance;
        const cappedMarch = denseMarch && this._maxMarchSteps !== null;
        const totalStep = int(
          denseMarch
            ? trunc(
                max(abs(xLen), abs(yLen))
                  .mul(marchQuality)
                  .min(cappedMarch ? this._maxMarchSteps : 65536),
              )
                .max(int(1))
                .toConst()
            : marchQuality.mul(MAX_STEPS).max(float(1)),
        )
          .mul(skipTrace ? int(metalness.greaterThan(0.0)) : int(1))
          .toConst();

        const xSpan = xLen.div(totalStep).toVar();
        const ySpan = yLen.div(totalStep).toVar();

        const stepVec = vec2(xSpan, ySpan).toVar();
        const invResolution = vec2(float(1), float(1)).div(this._resolution).toVar();
        const uvPixelStepX = vec2(invResolution.x, float(0)).toVar();

        // perf(three-new-ssr-fast): the ray parameter where the march leaves the screen, computed once so
        // the per-step bounds test is a single comparison against it instead of four comparisons against
        // the screen edges. Same exit point as the per-step test, so the output is unchanged.
        const sExit = this._clipRaysToScreen
          ? (() => {
              const exitS = (p, len, bound) =>
                len.equal(0).select(float(1e9), len.greaterThan(0).select(bound.sub(p), p.negate()).div(len));
              return min(exitS(d0.x, xLen, this._resolution.x), exitS(d0.y, yLen, this._resolution.y)).toConst();
            })()
          : null;

        // Reflected-ray view-space Z at ray parameter s ∈ [0,1] (linear in 1/z for perspective),
        // hoisted so the march and refinement evaluate it identically.
        const recipVPZ = float(1).div(rayOrigin.z).toConst();
        const recipD1VPZ = float(1).div(d1viewPosition.z).toConst();

        // Camera type is known at build time, so branch at compile time rather than via a runtime select.
        const reflectRayZAt = this.camera.isPerspectiveCamera
          ? (sVal) => float(1).div(recipVPZ.add(sVal.mul(recipD1VPZ.sub(recipVPZ))))
          : (sVal) => rayOrigin.z.add(sVal.mul(d1viewPosition.z.sub(rayOrigin.z)));

        // Screen-space position along the ray for a given s ∈ [0,1].
        const screenPosAt = (sVal) => d0.add(stepVec.mul(sVal.mul(totalStep)));

        // Ray parameter s ∈ [0,1] for step `idx`. Blur marches uniformly (one step per 1/quality texels),
        // jittered per pixel so the hits don't snap to the steps, which showed as bands. Scatter uses an exponential remap `(idx/steps)^stepExponent`
        // that concentrates samples near the origin, floored to ≥1 texel/step; `jitter` dissolves banding.
        const sampleFraction = cappedMarch
          ? (idx) => max(idx.add(jitter.sub(0.5)).div(totalStep).max(0).pow(this.stepExponent), idx.div(rayLen))
          : denseMarch
            ? (idx) => idx.add(jitter.sub(0.5)).div(totalStep).max(0)
            : (idx) => max(idx.add(jitter.sub(0.5)).div(totalStep).pow(this.stepExponent), idx.div(rayLen));

        // Carry the hit out of the loop so refinement runs after the march, not nested inside it (a
        // loop-inside-a-loop tripped shader-compiler bugs on some drivers). hitSLo/hitSHi bracket s.
        const foundHit = bool(false).toVar();
        const hitInside = bool(false).toVar();
        const hitSLo = float(0).toVar();
        const hitSHi = float(0).toVar();
        // Carry the coarse hit's UV/depth to skip a redundant fetch when refinement is off.
        const hitUvS = vec2(0).toVar();
        const hitD = float(0).toVar();

        if (hiZ) {
          // Hi-Z traversal: at each step the ray's current cell at `level`; if the ray stays in front of the nearest
          // surface in the cell over the whole cell, skip it and go one level coarser, otherwise go one level finer.
          // At level 0 (one trace texel) run the dense march's hit test at the texel's exit.
          const dir = vec2(xLen, yLen);
          const level = int(0).toVar();
          // start where the dense march takes its first sample (jittered, ~1/quality texels out): testing every texel
          // from the origin re-hits curved surfaces' own neighbouring texels
          const sCur = jitter.add(0.5).div(rayLen.mul(marchQuality)).toVar();
          const epsilon = float(0.01).div(rayLen);
          Loop({ start: int(0), end: int(this.hiZIterations), condition: '<' }, () => {
            If(sCur.greaterThanEqual(1).or(this._clipRaysToScreen ? sCur.greaterThan(sExit) : bool(false)), () => {
              Break();
            });
            const pos = d0.add(dir.mul(sCur)).toVar();
            const cellSize = exp2(float(level)).toVar();
            const cell = pos.div(cellSize).floor().toVar();
            const boundary = vec2(
              xLen.greaterThan(0).select(cell.x.add(1), cell.x),
              yLen.greaterThan(0).select(cell.y.add(1), cell.y),
            ).mul(cellSize);
            const sx = abs(xLen).greaterThan(1e-5).select(boundary.x.sub(d0.x).div(xLen), float(1e9));
            const sy = abs(yLen).greaterThan(1e-5).select(boundary.y.sub(d0.y).div(yLen), float(1e9));
            const sNext = min(sx, sy).add(epsilon).toVar();
            // mip sizes round down: a cell past the last full one isn't in the pyramid, so it is never skipped
            const levelSize = this._resolution.div(cellSize).floor().max(1);
            const covered = cell.x.lessThan(levelSize.x).and(cell.y.lessThan(levelSize.y));
            const coord = ivec2(cell.clamp(vec2(0), levelSize.sub(1)));
            const nearest = float(0).toVar();
            If(covered.not(), () => {
              nearest.assign(0);
            })
              .ElseIf(level.bitAnd(1).equal(0), () => {
                nearest.assign(textureLoad(this._hiZTargets[0].texture, coord, level).r);
              })
              .Else(() => {
                nearest.assign(textureLoad(this._hiZTargets[1].texture, coord, level).r);
              });
            const nearestZ = getViewZ(nearest);
            const inFront = min(reflectRayZAt(sCur), reflectRayZAt(sNext.min(1))).greaterThan(nearestZ);
            If(inFront, () => {
              sCur.assign(sNext);
              level.assign(level.add(1).min(HIZ_LEVELS - 1));
            })
              .ElseIf(level.greaterThan(0), () => {
                level.subAssign(1);
              })
              .Else(() => {
                // the dense march's crossing test at the middle of the ray's span inside this texel (depth and ray
                // depth at the same point; the texel's far end would sample the next texel)
                const sTest = sCur.add(sNext.min(1)).mul(0.5).toVar();
                const uvS = screenPosAt(sTest).mul(invResolution).toVar();
                const d = sampleDepth(uvS).toVar();
                const vZ = getViewZ(d).toVar();
                const viewReflectRayZ = reflectRayZAt(sTest).toVar();
                If(viewReflectRayZ.lessThanEqual(vZ).and(d.lessThan(1.0)), () => {
                  // the dense march's acceptance (radiance mode): within the thickness, or inside the solid
                  const vP = getViewPosition(uvS, d, this._cameraProjectionMatrixInverse).toVar();
                  const away = pointToLineDistance(vP, rayOrigin, d1viewPosition).toVar();
                  const vPNeighbor = getViewPosition(uvS.add(uvPixelStepX), d, this._cameraProjectionMatrixInverse);
                  const tk = max(vPNeighbor.x.sub(vP.x).mul(3), max(this.thickness, abs(vZ).mul(0.02))).toVar();
                  const insideSolid =
                    this.backDepthNode !== null
                      ? viewReflectRayZ.greaterThanEqual(getViewZ(this.backDepthNode.sample(uvS).r).sub(tk))
                      : bool(false);
                  If(away.lessThanEqual(tk).or(insideSolid), () => {
                    foundHit.assign(true);
                    hitInside.assign(away.greaterThan(tk));
                    hitUvS.assign(uvS);
                    hitD.assign(d);
                    hitSLo.assign(sCur);
                    hitSHi.assign(sTest);
                    Break();
                  });
                });
                sCur.assign(sNext);
              });
          });
        } else {
          // March from d0 toward d1 (inclusive), looking for an intersection with the depth buffer.
          Loop({ start: int(1), end: totalStep, condition: '<=' }, ({ i }) => {
            // Exponentially-distributed ray parameter, shared by the sample position and ray depth.
            // The jitter can push the last step past d1, so clamp it to the ray's end.
            const s = sampleFraction(float(i)).min(1).toVar();

            const xy = screenPosAt(s).toVar();

            If(
              this._clipRaysToScreen
                ? s.greaterThan(sExit)
                : xy.x
                    .lessThan(0)
                    .or(xy.x.greaterThan(this._resolution.x))
                    .or(xy.y.lessThan(0))
                    .or(xy.y.greaterThan(this._resolution.y)),
              () => {
                Break();
              },
            );

            const uvS = xy.mul(invResolution).toVar();
            const d = sampleDepth(uvS).toVar();
            const vZ = getViewZ(d).toVar();

            const viewReflectRayZ = reflectRayZAt(s).toVar();

            If(viewReflectRayZ.lessThanEqual(vZ), () => {
              // Depth crossing: ray went behind the depth buffer. Gate by thickness before stopping
              // so an occluder gap doesn't end the march prematurely.
              const vP = getViewPosition(uvS, d, this._cameraProjectionMatrixInverse).toVar();
              const away = pointToLineDistance(vP, rayOrigin, d1viewPosition).toVar();

              const uvNeighbor = uvS.add(uvPixelStepX).toVar();
              const vPNeighbor = getViewPosition(uvNeighbor, d, this._cameraProjectionMatrixInverse).toVar();
              const minThickness = vPNeighbor.x.sub(vP.x).mul(3).toVar();
              // Depth-proportional thickness (McGuire & Mara / Unreal HZB SSR): a surface farther from the
              // camera is assumed thicker in world units for the same screen footprint, so solid occluders
              // (the camera body, a box hiding another box) don't get leaked through as the ray recedes.
              const depthProportionalThickness = abs(vZ).mul(0.02).toVar();
              const tk = max(minThickness, max(this.thickness, depthProportionalThickness)).toVar();

              // Dual-layer depth: inside the solid (behind its front surface, in front of its back surface).
              const insideSolid =
                this.backDepthNode !== null
                  ? viewReflectRayZ.greaterThanEqual(getViewZ(this.backDepthNode.sample(uvS).r).sub(tk))
                  : bool(false);

              If(away.lessThanEqual(tk).or(insideSolid), () => {
                // Background (cleared far-plane depth) is not geometry: a ray running past the far plane must not
                // "hit" the screen-space backdrop, it continues and falls back to the environment.
                If(d.greaterThanEqual(1.0), () => {
                  Continue();
                });

                const vN = this.normalNode.sample(uvS).rgb.normalize().toVar();

                // the reflected ray is pointing towards the same side as the fragment's normal (current ray position),
                // which means it wouldn't reflect off the surface. The loop continues to the next step for the next ray sample.
                // Radiance mode keeps such hits: the ray is inside a solid whose (hidden) back side it would hit, and the
                // visible side's radiance is a better proxy than continuing past the solid to the environment (a mirror
                // facing the camera shows the far sides of the objects in front of it).
                if (this.stochastic === false && !this.outputRadiance) {
                  If(dot(viewReflectDir, vN).greaterThanEqual(0), () => {
                    Continue();
                  });
                }

                if (this.stochastic === false) {
                  // Distance exceeding limit: The reflection is potentially too far away and might not
                  // contribute significantly to the final color. In radiance mode there is no artistic
                  // cutoff to honor (maxDistance there is only a ray-length budget, not a hit-rejection
                  // radius): the ray already stops at the frustum/near-plane bound computed above, so a
                  // real hit here should always be shaded rather than dropped back to the environment.
                  if (!this.outputRadiance) {
                    // this distance represents the depth of the intersection point between the reflected ray and the scene.
                    const distance = pointPlaneDistance(vP, viewPosition, viewNormal).toVar();

                    If(distance.greaterThan(this.maxDistance), () => {
                      Break();
                    });
                  }
                }

                foundHit.assign(true);
                hitInside.assign(away.greaterThan(tk));
                hitUvS.assign(uvS);
                hitD.assign(d);

                if (this.binaryRefine) {
                  hitSLo.assign(sampleFraction(float(i).sub(1)));
                  hitSHi.assign(s);
                }

                Break();
              });
            });
          });
        }

        If(foundHit, () => {
          // Bisect the bracketed crossing toward the exact intersection. Run after the march, not
          // nested (a loop-inside-a-loop tripped shader-compiler bugs on some drivers).
          if (this.binaryRefine) {
            Loop({ start: int(0), end: int(this._binaryRefineSteps), type: 'int', condition: '<' }, () => {
              const sMid = hitSLo.add(hitSHi).mul(0.5).toVar();
              const sceneZMid = getViewZ(sampleDepth(screenPosAt(sMid).mul(invResolution)));

              If(reflectRayZAt(sMid).lessThanEqual(sceneZMid), () => {
                hitSHi.assign(sMid);
              }).Else(() => {
                hitSLo.assign(sMid);
              });
            });

            // Refinement moved the crossing, so re-fetch UV/depth at the refined `s`.
            hitUvS.assign(screenPosAt(hitSHi).mul(invResolution));
            hitD.assign(sampleDepth(hitUvS));
          }
        });

        return { foundHit, hitUvS, hitD, hitInside };
      };

      const output = vec4(0).toVar();
      const hit = float(0).toVar();
      const { foundHit, hitUvS, hitD, hitInside } = trace(
        viewPosition,
        viewNormal,
        viewReflectDir,
        viewIncidentDir,
        uvPos,
        noise.z,
      );

      If(foundHit, () => {
        // Shade the hit, reusing the depth fetched during the march (or refinement).
        const uvS = hitUvS;
        const vP = getViewPosition(uvS, hitD, this._cameraProjectionMatrixInverse).toVar();

        // In blur mode (non-radiance) the ratio² falloff re-grows past maxDistance, so over-range hits
        // fall back to env. The scatter path bounds reach via ray length, so every hit shades. Radiance
        // mode has no such artistic cutoff (see the Break above), so every hit is within range.
        const distancePointPlane =
          this.stochastic === false ? pointPlaneDistance(vP, viewPosition, viewNormal).toVar() : float(0);
        const withinRange =
          this.stochastic === false && !this.outputRadiance
            ? distancePointPlane.lessThanEqual(this.maxDistance)
            : bool(true);

        If(withinRange, () => {
          const hitWorldPosition = this._cameraWorldMatrix.mul(vec4(vP, 1.0)).xyz.toVar();
          hitDistance.assign(distance(worldPosition, hitWorldPosition));
          if (this.temporalFilter) {
            // the velocity buffer at the hit minus the motion the camera alone gives the hit point: the hit
            // object's own motion, which neither reprojection accounts for
            const cameraOffset = projectToUV(hitWorldPosition, this._currentViewProjection).sub(
              projectToUV(hitWorldPosition, this._previousViewProjection),
            );
            const velocityOffset = this.velocityNode.sample(uvS).xy.mul(vec2(0.5, -0.5));
            hitMotion.assign(velocityOffset.sub(cameraOffset).mul(this._resolution).length());
          }
          const worldDistance = distance(worldPosition, hitWorldPosition).mul(specDominantFactor).toVar();

          const reflectColor = this.colorNode.sample(uvS).toVar();

          // Multi-bounce: add the reprojected previous-frame reflection at the hit point.
          reflectColor.rgb.assign(reprojectHitPointHistory(uvS, reflectColor.rgb));

          if (previousRadianceTexture !== null && this.hitSpecularNode !== null && this.hitMaterialNode !== null) {
            reflectColor.rgb.assign(redirectHitSpecular(uvS, vP, reflectColor.rgb));
          }

          if (this.stochastic === true && this.outputRadiance === false)
            applyHitEdgeFade(reflectColor, uvS, hitBorderWidth);

          // The scatter (GGX) path bakes distance/grazing response into finalSampleWeight.
          // The mirror/blur path is a plain reflection, so reapply upstream's squared
          // distance attenuation and grazing Fresnel here to match its falloff.
          let weightedColor = reflectColor.rgb.mul(finalSampleWeight);

          if (this.stochastic === false) {
            if (this.outputRadiance) {
              // No distance fade for a reference: a real hit replaces the environment outright.
              // Only the screen-border fade remains, for hits found near the edge of the trace.
              hitWeight.assign(computeScreenBorderFactor(uvS, this.screenEdgeFade));
            } else {
              const ratio = float(1).sub(distancePointPlane.div(this.maxDistance)).toVar();
              const attenuation = ratio.mul(ratio).toVar();
              weightedColor = weightedColor.mul(attenuation);

              const fresnelCoe = div(dot(viewIncidentDir, viewReflectDir).add(1), 2).toVar();
              weightedColor = weightedColor.mul(fresnelCoe);
            }
          }

          if (this.stochastic === true && this.outputRadiance)
            hitWeight.assign(computeScreenBorderFactor(uvS, hitBorderWidth));

          hit.assign(1);
          output.assign(vec4(weightedColor, worldDistance));
        });
      });

      // Screen-space ray missed: environment fallback (MIS when CDF env is set up).
      If(hit.equal(0), () => {
        if (this.stochastic === true && this.outputRadiance === false) {
          output.assign(vec4(sampleEnvReflection().mul(this.environmentIntensity), float(ENV_RAY_LENGTH)));

          // Misses fade by the surface pixel UV (where the reflection is being shaded).
          if (this.screenEdgeFadeBlack) {
            output.rgb.mulAssign(surfaceBorderFactor);
          }
        }
      });

      const lum = luminance(output.rgb).max(1e-4).toVar();
      output.rgb.mulAssign(this.maxLuminance.div(lum).min(1));

      // scale the reflection color by the user-controlled intensity
      output.rgb.mulAssign(this.intensity);

      // Radiance mode: blend toward the environment on misses and fades, after the luminance cap so the
      // environment matches the materials. Misses report the environment ray length to the denoisers.
      if (this.temporalFilter) this._hitDistanceField.assign(vec2(hitDistance, hitMotion));
      if (this.accumulate || this.temporalFilter) {
        // ratio-estimator terms, resolved as Σ L·w / Σ w by the accumulation
        output.assign(vec4(mix(sampleEnvRadiance(), output.rgb, hitWeight).mul(sampleRatioWeight), sampleRatioWeight));
      } else if (this.outputRadiance) {
        output.assign(
          vec4(mix(sampleEnvRadiance(), output.rgb, hitWeight), hit.equal(1).select(output.a, float(ENV_RAY_LENGTH))),
        );
      }

      return output.max(0);
    });

    this._ssrFn = ssr;
    this._sharedContext = builder.getSharedContext();
    this._buildSSRMaterial();

    const reflectionBuffer = texture(this._ssrRenderTarget.texture);

    if (this.stochastic === false) {
      this._buildBlurMaterial();
    }

    this._copyMaterial.fragmentNode = reflectionBuffer;
    this._copyMaterial.needsUpdate = true;

    if (this.accumulate) {
      this._accumHistory.value = this._accumTargets[0].texture;
      this._resolveHistory.value = this._accumTargets[0].texture;
      // A non-finite sample (NaN fails every comparison) would poison the running mean forever: drop it as a
      // zero-weight sample, which the ratio estimator ignores.
      const current = reflectionBuffer.sample(uvNode);
      const finite = current.a
        .greaterThanEqual(0)
        .and(current.a.lessThan(1e30))
        .and(luminance(current.rgb).greaterThanEqual(0))
        .and(luminance(current.rgb).lessThan(1e30));
      this._accumMaterial.fragmentNode = mix(
        this._accumHistory.sample(uvNode),
        finite.select(current, vec4(0)),
        this._accumAlpha,
      );
      this._accumMaterial.needsUpdate = true;
      const sum = this._resolveHistory.sample(uvNode);
      this._resolveMaterial.fragmentNode = vec4(sum.rgb.div(sum.a.max(1e-8)), 1);
      this._resolveMaterial.needsUpdate = true;
    }

    if (this.temporalFilter) this._setupTemporalFilter(uvNode, sampleDepth);

    if (this._hiZ) {
      // level 0: the nearest of the depth samples covering the trace texel (2x2 at half resolution)
      const quarter = vec2(0.25).div(this._resolution);
      this._hiZMaterials[0].fragmentNode = vec4(
        min(
          min(sampleDepth(uvNode.add(quarter.mul(vec2(-1, -1)))), sampleDepth(uvNode.add(quarter.mul(vec2(1, -1))))),
          min(sampleDepth(uvNode.add(quarter.mul(vec2(-1, 1)))), sampleDepth(uvNode.add(quarter))),
        ),
      );
      // level L: the nearest of the 2x2 texels of level L - 1, plus the leftover row/column of an odd-sized source
      // (a 3x3 footprint, clamped), so every source texel is covered
      const downsample = (source, sourceLevel) =>
        Fn(() => {
          const sourceSize = ivec2(textureSize(textureLoad(source), int(sourceLevel)));
          const size = sourceSize.div(2).max(1);
          const base = ivec2(uvNode.mul(vec2(size)).floor()).mul(2);
          const last = sourceSize.sub(1);
          const tap = (x, y) => textureLoad(source, base.add(ivec2(x, y)).min(last), int(sourceLevel)).r;
          const nearest = min(min(tap(0, 0), tap(1, 0)), min(tap(0, 1), tap(1, 1))).toVar();
          for (const [x, y] of [
            [2, 0],
            [2, 1],
            [2, 2],
            [0, 2],
            [1, 2],
          ]) {
            nearest.assign(min(nearest, tap(x, y)));
          }
          return vec4(nearest);
        })();
      for (let level = 1; level < HIZ_LEVELS; level++) {
        this._hiZMaterials[level].fragmentNode = downsample(this._hiZTargets[(level - 1) % 2].texture, level - 1);
      }
      for (const m of this._hiZMaterials) m.needsUpdate = true;
    }

    //

    return this.getTextureNode();
  }

  /**
   * Builds the real-time filter passes (see `temporalFilter`): spatial ratio-estimator resolve, temporal
   * accumulation, history copy and the previous-frame geometry used to validate reprojected history.
   *
   * @private
   */
  _setupTemporalFilter(uvNode, sampleDepth) {
    const ratioTexture = texture(this._ssrRenderTarget.textures[0]);
    const distanceTexture = texture(this._ssrRenderTarget.textures[1]);
    const spatialTexture = texture(this._spatialTarget.texture);
    const historyTexture = texture(this._historyTarget.texture);
    const geometryTexture = texture(this._geometryTarget.texture);
    const resolution = this._resolution;
    const texel = vec2(1).div(resolution);
    // exact texel of a UV (the per-pixel samples must not be blended bilinearly)
    const snap = (coord) => coord.mul(resolution).floor().add(0.5).mul(texel);
    const viewPositionAt = (coord, depth) => getViewPosition(coord, depth, this._cameraProjectionMatrixInverse);
    const normalAt = (coord) => this.normalNode.sample(coord).rgb.normalize();
    const roughnessAt = (coord) => this.hitMaterialNode.sample(coord).g;

    // Spatial: Σ L·w / Σ w over this pixel's and up to 8 neighbours' rays (Stachowiak 2015), each neighbour weighted by
    // plane distance, normal and roughness similarity. The radius follows the lobe width (GGX alpha); mirrors keep
    // their own ray. Also resolves the w-weighted hit distance for the virtual-point reprojection.
    const spatial = Fn(() => {
      const depth = sampleDepth(uvNode).toVar();
      depth.greaterThanEqual(1.0).discard();
      const P = viewPositionAt(uvNode, depth).toVar();
      const N = normalAt(uvNode).toVar();
      const roughness = roughnessAt(uvNode).toVar();
      const center = ratioTexture.sample(uvNode).toVar();
      center.assign(isFiniteSample(center).select(center, vec4(0)));
      const numerator = center.rgb.toVar();
      const denominator = center.a.toVar();
      const distanceSum = center.a.mul(distanceTexture.sample(uvNode).r).toVar();
      const radius = roughness.mul(roughness).mul(this.spatialRadius).min(this.spatialMaxRadius).toVar();
      If(radius.greaterThan(0.5), () => {
        const pixel = uvNode.mul(resolution).floor();
        const seed = pixel.x.add(pixel.y.mul(resolution.x));
        const rotation = fract(hash(seed.mul(3).add(1)).add(float(this._frameIndex).mul(0.618034))).mul(Math.PI * 2);
        const TAPS = 8;
        for (let i = 0; i < TAPS; i++) {
          const angle = rotation.add(i * 2.399963);
          const uvTap = snap(
            uvNode.add(
              vec2(cos(angle), sin(angle))
                .mul(radius.mul(Math.sqrt((i + 0.5) / TAPS)))
                .mul(texel),
            ),
          );
          const inside = uvTap.x
            .greaterThan(0)
            .and(uvTap.x.lessThan(1))
            .and(uvTap.y.greaterThan(0))
            .and(uvTap.y.lessThan(1));
          const tapDepth = sampleDepth(uvTap);
          const planeDistance = abs(dot(N, viewPositionAt(uvTap, tapDepth).sub(P))).div(abs(P.z).mul(0.01).add(1e-4));
          const weight = float(1)
            .sub(planeDistance)
            .max(0)
            .mul(dot(N, normalAt(uvTap)).max(0).pow(16))
            .mul(
              abs(roughness.sub(roughnessAt(uvTap)))
                .mul(-20)
                .exp(),
            )
            .mul(inside.and(tapDepth.lessThan(1)).select(float(1), float(0)))
            .toVar();
          const tap = ratioTexture.sample(uvTap).toVar();
          weight.mulAssign(isFiniteSample(tap).select(float(1), float(0)));
          numerator.addAssign(tap.rgb.mul(weight));
          denominator.addAssign(tap.a.mul(weight));
          distanceSum.addAssign(tap.a.mul(weight).mul(distanceTexture.sample(uvTap).r));
        }
      });
      const inverse = float(1).div(denominator.max(1e-8));
      return vec4(numerator.mul(inverse), distanceSum.mul(inverse));
    });
    this._spatialMaterial.fragmentNode = spatial();
    this._spatialMaterial.needsUpdate = true;

    // Temporal: reproject the history along the surface motion and to the reflection's virtual point (the hit seen
    // through the mirror, which is what moves on screen for sharp reflections), keep whichever valid one is closer to
    // this frame's neighbourhood, variance-clip it and blend with 1/n, n capped by a roughness-dependent history length.
    const temporal = Fn(() => {
      const depth = sampleDepth(uvNode).toVar();
      depth.greaterThanEqual(1.0).discard();
      const P = viewPositionAt(uvNode, depth).toVar();
      const worldPosition = this._cameraWorldMatrix.mul(vec4(P, 1)).xyz.toVar();
      const worldNormal = this._cameraWorldMatrix
        .mul(vec4(normalAt(uvNode), 0))
        .xyz.normalize()
        .toVar();
      const roughness = roughnessAt(uvNode).toVar();
      const current = spatialTexture.sample(uvNode).toVar();

      const m1 = vec3(0).toVar();
      const m2 = vec3(0).toVar();
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          const c = toYCoCg(spatialTexture.sample(uvNode.add(vec2(x, y).mul(texel))).rgb).toVar();
          m1.addAssign(c);
          m2.addAssign(c.mul(c));
        }
      }
      const mean = m1.div(9).toVar();
      // dilated: the largest hit-object motion around this pixel
      const motion = float(0).toVar();
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          motion.assign(max(motion, distanceTexture.sample(uvNode.add(vec2(x, y).mul(texel))).g));
        }
      }
      const dynamic = motion.smoothstep(0.1, 1).toVar();
      const sigma = sqrt(m2.div(9).sub(mean.mul(mean)).max(0)).toVar();

      const project = projectToUV;
      const cameraPosition = this._cameraWorldPosition;
      const previousDistance = distance(this._previousCameraPosition, worldPosition).toVar();

      const uvSurface = uvNode.sub(this.velocityNode.sample(uvNode).xy.mul(vec2(0.5, -0.5))).toVar();
      const geometrySurface = geometryTexture.sample(uvSurface).toVar();
      const validSurface = insideScreen(uvSurface)
        .and(dot(geometrySurface.xyz, worldNormal).greaterThan(0.9))
        .and(abs(geometrySurface.w.sub(previousDistance)).lessThan(previousDistance.mul(0.05)));

      const viewDirection = worldPosition.sub(cameraPosition).normalize();
      const virtualPoint = cameraPosition.add(
        viewDirection.mul(distance(cameraPosition, worldPosition).add(current.a)),
      );
      // like the velocity buffer: the virtual point's motion between the two unjittered cameras, applied to this pixel,
      // so TRAA's sub-pixel jitter doesn't resample (blur) the history every frame
      const uvVirtual = uvNode
        .add(project(virtualPoint, this._previousViewProjection))
        .sub(project(virtualPoint, this._currentViewProjection))
        .toVar();
      const geometryVirtual = geometryTexture.sample(uvVirtual).toVar();
      const validVirtual = insideScreen(uvVirtual).and(dot(geometryVirtual.xyz, worldNormal).greaterThan(0.9));

      const historySurface = historyTexture.sample(uvSurface).toVar();
      const historyVirtual = historyTexture.sample(uvVirtual).toVar();
      const score = (h) => abs(toYCoCg(h.rgb).x.sub(mean.x)).div(sigma.x.add(1e-4));
      const useVirtual = validVirtual.and(validSurface.not().or(score(historyVirtual).lessThan(score(historySurface))));
      const history = useVirtual.select(historyVirtual, historySurface).toVar();
      const valid = validVirtual.or(validSurface).and(this._historyValid.greaterThan(0));

      const maxFrames = mix(
        mix(this.historyMin, this.historyMax, roughness.div(this.historyRoughness).clamp()),
        this.dynamicHistory,
        dynamic,
      );
      const frames = valid.select(history.a.add(1), float(1)).min(maxFrames).toVar();
      const box = sigma.mul(mix(this.clipGamma, this.dynamicClipGamma, dynamic));
      const clipped = fromYCoCg(toYCoCg(history.rgb).clamp(mean.sub(box), mean.add(box)));
      return vec4(mix(clipped, current.rgb, float(1).div(frames)), frames);
    });
    this._temporalMaterial.fragmentNode = temporal();
    this._temporalMaterial.needsUpdate = true;

    this._historyCopyMaterial.fragmentNode = texture(this._temporalTarget.texture).sample(uvNode);
    this._historyCopyMaterial.needsUpdate = true;

    // this frame's geometry for next frame's validation: world normal and distance to the (unjittered) camera
    this._geometryMaterial.fragmentNode = Fn(() => {
      const depth = sampleDepth(uvNode).toVar();
      depth.greaterThanEqual(1.0).discard();
      const worldPosition = this._cameraWorldMatrix.mul(vec4(viewPositionAt(uvNode, depth), 1)).xyz;
      const worldNormal = this._cameraWorldMatrix.mul(vec4(normalAt(uvNode), 0)).xyz.normalize();
      return vec4(worldNormal, distance(this._cameraWorldPosition, worldPosition));
    })();
    this._geometryMaterial.needsUpdate = true;

    // Joint bilateral upsample (identity at full resolution): the 4 nearest filtered texels, bilinear weights times
    // plane-distance and normal similarity to this full-resolution pixel, so reflections don't bleed across edges.
    const temporalTexture = texture(this._temporalTarget.texture);
    this._upsampleMaterial.fragmentNode = Fn(() => {
      const depth = sampleDepth(uvNode).toVar();
      depth.greaterThanEqual(1.0).discard();
      const P = viewPositionAt(uvNode, depth).toVar();
      const N = normalAt(uvNode).toVar();
      const coord = uvNode.mul(resolution).sub(0.5).toVar();
      const base = coord.floor().toVar();
      const f = coord.sub(base).toVar();
      const sum = vec3(0).toVar();
      const weightSum = float(0).toVar();
      for (const [x, y] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const uvTap = base
          .add(vec2(x, y))
          .add(0.5)
          .mul(texel)
          .clamp(texel.mul(0.5), vec2(1).sub(texel.mul(0.5)));
        const tapDepth = sampleDepth(uvTap);
        const bilinear = (x ? f.x : f.x.oneMinus()).mul(y ? f.y : f.y.oneMinus());
        const plane = abs(dot(N, viewPositionAt(uvTap, tapDepth).sub(P))).div(abs(P.z).mul(0.01).add(1e-4));
        const weight = bilinear
          .add(1e-3)
          .mul(float(1).sub(plane).max(0))
          .mul(dot(N, normalAt(uvTap)).max(0).pow(8))
          .mul(tapDepth.lessThan(1).select(float(1), float(0)))
          .toVar();
        sum.addAssign(temporalTexture.sample(uvTap).rgb.mul(weight));
        weightSum.addAssign(weight);
      }
      // no compatible texel (thin feature): nearest
      return vec4(weightSum.greaterThan(1e-4).select(sum.div(weightSum), temporalTexture.sample(uvNode).rgb), 1);
    })();
    this._upsampleMaterial.needsUpdate = true;
  }

  getRenderTarget() {
    return this._ssrRenderTarget;
  }

  /**
   * Frees internal resources. This method should be called
   * when the effect is no longer required.
   */
  dispose() {
    super.dispose();

    this._ssrRenderTarget.dispose();
    this._blurRenderTarget.dispose();

    this._ssrMaterial.dispose();
    this._blurMaterial.dispose();
    if (this.accumulate) {
      for (const target of this._accumTargets) target.dispose();
      this._resolveTarget.dispose();
      this._accumMaterial.dispose();
      this._resolveMaterial.dispose();
    }
    this._copyMaterial.dispose();
    if (this._hiZ) {
      for (const t of this._hiZTargets) t.dispose();
      for (const m of this._hiZMaterials) m.dispose();
    }
    if (this.temporalFilter) {
      for (const t of [this._spatialTarget, this._temporalTarget, this._historyTarget, this._geometryTarget]) {
        t.dispose();
      }
      this._upsampleTarget.dispose();
      this._upsampleMaterial.dispose();
      for (const m of [
        this._spatialMaterial,
        this._temporalMaterial,
        this._historyCopyMaterial,
        this._geometryMaterial,
      ]) {
        m.dispose();
      }
    }

    if (this._importanceEnvironment !== null) {
      this._importanceEnvironment.dispose();
      this._importanceEnvironment = null;
    }
  }
}

export default NewSSRNode;

/**
 * TSL function for creating screen space reflections (SSR).
 *
 * @tsl
 * @function
 * @param {Node<vec4>} colorNode - The node that represents the beauty pass.
 * @param {Node<float>} depthNode - A node that represents the beauty pass's depth.
 * @param {Node<vec3>} normalNode - A node that represents the beauty pass's normals.
 * @param {NewSSRNodeOptions} [options] - Optional inputs for material and environment data.
 * @returns {NewSSRNode}
 */
export const newSSR = (colorNode, depthNode, normalNode, options = {}) =>
  nodeObject(new NewSSRNode(nodeObject(colorNode), nodeObject(depthNode), nodeObject(normalNode), options));
