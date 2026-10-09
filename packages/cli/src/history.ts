import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
export interface HistoricalImage {
  source: string;
  destination: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}
export interface HistoryManifest {
  images: HistoricalImage[];
  sceneMappings: { source: string; id: string }[];
  rendererMappings: Record<string, string>;
}
/** Verify exact bytes and identity; reject manifests that could silently overwrite or escape the result root. */
export async function verifyImportedHistory(root: string, manifest: HistoryManifest): Promise<void> {
  const destinations = new Set<string>();
  const ids = new Map(manifest.sceneMappings.map((entry) => [entry.source, entry.id]));
  if (ids.size !== manifest.sceneMappings.length || new Set(ids.values()).size !== ids.size)
    throw new Error('Duplicate scene mapping');
  const resultRoot = resolve(root, 'fidelity-results') + sep;
  for (const image of manifest.images) {
    const [scene, output, filename] = image.source.split('/');
    const renderer = manifest.rendererMappings[filename?.replace(/\.avif$/, '') ?? ''];
    const expected = 'fidelity-results/' + ids.get(scene!) + '/' + output + '/' + renderer + '.avif';
    const file = resolve(root, image.destination);
    if (
      !ids.has(scene!) ||
      !renderer ||
      output !== 'beauty' ||
      image.destination !== expected ||
      !file.startsWith(resultRoot)
    )
      throw new Error('Invalid historical identity: ' + image.destination);
    if (destinations.has(file)) throw new Error('Duplicate historical destination: ' + file);
    destinations.add(file);
    const bytes = await readFile(file);
    if (bytes.length !== image.bytes || createHash('sha256').update(bytes).digest('hex') !== image.sha256)
      throw new Error('Historical image changed: ' + image.destination);
  }
}
