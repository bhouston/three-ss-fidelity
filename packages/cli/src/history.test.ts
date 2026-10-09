import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { verifyImportedHistory } from './history.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
it('preserves every imported image byte and explicit identity mapping', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../../migration/pathtracer-history.json', import.meta.url), 'utf8'),
  );
  expect(manifest.images).toHaveLength(545);
  expect(manifest.sceneMappings).toHaveLength(200);
  await verifyImportedHistory(root, manifest);
});
