import { BufferGeometry, Mesh } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** Keep only trace attributes and weld atlas triangle duplicates to fit large scenes in GPU storage buffers. */
export function createBakeTraceMeshes(entries) {
  return entries.map(({ mesh, geometry }) => {
    const attributes = new BufferGeometry();
    attributes.setAttribute('position', geometry.getAttribute('position'));
    attributes.setAttribute('uv1', geometry.getAttribute('uv1'));
    if (geometry.index) attributes.setIndex(geometry.index);
    const compact = mergeVertices(attributes, 1e-7);
    attributes.dispose();
    const proxy = new Mesh(compact, mesh.material);
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(mesh.matrixWorld);
    proxy.updateMatrixWorld(true);
    proxy.castShadow = mesh.castShadow;
    return proxy;
  });
}
