import { Link, createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import Header, { PassSelect } from '#/components/Header';
import { Button } from '#/components/ui/button';
import {
  RENDERERS,
  formatCamera,
  isPathTracer,
  isRendererName,
  parseCamera,
  parsePass,
  passSearch,
  type PassName,
} from '#/lib/scenes';
import { MAX_PATHTRACER_SAMPLES, startLiveRender } from '#/live/live-render';

export const Route = createFileRoute('/scenes/$name/live/$renderer')({
  ssr: false,
  params: {
    parse: ({ name, renderer }) => {
      if (!isRendererName(renderer)) throw notFound();
      return { name, renderer };
    },
  },
  validateSearch: (search: Record<string, unknown>): { pass?: PassName; camera?: string } => {
    const camera = parseCamera(search.camera);
    return { pass: passSearch(parsePass(search.pass)), camera: camera && formatCamera(camera) };
  },
  head: ({ params }) => ({ meta: [{ title: `${params.name} (${params.renderer}) – three-ss-fidelity` }] }),
  component: Live,
});

function Live() {
  const { name, renderer } = Route.useParams();
  const search = Route.useSearch();
  const pass = parsePass(search.pass);
  const navigate = useNavigate({ from: Route.fullPath });
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
    let cameraTimeout: number | undefined;
    startLiveRender({
      canvas,
      sceneName: name,
      renderer,
      pass,
      // read from the URL once per renderer start: orbiting rewrites the param, which must not restart the renderer
      camera: parseCamera(new URLSearchParams(window.location.search).get('camera')),
      // keep the URL's camera current (debounced), so the renderer buttons below and reloads keep the view
      onCamera: (camera) => {
        window.clearTimeout(cameraTimeout);
        cameraTimeout = window.setTimeout(
          () => void navigate({ replace: true, search: (prev) => ({ ...prev, camera: formatCamera(camera) }) }),
          200,
        );
      },
      onFrame: setSamples,
    }).then(
      (handle) => (disposed ? handle.dispose() : (live = handle)),
      (reason: unknown) => !disposed && setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      disposed = true;
      window.clearTimeout(cameraTimeout);
      live?.dispose();
    };
  }, [name, renderer, pass, navigate]);

  return (
    <>
      <Header renderer={renderer} scene={name}>
        <PassSelect
          onValueChange={(next) =>
            void navigate({ replace: true, search: (prev) => ({ ...prev, pass: passSearch(next) }) })
          }
          value={pass}
        />
      </Header>
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">
            {name} <span className="text-muted-foreground">· {pass} · live</span>
          </h1>
          <div className="ml-auto flex flex-wrap gap-2">
            {RENDERERS.map((other) => (
              <Button asChild key={other} size="sm" variant={other === renderer ? 'default' : 'outline'}>
                <Link
                  aria-current={other === renderer ? 'page' : undefined}
                  params={{ name, renderer: other }}
                  search={{ pass: passSearch(pass), camera: search.camera }}
                  to="/scenes/$name/live/$renderer"
                >
                  {other}
                </Link>
              </Button>
            ))}
          </div>
        </div>
        <div className="relative border border-border bg-black">
          {/* key: a fresh canvas per renderer, since a canvas can't switch between WebGPU and WebGL2 contexts. */}
          <canvas className="block h-auto w-full touch-none" key={`${renderer}-${pass}`} ref={canvasRef} />
          <div className="absolute top-2 left-2 bg-black/60 px-2 py-1 font-mono text-xs text-white">
            {renderer} ·{' '}
            {isPathTracer(renderer) ? `${samples} / ${MAX_PATHTRACER_SAMPLES} samples` : `${samples} frames`}
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
