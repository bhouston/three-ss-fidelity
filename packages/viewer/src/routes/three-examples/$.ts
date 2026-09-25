import { createFileRoute } from '@tanstack/react-router';
import { fileResponse } from '#/lib/file-response.server';
import { threeExamplesDir } from '#/lib/results.server';

/** Serves `submodules/three.js/examples/**` (glTF models, Draco decoder, textures) for the live views. */
export const Route = createFileRoute('/three-examples/$')({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        fileResponse(request, threeExamplesDir(), params._splat ?? '', 'public, max-age=86400'),
    },
  },
});
