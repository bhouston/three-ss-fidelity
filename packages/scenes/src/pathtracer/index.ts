// Definitions retain the sibling cameras, lighting and material transforms. Identity is explicitly mapped.
import { khronosScenes } from './khronos.js';
import { modelListScenes } from './model-list.js';
import { giDiagnosticScenes } from './gi-diagnostics.js';
import { ssgiScenes } from './ssgi.js';
import mappings from './scene-map.json' with { type: 'json' };
import type { SceneDefinition } from '../types.js';
const ids = new Map(mappings.map((entry) => [entry.source, entry.id]));
export const pathtracerScenes: SceneDefinition[] = [
  ...ssgiScenes,
  ...khronosScenes,
  ...modelListScenes,
  ...giDiagnosticScenes,
].map((definition) => {
  const name = ids.get(definition.name);
  if (!name) throw new Error('Missing imported scene mapping: ' + definition.name);
  return {
    ...definition,
    name,
    async create(ctx) {
      const setup = await definition.create({
        loadGLTF: (asset) => ctx.loadGLTF(asset),
        loadHDR: (asset) => ctx.loadHDR(asset),
        loadLDraw: (asset) => {
          if (!ctx.loadLDraw) throw new Error('This scene requires an LDraw asset loader');
          return ctx.loadLDraw(asset);
        },
        loadCollada: (asset) => {
          if (!ctx.loadCollada) throw new Error('This scene requires a Collada asset loader');
          return ctx.loadCollada(asset);
        },
      });
      const { toneMapping, toneMappingExposure, ...rest } = setup;
      return { ...rest, effects: { toneMapping, toneMappingExposure, temporalDenoise: false, frames: 1 } };
    },
  };
});
