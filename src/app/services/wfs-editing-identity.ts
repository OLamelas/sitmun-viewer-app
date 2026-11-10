import type { AppCfg, AppLayer, AppTasks } from '../api/model/app-cfg';

function url(value: unknown): URL | null {
  try { return typeof value === 'string' ? new URL(value, document.baseURI) : null; }
  catch { return null; }
}

/** Identity comes from profile provenance AND the cartography/service proxy route, never a title. */
export function editingTask(profile: AppCfg, native: any): AppTasks | undefined {
  if (!native || native.type !== 'WFS' || native.wmsLayer || native.options?.stealth || native.options?.readOnly) return undefined;
  const references = new Set<string>();
  if (native.options?.profileLayerId) references.add(native.options.profileLayerId);
  if (profile.layers?.some((layer) => layer.id === native.id)) references.add(native.id);
  const nodeId = native.options?.nodeId;
  if (nodeId) {
    for (const tree of profile.trees ?? []) {
      const resource = tree.nodes?.[nodeId]?.resource;
      if (resource) references.add(resource);
    }
  }
  if (references.size !== 1) return undefined;
  const id = [...references][0];
  const layer = profile.layers?.find((entry) => entry.id === id);
  const service = profile.services?.find((entry) => entry.id === layer?.service);
  if (!layer || !service || service.type !== 'WFS') return undefined;
  const nativeService = native.options?.serviceId;
  if (nativeService != null && nativeService !== service.id && `service/${nativeService}` !== service.id) return undefined;
  const actual = url(native.url ?? native.options?.url);
  if (!actual) return undefined;
  const types = native.featureType ?? native.options?.featureType;
  const nativeTypes: string[] = Array.isArray(types) ? types : typeof types === 'string' ? [types] : [];
  if (!sameTypes(layer, nativeTypes, native.featureNS ?? native.options?.featureNS)) return undefined;
  return profile.tasks?.find((task) => {
    if (task.type !== 'edition' || task.typeId !== 0 || task.scope !== 'feat-edit' || task.layer !== id) return false;
    const target = url(task.url);
    const route = target?.pathname.match(/\/proxy\/(\d+)\/(\d+)\/WFS\/(\d+)\/(\d+)\/?$/i);
    return !!target && !!route && !target.username && !target.password && !target.hash &&
      Number(route[1]) === profile.application.id && Number(route[2]) === profile.application.territoryId &&
      `service/${route[3]}` === layer.service && `layer/${route[4]}` === layer.id &&
      [target.href, url(layer.url)?.href, url(service.url)?.href].includes(actual.href) &&
      task.parameters?.typename?.value === layer.layers.join(',');
  });
}

function sameTypes(layer: AppLayer, types: string[], namespace: unknown): boolean {
  if (!types.length || new Set(types).size !== types.length) return false;
  return types.every((type) => layer.layers.includes(type) ||
    (typeof namespace === 'string' && !type.includes(':') && layer.layers.includes(`${namespace}:${type}`)));
}
