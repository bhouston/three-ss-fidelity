import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
const args = process.argv.slice(2);
let out = 'site/';
const rest = [];
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--out') {
    out = args[++index];
    if (!out || out.startsWith('--')) throw new Error('--out requires a directory');
  } else if (argument.startsWith('--out=')) {
    out = argument.slice(6);
    if (!out) throw new Error('--out requires a directory');
  } else rest.push(argument);
}
const result = spawnSync(
  process.execPath,
  [
    resolve('submodules/fidelity-kit/packages/cli/dist/bin.js'),
    'build',
    'fidelity-results',
    '--performance-root',
    'performance-results',
    '--registry',
    'registry.json',
    '--out',
    out,
    ...rest,
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const migration = join(out, 'migration');
await mkdir(migration, { recursive: true });
for (const file of ['pathtracer-history.json']) await copyFile(join('migration', file), join(migration, file));
for (const file of ['HISTORICAL-RESULTS.md', 'IMPORTED-ASSETS.md', 'DISTRIBUTED-CAPTURE.md'])
  await copyFile(join('docs', file), join(migration, file));
await copyFile('assets/pathtracer-provenance.json', join(migration, 'asset-provenance.json'));
