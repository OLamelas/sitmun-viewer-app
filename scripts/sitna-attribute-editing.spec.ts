import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

import { between, nativeHistoryConstructor, nativeSource } from './attribute-editing-phase0/native-source';
import { applyNativeAttributeData, AttributeRegistrationFailure, connectNativeAttributeHistory } from '../src/app/controls/handlers/wfs-attribute-session';
import { AttributeData } from '../src/app/utils/feature-attribute-draft';

/** Exercise postinstall transformations in memory, never write node_modules. */
function patchedSources(): Map<string, string> {
  const files = new Map<string, string>();
  const fs = {
    readFileSync: (file: string) => files.get(file) ?? readFileSync(file, 'utf8'),
    writeFileSync: (file: string, data: string) => files.set(file, data)
  };
  const script = readFileSync(join(__dirname, 'patch-sitna-wfs.js'), 'utf8');
  const run = () => runInNewContext(script, {
    __dirname, require: (name: string) => name === 'fs' ? fs : require(name)
  });
  run();
  const first = [...files.entries()];
  run();
  expect([...files.entries()]).toEqual(first);
  // Include already-patched files too: no write is needed in that case.
  for (const name of ['TC/control/WFSEdit.js', 'TC/control/AttributesEdit.js']) {
    const path = join(__dirname, '../node_modules/api-sitna', name);
    if (!files.has(path)) files.set(path, readFileSync(path, 'utf8'));
  }
  return new Map([...files].map(([path, source]) => [path.replace(/\\/g, '/'), source.replace(/\r\n/g, '\n')]));
}

function source(files: Map<string, string>, name: string): string {
  const found = [...files].find(([path]) => path.endsWith('/' + name));
  if (!found) throw new Error(`Missing patched source: ${name}`);
  return found[1];
}

interface SavedFeature {
  id: string;
  geometry: unknown;
  data: AttributeData;
}

function nativeSave(files: Map<string, string>) {
  const fragment = between(source(files, 'TC/control/WFSEdit.js'),
    '    async applyEdits() {', '\n    discardEdits() {');
  const body = fragment.slice(0, fragment.lastIndexOf('}')).replace(/self\.#/g, 'self.');
  const states: string[] = [];
  const added = [{ provId: 'new-1', data: { label: 'draft' } }];
  const state = { serializable: true, addedFeaturesLayer: { features: added },
    modifiedFeaturesLayer: { features: [] as SavedFeature[] }, removedFeaturesLayer: { features: [] },
    beforeEditLayer: { features: [] as SavedFeature[], clearFeatures: jest.fn() } };
  const vector = { applyEdits: jest.fn().mockResolvedValue(undefined), features: [] };
  let work!: Promise<void>;
  const self = { layer: { type: 'WFS' }, editControl: { layer: { sitmunHasDataId: false } }, isSyncing: false,
    getLayerEditData: () => state, getEditableLayer: jest.fn().mockResolvedValue(vector),
    setSyncState: jest.fn(), sitmunAttributeSyncState: (value: string) => states.push(value),
    discardEdits: jest.fn(), deleteCache: jest.fn().mockResolvedValue(undefined),
    cacheLayer: jest.fn().mockResolvedValue(undefined), getStoragePrefix: () => 'session:',
    getLocaleString: (key: string) => key,
    map: { wait: (task: () => Promise<void>) => { work = Promise.resolve().then(task); }, toast: jest.fn() } };
  const error = jest.fn();
  const run = new Function('Geometry', 'Consts', 'TC', `return async function () { ${body} };`)(
    { equals: () => true }, { layerType: { WMS: 'WMS' }, msgType: {}, msgErrorMode: {} }, { error });
  return { self, vector, states, state, error, run: () => run.call(self), work: () => work };
}

describe('phase 4 native transaction lifecycle', () => {
  let files: Map<string, string>;
  beforeAll(() => { files = patchedSources(); });

  it('reports success only after the actual service promise, preserving the native early return contract', async () => {
    const save = nativeSave(files);
    let acknowledge!: () => void;
    save.vector.applyEdits.mockReturnValue(new Promise<void>((resolve) => { acknowledge = resolve; }));
    await save.run();
    expect(save.states).toEqual(['saving']);
    expect(save.self.isSyncing).toBe(true);
    expect(save.self.discardEdits).not.toHaveBeenCalled();
    acknowledge();
    await save.work();
    expect(save.states).toEqual(['saving', 'success']);
    expect(save.self.discardEdits).toHaveBeenCalledTimes(1);
    expect(save.self.isSyncing).toBe(false);
  });

  it('keeps pending insertions on service rejection and never emits success', async () => {
    const save = nativeSave(files);
    save.vector.applyEdits.mockRejectedValue({ code: 'AccessDenied', reason: 'Denied' });
    await save.run();
    await save.work();
    expect(save.states).toEqual(['saving', 'error']);
    expect(save.state.addedFeaturesLayer.features).toHaveLength(1);
    expect(save.self.discardEdits).not.toHaveBeenCalled();
    expect(save.error).toHaveBeenCalled();
  });

  it.each([true, false])('sends a data id only when the layer schema identifies it, preserving fid (declared=%s)', async (declared) => {
    class ModifiedFeature {
      data: AttributeData = {};
      id = 'items.1';
      constructor(readonly geometry: unknown, readonly options?: unknown) {}
      setData(data: AttributeData) { this.data = data; }
      setId(id: string) { this.id = id; }
    }
    const save = nativeSave(files);
    save.self.editControl.layer.sitmunHasDataId = declared;
    const modified = new ModifiedFeature([1, 2]);
    modified.setData({ id: 'new-data-id', label: 'changed' });
    save.state.modifiedFeaturesLayer.features.push(modified);
    save.state.beforeEditLayer.features.push({ id: 'items.1', geometry: [1, 2], data: { id: 'old-data-id', label: 'old' } });
    await save.run();
    await save.work();
    const update = save.vector.applyEdits.mock.calls[0][1][0] as ModifiedFeature;
    expect(update.data).toEqual(declared ? { id: 'new-data-id', label: 'changed' } : { label: 'changed' });
    expect(update.id).toBe('items.1');
    expect(save.states).toEqual(['saving', 'success']);
  });

  it('also releases syncing if editable-layer resolution fails before the transaction', async () => {
    const save = nativeSave(files);
    save.self.getEditableLayer.mockRejectedValue(new Error('Layer unavailable'));
    await save.run();
    await save.work();
    expect(save.states).toEqual(['saving', 'error']);
    expect(save.self.isSyncing).toBe(false);
    expect(save.vector.applyEdits).not.toHaveBeenCalled();
  });

  it('distinguishes accepted server writes from failed local reconciliation, preventing blind resubmission', async () => {
    const save = nativeSave(files);
    save.self.deleteCache.mockRejectedValue(new Error('Local cache failed'));
    await save.run();
    await save.work();
    expect(save.states).toEqual(['saving', 'reconcileError']);
    expect(save.vector.applyEdits).toHaveBeenCalledTimes(1);
    expect(save.self.discardEdits).not.toHaveBeenCalled();
  });
});

function feature(data: AttributeData = {}, id = 'items.1') {
  const methods = between(nativeSource('SITNA/feature/Feature.js'), '    setData(data) {', '    clearData() {');
  const NativeFeature = new Function(`return class {
    constructor(data, id) { this.data = data; this.id = id; this.geometry = [1, 2];
      this.layer = {}; this.wrap = { setData() {}, unsetData() {} }; }
    getData() { return this.data; }
    setCoords(coords) { this.geometry = coords; }
    setData(data) { ${methods}
  };`)();
  return new NativeFeature(data, id);
}

function nativeSession(files: Map<string, string>, target: ReturnType<typeof feature>, inserted = false) {
  const layer = (initial: ReturnType<typeof feature>[] = []) => ({
    features: initial,
    getFeatureById(id: string) { return this.features.find((item) => (item.provId || item.id) === id); },
    addFeature(item: ReturnType<typeof feature>) { this.features.push(item); return Promise.resolve(item); },
    removeFeature(item: ReturnType<typeof feature>) { this.features.splice(this.features.indexOf(item), 1); }
  });
  const added = layer(inserted ? [feature({ ...target.getData() }, target.provId || target.id)] : []);
  const modified = layer();
  const before = layer([feature({ ...target.getData() }, target.id)]);
  const state = { serializable: true, addedFeaturesLayer: added, modifiedFeaturesLayer: modified, beforeEditLayer: before };
  const storage = jest.fn<Promise<unknown>, [string, unknown?]>().mockResolvedValue(undefined);
  const changed = jest.fn();
  const error = jest.fn();
  const self = { getLayerEditData: () => state, setChangedState: changed,
    getLocaleString: (key: string) => key, getAddedStoragePrefix: () => 'insert:',
    getModifiedStoragePrefix: () => 'update:',
    createAuxFeature: (item: ReturnType<typeof feature>) => feature({ ...item.getData() }, item.id) };
  const body = between(source(files, 'TC/control/WFSEdit.js'),
    '.on(Consts.event.FEATUREMODIFY, function (e) {',
    '\n            })\n            .on(Consts.event.FEATUREADD').replace(/self\.#/g, 'self.');
  const listener = new Function('self', 'storeFeature', 'deleteFeature', 'TC',
    `return function(e) { ${body} };`)(self, storage, storage, { error });
  const History = nativeHistoryConstructor();
  const history = new History();
  const NativeEventTarget = new Function(nativeSource('TC/EventTarget.js')
    .replace('export default EventTarget;', 'return EventTarget;'))();
  const events = new NativeEventTarget();
  events.on('featuremodify.tc', listener);
  const trigger = jest.fn((type: string, event: Record<string, unknown>) => events.trigger(type, event));
  const edit = { history, trigger };
  return { edit, history, storage, added, modified, changed, error, state };
}

describe('phase 3 native attribute bridge and postinstall patches', () => {
  let files: Map<string, string>;
  beforeAll(() => { files = patchedSources(); });

  it('exposes pending undo registration until native storage actually acknowledges it', async () => {
    const target = feature({ label: 'old' });
    const session = nativeSession(files, target);
    await applyNativeAttributeData(session.edit, target, { label: 'new' });
    let acknowledge!: () => void;
    session.storage.mockReturnValueOnce(new Promise<void>((resolve) => { acknowledge = resolve; }));
    const registering = jest.fn();
    const registered = jest.fn();
    const disconnect = connectNativeAttributeHistory(session.edit, registered, registering);
    session.history.undo(target);
    expect(registering).toHaveBeenLastCalledWith(true);
    expect(registered).not.toHaveBeenCalled();
    acknowledge();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(registering).toHaveBeenLastCalledWith(false);
    expect(registered).toHaveBeenCalledWith(target);
    disconnect();
  });

  it('waits for the actual storage promise, not the notification return value', async () => {
    const target = feature({ label: 'old' });
    const session = nativeSession(files, target);
    let release!: () => void;
    session.storage.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    const completed = jest.fn();
    const applying = applyNativeAttributeData(session.edit, target, { label: 'new' }).then(completed);
    expect(target.getData()).toEqual({ label: 'new' });
    expect(session.edit.trigger).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    release();
    await applying;
    expect(completed).toHaveBeenCalledWith(true);
    expect(session.storage).toHaveBeenCalledTimes(1);
    expect(session.modified.features).toHaveLength(1);
    expect(session.edit.trigger.mock.calls[0][1]).toMatchObject({ geometryChanged: false });
    expect(target.geometry).toEqual([1, 2]);
    expect(target.id).toBe('items.1');
  });

  it('propagates a storage failure without pretending history or memory was rolled back', async () => {
    const target = feature({ label: 'old' });
    const session = nativeSession(files, target);
    session.storage.mockRejectedValueOnce(new Error('IndexedDB failed'));
    await expect(applyNativeAttributeData(session.edit, target, { label: 'new' })).rejects.toThrow('IndexedDB failed');
    expect(target.getData()['label']).toBe('new');
    expect(session.changed).not.toHaveBeenCalled();
    expect(session.error).toHaveBeenCalledTimes(1);
  });

  it('retries the failed session registration without a second history action', async () => {
    const target = feature({ label: 'old' });
    const session = nativeSession(files, target);
    const push = jest.spyOn(session.history, 'setData');
    session.storage.mockRejectedValueOnce(new Error('IndexedDB failed'));
    let failure: unknown;
    try { await applyNativeAttributeData(session.edit, target, { label: 'new' }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AttributeRegistrationFailure);
    await (failure as AttributeRegistrationFailure).retry();
    expect(push).toHaveBeenCalledTimes(1);
    expect(session.storage).toHaveBeenCalledTimes(2);
    expect(session.modified.features).toHaveLength(1);
  });

  it('keeps a single insertion and propagates property removal through attribute undo/redo', async () => {
    const target = feature({}, 'temporary');
    target.provId = 'new.1';
    const session = nativeSession(files, target, true);
    const registered = jest.fn();
    const disconnect = connectNativeAttributeHistory(session.edit, registered);
    await applyNativeAttributeData(session.edit, target, { label: 'new' });
    session.history.undo(target);
    await Promise.resolve();
    await Promise.resolve();
    expect(target.getData()).toEqual({});
    expect(session.added.features[0].getData()).toEqual({});
    session.history.redo(target);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.added.features[0].getData()).toEqual({ label: 'new' });
    expect(session.added.features).toHaveLength(1);
    expect(session.modified.features).toHaveLength(0);
    expect(session.storage).toHaveBeenCalledTimes(3);
    expect(registered).toHaveBeenCalledTimes(2);
    disconnect();
    session.history.undo(target);
    expect(session.storage).toHaveBeenCalledTimes(3);
  });

  it('makes no-op history-free and rejects unsafe untouched data before mutation', async () => {
    const target = feature({ label: 'old' });
    const session = nativeSession(files, target);
    expect(await applyNativeAttributeData(session.edit, target, { label: 'old' })).toBe(false);
    expect(session.history.canUndo(target)).toBe(false);
    target.data['unsafe'] = undefined;
    await expect(applyNativeAttributeData(session.edit, target, { label: 'new' })).rejects.toThrow('unsafeData');
    expect(session.edit.trigger).not.toHaveBeenCalled();
  });

  it('does not duplicate geometric undo/redo notifications', () => {
    const target = feature();
    const session = nativeSession(files, target);
    const cleanup = connectNativeAttributeHistory(session.edit, jest.fn());
    session.history.dispatchEvent(Object.assign(new Event('undo'), { feature: target, action: { type: 'geometryChange' } }));
    expect(session.edit.trigger).not.toHaveBeenCalled();
    cleanup();
  });

  it('guards both native Save entry points before the native confirmation/transaction', () => {
    const native = source(files, 'TC/control/WFSEdit.js');
    const save = between(native, 'self.#saveBtn.addEventListener(Consts.event.CLICK, function () {', '\n        }, { passive: true });');
    const confirm = jest.fn();
    new Function('self', 'TC', save)({ sitmunCanSaveAttributes: () => false }, { confirm });
    expect(confirm).not.toHaveBeenCalled();
    const apply = between(native, '    async applyEdits() {', '\n    discardEdits() {');
    const wait = jest.fn();
    const method = new Function(`return async function() { ${apply.replace(/self\.#/g, 'self.')} `)();
    return method.call({ sitmunCanSaveAttributes: () => false, map: { wait } }).then(() => {
      expect(wait).not.toHaveBeenCalled();
    });
  });

  it('invalidates an already-started render when the same native client is detached and reattached', async () => {
    const native = source(files, 'TC/control/AttributesEdit.js');
    const awaiting = between(native, '            if (layer) {', '                // Inferimos estructura de atributos');
    const setter = between(native, '    set clientControl(value) {', '\n    setFeatureAttribute(');
    let release!: (metadata: unknown) => void;
    const metadata = new Promise((resolve) => { release = resolve; });
    const target = { layer: { type: 'WFS', features: [] } };
    const mutate = jest.fn();
    const editor = new Function('initial', 'pending', 'Consts', 'Modify', 'Draw', 'mutate', `return new class {
      #feature = initial; #clientControl; #clientControlAbortController; #sitmunRenderRevision = 0;
      async #getFeatureTypeMetadata() { return pending; }
      set clientControl(value) { ${setter}
      async render() {
        const sitmunRenderRevision = this.#sitmunRenderRevision;
        const layer = this.#feature.layer, renderObject = {};
        let layerAttributeMetadata, geometriesMetadata, featureTypeMetadata;
        if (layer) { ${awaiting} mutate(); }
      }
    };`)(target, metadata, { layerType: { WFS: 'WFS' } }, class {}, class {}, mutate);
    const rendered = editor.render();
    editor.clientControl = null;
    editor.clientControl = {};
    release({ attributes: [] });
    await rendered;
    expect(mutate).not.toHaveBeenCalled();
  });

  it('invalidates queued drawing timers and refuses feature assignments while suspended', () => {
    jest.useFakeTimers();
    try {
      const native = source(files, 'TC/control/AttributesEdit.js');
      const clientSetter = between(native, '    set clientControl(value) {', '\n    setFeatureAttribute(');
      const featureSetter = between(native, '    set feature(value) {', '\n    get clientControl()');
      class Draw extends EventTarget {}
      const render = jest.fn();
      const editor = new Function('Draw', 'Modify', 'Consts', 'render', `return new class {
        #feature; #clientControl; #clientControlAbortController; #sitmunRenderRevision = 0;
        sitmunAttributesSuspended = false;
        get feature() { return this.#feature; }
        render() { render(); }
        set feature(value) { ${featureSetter}
        set clientControl(value) { ${clientSetter}
      };`)(Draw, class {}, { event: { DRAWEND: 'drawend', DRAWSTART: 'drawstart', DRAWCANCEL: 'drawcancel' },
        geom: { POINT: 'point' } }, render);
      const draw = new Draw();
      editor.clientControl = draw;
      draw.dispatchEvent(new CustomEvent('drawend', { detail: { feature: {} } }));
      editor.sitmunAttributesSuspended = true;
      editor.clientControl = null;
      editor.feature = {};
      jest.runOnlyPendingTimers();
      expect(editor.feature).toBeUndefined();
      expect(render).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });
});
