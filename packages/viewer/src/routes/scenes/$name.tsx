import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import Header, { buttonClassName } from '#/components/Header';
import { ResultImage } from '#/components/ResultImage';
import { isSceneName, readSceneResult, sceneRegistry } from '#/lib/results.server';
import { RENDERERS, formatMetric, psnrClassName } from '#/lib/scenes';

const getScene = createServerFn({ method: 'GET' })
  .validator((name: string) => name)
  .handler(async ({ data: name }) => {
    const registered = sceneRegistry().find((scene) => scene.name === name);
    const result = isSceneName(name) ? await readSceneResult(name) : undefined;
    if (!result || (!registered && !result.metrics && !Object.values(result.images).some(Boolean))) {
      throw notFound();
    }
    return { ...result, description: registered?.description };
  });

export const Route = createFileRoute('/scenes/$name')({
  loader: ({ params }) => getScene({ data: params.name }),
  head: ({ params }) => ({ meta: [{ title: `${params.name} – Screen-Space Fidelity` }] }),
  component: SceneDetail,
});

function SceneDetail() {
  const scene = Route.useLoaderData();
  const { metrics, images } = scene;
  const [split, setSplit] = useState(50);

  return (
    <>
      <Header />
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-xl font-semibold">{scene.name}</h1>
            {scene.description ? <p className="text-sm text-muted-foreground">{scene.description}</p> : null}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Link className={buttonClassName} to="/">
              All scenes
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

        <section className="grid gap-4 md:grid-cols-2">
          <figure>
            <ResultImage alt="three-gpu-pathtracer reference" src={images.reference} />
            <figcaption className="mt-1 text-center text-sm text-muted-foreground">
              three-gpu-pathtracer (reference)
            </figcaption>
          </figure>
          <figure>
            <ResultImage alt="three-ss" src={images.test} />
            <figcaption className="mt-1 text-center text-sm text-muted-foreground">three-ss</figcaption>
          </figure>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <figure>
            {images.reference && images.test ? (
              <div className="relative select-none">
                <img alt="three-ss" className="block w-full border border-border" src={images.test} />
                <img
                  alt="three-gpu-pathtracer reference"
                  className="absolute inset-0 block w-full border border-border"
                  src={images.reference}
                  style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                />
                <div className="pointer-events-none absolute inset-y-0 w-px bg-white" style={{ left: `${split}%` }} />
                <input
                  aria-label="Compare split"
                  className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
                  max={100}
                  min={0}
                  onChange={(event) => setSplit(Number(event.currentTarget.value))}
                  type="range"
                  value={split}
                />
              </div>
            ) : (
              <ResultImage alt="compare" />
            )}
            <figcaption className="mt-1 text-center text-sm text-muted-foreground">
              compare: reference (left) / three-ss (right) — drag to swipe
            </figcaption>
          </figure>
          <figure>
            <ResultImage alt="delta" src={images.delta} />
            <figcaption className="mt-1 text-center text-sm text-muted-foreground">delta</figcaption>
          </figure>
        </section>

        <section>
          <h2 className="mb-2 font-semibold">Metrics</h2>
          {metrics ? (
            <dl className={`grid max-w-md grid-cols-2 gap-x-4 gap-y-1 p-2 font-mono text-sm ${psnrClassName(metrics)}`}>
              <dt>PSNR (dB)</dt>
              <dd>{formatMetric(metrics.psnr)}</dd>
              <dt>RMSE</dt>
              <dd>{formatMetric(metrics.rmse, 5)}</dd>
              <dt>MAE</dt>
              <dd>{formatMetric(metrics.mae, 5)}</dd>
              <dt>Max error</dt>
              <dd>{formatMetric(metrics.maxError, 5)}</dd>
              <dt>Size</dt>
              <dd>
                {metrics.width}×{metrics.height}
              </dd>
              <dt>Generated</dt>
              <dd>{metrics.generatedAt}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No metrics yet. Run `pnpm cli compare`.</p>
          )}
        </section>
      </div>
    </>
  );
}
