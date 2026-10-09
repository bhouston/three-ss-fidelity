/** Immutable asset revisions from the sibling suite. Browser models stay remote to keep Pages within its size limit. */
export const assetRepositories = {
  'glTF-Sample-Assets': {
    repository: 'KhronosGroup/glTF-Sample-Assets',
    revision: 'f36bfdabd1031c3cf6689a50570b8cdf3678b49c',
  },
  '3d-demo-data': { repository: 'gkjohnson/3d-demo-data', revision: '9149f69c729cae652f2cd4b25f25e726f54efa6a' },
  'ldraw-parts-library': {
    repository: 'gkjohnson/ldraw-parts-library',
    revision: '1f24cac1821b9a86a5a84cd3a40291aad24679b3',
  },
} as const;
export function browserAssetUrl(asset: string, examplesBase: string, assetsBase: string): string {
  if (asset.startsWith('@/assets/')) return assetsBase + asset.slice('@/assets/'.length);
  if (asset.startsWith('suite-assets/')) return assetsBase + asset.slice('suite-assets/'.length);
  if (asset.startsWith('@/submodules/three.js/examples/'))
    return examplesBase + asset.slice('@/submodules/three.js/examples/'.length);
  for (const [name, source] of Object.entries(assetRepositories)) {
    const prefix = '@/submodules/' + name + '/';
    if (asset.startsWith(prefix))
      return (
        'https://raw.githubusercontent.com/' +
        source.repository +
        '/' +
        source.revision +
        '/' +
        asset.slice(prefix.length).split('/').map(encodeURIComponent).join('/')
      );
  }
  if (asset.startsWith('@/')) throw new Error('Unsupported imported asset path: ' + asset);
  return examplesBase + asset;
}
