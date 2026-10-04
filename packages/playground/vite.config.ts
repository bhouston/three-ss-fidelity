import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { defineConfig } from 'vite';

const source = (name: string) => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));
export default defineConfig({
  plugins: [
    {
      name: 'suite-assets',
      configureServer(server) {
        server.middlewares.use('/suite-assets', (request, response, next) => {
          const asset = request.url?.split('?')[0];
          if (!asset || !/^\/complex-scenes\/[a-z0-9-]+\.glb$/.test(asset)) return next();
          const stream = createReadStream(fileURLToPath(new URL(`../../assets${asset}`, import.meta.url)));
          stream.on('error', () => {
            if (!response.headersSent) next();
            else response.destroy();
          });
          response.setHeader('Content-Type', 'model/gltf-binary');
          stream.pipe(response);
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@ss-fidelity/runtime': source('runtime'),
      '@ss-fidelity/renderers': source('renderers'),
      '@ss-fidelity/scenes': source('scenes'),
      'performance-kit-reporter': fileURLToPath(
        new URL('../../submodules/performance-kit/packages/reporter/src/index.ts', import.meta.url),
      ),
    },
  },
  // Keep one TSL stack/runtime: prebundling BVH can embed a second copy of the linked Three.js fork.
  optimizeDeps: { exclude: ['three', 'three-mesh-bvh', 'three-gpu-pathtracer'] },
  publicDir: fileURLToPath(new URL('../../submodules/three.js/examples/', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
  },
  // The playground is a local development tool; don't duplicate the large examples asset library in builds.
  build: {
    copyPublicDir: false,
    rollupOptions: {
      input: {
        playground: fileURLToPath(new URL('./index.html', import.meta.url)),
        performance: fileURLToPath(new URL('./performance.html', import.meta.url)),
      },
    },
  },
});
