import { describe, expect, it } from 'vitest';
import { BoxGeometry, DataTexture, Mesh, MeshPhysicalMaterial, Scene } from 'three';
import { makeMaterialsWhite } from './white-materials.js';

describe('white materials', () => {
  it('removes color tint while retaining alpha cutouts, shared textures and physical properties', () => {
    const scene = new Scene();
    const pixels = new Uint8Array([20, 80, 160, 0, 40, 60, 100, 128]);
    const map = new DataTexture(pixels, 2, 1);
    map.channel = 1;
    map.repeat.set(2, 3);
    const discarded = new DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1);
    let disposed = 0;
    discarded.addEventListener('dispose', () => disposed++);
    const material = new MeshPhysicalMaterial({
      color: 0xff0000,
      map,
      normalMap: map,
      alphaTest: 0.5,
      opacity: 0.8,
      transmission: 0.9,
      roughness: 0.2,
      metalness: 0.3,
      thickness: 0.4,
      ior: 1.4,
      attenuationColor: 0xff0000,
      specularColor: 0x00ff00,
      sheenColor: 0x0000ff,
      vertexColors: true,
      emissive: 0x80ff40,
      emissiveIntensity: 2,
      emissiveMap: discarded,
      specularColorMap: discarded,
      sheenColorMap: discarded,
    });
    const opaque = new MeshPhysicalMaterial({ map: discarded, color: 0x001122 });
    const geometry = new BoxGeometry();
    scene.add(new Mesh(geometry, [material, opaque]), new Mesh(geometry, material));
    const emission = material.emissive.clone();
    const luminance = emission.r * 0.2126 + emission.g * 0.7152 + emission.b * 0.0722;
    makeMaterialsWhite(scene);
    expect(material.color.toArray()).toEqual([1, 1, 1]);
    expect(material.attenuationColor.toArray()).toEqual([1, 1, 1]);
    expect(material.specularColor.toArray()).toEqual([1, 1, 1]);
    expect(material.sheenColor.toArray()).toEqual([1, 1, 1]);
    expect(material.vertexColors).toBe(false);
    expect((material.map as DataTexture).image.data).toEqual(new Uint8Array([255, 255, 255, 0, 255, 255, 255, 128]));
    expect(material.map!.channel).toBe(1);
    expect(material.map!.repeat.toArray()).toEqual([2, 3]);
    expect(map.image.data).toBe(pixels);
    expect(material.normalMap).toBe(map);
    expect(opaque.map).toBeNull();
    expect(material.emissiveMap).toBeNull();
    expect(material.emissive.toArray()).toEqual([luminance, luminance, luminance]);
    expect(material.emissiveIntensity).toBe(2);
    expect(material).toMatchObject({
      alphaTest: 0.5,
      opacity: 0.8,
      transmission: 0.9,
      roughness: 0.2,
      metalness: 0.3,
      thickness: 0.4,
      ior: 1.4,
    });
    expect(disposed).toBe(1);
    geometry.dispose();
    material.map!.dispose();
    map.dispose();
    material.dispose();
    opaque.dispose();
  });
});
