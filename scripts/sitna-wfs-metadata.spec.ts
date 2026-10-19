import { readFileSync } from 'fs';
import { join } from 'path';

describe('SITNA WFS metadata', () => {
  it.each(['http', 'https'])('uses bundled GML schemas for internal %s GeoServer URLs', async (scheme) => {
    const file = join(__dirname, '../node_modules/api-sitna/TC/tool/FeatureTypeParser.js');
    const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('    async #requestSchema(');
    const end = source.indexOf('    getFeatureTypeDescription(', start);
    const method = source.slice(start, end)
      .replace('#requestSchema', 'requestSchema')
      .replace("const { default: xsdDictionary } = await import('./xsdDocuments.mjs');", 'const xsdDictionary = dictionary;')
      .replace('this.#proxificationTool.fetchXML', 'fetchXML');
    const dictionary = new Map([['http://schemas.opengis.net/gml/3.2.1/gml.xsd', '<schema/>']]);
    const fetchXML = jest.fn();
    const parser = new Function('dictionary', 'fetchXML', `return new class { ${method} };`)(dictionary, fetchXML);
    const worker = { postMessage: jest.fn() };
    const url = `${scheme}://geoserver.local:8080/geoserver/schemas/gml/3.2.1/gml.xsd`;

    await parser.requestSchema(worker, url);

    expect(fetchXML).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'getSchema', url, xml: '<schema/>' });
  });

  it('abandons stale attribute rendering when the feature is deselected during metadata loading', async () => {
    const file = join(__dirname, '../node_modules/api-sitna/TC/control/AttributesEdit.js');
    const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('            if (layer) {\n');
    const end = source.indexOf('                const featuresToCheck = layer.features;', start);
    const snippet = source.slice(start, end);
    let resolve: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const feature = { getData: jest.fn() };
    const editor = new Function('pending', 'initial', 'Consts', `return new class {
      #feature = initial;
      async #getFeatureTypeMetadata() { return pending; }
      clear() { this.#feature = undefined; }
      async render() {
        const layer = { type: 'WFS' }, renderObject = {};
        let layerAttributeMetadata, featureTypeMetadata, geometriesMetadata;
        ${snippet}
          this.#feature.getData();
        }
      }
    };`)(pending, feature, { layerType: { WFS: 'WFS' } });

    const rendered = editor.render();
    editor.clear();
    resolve!({ attributes: [] });
    await expect(rendered).resolves.toBeUndefined();
    expect(feature.getData).not.toHaveBeenCalled();
  });
});
