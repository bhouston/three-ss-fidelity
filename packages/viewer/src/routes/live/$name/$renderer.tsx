import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import Header, { buttonClassName } from '#/components/Header';
import { RENDERERS, isRendererName, parsePass, passSearch, type PassName } from '#/lib/scenes';
import { MAX_PATHTRACER_SAMPLES, startLiveRender } from '#/live/live-render';

export const Route = createFileRoute('/live/$name/$renderer')({
  ssr: false,
  params: {
    parse: ({ name, renderer }) => {
      if (!isRendererName(renderer)) throw notFound();
      return { name, renderer };
    },
  },
  validateSearch: (search: Record<string, unknown>): { pass?: PassName } => ({
    pass: passSearch(parsePass(search.pass)),
  }),
  head: ({ params }) => ({ meta: [{ title: `${params.name} (${params.renderer}) – three-ss-fidelity` }] }),
  component: Live,
});

function Live() {
  const { name, renderer } = Route.useParams();
  const pass = parsePass(Route.useSearch().pass);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [samples, setSamples] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let live: { dispose(): void } | undefined;
    setSamples(0);
    setError(undefined);
    startLiveRender({ canvas, sceneName: name, renderer, pass, onFrame: setSamples }).then(
      (handle) => (disposed ? handle.dispose() : (live = handle)),
      (reason: unknown) => !disposed && setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      disposed = true;
      live?.dispose();
    };
  }, [name, renderer, pass]);

  return (
    <>
      <Header />
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">
            {name} <span className="text-muted-foreground">· {pass} · live</span>
          </h1>
          <div className="ml-auto flex flex-wrap gap-2">
            {RENDERERS.map((other) => (
              <Link
                aria-current={other === renderer ? 'page' : undefined}
                className={`${buttonClassName} ${other === renderer ? 'border-primary font-semibold' : ''}`}
                key={other}
                params={{ name, renderer: other }}
                search={{ pass: passSearch(pass) }}
                to="/live/$name/$renderer"
              >
                {other}
              </Link>
            ))}
            <button
              className={buttonClassName}
              onClick={() => void canvasRef.current?.requestFullscreen()}
              type="button"
            >
              Full screen
            </button>
            <Link className={buttonClassName} params={{ name }} search={{ pass: passSearch(pass) }} to="/scenes/$name">
              Back to results
            </Link>
          </div>
        </div>
        <div className="relative border border-border bg-black">
          {/* key: a fresh canvas per renderer, since a canvas can't switch between WebGPU and WebGL2 contexts. */}
          <canvas className="block h-auto w-full touch-none" key={`${renderer}-${pass}`} ref={canvasRef} />
          <div className="absolute top-2 left-2 bg-black/60 px-2 py-1 font-mono text-xs text-white">
            {renderer} ·{' '}
            {renderer === 'three-gpu-pathtracer'
              ? `${samples} / ${MAX_PATHTRACER_SAMPLES} samples`
              : `${samples} frames`}
          </div>
          {error ? (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white">
              {error}
            </div>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">Drag to orbit, scroll to zoom, right-drag to pan.</p>
      </div>
    </>
  );
}
