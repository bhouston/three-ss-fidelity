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
} from 'three/tsl';
import {
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
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

// Maximum ray-march step count; `quality` (0..1) scales it to a fixed per-ray count.
const MAX_STEPS = 64;

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
    } = options;

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
    this._ssrRenderTarget = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
    this._ssrRenderTarget.texture.name = 'NewSSRNode.SSR';

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
      this.accumulate ? this._resolveTarget.texture : this._ssrRenderTarget.texture,
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
    this._ssrMaterial.fragmentNode = this._ssrFn();
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
    width = Math.round(this.resolutionScale * width);
    height = Math.round(this.resolutionScale * height);

    this._resolution.value.set(width, height);
    this._ssrRenderTarget.setSize(width, height);
    this._blurRenderTarget.setSize(width, height);
    if (this.accumulate) {
      for (const target of this._accumTargets) target.setSize(width, height);
      this._resolveTarget.setSize(width, height);
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
    const sampleMarchNoise = (uvCoord, frameIndex) => {
      const pixel = uvCoord.mul(this._resolution).floor();
      const seed = pixel.x.add(pixel.y.mul(this._resolution.x)).mul(4);
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

      // Guard grazing or back-facing normals, which would make the ray infinite or reverse it.
      const maxReflectRayLen = this.maxDistance.div(dot(viewIncidentDir.negate(), viewNormal).max(1e-3)).toVar();

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
      const totalStep = int(
        denseMarch
          ? trunc(max(abs(xLen), abs(yLen)).mul(this.quality.clamp()).min(65536))
              .max(int(1))
              .toConst()
          : this.quality.clamp().mul(MAX_STEPS).max(float(1)),
      )
        .mul(skipTrace ? int(metalness.greaterThan(0.0)) : int(1))
        .toConst();

      const xSpan = xLen.div(totalStep).toVar();
      const ySpan = yLen.div(totalStep).toVar();

      const stepVec = vec2(xSpan, ySpan).toVar();
      const invResolution = vec2(float(1), float(1)).div(this._resolution).toVar();
      const uvPixelStepX = vec2(invResolution.x, float(0)).toVar();

      const output = vec4(0).toVar();
      const hit = float(0).toVar();

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
      const sampleFraction = denseMarch
        ? (idx) => idx.add(noise.z.sub(0.5)).div(totalStep).max(0)
        : (idx) => max(idx.add(noise.z.sub(0.5)).div(totalStep).pow(this.stepExponent), idx.div(rayLen));

      // Carry the hit out of the loop so refinement runs after the march, not nested inside it (a
      // loop-inside-a-loop tripped shader-compiler bugs on some drivers). hitSLo/hitSHi bracket s.
      const foundHit = bool(false).toVar();
      const hitSLo = float(0).toVar();
      const hitSHi = float(0).toVar();
      // Carry the coarse hit's UV/depth to skip a redundant fetch when refinement is off.
      const hitUvS = vec2(0).toVar();
      const hitD = float(0).toVar();

      // March from d0 toward d1 (inclusive), looking for an intersection with the depth buffer.
      Loop({ start: int(1), end: totalStep, condition: '<=' }, ({ i }) => {
        // Exponentially-distributed ray parameter, shared by the sample position and ray depth.
        // The jitter can push the last step past d1, so clamp it to the ray's end.
        const s = sampleFraction(float(i)).min(1).toVar();

        const xy = screenPosAt(s).toVar();

        If(
          xy.x
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

      If(foundHit, () => {
        // Bisect the bracketed crossing toward the exact intersection. Run after the march, not
        // nested (a loop-inside-a-loop tripped shader-compiler bugs on some drivers).
        if (this.binaryRefine) {
          Loop({ start: int(0), end: int(8), type: 'int', condition: '<' }, () => {
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
          const worldDistance = distance(worldPosition, hitWorldPosition).mul(specDominantFactor).toVar();

          const reflectColor = this.colorNode.sample(uvS).toVar();

          // Multi-bounce: add the reprojected previous-frame reflection at the hit point.
          reflectColor.rgb.assign(reprojectHitPointHistory(uvS, reflectColor.rgb));

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
      if (this.accumulate) {
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

    //

    return this.getTextureNode();
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
