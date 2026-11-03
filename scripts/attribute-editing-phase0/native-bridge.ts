/** Phase-0 prototype only. Nothing in src/ imports or installs this bridge. */
export type AttributeData = Record<string, unknown>;

export interface AttributeFeature {
  layer: unknown;
  getData(): AttributeData;
}

export interface AttributeAction {
  type: string;
  oldData: AttributeData;
  newData: AttributeData;
}

export interface AttributeHistory extends EventTarget {
  setData(feature: AttributeFeature, data: AttributeData): AttributeAction;
}

export interface AttributeEdit {
  history: AttributeHistory;
  trigger(type: string, data: Record<string, unknown>): unknown;
}

/** Fail closed for values the native JSON history copy cannot preserve. */
export function assertJsonHistorySafe(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
    throw new Error('Unverified numeric representation');
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new Error('Value cannot be preserved by native JSON history');
  }
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
    throw new Error('Non-plain attribute value');
  }
  if (array && (Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, index) => key !== String(index)))) {
    throw new Error('Sparse array or custom array properties');
  }
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) ||
          ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)) {
        throw new Error('Unsupported attribute property');
      }
      assertJsonHistorySafe(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function createAttributeDraft(feature: AttributeFeature): AttributeData {
  const data = feature.getData();
  assertJsonHistorySafe(data);
  return JSON.parse(JSON.stringify(data)) as AttributeData;
}

/**
 * Call only with an already validated delta and a revalidated session context.
 * Notification is NOT an acknowledgement of IndexedDB persistence or WFS saving.
 */
export function applyAttributeDeltaPrototype(
  edit: AttributeEdit,
  feature: AttributeFeature,
  delta: AttributeData,
  editableNames: ReadonlySet<string>,
  featureModifyEvent: string
): AttributeAction | null {
  const current = feature.getData();
  assertJsonHistorySafe(current); // Includes attributes that were not edited.
  assertJsonHistorySafe(delta);
  if (Object.values(delta).some(value => value !== null && typeof value === 'object')) {
    throw new Error('Prototype only applies simple attributes');
  }
  if (Object.keys(delta).some(key => !editableNames.has(key))) {
    throw new Error('Delta contains a non-editable attribute');
  }
  const changed = Object.keys(delta).some(key =>
    !Object.hasOwn(current, key) || !Object.is(current[key], delta[key]));
  if (!changed) return null;
  const action = edit.history.setData(feature, { ...current, ...delta });
  edit.trigger(featureModifyEvent, {
    feature, layer: feature.layer, oldData: action.oldData,
    newData: action.newData, geometryChanged: false
  });
  return action;
}

/** The installed patch forwards geometry undo/redo, not attribute undo/redo. */
export function connectAttributeHistoryPrototype(edit: AttributeEdit, featureModifyEvent: string): () => void {
  const connect = (type: 'undo' | 'redo') => {
    const listener = (event: Event) => {
      const { feature, action } = event as Event & {
        feature: AttributeFeature; action: AttributeAction;
      };
      if (action.type !== 'attributesChange') return;
      edit.trigger(featureModifyEvent, {
        feature, layer: feature.layer, geometryChanged: false, historyAction: type,
        oldData: type === 'undo' ? action.newData : action.oldData,
        newData: type === 'undo' ? action.oldData : action.newData
      });
    };
    edit.history.addEventListener(type, listener);
    return () => edit.history.removeEventListener(type, listener);
  };
  const cleanups = [connect('undo'), connect('redo')];
  return () => cleanups.forEach(cleanup => cleanup());
}

/** Observe native selection, never replace its hit-test or infer a programmatic click. */
export function selectedFeatureFromClickPrototype(event: {
  selected: unknown[];
  mapBrowserEvent?: { type?: string; originalEvent?: Event };
}): unknown | null {
  const gesture = event.mapBrowserEvent;
  return gesture?.type === 'singleclick' && gesture.originalEvent && event.selected.length === 1
    ? event.selected[0] : null;
}
