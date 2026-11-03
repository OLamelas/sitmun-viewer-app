import { readFileSync } from 'fs';
import { join } from 'path';

import { between, nativeSource } from './native-source';

describe('Phase 0: native integration boundaries (not browser or server certification)', () => {
  it('targets exactly the lockfile SITNA version and the existing native Edit/history API', () => {
    const installed = JSON.parse(nativeSource('package.json')) as { version: string };
    const lock = JSON.parse(readFileSync(join(__dirname, '../../package-lock.json'), 'utf8'));
    expect(installed.version).toBe('4.9.1');
    expect(lock.packages['node_modules/api-sitna'].version).toBe(installed.version);
    expect(nativeSource('TC/control/WFSEdit.js')).toContain('getEditControl()');
    expect(nativeSource('TC/control/Edit.js')).toContain('self.history = self.modifyControl.history;');
    expect(nativeSource('TC/control/Edit.js')).toContain('getModifyControlAttributeEditor()');
  });

  it('the native select callback splits one gesture into two events and drops the gesture context', () => {
    const body = between(nativeSource('TC/ol/ol.js'),
      "select.on('select', function (event) {", '\n            });\n            if (self.modifyInteraction)');
    const parent = { dispatchEvent: jest.fn() };
    class ControlEvent extends Event {
      constructor(type: string, options: object) { super(type); Object.assign(this, options); }
    }
    const callback = new Function('self', 'ControlEvent', 'Consts', 'getWrapperFeature',
      `return function(event) { ${body} };`)(
      { parent }, ControlEvent,
      { event: { FEATURESUNSELECT: 'unselect', FEATURESSELECT: 'select' } },
      (feature: { wrapped: unknown }) => feature.wrapped
    );
    const oldFeature = {};
    const nextFeature = {};
    callback({ deselected: [{ wrapped: oldFeature }], selected: [{ wrapped: nextFeature }],
      mapBrowserEvent: { type: 'singleclick', originalEvent: new MouseEvent('click') } });
    expect(parent.dispatchEvent).toHaveBeenCalledTimes(2);
    expect(parent.dispatchEvent.mock.calls[0][0]).toMatchObject({ type: 'unselect', features: [oldFeature] });
    expect(parent.dispatchEvent.mock.calls[1][0]).toMatchObject({ type: 'select', features: [nextFeature] });
    expect(parent.dispatchEvent.mock.calls[1][0].mapBrowserEvent).toBeUndefined();
  });

  it('recreates the 2D selection interaction and has a separate 3D selection implementation', () => {
    const source = nativeSource('TC/ol/ol.js');
    const activate = between(source, 'TC.wrap.control.Modify.prototype.activate = function () {',
      'TC.wrap.control.Modify.prototype.deactivate =');
    expect(activate).toContain('select = new ol.interaction.Select(selectOptions);');
    expect(activate).toContain('self.selectInteraction = select;');
    expect(activate).toContain('new Select3D(');
    // A source boundary is not evidence of a real 3D click or hit-test.
  });

  it('can intercept a visibility intention in capture phase before the synchronous native mutation', () => {
    const body = between(nativeSource('TC/control/WorkLayerManager.js'),
      'sitna-toggle.${self.CLASS}-cb-visibility`, function (e) {', '\n        }));');
    const setVisibility = jest.fn();
    const nativeListener = new Function('self', `return function(e) { ${body} };`)(
      { CLASS: 'tc-ctl-wlm', map: { getLayer: () => ({ setVisibility }) } }
    );
    const root = document.createElement('div');
    const li = document.createElement('li');
    li.className = 'tc-ctl-wlm-elm';
    li.dataset['layerId'] = 'edited';
    const toggle = document.createElement('sitna-toggle');
    Object.assign(toggle, { checked: false });
    li.append(toggle);
    root.append(li);
    root.addEventListener('change', nativeListener);
    const guard = (event: Event) => { event.stopImmediatePropagation(); };
    root.addEventListener('change', guard, true);
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setVisibility).not.toHaveBeenCalled();
    root.removeEventListener('change', guard, true);
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setVisibility).toHaveBeenCalledTimes(1);
    expect(setVisibility).toHaveBeenCalledWith(false);

    const setter = between(nativeSource('SITNA/layer/Layer.js'),
      '    setVisibility(visible) {', '\n    }');
    const layer = { wrap: { setVisibility: jest.fn() } };
    expect(new Function('visible', setter).call(layer, false)).toBe(layer);
  });

  it('uses native DescribeFeatureType through the same proxificationTool and requests JSON for associated WFS', () => {
    const vector = nativeSource('SITNA/layer/Vector.js');
    expect(vector).toContain('self.proxificationTool.fetchXML(self.getDescribeFeatureTypeUrl(layers || self.featureType))');
    expect(nativeSource('TC/control/WFSEdit.js')).toContain('outputFormat: Consts.format.JSON');
  });

  it('invalidates the native late render after client detachment (phase-3 postinstall fix)', async () => {
    const source = nativeSource('TC/control/AttributesEdit.js');
    const awaiting = between(source, '            if (layer) {', '                // Inferimos estructura de atributos');
    const populate = between(source, '                const newData = {};', '\n                // Quitamos los atributos geométricos');
    const clientSetter = between(source, '    set clientControl(value) {', '\n    setFeatureAttribute(');
    // Keep the real setter and pre-mutation code, without unrelated DOM rendering.
    let release!: (metadata: unknown) => void;
    const metadata = new Promise(resolve => { release = resolve; });
    const data: Record<string, unknown> = {};
    const target = { layer: { type: 'WFS' }, getData: () => data,
      setData: jest.fn((added: object) => Object.assign(data, added)) };
    const editor = new Function('initial', 'pending', 'Consts', 'Modify', 'Draw', `return new class {
      #feature = initial; #clientControl = {}; #clientControlAbortController; #sitmunRenderRevision = 0;
      async #getFeatureTypeMetadata() { return pending; }
      get clientControl() { return this.#clientControl; }
      set clientControl(value) { ${clientSetter}
      async render() {
        const sitmunRenderRevision = this.#sitmunRenderRevision;
        const layer = this.#feature.layer, renderObject = {};
        let layerAttributeMetadata, featureTypeMetadata, geometriesMetadata;
        let featureData = this.#feature.getData();
        const genericEquals = (a, b) => a === b;
        const getDataFromMetadata = value => value;
        if (layer) {
        ${awaiting}
        const newData = {}; ${populate}
        }
      }
    };`)(target, metadata, { layerType: { WFS: 'WFS' } }, class {}, class {});
    const rendered = editor.render();
    editor.clientControl = null;
    release({ attributes: [{ name: 'required', type: 'string', optional: false, nonNullable: true }] });
    await rendered;
    expect(target.setData).not.toHaveBeenCalled();
    expect(data).toEqual({});
  });

  it('characterizes applyEdits resolving before the map.wait transaction completes', async () => {
    const body = between(nativeSource('TC/control/WFSEdit.js'), '    async applyEdits() {', '\n    discardEdits() {');
    let transaction: (() => Promise<void>) | undefined;
    const context = {
      layer: {}, isSyncing: false,
      getLayerEditData: () => ({ serializable: true }),
      setSyncState: jest.fn(),
      map: { wait: jest.fn((callback: () => Promise<void>) => { transaction = callback; }) }
    };
    const method = new Function(`return async function() { ${body.replace(/self\.#/g, 'self.')} `)();
    await method.call(context);
    expect(context.isSyncing).toBe(true);
    expect(transaction).toBeDefined();
    expect(context.map.wait).toHaveBeenCalledTimes(1);
    // The transaction was captured, not executed; no HTTP can occur in this probe.
  });
});
