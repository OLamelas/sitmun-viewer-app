import { readFileSync } from 'fs';
import { join } from 'path';

import { inspectSchemaProbe, loadSchemaProbe, type SchemaLayer } from './schema-probe';

const XSD = 'http://www.w3.org/2001/XMLSchema';
const url = 'https://wfs.example.test/service?request=DescribeFeatureType';
const xml = (source: string) => new DOMParser().parseFromString(source, 'text/xml');
const schema = (content: string) => xml(`<s:schema xmlns:s="${XSD}" xmlns:app="urn:app"
  targetNamespace="urn:app" elementFormDefault="qualified">${content}</s:schema>`);
const feature = (fields: string, extras = '') => schema(`${extras}
  <s:element name="item" type="app:Item"/>
  <s:complexType name="Item"><s:sequence>${fields}</s:sequence></s:complexType>`);
function inspect(root: Document) {
  return inspectSchemaProbe({ root, documents: [root], issues: [] }, 'urn:app', 'item');
}
function layer(fetchXML: jest.Mock): SchemaLayer {
  return { featureType: ['app:item'], getCapabilitiesPromise: jest.fn().mockResolvedValue({}),
    getDescribeFeatureTypeUrl: jest.fn().mockReturnValue(url), proxificationTool: { fetchXML } };
}

describe('Phase 0: bounded original-XSD probe', () => {
  it('waits for capabilities and uses the native URL and proxificationTool, never a second HTTP client', async () => {
    const root = feature('<s:element name="text" type="s:string"/>');
    const fetchXML = jest.fn().mockResolvedValue(root);
    const source = layer(fetchXML);
    let release!: () => void;
    source.getCapabilitiesPromise = jest.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = loadSchemaProbe(source);
    expect(fetchXML).not.toHaveBeenCalled();
    release();
    const result = await pending;
    expect(source.getDescribeFeatureTypeUrl).toHaveBeenCalledWith(['app:item']);
    expect(fetchXML).toHaveBeenCalledWith(url);
    expect(result.root).toBe(root);
    expect(result.issues).toEqual([]);
  });

  it('resolves by namespace URI, keeps field order, nullability, occurrence and default/fixed lexemes', () => {
    const result = inspect(feature(`
      <s:element name="label" type="app:Label" minOccurs="0" nillable="1" default="untitled"/>
      <s:element name="active" type="s:boolean" fixed="false"/>
      <s:element name="count" type="s:int"/>`, `
      <s:simpleType name="Label"><s:restriction base="s:string">
        <s:maxLength value="12"/><s:enumeration value="one"/><s:enumeration value="two"/>
      </s:restriction></s:simpleType>`));
    expect(result.issues).toEqual([]);
    expect(result.fields.map(field => field.name)).toEqual(['label', 'active', 'count']);
    expect(result.fields[0]).toMatchObject({ type: 'string', minOccurs: '0', maxOccurs: '1',
      nillable: true, defaultValue: 'untitled', fixedValue: null, reasons: [],
      facets: [{ name: 'maxLength', value: '12' }, { name: 'enumeration', value: 'one' }, { name: 'enumeration', value: 'two' }] });
    expect(result.fields[1].reasons).toContain('Fixed field is not a free input');
    expect(result.fields[2].type).toBe('int');
  });

  it('keeps inherited facets instead of silently dropping the base restriction', () => {
    const result = inspect(feature('<s:element name="value" type="app:Narrow"/>', `
      <s:simpleType name="Base"><s:restriction base="s:int"><s:minInclusive value="0"/></s:restriction></s:simpleType>
      <s:simpleType name="Narrow"><s:restriction base="app:Base"><s:maxExclusive value="10"/></s:restriction></s:simpleType>`));
    expect(result.fields[0].facets).toEqual([
      { name: 'minInclusive', value: '0' }, { name: 'maxExclusive', value: '10' }
    ]);
  });

  it.each([
    '<s:element name="value" type="s:dateTime"/>',
    '<s:element name="value" type="unknown:string"/>',
    '<s:element name="value" type="s:string" maxOccurs="unbounded"/>',
    '<s:element name="value"><s:simpleType><s:restriction base="s:string"><s:pattern value="[a-z]+"/></s:restriction></s:simpleType></s:element>',
    '<s:element name="value"><s:complexType><s:sequence/></s:complexType></s:element>'
  ])('reports unsupported cases as unknown, not unrestricted: %s', field => {
    expect(inspect(feature(field)).fields[0].reasons.length).toBeGreaterThan(0);
  });

  it('detects cyclic named simple types and refuses unknown feature structures', () => {
    const cyclic = feature('<s:element name="value" type="app:Loop"/>',
      '<s:simpleType name="Loop"><s:restriction base="app:Loop"/></s:simpleType>');
    expect(inspect(cyclic).fields[0].reasons).toContain('Cyclic simple type');
    const choice = schema('<s:element name="item"><s:complexType><s:choice/></s:complexType></s:element>');
    expect(() => inspect(choice)).toThrow('Unsupported feature content model');
  });

  it('does not fetch imports without explicit authorization and keeps a blocking issue', async () => {
    const root = feature('', '<s:import namespace="urn:remote" schemaLocation="https://remote.test/types.xsd"/>');
    const fetchXML = jest.fn().mockResolvedValue(root);
    const result = await loadSchemaProbe(layer(fetchXML));
    expect(fetchXML).toHaveBeenCalledTimes(1);
    expect(result.issues).toContain('Schema dependency is not explicitly authorized');
    expect(inspectSchemaProbe(result, 'urn:app', 'item').issues).toEqual(result.issues);
  });

  it('uses bundled dependencies, deduplicates and resolves relative locations', async () => {
    const imported = schema('<s:simpleType name="Label"><s:restriction base="s:string"/></s:simpleType>');
    const root = feature('<s:element name="label" type="app:Label"/>', `
      <s:include schemaLocation="./types.xsd"/><s:include schemaLocation="./types.xsd"/>`);
    const fetchXML = jest.fn().mockResolvedValue(root);
    const result = await loadSchemaProbe(layer(fetchXML), {
      bundled: new Map([['https://wfs.example.test/types.xsd', imported]])
    });
    expect(fetchXML).toHaveBeenCalledTimes(1);
    expect(result.documents).toHaveLength(2);
    expect(result.issues).toEqual([]);
    expect(inspectSchemaProbe(result, 'urn:app', 'item').fields[0].type).toBe('string');
  });

  it('reports failed imports, mismatched namespaces, cycles and document/depth limits', async () => {
    const root = feature('', '<s:include schemaLocation="./types.xsd"/>');
    const failed = jest.fn().mockResolvedValueOnce(root).mockRejectedValueOnce(new Error('Access denied'));
    expect((await loadSchemaProbe(layer(failed), { allowDependency: () => true })).issues).toContain('Access denied');
    const mismatch = jest.fn().mockResolvedValueOnce(root).mockResolvedValueOnce(xml(`<s:schema xmlns:s="${XSD}" targetNamespace="urn:other"/>`));
    expect((await loadSchemaProbe(layer(mismatch), { allowDependency: () => true })).issues).toContain('Schema dependency namespace mismatch');
    const cyclic = feature('', '<s:include schemaLocation="./service?request=DescribeFeatureType"/>');
    expect((await loadSchemaProbe(layer(jest.fn().mockResolvedValue(cyclic)), { allowDependency: () => true })).issues)
      .toContain('Cyclic schema dependency');
    for (const options of [{ maxDocuments: 1 }, { maxDepth: 0 }]) {
      expect((await loadSchemaProbe(layer(jest.fn().mockResolvedValue(root)), options)).issues)
        .toContain('Schema dependency limit exceeded');
    }
  });

  it('times out a stalled request without accepting a late schema', async () => {
    jest.useFakeTimers();
    try {
      const source = layer(jest.fn(() => new Promise<Document>(() => undefined)));
      const pending = loadSchemaProbe(source, { timeoutMs: 50 });
      const assertion = expect(pending).rejects.toThrow('Schema deadline exceeded');
      await jest.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects OGC exception reports instead of treating them as an empty schema', async () => {
    const source = layer(jest.fn().mockResolvedValue(xml('<ExceptionReport/>')));
    await expect(loadSchemaProbe(source)).rejects.toThrow('did not return an XSD schema');
  });

  it('characterizes the local shops XSD without claiming imported GML or technical identifiers are resolved', async () => {
    const root = xml(readFileSync(join(__dirname, 'fixtures/shops.xsd'), 'utf8'));
    const result = inspectSchemaProbe(await loadSchemaProbe(layer(jest.fn().mockResolvedValue(root))), 'http://menorca', 'shops');
    expect(result.fields.map(field => field.name)).toEqual(['gid', 'category', 'city', 'municipality', 'employees', 'scope', 'geom']);
    expect(result.fields.find(field => field.name === 'category')).toMatchObject({ type: 'string', minOccurs: '1', nillable: false });
    expect(result.fields.find(field => field.name === 'employees')).toMatchObject({ type: 'int', minOccurs: '0', nillable: true });
    expect(result.fields.find(field => field.name === 'geom')!.reasons.length).toBeGreaterThan(0);
    expect(result.fields.some(field => field.name === 'name')).toBe(false);
    expect(result.issues).toContain('Complex type inheritance requires native/GML metadata reconciliation');
    expect(result.issues).toContain('Schema dependency is not explicitly authorized');
  });
});
