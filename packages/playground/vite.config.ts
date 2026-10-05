import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';

const stockRequire = createRequire(new URL('../renderers/package.json', import.meta.url));
const stockRoot = dirname(dirname(stockRequire.resolve('three-r186')));

const source = (name: string) => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));
export default defineConfig({
  plugins: [
    {
      name: 'stock-three-self-imports',
      enforce: 'pre',
      resolveId(id) {
        if (id !== 'three-r186' && !id.startsWith('three-r186/')) return;
        return id === 'three-r186' ? join(stockRoot, 'build/three.module.js') : stockRequire.resolve(id);
      },
      transform(code, id) {
        if (!id.startsWith(stockRoot + '/')) return;
        // Preserve the npm package's self imports and their Vite dependency version.
        // Using the same specifier as application imports avoids duplicate TSL stacks.
        return code.replace(/(from\s*['"])three(?=\/|['"])/g, '$1three-r186');
      },
    },
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
  // Keep one TSL stack per Three.js version; prebundling can embed additional runtime copies.
  optimizeDeps: { exclude: ['three', 'three-r186', 'three-mesh-bvh', 'three-gpu-pathtracer'] },
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
