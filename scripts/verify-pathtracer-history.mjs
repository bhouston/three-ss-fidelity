import { readFile } from 'node:fs/promises';
import { verifyImportedHistory } from '../packages/cli/dist/history.js';
const manifest = JSON.parse(await readFile('migration/pathtracer-history.json', 'utf8'));
await verifyImportedHistory(process.cwd(), manifest);
console.log(
  'Verified ' + manifest.images.length + ' historical images in ' + manifest.sceneMappings.length + ' scenes.',
);
