import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bin': 'application/octet-stream',
  '.exr': 'image/x-exr',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'image/vnd.radiance',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

/** Resolves `relativePath` inside `root`, or `undefined` if it would escape it. */
export function resolveInside(root: string, relativePath: string): string | undefined {
  if (relativePath.includes('\0') || relativePath.includes('\\')) return undefined;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  return resolved.startsWith(resolvedRoot + path.sep) ? resolved : undefined;
}

/** GET response for a file under `root` with a weak mtime/size ETag and 304 support. */
export async function fileResponse(
  request: Request,
  root: string,
  relativePath: string,
  cacheControl: string,
): Promise<Response> {
  const file = resolveInside(root, relativePath);
  const info = file ? await stat(file).catch(() => undefined) : undefined;
  if (!file || !info?.isFile()) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
  const headers = { ETag: etag, 'Cache-Control': cacheControl };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(await readFile(file), {
    headers: {
      ...headers,
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size.toString(),
    },
  });
}
