import { readFileSync } from 'fs';
import { join } from 'path';
import { attributeFormFields, resolveNativeAttributeMetadata } from '../src/app/utils/wfs-attribute-fields';
import { loadWfsAttributeSchema, parseWfsAttributeSchema, resolveWfsFeatureType } from '../src/app/utils/wfs-attribute-schema';

describe('SITNA WFS metadata', () => {
  it('preserves the DescribeFeatureType declaration in originaData and derives native attributes in Vector', async () => {
    const xml = readFileSync(join(__dirname, '../src/app/utils/fixtures/shops-gml32-with-name.xsd'), 'utf8');
    const description = {
      'gml:name': { '@name': 'gml:name', '@type': 'xsd:string', type: 'string',
        '@minOccurs': 0, '@maxOccurs': 1, '@nillable': false },
      name: { '@name': 'name', '@type': 'xsd:string', type: 'string',
        '@minOccurs': 1, '@maxOccurs': 1, '@nillable': false },
      geom: { '@name': 'geom', '@type': 'gml:PointPropertyType', type: 'gml:PointPropertyType',
        '@minOccurs': 1, '@maxOccurs': 1, '@nillable': false }
    };

    const source = readFileSync(join(__dirname, '../node_modules/api-sitna/SITNA/layer/Vector.js'), 'utf8');
    const methodStart = source.indexOf('    async getFeatureTypeMetadata() {');
    const methodEnd = source.indexOf('    setFeatureTypeMetadata(', methodStart);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const method = source.slice(methodStart, methodEnd).replaceAll('#featureTypeMetadata', 'metadata');
    const layer = new Function('Consts', 'GMLBase', `return new class {
      type = 'WFS'; featureType = ['shops']; ${method}
    };`)({ layerType: { WFS: 'WFS' }, dataType: { STRING: 'string', INTEGER: 'integer' } },
      { getGeometryType: (type: unknown) => type === 'gml:PointPropertyType' ? 'point' : undefined });
    layer.options = { featureNS: 'menorca' };
    layer.describeFeatureType = jest.fn().mockResolvedValue(description);
    const metadata = await layer.getFeatureTypeMetadata();
    expect(metadata).toMatchObject({ name: ['shops'], origin: 'WFS' });
    expect(metadata.originaData).toBe(description);
    expect(metadata.attributes).toContainEqual(expect.objectContaining({ name: 'name', originalType: 'string' }));
    expect(metadata.attributes).toContainEqual(expect.objectContaining({ name: 'gml:name', originalType: 'string' }));
    expect(metadata.geometries).toContainEqual(expect.objectContaining({ name: 'geom', originalType: 'gml:PointPropertyType' }));
    layer.getCapabilitiesPromise = async () => ({});
    layer.getDescribeFeatureTypeUrl = () => 'https://wfs.test/schema';
    layer.proxificationTool = { fetchXML: async () => new DOMParser().parseFromString(xml, 'application/xml') };
    const loaded = await loadWfsAttributeSchema(layer);
    const identity = resolveWfsFeatureType(layer, loaded.documents, loaded.capabilities);
    const schema = parseWfsAttributeSchema(loaded.documents, identity, loaded.issues);
    const before = JSON.stringify(metadata);
    const fields = attributeFormFields(schema, { 'menorca:name': 'Comerç rural 60' },
      resolveNativeAttributeMetadata(schema, metadata, identity), false, (key) => key);
    expect(fields.find((field) => field.name === 'menorca:name')).toMatchObject({
      value: 'Comerç rural 60', present: true, editable: true, reasons: [] });
    expect(JSON.stringify(metadata)).toBe(before);
  });

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
