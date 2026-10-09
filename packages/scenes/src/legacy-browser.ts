import { MeshStandardMaterial } from 'three';
import type { Mesh, Object3D } from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { LDrawUtils } from 'three/addons/utils/LDrawUtils.js';

export async function loadBrowserLDraw(url: string, library: string): Promise<Object3D> {
  const loader = new LDrawLoader();
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial as never);
  await loader.preloadMaterials(library + 'colors/ldcfgalt.ldr');
  loader.setPartsLibraryPath(library + 'complete/ldraw/');
  const response = await fetch(url);
  if (!response.ok) throw new Error('LDraw asset request failed: ' + response.status + ' ' + url);
  const text = (await response.text()).replace(/^0 FILE (.+)$/gm, (_line, name: string) => {
    let normalized = name.trim().replace(/\\/g, '/');
    if (normalized.startsWith('s/')) normalized = 'parts/' + normalized;
    else if (normalized.startsWith('48/')) normalized = 'p/' + normalized;
    return '0 FILE ' + normalized;
  });
  const result = await new Promise<Object3D>((resolve, reject) => loader.parse(text, resolve, reject));
  const model = LDrawUtils.mergeObject(result);
  model.rotation.set(Math.PI, 0, 0);
  const lines: Object3D[] = [];
  model.traverse((object) => {
    if ((object as { isLineSegments?: boolean }).isLineSegments) lines.push(object);
    if ((object as Mesh).isMesh) ((object as Mesh).material as MeshStandardMaterial).roughness *= 0.25;
  });
  for (const line of lines) line.removeFromParent();
  return model;
}
export async function loadBrowserCollada(url: string): Promise<Object3D> {
  const scene = (await new ColladaLoader().loadAsync(url))!.scene;
  scene.scale.setScalar(1);
  scene.traverse((object) => {
    const material = (object as Mesh).material as MeshStandardMaterial & { isMeshPhongMaterial?: boolean };
    if (material?.isMeshPhongMaterial)
      (object as Mesh).material = new MeshStandardMaterial({
        color: material.color,
        roughness: material.roughness || 0,
        metalness: material.metalness || 0,
        map: material.map || null,
      });
  });
  return scene;
}
