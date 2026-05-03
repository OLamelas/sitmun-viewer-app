/**
 * SITNA {@code LayerCatalog} removes the info button when {@code getInfo} lacks own
 * properties {@code abstract}, {@code legend}, and {@code metadata}. If only {@code dataUrl}
 * is present, add an empty {@code abstract} so the affordance remains.
 */
export function ensureLayerCatalogInfoAffordance(info: unknown): unknown {
  if (!info || typeof info !== 'object') {
    return info;
  }
  const o = info as Record<string, unknown>;
  const hasAbstract = Object.prototype.hasOwnProperty.call(o, 'abstract');
  const hasLegend = Object.prototype.hasOwnProperty.call(o, 'legend');
  const hasMetadata = Object.prototype.hasOwnProperty.call(o, 'metadata');
  const du = o['dataUrl'];
  const hasDataUrl = Array.isArray(du) && du.length > 0;
  if (hasDataUrl && !hasAbstract && !hasLegend && !hasMetadata) {
    return { ...o, abstract: '' };
  }
  return info;
}
