import { expect, it } from 'vitest';
import { browserAssetUrl } from './asset-paths.js';
it('resolves suite and upstream assets and pins remote model dependencies', () => {
  expect(browserAssetUrl('@/assets/environments/studio.hdr', '/examples/', '/assets/')).toBe(
    '/assets/environments/studio.hdr',
  );
  expect(browserAssetUrl('suite-assets/complex-scenes/room.glb', '/examples/', '/assets/')).toBe(
    '/assets/complex-scenes/room.glb',
  );
  expect(browserAssetUrl('@/submodules/three.js/examples/models/a.mpd', '/examples/', '/assets/')).toBe(
    '/examples/models/a.mpd',
  );
  expect(browserAssetUrl('@/submodules/3d-demo-data/models/a b.glb', '/', '/')).toBe(
    'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/9149f69c729cae652f2cd4b25f25e726f54efa6a/models/a%20b.glb',
  );
  expect(() => browserAssetUrl('@/secrets/key', '/', '/')).toThrow('Unsupported imported asset');
});
