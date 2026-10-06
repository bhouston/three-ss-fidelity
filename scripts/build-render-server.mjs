import { cp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const at = process.argv.indexOf('--out');
const out = resolve(at < 0 ? 'render-site' : process.argv[at + 1]);
await mkdir(out, { recursive: true });
await cp('packages/playground/dist', out, { recursive: true });
// Keep the upstream asset paths expected by scene loaders; exclude upstream HTML and source demos.
for (const folder of ['models', 'textures', 'jsm/libs/draco', 'jsm/libs/basis'])
  await cp(join('submodules/three.js/examples', folder), join(out, folder), { recursive: true });
await cp('assets', join(out, 'suite-assets'), { recursive: true });
console.log(`Browser render server: ${out}`);
