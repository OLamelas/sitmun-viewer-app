import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { runInNewContext } from 'vm';

describe('SITNA compatibility', () => {
  it('can run the installation scripts repeatedly without changing the patched code', () => {
    const files = [
      'TC/control/PrintMap.js',
      'TC/control/WFSEdit.js',
      'TC/control/AttributesEdit.js',
      'TC/tool/FeatureTypeParser.js',
      'TC/ol/ol.js',
      'workers/tc-caps-web-worker-blob.mjs'
    ];
    const readSources = () => files.map(file => readFileSync(join(__dirname, '../node_modules/api-sitna', file), 'utf8'));
    const before = readSources();
    for (let run = 0; run < 2; run++) {
      for (const script of ['patch-printmap-logo.js', 'patch-wfs-110-parser.js', 'patch-sitna-wfs.js']) {
        execFileSync(process.execPath, [join(__dirname, script)]);
      }
    }
    expect(readSources()).toEqual(before);
  });

  it.each(['1.1.0', '2.0.0'])('parses prefixed WFS %s capabilities', (version) => {
    const source = readFileSync(join(__dirname, '../node_modules/api-sitna/workers/tc-caps-web-worker-blob.mjs'), 'utf8');
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
    const source = readFileSync(join(__dirname, '../node_modules/api-sitna/TC/control/WFSEdit.js'), 'utf8');
    const start = source.indexOf('const getLayerTitle = ') + 'const getLayerTitle = '.length;
    const end = source.indexOf('const getLegendImage', start);
    const getLayerTitle = new Function('return ' + source.slice(start, end))();

    expect(getLayerTitle({ getPath: () => [], title: 'Shops', id: '9417' })).toBe('Shops');
    expect(getLayerTitle({ getPath: () => ['Menorca', 'Shops'], title: 'Shops' })).toBe('Menorca • Shops');
    expect(getLayerTitle({ getPath: () => [], id: '9417' })).toBe('9417');
  });
});
