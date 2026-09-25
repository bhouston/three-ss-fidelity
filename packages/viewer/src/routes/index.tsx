import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { ArrowUpDown, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import Header, { buttonClassName } from '#/components/Header';
import { ResultImage } from '#/components/ResultImage';
import { listScenes, sceneRegistry } from '#/lib/results.server';
import {
  RENDERERS,
  SORT_OPTIONS,
  filterScenes,
  formatMetric,
  parseSort,
  psnrClassName,
  sortScenes,
  type SceneSummary,
  type SortValue,
} from '#/lib/scenes';

const getScenes = createServerFn({ method: 'GET' }).handler(() => listScenes(sceneRegistry()));

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { filter?: string; sort?: SortValue } => ({
    filter: typeof search.filter === 'string' && search.filter.trim() ? search.filter : undefined,
    sort: parseSort(search.sort) === 'name' ? undefined : parseSort(search.sort),
  }),
  loader: () => getScenes(),
  component: Index,
});

function Index() {
  const scenes = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [filterInput, setFilterInput] = useState(search.filter ?? '');
  const sort = parseSort(search.sort);
  const shown = sortScenes(filterScenes(scenes, search.filter ?? ''), sort);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const filter = filterInput.trim() ? filterInput : undefined;
      if (filter !== search.filter) void navigate({ replace: true, search: (prev) => ({ ...prev, filter }) });
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [filterInput, search.filter, navigate]);

  return (
    <>
      <Header>
        <input
          aria-label="Filter scenes"
          className="h-9 w-full min-w-0 rounded-none border border-border bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-primary md:w-80"
          onChange={(event) => setFilterInput(event.currentTarget.value)}
          placeholder="Scene Filter"
          type="text"
          value={filterInput}
        />
        <div className="relative shrink-0">
          <ArrowUpDown className="pointer-events-none absolute top-1/2 left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-foreground" />
          <select
            aria-label="Sort scenes"
            className="h-9 w-9 appearance-none rounded-none border border-border bg-muted/40 p-0 text-sm text-transparent shadow-xs outline-none transition-colors hover:border-primary/40 hover:bg-muted/60 focus:border-primary"
            onChange={(event) =>
              void navigate({
                replace: true,
                search: (prev) => ({
                  ...prev,
                  sort: event.target.value === 'name' ? undefined : parseSort(event.target.value),
                }),
              })
            }
            title={`Sort: ${SORT_OPTIONS.find((option) => option.value === sort)?.label}`}
            value={sort}
          >
            {SORT_OPTIONS.map((option) => (
              <option className="text-foreground" key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">
          {shown.length}/{scenes.length}
        </span>
      </Header>
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6">
        <p className="text-sm leading-6 text-muted-foreground sm:text-base">
          Each scene is rendered with three.js screen-space effects (<code>three-ss</code>: SSGI, SSR, AO on
          WebGPURenderer) and with <code>three-gpu-pathtracer</code> as ground truth. The delta image and PSNR / RMSE /
          MAE show how far the screen-space approximation is from the reference.
        </p>
        <section>
          {shown.length > 0 ? (
            shown.map((scene) => <SceneRow key={scene.name} scene={scene} />)
          ) : (
            <div className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              {scenes.length === 0
                ? 'No results yet. Run `pnpm cli render` and `pnpm cli compare`.'
                : 'No scenes match.'}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function SceneRow({ scene }: { scene: SceneSummary }) {
  const { metrics, images } = scene;
  const cells = [
    { label: 'three-gpu-pathtracer (reference)', src: images.reference },
    { label: 'three-ss', src: images.test },
    { label: 'delta', src: images.delta },
  ];
  return (
    <article className="border-b border-border py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-foreground">
          <Link params={{ name: scene.name }} to="/scenes/$name">
            {scene.name}
          </Link>
        </h3>
        {scene.description ? <p className="text-sm text-muted-foreground">{scene.description}</p> : null}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Link className={buttonClassName} params={{ name: scene.name }} to="/scenes/$name">
            Details
          </Link>
          {RENDERERS.map((renderer) => (
            <Link
              className={buttonClassName}
              key={renderer}
              params={{ name: scene.name, renderer }}
              to="/live/$name/$renderer"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" /> Live {renderer}
            </Link>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        <Link className="grid flex-1 grid-cols-3 gap-px" params={{ name: scene.name }} to="/scenes/$name">
          {cells.map((cell) => (
            <figure className="flex min-w-0 flex-col gap-1" key={cell.label}>
              <ResultImage alt={`${scene.name}: ${cell.label}`} src={cell.src} />
              <figcaption className="truncate text-center text-xs text-muted-foreground">{cell.label}</figcaption>
            </figure>
          ))}
        </Link>
        <dl className={`grid w-40 grid-cols-2 gap-x-2 p-2 font-mono text-xs ${psnrClassName(metrics)}`}>
          <dt>PSNR</dt>
          <dd className="text-right">{formatMetric(metrics?.psnr)}</dd>
          <dt>RMSE</dt>
          <dd className="text-right">{formatMetric(metrics?.rmse, 4)}</dd>
          <dt>MAE</dt>
          <dd className="text-right">{formatMetric(metrics?.mae, 4)}</dd>
        </dl>
      </div>
    </article>
  );
}
