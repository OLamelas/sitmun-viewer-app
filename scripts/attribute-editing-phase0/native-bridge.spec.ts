import {
  applyAttributeDeltaPrototype, assertJsonHistorySafe, connectAttributeHistoryPrototype,
  createAttributeDraft, selectedFeatureFromClickPrototype,
  type AttributeData, type AttributeEdit
} from './native-bridge';
import { between, nativeHistoryConstructor, nativeSource } from './native-source';

const MODIFY = 'featuremodify.tc';

function feature(data: AttributeData = {}, id = 'shops.1') {
  // Execute native merge/unset semantics, not a substitute implementation of history.
  const methods = between(nativeSource('SITNA/feature/Feature.js'),
    '    setData(data) {', '    clearData() {');
  const NativeFeature = new Function(`return class {
    constructor(data, id) { this.data = data; this.id = id; this.geometry = [1, 2];
      this.layer = {}; this.wrap = { setData() {}, unsetData() {} }; }
    getData() { return this.data; }
    setCoords(coords) { this.geometry = coords; }
    setData(data) { ${methods}
  };`)();
  return new NativeFeature(data, id);
}

function nativeSession(target: ReturnType<typeof feature>, inserted = false) {
  const layer = (initial: ReturnType<typeof feature>[] = []) => ({
    features: initial,
    getFeatureById(id: string) { return this.features.find(item => (item.provId || item.id) === id); },
    addFeature(item: ReturnType<typeof feature>) { this.features.push(item); },
    removeFeature(item: ReturnType<typeof feature>) { this.features.splice(this.features.indexOf(item), 1); }
  });
  const added = layer(inserted ? [feature(createAttributeDraft(target), target.provId || target.id)] : []);
  const modified = layer();
  const before = layer([feature(createAttributeDraft(target), target.id)]);
  const state = { serializable: true, addedFeaturesLayer: added, modifiedFeaturesLayer: modified, beforeEditLayer: before };
  const pending: Promise<unknown>[] = [];
  const storage = jest.fn(() => {
    const promise = Promise.resolve();
    pending.push(promise);
    return promise;
  });
  const changed = jest.fn();
  const error = jest.fn();
  const self = {
    getLayerEditData: () => state,
    setChangedState: changed,
    getLocaleString: (key: string) => key,
    getAddedStoragePrefix: () => 'insert:',
    getModifiedStoragePrefix: () => 'update:',
    createAuxFeature: (item: ReturnType<typeof feature>) => feature(createAttributeDraft(item), item.id)
  };
  const body = between(nativeSource('TC/control/WFSEdit.js'),
    '.on(Consts.event.FEATUREMODIFY, function (e) {',
    '\n            })\n            .on(Consts.event.FEATUREADD').replace(/self\.#/g, 'self.');
  const listener = new Function('self', 'storeFeature', 'deleteFeature', 'TC',
    `return function(e) { ${body} };`)(self, storage, storage, { error });
  const History = nativeHistoryConstructor();
  const history = new History();
  const trigger = jest.fn((type: string, event: Record<string, unknown>) => {
    if (type === MODIFY) listener(event);
  });
  const edit: AttributeEdit = { history, trigger };
  return { edit, history, trigger, storage, added, modified, changed, error,
    settle: () => Promise.all(pending) };
}

describe('Phase 0: isolated attribute bridge against installed SITNA', () => {
  it('opening, changing and discarding a detached draft does not mutate data or history', () => {
    const target = feature({ text: 'old', untouched: { nested: [false, 0, null, ''] } });
    const { history, storage } = nativeSession(target);
    const draft = createAttributeDraft(target);
    draft['text'] = 'new';
    (draft['untouched'] as { nested: unknown[] }).nested.push('draft only');
    expect(target.getData()).toEqual({ text: 'old', untouched: { nested: [false, 0, null, ''] } });
    expect(history.canUndo(target)).toBe(false);
    expect(storage).not.toHaveBeenCalled();
  });

  it('does not invent missing fields or defaults on a new feature', () => {
    const target = feature({});
    const session = nativeSession(target, true);
    const draft = createAttributeDraft(target);
    draft['category'] = 'draft';
    expect(Object.hasOwn(target.getData(), 'category')).toBe(false);
    expect(session.added.features[0].getData()).toEqual({});
    expect(session.history.canUndo(target)).toBe(false);
  });

  it('applies once through native history and WFSEdit, preserving geometry, ID and untouched data', async () => {
    const original = { category: 'old', empty: '', zero: 0, bool: false, nil: null, complex: { list: ['x'] } };
    const target = feature(original);
    const geometry = target.geometry;
    const session = nativeSession(target);
    const disconnect = connectAttributeHistoryPrototype(session.edit, MODIFY);
    const action = applyAttributeDeltaPrototype(session.edit, target, { category: 'new' }, new Set(['category']), MODIFY);
    expect(session.changed).not.toHaveBeenCalled(); // Notification precedes async local persistence.
    await session.settle();
    expect(action?.type).toBe('attributesChange');
    expect(session.trigger).toHaveBeenCalledTimes(1);
    expect(session.storage).toHaveBeenCalledTimes(1);
    expect(session.modified.features).toHaveLength(1);
    expect(target.geometry).toBe(geometry);
    expect(target.id).toBe('shops.1');
    expect(session.trigger.mock.calls[0][1]).toMatchObject({ geometryChanged: false, oldData: original });
    expect(target.getData()).toEqual({ ...original, category: 'new' });

    session.history.undo(target);
    await session.settle();
    expect(target.getData()).toEqual(original);
    expect(session.modified.features).toHaveLength(0); // Existing postinstall patch.
    session.history.redo(target);
    await session.settle();
    expect(target.getData()).toEqual({ ...original, category: 'new' });
    expect(session.modified.features).toHaveLength(1);
    expect(session.trigger).toHaveBeenCalledTimes(3);
    expect(session.trigger.mock.calls[1][1]).toMatchObject({ historyAction: 'undo', geometryChanged: false });
    expect(session.error).not.toHaveBeenCalled();
    disconnect();
    session.history.undo(target);
    expect(session.trigger).toHaveBeenCalledTimes(3);
  });

  it('updates the pending insertion by provisional identity without creating an update or duplicate', async () => {
    const target = feature({}, 'temporary');
    target.provId = 'new.1';
    const session = nativeSession(target, true);
    const disconnect = connectAttributeHistoryPrototype(session.edit, MODIFY);
    applyAttributeDeltaPrototype(session.edit, target, { category: 'new' }, new Set(['category']), MODIFY);
    await session.settle();
    expect(session.added.features).toHaveLength(1);
    expect(session.added.features[0].getData()).toEqual({ category: 'new' });
    expect(session.modified.features).toHaveLength(0);
    expect(session.storage.mock.calls[0]).toEqual(['insert:new.1', target]);
    session.history.undo(target);
    expect(Object.hasOwn(target.getData(), 'category')).toBe(false);
    // Phase 3 postinstall fix propagates removals before the native merging setter.
    expect(session.added.features[0].getData()).toEqual({});
    disconnect();
  });

  it('does not create history or notifications for a no-op', () => {
    const target = feature({ category: 'old' });
    const session = nativeSession(target);
    expect(applyAttributeDeltaPrototype(session.edit, target, { category: 'old' }, new Set(['category']), MODIFY)).toBeNull();
    expect(session.trigger).not.toHaveBeenCalled();
    expect(session.history.canUndo(target)).toBe(false);
  });

  it('rejects undeclared delta fields and non-simple changes before mutation', () => {
    const target = feature({ category: 'old' });
    const session = nativeSession(target);
    for (const delta of [{ html: '<b>presentation</b>' }, { category: { nested: true } }]) {
      expect(() => applyAttributeDeltaPrototype(session.edit, target, delta, new Set(['category']), MODIFY)).toThrow();
    }
    expect(target.getData()).toEqual({ category: 'old' });
    expect(session.history.canUndo(target)).toBe(false);
  });

  it.each([undefined, NaN, Infinity, -0, 9007199254740992, new Date(), BigInt(1), () => 1, [, 'x']]
    .map(value => ({ value })))(
    'blocks an unsafe untouched attribute before applying: $value', ({ value }) => {
      const target = feature({ category: 'old', untouched: value });
      const History = nativeHistoryConstructor();
      const history = new History();
      const trigger = jest.fn();
      expect(() => applyAttributeDeltaPrototype({ history, trigger }, target,
        { category: 'new' }, new Set(['category']), MODIFY)).toThrow();
      expect(target.getData()['category']).toBe('old');
      expect(history.canUndo(target)).toBe(false);
      expect(trigger).not.toHaveBeenCalled();
    }
  );

  it('blocks cycles, accessors, symbol properties and sparse arrays with extra keys', () => {
    const cycle: AttributeData = {};
    cycle['self'] = cycle;
    const getter = jest.fn();
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    const array = new Array(1);
    Object.assign(array, { extra: true });
    for (const value of [cycle, accessor, { [Symbol('key')]: 1 }, array]) {
      expect(() => assertJsonHistorySafe(value)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('characterizes the native JSON copy losing undefined even in an untouched field', () => {
    const target = feature({ category: 'old', optional: undefined });
    const History = nativeHistoryConstructor();
    const history = new History();
    const action = history.setData(target, { category: 'new' });
    expect(Object.hasOwn(action.oldData, 'optional')).toBe(false);
    expect(Object.hasOwn(action.newData, 'optional')).toBe(false);
  });

  it('does not forward geometry actions a second time', () => {
    const target = feature();
    const session = nativeSession(target);
    const disconnect = connectAttributeHistoryPrototype(session.edit, MODIFY);
    session.history.dispatchEvent(Object.assign(new Event('undo'), {
      feature: target, action: { type: 'geometryChange' }
    }));
    expect(session.trigger).not.toHaveBeenCalled();
    disconnect();
  });

  it('accepts one native singleclick target, not selection events, drags or ambiguous multi-selection', () => {
    const selected = {};
    const click = { type: 'singleclick', originalEvent: new MouseEvent('click') };
    expect(selectedFeatureFromClickPrototype({ selected: [selected], mapBrowserEvent: click })).toBe(selected);
    for (const event of [
      { selected: [selected] },
      { selected: [], mapBrowserEvent: click },
      { selected: [selected, {}], mapBrowserEvent: click },
      { selected: [selected], mapBrowserEvent: { type: 'pointerdrag', originalEvent: new Event('pointermove') } }
    ]) expect(selectedFeatureFromClickPrototype(event)).toBeNull();
  });
});
