import { ensureLayerCatalogInfoAffordance } from './layer-catalog-info-affordance';

describe('ensureLayerCatalogInfoAffordance', () => {
  it('returns primitives unchanged', () => {
    expect(ensureLayerCatalogInfoAffordance(null)).toBeNull();
    expect(ensureLayerCatalogInfoAffordance(undefined)).toBeUndefined();
    expect(ensureLayerCatalogInfoAffordance('x')).toBe('x');
  });

  it('adds abstract when only dataUrl is present', () => {
    const out = ensureLayerCatalogInfoAffordance({
      dataUrl: [{ url: 'https://x', format: 'application/zip', type: 'simple' }]
    }) as Record<string, unknown>;
    expect(out['abstract']).toBe('');
    expect(Array.isArray(out['dataUrl'])).toBe(true);
  });

  it('does not add abstract when metadata exists', () => {
    const input = {
      metadata: [],
      dataUrl: [{ url: 'https://x', format: 'application/zip', type: 'simple' }]
    };
    const out = ensureLayerCatalogInfoAffordance(input) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(out, 'abstract')).toBe(false);
  });
});
