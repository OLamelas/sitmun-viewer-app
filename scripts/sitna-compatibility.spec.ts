import { runInNewContext } from 'vm';
import { createSitnaPatchSandbox } from './sitna-patch-sandbox';

describe('SITNA compatibility', () => {
  const files = [
    'TC/control/PrintMap.js',
    'TC/control/Edit.js',
    'TC/control/WFSEdit.js',
    'TC/control/AttributesEdit.js',
    'TC/tool/FeatureTypeParser.js',
    'TC/ol/ol.js',
    'workers/tc-caps-web-worker-blob.mjs'
  ];
  const scripts = ['patch-printmap-logo.js', 'patch-wfs-110-parser.js', 'patch-sitna-wfs.js'];
  const sandbox = createSitnaPatchSandbox();
  const readSources = () => files.map(file => sandbox.read(file));
  const runInstallationScripts = () => scripts.forEach(script => sandbox.run(script));
  let patchedSources: string[];

  beforeAll(() => {
    runInstallationScripts();
    patchedSources = readSources();
  });

  it('can rerun the installation scripts without changing their patched sources', () => {
    runInstallationScripts();
    expect(readSources()).toEqual(patchedSources);
  });

  it.each(['clean', 'v1'] as const)('installs the mandatory v2 hooks from the reconstructed %s dependency', (version) => {
    const input = createSitnaPatchSandbox();
    input.wfsBaseline(version);
    const before = input.read('TC/control/WFSEdit.js');
    expect(before).not.toContain('sitmunPermissionHooksVersion = 2;');
    expect(before).not.toContain('if (self.sitmunCanMutate?.() === false) return;');
    if (version === 'v1') expect(before).toContain('sitmunPermissionHooksVersion = 1;');
    else expect(before).not.toContain('sitmunPermissionHooksVersion');
    input.run('patch-sitna-wfs.js');
    const upgraded = input.read('TC/control/WFSEdit.js');
    expect(upgraded).toContain('sitmunPermissionHooksVersion = 2;');
    expect(upgraded.match(/if \(self.sitmunCanMutate\?\.\(\) === false\) return;/g)).toHaveLength(1);
    expect(upgraded).toContain('sitmunCloseLayerTransition(mapLayer, sitmunAttemptCurrent)');
    expect(upgraded).not.toContain('self.sitmunLayerAttemptCurrent?.(');
    input.run('patch-sitna-wfs.js');
    expect(input.read('TC/control/WFSEdit.js')).toBe(upgraded);
  });

  it.each(['1.1.0', '2.0.0'])('parses prefixed WFS %s capabilities', (version) => {
    const source = sandbox.read('workers/tc-caps-web-worker-blob.mjs');
    const worker = source.slice(source.indexOf('String.raw`') + 'String.raw`'.length, source.lastIndexOf('`],'));
    const postMessage = jest.fn();
    const context = { postMessage, onmessage: null as ((event: unknown) => void) | null };
    runInNewContext(worker, context);
    context.onmessage!({ data: { type: 'WFS', text: `
      <wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs" xmlns:ows="http://www.opengis.net/ows" xmlns:menorca="http://menorca" version="${version}">
        <ows:OperationsMetadata>
          <ows:Operation name="GetFeature"><ows:Parameter name="outputFormat"><ows:Value>application/json</ows:Value></ows:Parameter></ows:Operation>
          <ows:Operation name="Transaction"><ows:Parameter name="inputFormat"><ows:Value>text/xml</ows:Value></ows:Parameter></ows:Operation>
        </ows:OperationsMetadata>
        <FeatureTypeList><FeatureType><Name>menorca:shops</Name></FeatureType></FeatureTypeList>
        <Filter_Capabilities/>
      </wfs:WFS_Capabilities>` } });

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      state: 'success',
      capabilities: expect.objectContaining({
        version,
        Operations: expect.objectContaining({ GetFeature: expect.any(Object), Transaction: expect.any(Object) }),
        FeatureTypes: { shops: expect.objectContaining({ Name: 'menorca:shops' }) },
        'xmlns:menorca': 'http://menorca'
      })
    }));
  });

  it('uses the layer title when its path is empty', () => {
    const source = sandbox.read('TC/control/WFSEdit.js');
    const start = source.indexOf('const getLayerTitle = ') + 'const getLayerTitle = '.length;
    const end = source.indexOf('const getLegendImage', start);
    const getLayerTitle = new Function('return ' + source.slice(start, end))();

    expect(getLayerTitle({ getPath: () => [], title: 'Shops', id: '9417' })).toBe('Shops');
    expect(getLayerTitle({ getPath: () => ['Menorca', 'Shops'], title: 'Shops' })).toBe('Menorca • Shops');
    expect(getLayerTitle({ getPath: () => [], id: '9417' })).toBe('9417');
  });

  it('forwards geometry edits to WFSEdit without duplicating elevation changes', () => {
    const source = sandbox.read('TC/control/Edit.js').replace(/\r\n/g, '\n');
    const geometryModifyHandler = source.slice(
      source.indexOf('self.modifyControl\n            .on(Consts.event.FEATUREMODIFY'),
      source.indexOf("const onFeaturesSelectionChange", source.indexOf('self.modifyControl\n            .on(Consts.event.FEATUREMODIFY'))
    );

    expect(geometryModifyHandler).toContain('const elevationChangeEmitted = await addElevation(e.feature);');
    expect(geometryModifyHandler).toContain('if (!elevationChangeEmitted)');
    expect(geometryModifyHandler).toContain('self.trigger(Consts.event.FEATUREMODIFY, { ...e });');
    expect(source).toContain('let emittedChange = false;');
  });

  it('forwards geometry undo and redo and clears reverted WFS modifications', () => {
    const editSource = sandbox.read('TC/control/Edit.js').replace(/\r\n/g, '\n');
    const wfsSource = sandbox.read('TC/control/WFSEdit.js').replace(/\r\n/g, '\n');

    expect(editSource).toContain("self.history.addEventListener('undo'");
    expect(editSource).toContain("self.history.addEventListener('redo'");
    expect(wfsSource).toContain('layerEditData.beforeEditLayer?.getFeatureById(fid)');
    expect(wfsSource).toContain('layerEditData.modifiedFeaturesLayer.removeFeature(storedFeature);');
    expect(wfsSource).toContain('deleteFeature(self.#getModifiedStoragePrefix() + fid)');
  });
});
