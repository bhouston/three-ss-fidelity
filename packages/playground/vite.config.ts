import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const source = (name: string) => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      '@ss-fidelity/runtime': source('runtime'),
      '@ss-fidelity/renderers': source('renderers'),
      '@ss-fidelity/scenes': source('scenes'),
    },
  },
  publicDir: fileURLToPath(new URL('../../submodules/three.js/examples/', import.meta.url)),
  server: { host: '127.0.0.1', port: 5173, fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] } },
  // The playground is a local development tool; don't duplicate the large examples asset library in builds.
  build: { copyPublicDir: false },
});
