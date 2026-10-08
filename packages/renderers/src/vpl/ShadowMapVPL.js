import { Box3, Vector3 } from 'three';
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { lights } from 'three/tsl';
import { VirtualPointLightGenerator } from './upstream/VirtualPointLightGenerator.js';
import { VirtualPointLightShadowMaps } from './upstream/VirtualPointLightShadowMaps.js';
import { VirtualPointLightsNode } from './upstream/VirtualPointLightsNode.js';

/** Static diffuse transport from three.js 24201509d9; camera changes reuse the visibility atlas. */
export class ShadowMapVPL {
  constructor(
    renderer,
    scene,
    { count = 128, bounces = 8, seed = 1, resolution = 64, minDistance = 3, candidateMultiplier = 16 } = {},
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.samples = count * candidateMultiplier;
    this.samplesPerFrame = this.samples;
    this.pass = 0;
    this.phase = 'preparing';
    this.snapshots = [];
    this.materials = new Map();
    this.options = { count, bounces, seed, candidateMultiplier };
    this.resolution = resolution;
    scene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(scene);
    this.options.bounds = bounds;
    const sourceLights = [];
    const directLights = [];
    scene.traverseVisible((object) => {
      if (object.isLight) {
        directLights.push(object);
        if (object.isPointLight || object.isDirectionalLight) sourceLights.push(object);
        else if (!object.isAmbientLight && !object.isHemisphereLight && !object.isLightProbe)
          throw new Error(`Shadow-map VPL transport does not support ${object.type} source lights`);
      }
    });
    this.sourceLights = sourceLights;
    this.generator = new VirtualPointLightGenerator(count);
    this.shadowMaps = new VirtualPointLightShadowMaps(
      count,
      resolution,
      Math.max(40, bounds.getSize(new Vector3()).length() * 2),
    );
    this.node = new VirtualPointLightsNode(this.generator, (start, end, index) =>
      this.shadowMaps.visibility(start, end, index),
    );
    this.node.minDistance.value = minDistance;
    const lighting = lights([...directLights, this.node]);
    try {
      scene.traverse((object) => {
        if (!object.isMesh) return;
        this.snapshots.push({ object, material: object.material });
        const convert = (source) => {
          if (!source.isMeshStandardMaterial) return source;
          if (!this.materials.has(source)) {
            const material = source.isMeshPhysicalMaterial
              ? new MeshPhysicalNodeMaterial()
              : new MeshStandardNodeMaterial();
            material.copy(source);
            material.lightsNode = lighting;
            this.materials.set(source, material);
          }
          return this.materials.get(source);
        };
        object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  step() {
    if (this.phase === 'converged') return false;
    this.generator.generate(this.scene, this.sourceLights, this.options);
    this.node.update();
    this.shadowMaps.update(this.renderer, this.scene, this.generator, this.node.bias.value, this.resolution);
    this.pass = 1;
    this.phase = 'converged';
    return true;
  }
  dispose() {
    for (const { object, material } of this.snapshots) object.material = material;
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.shadowMaps.dispose();
  }
}
