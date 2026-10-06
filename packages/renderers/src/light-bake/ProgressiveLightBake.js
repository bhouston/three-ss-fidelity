// UV-space rasterization follows Three.js ProgressiveLightMapGPU (MIT, zalo).
// BVHComputeData is the GPU BVH infrastructure used by gkjohnson's three-gpu-pathtracer.
import {
  Box3,
  Color,
  DoubleSide,
  FloatType,
  HalfFloatType,
  UnsignedByteType,
  LinearFilter,
  NearestFilter,
  Vector3,
} from 'three';
import { Mesh, Scene, OrthographicCamera, MeshBasicNodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu';
import { BVHComputeData, rayIntersectionResultStruct, wgslTagFn } from 'three-mesh-bvh/webgpu';
import {
  Fn,
  If,
  Loop,
  float,
  ivec2,
  materialColor,
  color,
  mix,
  mrt,
  packNormalToRGB,
  unpackRGBToNormal,
  normalWorldGeometry,
  positionWorld,
  screenCoordinate,
  texture,
  textureLoad,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { StaticGeometryGenerator } from 'three-mesh-bvh';
import { prepareAtlas } from './atlas.js';
import { createBakeTraceMeshes } from './trace-geometry.js';

const PI = Math.PI;

/** Fixed work budget and finite bake; camera motion never invalidates surface lighting. */
export class ProgressiveLightBake {
  constructor(renderer, scene, { samples = 1024, samplesPerFrame = 16, density = 16, mirrors = [] } = {}) {
    /** Planar mirrors as {normal, point, color}; the VPL gather connects through them (see VirtualPointLightGI). */
    this.mirrors = mirrors;
    this.renderer = renderer;
    this.scene = scene;
    this.samples = samples;
    this.samplesPerFrame = samplesPerFrame;
    this.pass = 0;
    this.phase = 'preparing';
    this.resources = [];
    this.snapshots = [];
    try {
      this.initialize(density);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  initialize(density) {
    const { scene } = this;
    scene.updateMatrixWorld(true);
    const sources = [];
    scene.traverseVisible((mesh) => {
      if (mesh.isSkinnedMesh || mesh.isInstancedMesh) sources.push(mesh);
    });
    for (const source of sources) {
      const snapshots = [];
      if (source.isSkinnedMesh) {
        const generator = new StaticGeometryGenerator([source]);
        generator.attributes = ['position', 'normal', 'uv', 'color'];
        generator.applyWorldTransforms = false;
        const geometry = generator.generate();
        const mesh = new Mesh(geometry, source.material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(source.matrix);
        mesh.castShadow = source.castShadow;
        mesh.receiveShadow = source.receiveShadow;
        snapshots.push(mesh);
      } else {
        for (let i = 0; i < source.count; i++) {
          const mesh = new Mesh(source.geometry, source.material);
          mesh.matrixAutoUpdate = false;
          source.getMatrixAt(i, mesh.matrix);
          mesh.matrix.premultiply(source.matrix);
          mesh.castShadow = source.castShadow;
          mesh.receiveShadow = source.receiveShadow;
          snapshots.push(mesh);
        }
      }
      this.snapshots.push({ source, visible: source.visible, snapshots });
      for (const mesh of snapshots) source.parent.add(mesh);
      source.visible = false;
    }
    this.atlas = prepareAtlas(scene, density);
    const size = this.atlas.size;
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2);
    this.camera.position.z = 1;
    this.gbufferScene = new Scene();
    this.gbuffer = new RenderTarget(size, size, {
      type: FloatType,
      count: 2,
      depthBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    this.gbuffer.textures[0].name = 'output';
    this.gbuffer.textures[1].name = 'normal';
    this.gbuffer.textures[1].type = this.normalTextureType();
    this.surface = new RenderTarget(size, size, {
      type: HalfFloatType,
      count: 2,
      depthBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    this.surface.textures[0].name = 'output';
    this.surface.textures[0].type = UnsignedByteType;
    this.surface.textures[1].name = 'emissive';
    this.resources.push(this.gbuffer, this.surface);
    this.gbufferClear = mrt({}).setClearColor('normal', 0, 0);
    this.surfaceClear = mrt({}).setClearColor('emissive', 0, 0);
    for (const entry of this.atlas.entries) {
      const original = Array.isArray(entry.originalMaterial) ? entry.originalMaterial : [entry.originalMaterial];
      const materials = original.map((source) => {
        const material = new MeshBasicNodeMaterial({ side: DoubleSide, depthTest: false, depthWrite: false });
        material.color.copy(source.color ?? new Color(1, 1, 1));
        material.map = source.map ?? null;
        material.vertexColors = source.vertexColors;
        const emission = color(source.emissive ?? new Color(0)).mul(source.emissiveIntensity ?? 1);
        const emitted = source.emissiveMap ? emission.mul(texture(source.emissiveMap, uv()).rgb) : emission;
        const metal = source.metalnessMap
          ? texture(source.metalnessMap, uv()).b.mul(source.metalness ?? 0)
          : float(source.metalness ?? 0);
        material.vertexNode = vec4(uv(1).flipY().mul(2).sub(1), 0, 1);
        material.fragmentNode = mrt({
          output: vec4(positionWorld, 1),
          normal: this.normalOutput(),
        });
        const surfaceMaterial = material.clone();
        surfaceMaterial.fragmentNode = mrt({
          output: vec4(materialColor.rgb.mul(metal.oneMinus()), 1),
          emissive: vec4(emitted, 1),
        });
        material.surfaceMaterial = surfaceMaterial;
        this.resources.push(material, surfaceMaterial);
        return material;
      });
      const proxy = new Mesh(entry.geometry, Array.isArray(entry.originalMaterial) ? materials : materials[0]);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(entry.mesh.matrixWorld);
      proxy.frustumCulled = false;
      this.gbufferScene.add(proxy);
      const live = original.map((m) => m.clone());
      entry.mesh.material = Array.isArray(entry.originalMaterial) ? live : live[0];
      this.resources.push(...live);
    }
    this.traceMeshes = createBakeTraceMeshes(this.atlas.entries);
    this.bvh = new BVHComputeData(this.traceMeshes, { attributes: { position: 'vec4f', uv1: 'vec2f' } });
    this.bvh.update();
    this.shadowBvh = new BVHComputeData(this.traceMeshes.filter((mesh) => mesh.castShadow));
    this.shadowBvh.update();
    // Offset scales with scene bounds rather than a fixed world unit.
    this.epsilon = Math.max(1e-6, this.bvh.bvh.getBoundingBox(new Box3()).getSize(new Vector3()).length() * 1e-5);
    const target = () => {
      const rt = new RenderTarget(size, size, {
        type: HalfFloatType,
        depthBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
      });
      rt.texture.channel = 1;
      this.resources.push(rt);
      return rt;
    };
    this.surfaceAlbedo = target();
    this.surfaceEmission = target();
    this.directRaw = target();
    this.direct = target();
    this.targets = [target(), target()];
    this.display = target();
    this.feedback = texture(this.display.texture);
    this.previous = texture(this.targets[0].texture);
    this.iteration = uniform(0);
    this.position = textureLoad(this.gbuffer.textures[0]);
    this.normal = textureLoad(this.gbuffer.textures[1]);
    this.albedo = texture(this.surfaceAlbedo.texture);
    this.emissive = texture(this.surfaceEmission.texture);
    this.lights = [];
    scene.traverseVisible((light) => {
      if (!(light.isDirectionalLight || light.isPointLight || light.isSpotLight || light.isRectAreaLight)) return;
      this.lights.push(light);
    });
    this.seedMaterial = this.material(this.seedGraph());
    this.bakeMaterial = this.material(this.bakeGraph());
    this.dilateMaterial = this.material(this.dilateGraph());
    this.dilateSource = texture(this.targets[0].texture);
    // Rebuild after creating the display source.
    this.dilateMaterial.fragmentNode = this.dilateGraph();
    this.quad = new QuadMesh();
  }
  /** @returns {import('three').TextureDataType} */
  normalTextureType() {
    return UnsignedByteType;
  }
  normalOutput() {
    return vec4(packNormalToRGB(normalWorldGeometry), 1);
  }
  material(node) {
    const m = new MeshBasicNodeMaterial();
    m.fragmentNode = node;
    this.resources.push(m);
    return m;
  }
  createTrace(bvh = this.bvh) {
    // The library exposes a WGSL pointer-result signature that its parser cannot call directly
    // from TSL. This ABI bridge only returns the library hit; all bake/shading math is TSL.
    const trace = wgslTagFn`
      fn lightBakeTrace(origin: vec3f, direction: vec3f, maxDist: f32) -> IntersectionResult {
        var hit: ${rayIntersectionResultStruct};
        ${bvh.fns.raycastFirstHit}(Ray(origin, direction, maxDist), &hit);
        return hit;
      }
    `;
    trace.outputType = rayIntersectionResultStruct;
    return trace;
  }
  trace(origin, direction, maxDist = 0, tracer) {
    return tracer(origin, direction, float(maxDist)).toVar();
  }
  directAt(p, n, random, tracer) {
    const sum = vec3(0).toVar();
    // Host specialization for a small heterogeneous light list; sample loop stays on the GPU.
    for (const light of this.lights) {
      const location = new Vector3().setFromMatrixPosition(light.matrixWorld);
      const intensity = color(light.color).mul(light.intensity);
      let direction, distance, contribution;
      if (light.isDirectionalLight) {
        direction = vec3(location.sub(new Vector3().setFromMatrixPosition(light.target.matrixWorld)).normalize());
        distance = float(0);
        contribution = intensity;
      } else {
        let lightPosition = vec3(location);
        if (light.isRectAreaLight) {
          const e = light.matrixWorld.elements;
          lightPosition = lightPosition
            .add(vec3(e[0], e[1], e[2]).mul(random.x.sub(0.5).mul(light.width)))
            .add(vec3(e[4], e[5], e[6]).mul(random.y.sub(0.5).mul(light.height)));
        }
        const delta = lightPosition.sub(p).toVar();
        distance = delta.length().toVar();
        direction = delta.div(distance.max(1e-6)).toVar();
        contribution = intensity.div(distance.pow(light.decay ?? 2).max(0.01));
        if (light.distance > 0)
          contribution = contribution.mul(distance.div(light.distance).pow(4).oneMinus().clamp().pow(2));
        if (light.isSpotLight) {
          const axis = vec3(new Vector3().setFromMatrixPosition(light.target.matrixWorld).sub(location).normalize());
          contribution = contribution.mul(
            direction
              .negate()
              .dot(axis)
              .smoothstep(Math.cos(light.angle), Math.cos(light.angle * (1 - light.penumbra))),
          );
        }
        if (light.isRectAreaLight) {
          const e = light.matrixWorld.elements;
          contribution = intensity
            .mul(light.width * light.height)
            .mul(direction.dot(vec3(e[8], e[9], e[10])).max(0))
            .div(distance.pow(2).max(0.01));
        }
      }
      const cosine = n.dot(direction).max(0).toVar();
      If(cosine.greaterThan(0), () => {
        const hit = this.trace(p.add(n.mul(this.epsilon)), direction, distance, tracer);
        If(hit.get('didHit').not(), () => {
          sum.addAssign(contribution.mul(cosine));
        });
      });
    }
    return sum;
  }
  random(index) {
    // R2 sequence with a deterministic per-texel scramble, shared across seed and bounce sampling.
    const pixel = screenCoordinate.xy.floor();
    const scramble = pixel.dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract();
    return vec2(index.mul(0.754877666), index.mul(0.569840296)).add(scramble).fract();
  }
  seedSampleCount() {
    return 16;
  }
  seedGraph() {
    const seedSamples = this.seedSampleCount();
    return Fn((builder) => {
      rayIntersectionResultStruct.setup(builder);
      const tracer = this.createTrace(this.shadowBvh);
      const pixel = ivec2(screenCoordinate.xy),
        p = this.position.load(pixel).toVar(),
        n = unpackRGBToNormal(this.normal.load(pixel).xyz).normalize().toVar();
      const result = vec3(0).toVar();
      If(p.w.greaterThan(0), () => {
        Loop({ start: 0, end: seedSamples, name: 'seedSample' }, ({ seedSample }) => {
          result.addAssign(this.directAt(p.xyz, n, this.random(float(seedSample)), tracer));
        });
      });
      return vec4(result.div(seedSamples), p.w);
    })();
  }
  bakeGraph() {
    return Fn((builder) => {
      rayIntersectionResultStruct.setup(builder);
      const tracer = this.createTrace();
      const pixel = ivec2(screenCoordinate.xy),
        p = this.position.load(pixel).toVar(),
        n = unpackRGBToNormal(this.normal.load(pixel).xyz).normalize().toVar();
      const previous = this.previous.load(pixel).toVar(),
        sum = vec3(0).toVar();
      If(p.w.greaterThan(0), () => {
        const tangent = n.z
          .abs()
          .lessThan(0.999)
          .select(vec3(0, 0, 1), vec3(1, 0, 0))
          .cross(n)
          .normalize()
          .toVar();
        const bitangent = n.cross(tangent).toVar();
        Loop({ start: 0, end: this.samplesPerFrame, name: 'bakeSample' }, ({ bakeSample }) => {
          const r = this.random(this.iteration.mul(this.samplesPerFrame).add(float(bakeSample))).toVar();
          const phi = r.y.mul(2 * PI),
            radius = r.x.sqrt();
          const direction = tangent
            .mul(radius.mul(phi.cos()))
            .add(bitangent.mul(radius.mul(phi.sin())))
            .add(n.mul(r.x.oneMinus().sqrt()))
            .toVar();
          const hit = this.trace(p.xyz.add(n.mul(this.epsilon)), direction, 0, tracer);
          If(hit.get('didHit').and(hit.get('side').greaterThan(0)), () => {
            const indices = hit.get('indices').toUVec4(),
              bary = hit.get('barycoord').toVec3();
            const attrib = this.bvh.storage.attributes;
            const hitUV = attrib
              .element(indices.x)
              .get('uv1')
              .toVec2()
              .mul(bary.x)
              .add(attrib.element(indices.y).get('uv1').toVec2().mul(bary.y))
              .add(attrib.element(indices.z).get('uv1').toVec2().mul(bary.z))
              .toVar();
            const outgoing = this.albedo
              .sample(hitUV)
              .rgb.mul(texture(this.direct.texture).sample(hitUV).rgb.add(this.feedback.sample(hitUV).rgb))
              .add(this.emissive.sample(hitUV).rgb.mul(PI));
            sum.addAssign(outgoing);
          });
        });
      });
      const weight = float(1).div(this.iteration.add(1)).max(0.04);
      return vec4(mix(previous.rgb, sum.div(this.samplesPerFrame), weight), p.w);
    })();
  }
  /** Opt-in diagnostic: per-texel counts over `rays` hemisphere rays, as rgba = escaped, front hit, back hit,
   * hit within 10 epsilon of the origin (starts-inside signal; also counted in front/back). Caller owns the target. */
  diagnoseRays(rays = 256) {
    const graph = Fn((builder) => {
      rayIntersectionResultStruct.setup(builder);
      const tracer = this.createTrace();
      const pixel = ivec2(screenCoordinate.xy),
        p = this.position.load(pixel).toVar(),
        n = unpackRGBToNormal(this.normal.load(pixel).xyz).normalize().toVar();
      const count = vec4(0).toVar();
      If(p.w.greaterThan(0), () => {
        const tangent = n.z
          .abs()
          .lessThan(0.999)
          .select(vec3(0, 0, 1), vec3(1, 0, 0))
          .cross(n)
          .normalize()
          .toVar();
        const bitangent = n.cross(tangent).toVar();
        Loop({ start: 0, end: rays, name: 'diagSample' }, ({ diagSample }) => {
          const r = this.random(float(diagSample)).toVar();
          const phi = r.y.mul(2 * PI),
            radius = r.x.sqrt();
          const direction = tangent
            .mul(radius.mul(phi.cos()))
            .add(bitangent.mul(radius.mul(phi.sin())))
            .add(n.mul(r.x.oneMinus().sqrt()))
            .toVar();
          const hit = this.trace(p.xyz.add(n.mul(this.epsilon)), direction, 0, tracer);
          If(hit.get('didHit').not(), () => count.x.addAssign(1))
            .ElseIf(hit.get('side').greaterThan(0), () => count.y.addAssign(1))
            .Else(() => count.z.addAssign(1));
          If(hit.get('didHit').and(hit.get('dist').lessThan(this.epsilon * 10)), () => count.w.addAssign(1));
        });
      });
      return count;
    })();
    const target = new RenderTarget(this.atlas.size, this.atlas.size, {
      type: FloatType,
      depthBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    const material = this.material(graph);
    const previousTarget = this.renderer.getRenderTarget();
    try {
      this.renderer.setClearColor(0, 0);
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.draw(material, target);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
    }
    return target;
  }
  dilateGraph() {
    return Fn(() => {
      if (!this.dilateSource) return vec4(0);
      const pixel = ivec2(screenCoordinate.xy),
        center = this.dilateSource.load(pixel).toVar();
      const sum = vec3(0).toVar(),
        weight = float(0).toVar();
      If(center.w.lessThan(0.5), () => {
        Loop(
          { start: -3, end: 3, condition: '<=', name: 'dx' },
          { start: -3, end: 3, condition: '<=', name: 'dy' },
          ({ dx, dy }) => {
            const q = pixel.add(ivec2(dx, dy)).clamp(ivec2(0), ivec2(this.atlas.size - 1));
            const value = this.dilateSource.load(q).toVar();
            sum.addAssign(value.rgb.mul(value.w));
            weight.addAssign(value.w);
          },
        );
        center.rgb.assign(sum.div(weight.max(1)));
        center.w.assign(weight.greaterThan(0).select(1, 0));
      });
      return center;
    })();
  }
  draw(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }
  step() {
    if (this.phase === 'converged') return false;
    const previousTarget = this.renderer.getRenderTarget(),
      previousMRT = this.renderer.getMRT();
    const clear = this.renderer.getClearColor(new Color()),
      alpha = this.renderer.getClearAlpha();
    try {
      this.renderer.setMRT(null);
      this.renderer.setClearColor(0, 0);
      if (this.phase === 'preparing') {
        this.renderer.setMRT(this.gbufferClear);
        this.renderer.setRenderTarget(this.gbuffer);
        this.renderer.clear();
        this.renderer.render(this.gbufferScene, this.camera);
        for (const proxy of this.gbufferScene.children) {
          proxy.positionMaterial = proxy.material;
          proxy.material = Array.isArray(proxy.material)
            ? proxy.material.map((m) => m.surfaceMaterial)
            : proxy.material.surfaceMaterial;
        }
        this.renderer.setMRT(this.surfaceClear);
        this.renderer.setRenderTarget(this.surface);
        this.renderer.clear();
        this.renderer.render(this.gbufferScene, this.camera);
        for (const proxy of this.gbufferScene.children) proxy.material = proxy.positionMaterial;
        this.renderer.setMRT(null);
        this.dilateSource.value = this.surface.textures[0];
        this.draw(this.dilateMaterial, this.surfaceAlbedo);
        this.dilateSource.value = this.surface.textures[1];
        this.draw(this.dilateMaterial, this.surfaceEmission);
        this.draw(this.seedMaterial, this.directRaw);
        this.dilateSource.value = this.directRaw.texture;
        this.draw(this.dilateMaterial, this.direct);
        for (const rt of this.targets) {
          this.renderer.setRenderTarget(rt);
          this.renderer.clear();
        }
        for (const entry of this.atlas.entries) {
          for (const m of Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material]) {
            m.lightMap = this.display.texture;
            m.lightMapIntensity = 1;
            m.needsUpdate = true;
          }
        }
        this.phase = 'accumulating';
      }
      const write = this.targets[(this.pass + 1) % 2];
      this.previous.value = this.targets[this.pass % 2].texture;
      this.iteration.value = this.pass;
      this.draw(this.bakeMaterial, write);
      this.dilateSource.value = write.texture;
      this.draw(this.dilateMaterial, this.display);
      this.pass++;
      if (this.pass * this.samplesPerFrame >= this.samples) {
        this.phase = 'converged';
        console.info(
          `Light bake: ${this.atlas.size}², ${this.atlas.charts.length} charts, ${this.pass * this.samplesPerFrame} samples; converged`,
        );
      }
      return true;
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setMRT(previousMRT);
      this.renderer.setClearColor(clear, alpha);
    }
  }
  dispose() {
    for (const entry of this.atlas?.entries ?? []) {
      entry.mesh.geometry = entry.originalGeometry;
      entry.mesh.material = entry.originalMaterial;
      entry.geometry.dispose();
    }
    for (const { source, visible, snapshots } of this.snapshots) {
      source.visible = visible;
      for (const mesh of snapshots) {
        mesh.removeFromParent();
        if (source.isSkinnedMesh) mesh.geometry.dispose();
      }
    }
    for (const resource of this.resources) resource.dispose();
    this.bvh?.dispose();
    this.shadowBvh?.dispose();
    for (const mesh of this.traceMeshes ?? []) mesh.geometry.dispose();
    this.quad?.dispose();
  }
}
