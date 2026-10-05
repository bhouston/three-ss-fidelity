import suite from '../../../performance-suite.json';

/** Use the benchmark's renderer identities and experiment settings in the live picker. */
export const liveRendererPresets = [
  ...new Map(
    suite.entries.map((entry) => [
      entry.renderer.id,
      {
        id: entry.renderer.id,
        name: entry.renderer.name,
        renderer: entry.params.renderer,
        experiment: 'experiment' in entry.params ? entry.params.experiment : 'baseline',
      },
    ]),
  ).values(),
];
