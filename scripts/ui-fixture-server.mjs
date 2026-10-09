import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cliPackage from '../submodules/fidelity-kit/packages/cli/package.json' with { type: 'json' };
const require = createRequire(new URL('../submodules/fidelity-kit/packages/viewer/package.json', import.meta.url));
export async function createUIFixtureServer() {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('./fixtures/ui/', import.meta.url)),
    resolve: {
      alias: {
        'fidelity-kit/browser/host': fileURLToPath(
          new URL(
            cliPackage.exports['./browser/host'].import,
            new URL('../submodules/fidelity-kit/packages/cli/', import.meta.url),
          ),
        ),
      },
    },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../', import.meta.url))] } },
  });
  await server.listen();
  return { url: 'http://127.0.0.1:' + server.httpServer.address().port + '/', close: () => server.close() };
}
