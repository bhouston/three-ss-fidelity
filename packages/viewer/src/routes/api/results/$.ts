import { createFileRoute } from '@tanstack/react-router';
import { fileResponse } from '#/lib/file-response.server';
import { RESULT_FILES, isSceneName, resultsDir } from '#/lib/results.server';
import { isPassName } from '#/lib/scenes';

/** `/api/results/<scene>/<pass>/<file>`: only the known result files of a valid scene and pass are served. */
export const Route = createFileRoute('/api/results/$')({
  server: {
    handlers: {
      GET: ({ params, request }) => {
        const [scene, pass, file, ...rest] = (params._splat ?? '').split('/');
        if (
          !scene ||
          !file ||
          rest.length > 0 ||
          !isSceneName(scene) ||
          !isPassName(pass) ||
          !RESULT_FILES.includes(file)
        ) {
          return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        }
        // Listing URLs carry `?v=<mtime>`, so versioned requests can be cached forever in production.
        const versioned = new URL(request.url).searchParams.has('v') && process.env.NODE_ENV === 'production';
        return fileResponse(
          request,
          resultsDir(),
          `${scene}/${pass}/${file}`,
          versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    },
  },
});
