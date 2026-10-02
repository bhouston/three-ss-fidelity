import { DataTexture, RGBAFormat, TextureSource, UnsignedByteType } from 'three';
import type { Material, Mesh, MeshPhysicalMaterial, Scene, Texture } from 'three';

/** Keep base-color alpha cutouts while removing the texture's RGB tint. */
function whiteAlphaTexture(original: Texture): Texture {
  const image = original.image as { width: number; height: number; data?: ArrayLike<number> };
  const { width, height } = image;
  let pixels = image.data;
  if (!pixels) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot read the material opacity texture');
    context.drawImage(original.image as CanvasImageSource, 0, 0);
    pixels = context.getImageData(0, 0, width, height).data;
  }
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let i = 3; i < data.length; i += 4) data[i] = pixels[i]!;
  const texture: Texture = new DataTexture(data, width, height);
  texture.copy(original);
  // Texture.copy shares the source; assign a new one before changing pixels.
  texture.source = new TextureSource({ data, width, height });
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.needsUpdate = true;
  return texture;
}

/** Whiten an owned scene's materials, retaining surface detail, opacity and physical parameters. */
export function makeMaterialsWhite(scene: Scene): void {
  const materials = new Set<Material>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh)
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  const textures = (): Set<Texture> =>
    new Set(
      [...materials].flatMap((material) =>
        Object.values(material).filter((value): value is Texture => value?.isTexture === true),
      ),
    );
  const originalTextures = textures();
  const whiteMaps = new Map<Texture, Texture>();
  for (const material of materials) {
    const surface = material as MeshPhysicalMaterial;
    surface.color?.setRGB(1, 1, 1);
    surface.specularColor?.setRGB(1, 1, 1);
    surface.sheenColor?.setRGB(1, 1, 1);
    surface.attenuationColor?.setRGB(1, 1, 1);
    surface.vertexColors = false;
    if (surface.map) {
      const original = surface.map;
      if (surface.transparent || surface.alphaTest > 0) {
        if (!whiteMaps.has(original)) whiteMaps.set(original, whiteAlphaTexture(original));
        surface.map = whiteMaps.get(original)!;
      } else surface.map = null;
    }
    surface.specularColorMap = null;
    surface.sheenColorMap = null;
    if (surface.emissive) {
      const luminance = 0.2126 * surface.emissive.r + 0.7152 * surface.emissive.g + 0.0722 * surface.emissive.b;
      surface.emissive.setRGB(luminance, luminance, luminance);
    }
    surface.emissiveMap = null;
    surface.needsUpdate = true;
  }
  const retained = textures();
  for (const texture of originalTextures)
    if (!retained.has(texture) && texture !== scene.environment && texture !== scene.background) texture.dispose();
}
