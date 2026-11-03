import { readFileSync } from 'fs';
import { join } from 'path';
import { attributeFormFields } from './wfs-attribute-fields';
import {
  loadWfsAttributeSchema,
  parseWfsAttributeSchema,
  resolveWfsFeatureType,
  WfsSchemaLayer
} from './wfs-attribute-schema';

const XSD = 'http://www.w3.org/2001/XMLSchema';
const documentFrom = (xml: string): Document =>
  new DOMParser().parseFromString(xml, 'application/xml');
const schema = (content: string): Document =>
  documentFrom(
    `<xsd:schema xmlns:xsd="${XSD}" xmlns:app="urn:app" targetNamespace="urn:app" elementFormDefault="qualified">${content}</xsd:schema>`
  );

describe('WFS attribute schema', () => {
  describe('native feature identity', () => {
    const doc = () => schema(`<xsd:element name="shops"><xsd:complexType><xsd:sequence>
      <xsd:element name="label" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>`);

    it('resolves a short native name without changing internal QName rules or layer options', () => {
      const layer = { featureType: ['shops'], options: { featureNS: 'app' } };
      const identity = resolveWfsFeatureType(layer, [doc()], {});
      expect(identity).toEqual({ namespaceURI: 'urn:app', localName: 'shops' });
      expect(parseWfsAttributeSchema([doc()], identity).fields[0].type).toBe('string');
      expect(layer).toEqual({ featureType: ['shops'], options: { featureNS: 'app' } });
      expect(() => parseWfsAttributeSchema([doc()], 'shops')).toThrow('Unresolved schema QName');
    });

    it('matches different prefixes by URI using native capabilities', () => {
      const identity = resolveWfsFeatureType({ featureType: 'native:shops', featureNS: 'app' },
        [doc()], { 'xmlns:native': 'urn:app' });
      expect(parseWfsAttributeSchema([doc()], identity).fields[0].name).toBe('label');
    });

    it.each([
      [{ featureType: ['shops'] }, {}, 'Missing native'],
      [{ featureType: 'unknown:shops' }, {}, 'Unknown WFS'],
      [{ featureType: 'app:shops' }, { 'xmlns:app': 'urn:other' }, 'Contradictory'],
      [{ featureType: ['shops'], featureNS: 'native' }, { 'xmlns:native': 'urn:other' }, 'does not match'],
      [{ featureType: ['other'], featureNS: 'app' }, {}, 'Missing or ambiguous']
    ])('rejects unproven or conflicting identities: %j', (layer, capabilities, error) => {
      expect(() => resolveWfsFeatureType(layer as any, [doc()], capabilities)).toThrow(error as string);
    });

    it('rejects duplicate global declarations rather than selecting the first', () => {
      expect(() => resolveWfsFeatureType({ featureType: ['shops'], featureNS: 'app' },
        [doc(), doc()], {})).toThrow('ambiguous');
    });

    it('does not resolve an unqualified internal type against targetNamespace', () => {
      const xml = schema('<xsd:element name="shops" type="ShopType"/><xsd:complexType name="ShopType"/>');
      const identity = resolveWfsFeatureType({ featureType: ['shops'], featureNS: 'app' }, [xml], {});
      expect(() => parseWfsAttributeSchema([xml], identity)).toThrow('Unresolved schema QName: ShopType');
    });
  });
  it('preserves schema order and resolves simple types and restrictions by namespace', () => {
    const doc = schema(`
      <xsd:element name="items" type="app:ItemType"/>
      <xsd:complexType name="ItemType"><xsd:sequence>
        <xsd:element name="category" type="app:Category" minOccurs="1" nillable="false"/>
        <xsd:element name="count" type="xsd:int" minOccurs="0" nillable="true"/>
      </xsd:sequence></xsd:complexType>
      <xsd:simpleType name="Category"><xsd:restriction base="xsd:string">
        <xsd:maxLength value="20"/><xsd:enumeration value="one"/>
      </xsd:restriction></xsd:simpleType>`);

    const result = parseWfsAttributeSchema([doc], 'app:items');

    expect(result.issues).toEqual([]);
    expect(result.fields.map((field) => field.name)).toEqual(['category', 'count']);
    expect(result.fields[0]).toMatchObject({
      type: 'string',
      minOccurs: '1',
      nillable: false,
      facets: [
        { name: 'maxLength', value: '20' },
        { name: 'enumeration', value: 'one' }
      ]
    });
    expect(result.fields[1]).toMatchObject({ type: 'int', minOccurs: '0', nillable: true });
  });

  it('applies XSD defaults to omitted declaration attributes', () => {
    const doc = schema(`
      <xsd:element name="items"><xsd:complexType><xsd:sequence>
        <xsd:element name="ordinary" type="xsd:string"/>
        <xsd:element name="unqualified" type="xsd:string" form="unqualified"/>
        <xsd:element name="constant" type="xsd:string" fixed="locked"/>
      </xsd:sequence></xsd:complexType></xsd:element>`);

    const result = parseWfsAttributeSchema([doc], 'app:items');

    expect(result.fields[0]).toMatchObject({
      namespace: 'urn:app',
      minOccurs: '1',
      maxOccurs: '1',
      nillable: false,
      defaultValue: null,
      fixedValue: null,
      reasons: []
    });
    expect(result.fields[1].namespace).toBe('');
    expect(result.fields[2]).toMatchObject({
      fixedValue: 'locked',
      reasons: []
    });
  });

  it('retains dates, repeated fields and facets without a three-type editability whitelist', () => {
    const doc = schema(`
      <xsd:element name="items"><xsd:complexType><xsd:sequence>
        <xsd:element name="repeat" type="xsd:string" maxOccurs="unbounded"/>
        <xsd:element name="date" type="xsd:date"/>
        <xsd:element name="pattern" type="app:Pattern"/>
      </xsd:sequence></xsd:complexType></xsd:element>
      <xsd:simpleType name="Pattern"><xsd:restriction base="xsd:string"><xsd:pattern value="[a-z]+"/></xsd:restriction></xsd:simpleType>`);

    const result = parseWfsAttributeSchema([doc], 'app:items');

    expect(result.fields.map((field) => field.reasons)).toEqual([[], [], []]);
    expect(result.fields[0].maxOccurs).toBe('unbounded');
    expect(result.fields[1].type).toBe('date');
    expect(result.fields[2].facets).toEqual([{ name: 'pattern', value: '[a-z]+' }]);
  });

  it('retains list, union, complex and binary contracts for their respective editors', () => {
    const doc = schema(`<xsd:element name="items"><xsd:complexType><xsd:sequence>
      <xsd:element name="numbers" type="app:Numbers"/>
      <xsd:element name="choice" type="app:Choice"/>
      <xsd:element name="details"><xsd:complexType><xsd:sequence/></xsd:complexType></xsd:element>
      <xsd:element name="binary" type="xsd:base64Binary"/>
      <xsd:element name="references" type="xsd:IDREFS"/>
      </xsd:sequence></xsd:complexType></xsd:element>
      <xsd:simpleType name="Numbers"><xsd:list itemType="xsd:long"/></xsd:simpleType>
      <xsd:simpleType name="Choice"><xsd:union memberTypes="xsd:string xsd:int"/></xsd:simpleType>`);
    const fields = parseWfsAttributeSchema([doc], 'app:items').fields;
    expect(fields.map((field) => field.type)).toEqual(['list', 'union', 'complex', 'base64Binary', 'list']);
    expect(fields[0].itemType).toBe('long');
    expect(fields[4].itemType).toBe('IDREF');
    expect(fields.every((field) => field.reasons.length === 0)).toBe(true);
  });

  it('uses the layer capability, DescribeFeatureType URL and proxification tool', async () => {
    const root = schema('<xsd:element name="items" type="xsd:string"/>');
    const layer: WfsSchemaLayer = {
      featureType: 'app:items',
      getCapabilitiesPromise: jest.fn().mockResolvedValue({}),
      getDescribeFeatureTypeUrl: jest.fn().mockReturnValue('https://service.test/wfs?request=DescribeFeatureType'),
      proxificationTool: { fetchXML: jest.fn().mockResolvedValue(root) }
    };

    const result = await loadWfsAttributeSchema(layer);

    expect(layer.getCapabilitiesPromise).toHaveBeenCalledTimes(1);
    expect(layer.getDescribeFeatureTypeUrl).toHaveBeenCalledWith(['app:items']);
    expect(layer.proxificationTool.fetchXML).toHaveBeenCalledWith(
      'https://service.test/wfs?request=DescribeFeatureType'
    );
    expect(result.documents).toEqual([root]);
    expect(result.issues).toEqual([]);
  });

  it('keeps an external import as a blocking issue and does not fetch it', async () => {
    const root = schema(`
      <xsd:import namespace="urn:external" schemaLocation="https://other.test/types.xsd"/>
      <xsd:element name="items"><xsd:complexType><xsd:sequence>
        <xsd:element name="label" type="xsd:string"/>
      </xsd:sequence></xsd:complexType></xsd:element>`);
    const fetchXML = jest.fn().mockResolvedValue(root);
    const layer: WfsSchemaLayer = {
      featureType: 'app:items',
      getCapabilitiesPromise: jest.fn().mockResolvedValue({}),
      getDescribeFeatureTypeUrl: jest.fn().mockReturnValue('https://service.test/wfs?request=DescribeFeatureType'),
      proxificationTool: { fetchXML }
    };

    const result = await loadWfsAttributeSchema(layer);

    expect(fetchXML).toHaveBeenCalledTimes(1);
    expect(result.issues).toContain(
      'Schema dependency is outside the authorized service origin'
    );
    expect(parseWfsAttributeSchema(result.documents, 'app:items', result.issues).issues)
      .toEqual(result.issues);
  });

  it('rejects exception documents rather than inferring a schema', async () => {
    const layer: WfsSchemaLayer = {
      featureType: 'app:items',
      getCapabilitiesPromise: jest.fn().mockResolvedValue({}),
      getDescribeFeatureTypeUrl: jest.fn().mockReturnValue('https://service.test/wfs'),
      proxificationTool: { fetchXML: jest.fn().mockResolvedValue(documentFrom('<ExceptionReport/>')) }
    };

    await expect(loadWfsAttributeSchema(layer)).rejects.toThrow(
      'DescribeFeatureType did not return an XSD schema'
    );
  });

  it('resolves the URL only after capabilities are ready', async () => {
    let ready = false;
    const layer: WfsSchemaLayer = {
      featureType: 'app:items',
      getCapabilitiesPromise: async () => { ready = true; },
      getDescribeFeatureTypeUrl: () => {
        if (!ready) throw new Error('capabilities not ready');
        return 'https://service.test/wfs';
      },
      proxificationTool: { fetchXML: async () => schema('') }
    };
    await expect(loadWfsAttributeSchema(layer)).resolves.toMatchObject({ issues: [] });
  });

  it('does not broaden inherited enumeration restrictions into a union', () => {
    const doc = schema(`<xsd:element name="items"><xsd:complexType><xsd:sequence>
      <xsd:element name="value" type="app:Narrow"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:simpleType name="Base"><xsd:restriction base="xsd:string">
        <xsd:enumeration value="a"/><xsd:enumeration value="b"/>
      </xsd:restriction></xsd:simpleType>
      <xsd:simpleType name="Narrow"><xsd:restriction base="app:Base">
        <xsd:enumeration value="a"/>
      </xsd:restriction></xsd:simpleType>`);
    expect(parseWfsAttributeSchema([doc], 'app:items').fields[0]).toMatchObject({ reasons: [],
      facets: [{ name: 'enumeration', value: 'a' }] });
  });

  it('resolves the shops GML 3.2 inheritance from bundled schemas without external network access', async () => {
    const root = documentFrom(readFileSync(join(__dirname, 'fixtures/shops-gml32.xsd'), 'utf8'));
    const fetchXML = jest.fn().mockResolvedValue(root);
    const loaded = await loadWfsAttributeSchema({ featureType: 'menorca:shops',
      getCapabilitiesPromise: async () => ({}), getDescribeFeatureTypeUrl: () => 'https://app.test/middleware/wfs',
      proxificationTool: { fetchXML } });
    expect(fetchXML).toHaveBeenCalledTimes(1);
    expect(loaded.issues).toEqual([]);
    const parsed = parseWfsAttributeSchema(loaded.documents, 'menorca:shops', loaded.issues);
    expect(parsed.issues).toEqual([]);
    expect(parsed.fields.find((field) => field.name === 'category')).toMatchObject({ type: 'string', reasons: [] });
    expect(parsed.fields.find((field) => field.name === 'name')).toMatchObject({
      namespace: 'http://www.opengis.net/gml/3.2', inherited: true });
    expect(parsed.fields.find((field) => field.name === 'boundedBy')?.reasons.length).toBeGreaterThan(0);
    const fields = attributeFormFields(parsed, { 'menorca:category': 'alimentació', 'menorca:employees': '7',
      'menorca:name': 'Comerç rural', 'gml:boundedBy': [1, 2, 1, 2] },
    { attributes: [{ name: 'category' }, { name: 'employees' }, { name: 'name' }], geometries: [{ name: 'geom' }] },
    false, (key) => key);
    expect(fields.find((field) => field.name === 'menorca:category')).toMatchObject({ value: 'alimentació', editable: true });
    expect(fields.find((field) => field.name === 'menorca:employees')).toMatchObject({ value: '7', editable: true });
    expect(fields.find((field) => field.name === 'menorca:name')).toMatchObject({ editable: true });
    expect(fields.filter((field) => field.schema?.name === 'category')).toHaveLength(1);
  });

  it('resolves application inheritance, groups and references without making it all read-only', () => {
    const doc = schema(`<xsd:element name="items" type="app:Item"/>
      <xsd:element name="label" type="xsd:string"/>
      <xsd:group name="Common"><xsd:sequence><xsd:element ref="app:label" minOccurs="0"/></xsd:sequence></xsd:group>
      <xsd:complexType name="Base"><xsd:sequence><xsd:group ref="app:Common"/></xsd:sequence></xsd:complexType>
      <xsd:complexType name="Item"><xsd:complexContent><xsd:extension base="app:Base"><xsd:sequence>
        <xsd:element name="count" type="xsd:int"/>
      </xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType>`);
    const result = parseWfsAttributeSchema([doc], 'app:items');
    expect(result.issues).toEqual([]);
    expect(result.fields.map((field) => field.name)).toEqual(['label', 'count']);
    expect(result.fields[0]).toMatchObject({ namespace: 'urn:app', inherited: true, minOccurs: '0', reasons: [] });
  });

  it('keeps the corrected local shops name distinct from inherited GML name', async () => {
    const root = documentFrom(readFileSync(join(__dirname, 'fixtures/shops-gml32-with-name.xsd'), 'utf8'));
    const layer = { featureType: ['shops'], options: { featureNS: 'menorca' },
      getCapabilitiesPromise: async () => ({}), getDescribeFeatureTypeUrl: () => 'https://wfs.test/schema',
      proxificationTool: { fetchXML: jest.fn().mockResolvedValue(root) } };
    const loaded = await loadWfsAttributeSchema(layer);
    const identity = resolveWfsFeatureType(layer, loaded.documents, loaded.capabilities);
    const parsed = parseWfsAttributeSchema(loaded.documents, identity, loaded.issues);
    expect(identity).toEqual({ namespaceURI: 'http://menorca', localName: 'shops' });
    expect(parsed.issues).toEqual([]);
    expect(parsed.fields.filter((field) => field.name === 'name')).toEqual([
      expect.objectContaining({ namespace: 'http://www.opengis.net/gml/3.2', inherited: true,
        reasons: expect.arrayContaining(['Inherited infrastructure field']) }),
      expect.objectContaining({ namespace: 'http://menorca', inherited: false, type: 'string',
        minOccurs: '1', maxOccurs: '1', nillable: false, reasons: [] })
    ]);
    // Parsing alone is not proof that the unqualified native metadata means the local field.
    expect(attributeFormFields(parsed, { 'menorca:name': 'Comerç rural 60' },
      { attributes: [{ name: 'name' }] }, false, (key) => key)
      .find((field) => field.name === 'menorca:name')).toMatchObject({ editable: false });
    expect(layer.proxificationTool.fetchXML).toHaveBeenCalledTimes(1);
  });

  it('keeps missing and cyclic inheritance blocking, while showing the local sequence', () => {
    for (const base of ['app:Missing', 'app:Item']) {
      const doc = schema(`<xsd:element name="items" type="app:Item"/>
        <xsd:complexType name="Item"><xsd:complexContent><xsd:extension base="${base}"><xsd:sequence>
          <xsd:element name="label" type="xsd:string"/>
        </xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType>`);
      const result = parseWfsAttributeSchema([doc], 'app:items');
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.fields.map((field) => field.name)).toEqual(['label']);
    }
  });

  it('rejects namespace-mismatched imports before adding their declarations', async () => {
    const root = schema('<xsd:import namespace="urn:expected" schemaLocation="./types.xsd"/>');
    const fetchXML = jest.fn().mockResolvedValueOnce(root).mockResolvedValueOnce(schema(''));
    const loaded = await loadWfsAttributeSchema({ featureType: 'app:items', getCapabilitiesPromise: async () => ({}),
      getDescribeFeatureTypeUrl: () => 'https://wfs.test/schema', proxificationTool: { fetchXML } });
    expect(loaded.documents).toEqual([root]);
    expect(loaded.issues).toEqual(['Schema dependency namespace mismatch']);
  });
});
