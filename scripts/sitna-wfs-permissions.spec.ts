import { createSitnaPatchSandbox } from './sitna-patch-sandbox';

const sandbox = createSitnaPatchSandbox();
sandbox.run('patch-sitna-wfs.js');
const source = sandbox.read('TC/ol/ol.js');
const wfsSource = sandbox.read('TC/control/WFSEdit.js').replace(/\r\n/g, '\n');

describe('definitive native WFSEdit importer', () => {
  function importer(self: any) {
    const marker = 'self.editControl.importFeatures = ';
    const start = wfsSource.indexOf(marker) + marker.length;
    const end = wfsSource.indexOf('\n        self.editControl\n', start);
    return new Function('self', 'return ' + wfsSource.slice(start, end))(self);
  }

  it('checks permission before session access, copies or prototype delegation after native reassignment', () => {
    const native = jest.fn();
    const edit = Object.create({ importFeatures: native });
    const self = { editControl: edit, sitmunCanMutate: () => false, getLayerEditData: jest.fn() };
    edit.importFeatures = importer(self);
    edit.importFeatures([{ data: { name: 'forbidden' } }]);
    expect(self.getLayerEditData).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  });

  it('retains the authorized native attribute transformation and calls the importer exactly once', () => {
    const native = jest.fn(); const edit = Object.create({ importFeatures: native });
    class Feature {
      constructor(public geometry: unknown, public options: any) {}
      get data() { return this.options.data; }
    }
    const self = { editControl: edit, sitmunCanMutate: () => true,
      getLayerEditData: () => ({ attributes: { name: {} }, geometryName: 'geom' }) };
    edit.importFeatures = importer(self);
    const feature = new Feature([1, 2], { data: { name: 'kept', extra: 'excluded' } });
    edit.importFeatures([feature]);
    expect(native).toHaveBeenCalledTimes(1); expect(native.mock.instances[0]).toBe(edit);
    expect(native.mock.calls[0][0][0].options).toEqual({ geometryName: 'geom', data: { name: 'kept' } });
  });
});

describe('scoped native draft recovery', () => {
  function fixture(keys: string[], failure?: 'keys' | 'read' | 'restore') {
    const prefix = 'scoped.app:roads@https://host/wfs';
    const item = { id: 'roads.1', geometry: [1, 2], attributes: { name: 'recovered' }, type: 'point' };
    const read = jest.fn(async (key: string) => {
      if (failure === 'read') throw new Error('read');
      return { key, feature: item };
    });
    const feature: any = { id: 'roads.1', setCoords: jest.fn(), setData: jest.fn(), setId: jest.fn(), setStyle: jest.fn(), clone: () => feature };
    class Vector {
      features: unknown[] = [];
      constructor(_options: unknown) {}
      async addFeature(value: unknown) {
        if (failure === 'restore') throw new Error('restore');
        this.features.push(value); return value;
      }
    }
    const editable = { type: 'WFS', state: 'IDLE', options: {}, getFeatureById: () => feature,
      removeFeature: jest.fn(), addPoint: jest.fn(async () => feature) };
    const data: any = {};
    const self = { sitmunStorageContext: 'scope.', sitmunCaptureLayerAttempt: () => () => true,
      sitmunMigrateLegacyDrafts: async () => true, getEditableLayer: async () => editable,
      getLayerEditData: () => data, getUID: () => 'aux', getLocaleString: () => '',
      getStoragePrefix: () => prefix, getAddedStoragePrefix: () => prefix + '.added.',
      getModifiedStoragePrefix: () => prefix + '.modified.', getRemovedStoragePrefix: () => prefix + '.removed.' };
    const start = wfsSource.indexOf('    #enableEditSerialization(layer) {');
    const end = wfsSource.indexOf('\n    async applyEdits()', start);
    const method = wfsSource.slice(start, end).replace('#enableEditSerialization(layer)', 'function (layer)')
      .replace(/self\.#/g, 'self.');
    const recovery = new Function('localforage', 'readFeature', 'Vector', 'Util', 'Layer', 'Consts', 'getLayerTitle', 'getLayerStoreID',
      'let newFeatureIdNumber = 0; return ' + method)(
      { keys: async () => { if (failure === 'keys') throw new Error('keys'); return keys; } }, read, Vector,
      { extend: Object.assign }, { state: { LOADING: 'LOADING' } }, { layerType: { WFS: 'WFS' }, geom: { POINT: 'point' } },
      () => 'Roads', () => 'legacy');
    return { recover: () => recovery.call(self, editable), read, data, prefix, editable };
  }

  it('ignores unknown scoped keys without reading, deleting or leaving the opening pending', async () => {
    const prefix = 'scoped.app:roads@https://host/wfs';
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = fixture([prefix + '2.modified.roads.1', prefix + '.mystery.roads.1', prefix + '.added.']);
      await expect(f.recover()).resolves.toBe(f.editable);
      expect(f.read).not.toHaveBeenCalled(); expect(f.data.serializable).toBe(true);
      expect(warning).toHaveBeenCalledWith('SITMUN: unrecognized scoped WFS draft key ignored');
    } finally { warning.mockRestore(); }
  });

  it.each(['added', 'modified', 'removed'])('recovers exact %s operations with dotted feature IDs', async (operation) => {
    const f = fixture([`scoped.app:roads@https://host/wfs.${operation}.roads.1`]);
    await expect(f.recover()).resolves.toBe(f.editable); expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.data.serializable).toBe(true);
  });

  it.each(['keys', 'read', 'restore'] as const)('propagates %s failures to the outer opening', async (failure) => {
    const f = fixture(['scoped.app:roads@https://host/wfs.modified.roads.1'], failure);
    await expect(f.recover()).rejects.toThrow(failure);
    expect(f.data.serializable).not.toBe(true);
  });
});

function activation(name: 'Draw' | 'Modify'): (this: any, mode?: string) => void {
  const marker = `TC.wrap.control.${name}.prototype.activate = `;
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf('\n};', start) + '\n};'.length;
  return new Function('Consts', 'olGeometryType', 'return ' + source.slice(start, end))(
    { geom: {} }, { LINE_STRING: 'LineString' }
  );
}

describe('native WFS deferred permission guards', () => {
  it.each(['Draw', 'Modify'] as const)('does not create %s interactions after revocation while resolving the map', async (name) => {
    let allowed = true;
    let resolveMap!: (map: unknown) => void;
    const mapReady = new Promise((resolve) => { resolveMap = resolve; });
    const olMap = { getViewport: jest.fn(), addInteraction: jest.fn() };
    const layer = { wrap: { getLayer: async () => ({}) } };
    const native: any = { parent: {
      map: { wrap: { getMap: () => mapReady } }, layer, getLayer: async () => layer,
      sitmunCaptureEditingPermission: () => () => allowed
    } };
    activation(name).call(native);
    allowed = false;
    resolveMap(olMap);
    await mapReady; await Promise.resolve(); await Promise.resolve();
    expect(olMap.getViewport).not.toHaveBeenCalled();
    expect(olMap.addInteraction).not.toHaveBeenCalled();
    expect(native.interaction).toBeUndefined();
    expect(native.modifyInteraction).toBeUndefined();
  });

  it('rechecks Draw permission after its second asynchronous layer resolution', async () => {
    let allowed = true;
    let resolveLayer!: (layer: unknown) => void;
    const layerReady = new Promise((resolve) => { resolveLayer = resolve; });
    const olMap = { getViewport: jest.fn(), addInteraction: jest.fn() };
    const getLayer = jest.fn(() => layerReady);
    const layer = { wrap: { getLayer } };
    const native = { parent: {
      map: { wrap: { getMap: async () => olMap } }, getLayer: async () => layer,
      sitmunCaptureEditingPermission: () => () => allowed
    } };
    activation('Draw').call(native);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(getLayer).toHaveBeenCalledTimes(1);
    allowed = false;
    resolveLayer({});
    await layerReady; await Promise.resolve();
    expect(olMap.getViewport).not.toHaveBeenCalled();
    expect(olMap.addInteraction).not.toHaveBeenCalled();
  });
});
