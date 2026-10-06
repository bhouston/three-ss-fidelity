import suite from '../../../registry.json';
/** One renderer catalogue for fidelity, performance and live. */
export const liveRendererPresets = suite.renderers
  .filter((item) => !('kind' in item && item.kind === 'external'))
  .map((item) => ({
    id: item.id,
    name: item.name,
    renderer: item.params.renderer,
    experiment: 'experiment' in item.params ? item.params.experiment : 'baseline',
  }));
