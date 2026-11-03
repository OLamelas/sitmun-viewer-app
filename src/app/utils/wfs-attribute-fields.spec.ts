import { readFileSync } from 'fs';
import { join } from 'path';
import { attributeFormFields, isAuxiliaryGmlBounds, NativeAttributeMetadata, resolveNativeAttributeMetadata } from './wfs-attribute-fields';
import { loadWfsAttributeSchema, parseWfsAttributeSchema, resolveWfsFeatureType, WfsAttributeField, WfsAttributeSchema } from './wfs-attribute-schema';

const definition = (name = 'category', overrides: Partial<WfsAttributeField> = {}): WfsAttributeField => ({
  name, namespace: 'urn:app', type: 'string', minOccurs: '0', maxOccurs: '1', nillable: true,
  defaultValue: null, fixedValue: null, facets: [], reasons: [], ...overrides
});
const schema = (fields = [definition()]): WfsAttributeSchema => ({ featureType: 'app:items', fields, issues: [],
  namespaces: { app: 'urn:app', alias: 'urn:app', other: 'urn:other', gml: 'http://www.opengis.net/gml/3.2' } });
const text = (key: string) => key;

describe('verified native local names with GML inheritance', () => {
  const identity = { namespaceURI: 'http://menorca', localName: 'shops' };
  const data = Object.freeze({ 'menorca:name': 'Comerç rural 60' });
  const native = (): NativeAttributeMetadata => ({
    name: ['shops'], origin: 'WFS',
    originaData: { name: { '@name': 'name', '@type': 'xsd:string', type: 'string',
      '@minOccurs': 1, '@maxOccurs': 1, '@nillable': false } },
    attributes: [{ name: 'name', originalType: 'string' }], geometries: [{ name: 'geom' }]
  });
  let corrected: WfsAttributeSchema;
  let old: WfsAttributeSchema;

  beforeAll(async () => {
    const doc = (name: string) => new DOMParser().parseFromString(
      readFileSync(join(__dirname, `fixtures/${name}.xsd`), 'utf8'), 'application/xml');
    const layer = { featureType: 'menorca:shops', getCapabilitiesPromise: async () => ({}),
      getDescribeFeatureTypeUrl: () => 'https://wfs.test/schema',
      proxificationTool: { fetchXML: async () => doc('shops-gml32-with-name') } };
    const loaded = await loadWfsAttributeSchema(layer);
    const resolved = resolveWfsFeatureType(layer, loaded.documents, loaded.capabilities);
    corrected = parseWfsAttributeSchema(loaded.documents, resolved, loaded.issues);
    old = parseWfsAttributeSchema([doc('shops-gml32'), ...loaded.documents.slice(1)], resolved, loaded.issues);
  });

  function fields(metadata: NativeAttributeMetadata | undefined = native(), values: Record<string, unknown> = data, parsed = corrected) {
    return attributeFormFields(parsed, values, resolveNativeAttributeMetadata(parsed, metadata, identity), false, text);
  }

  it('verifies the local declaration without identifying it as inherited gml:name or mutating native objects', () => {
    const metadata = native();
    Object.freeze(metadata.attributes![0]);
    Object.freeze(metadata.attributes);
    Object.freeze(metadata.originaData!['name']);
    Object.freeze(metadata.originaData);
    Object.freeze(metadata);
    const before = JSON.stringify(metadata);
    const adapted = resolveNativeAttributeMetadata(corrected, metadata, identity)!;
    expect(adapted).not.toBe(metadata);
    expect(adapted.attributes![0]).not.toBe(metadata.attributes![0]);
    expect(adapted.attributes![0]).toMatchObject({ name: 'name', resolvedNamespace: 'http://menorca' });
    const result = attributeFormFields(corrected, data, adapted, false, text);
    expect(result.find((field) => field.name === 'menorca:name')).toMatchObject({
      value: 'Comerç rural 60', present: true, editable: true, reasons: [],
      schema: { namespace: 'http://menorca', inherited: false }
    });
    expect(result.some((field) => field.name.startsWith('gml:'))).toBe(false);
    expect(JSON.stringify(metadata)).toBe(before);
    expect(data).toEqual({ 'menorca:name': 'Comerç rural 60' });
  });

  it.each([{ name: 'shops' }, { name: ['shops'] }, { name: 'menorca:shops' }, { name: ['menorca:shops'] }])
    ('accepts the matching native feature identity %j', ({ name }) => {
      expect(fields({ ...native(), name }).find((field) => field.name === 'menorca:name')!.editable).toBe(true);
    });

  it('still requires metadata and respects the caller schema-incomplete gate', () => {
    expect(resolveNativeAttributeMetadata(corrected, undefined, identity)).toBeUndefined();
    expect(attributeFormFields(corrected, data, undefined, false, text)
      .find((field) => field.name === 'menorca:name')!.reasons).toContain('featureAttribute.unverified');
    expect(attributeFormFields(corrected, data, resolveNativeAttributeMetadata(corrected, native(), identity), true, text)
      .find((field) => field.name === 'menorca:name')!.reasons).toContain('featureAttribute.schemaIncomplete');
  });

  it.each([
    ['missing origin', { origin: undefined }],
    ['non-WFS origin', { origin: 'KML' }],
    ['missing feature type', { name: undefined }],
    ['another feature type', { name: 'menorca:other' }],
    ['another namespace', { name: 'gml:shops' }],
    ['unknown feature prefix', { name: 'unknown:shops' }],
    ['multiple feature types', { name: ['shops', 'other'] }],
    ['missing original description', { originaData: undefined }],
    ['missing declaration', { originaData: {} }],
    ['untrusted namespace marker', { origin: undefined,
      attributes: [{ name: 'name', originalType: 'string', resolvedNamespace: 'http://menorca' }] }],
    ['unverified metadata prefix', { attributes: [{ name: 'unknown:name', originalType: 'string' }] }]
  ])('keeps the local field read-only with %s', (_label, change) => {
    expect(fields({ ...native(), ...change }).find((field) => field.name === 'menorca:name')!.editable).toBe(false);
  });

  it.each([
    { '@name': 'gml:name' }, { '@name': 'unknown:name' }, { '@name': undefined },
    { '@type': 'unknown:string' }, { '@type': 'xsd:boolean' }, { type: 'boolean' },
    { '@form': 'unqualified' }, { '@ref': 'gml:name' },
    { '@minOccurs': 0 }, { '@maxOccurs': 'unbounded' }, { '@nillable': true }
  ])('does not accept a contradictory original declaration: %j', (change) => {
    const metadata = native();
    metadata.originaData!['name'] = { ...(metadata.originaData!['name'] as object), ...change };
    expect(fields(metadata).find((field) => field.name === 'menorca:name')!.editable).toBe(false);
  });

  it('retains structural ambiguity checks but allows an existing attribute missing from the old XSD', () => {
    expect(fields(native(), data, old).find((field) => field.name === 'menorca:name')!.editable).toBe(true);
    for (const parsed of [{ ...corrected, issues: ['unresolved dependency'] },
      { ...corrected, fields: corrected.fields.map((field) => ({ ...field, inherited: true })) },
      { ...corrected, fields: [...corrected.fields, corrected.fields.find((field) => field.namespace === 'http://menorca' && field.name === 'name')!] }]) {
      expect(fields(native(), data, parsed).find((field) => field.name === 'menorca:name')!.editable).toBe(false);
    }
    expect(resolveNativeAttributeMetadata(corrected, native(), { ...identity, localName: 'other' })!
      .attributes![0].resolvedNamespace).toBeUndefined();
  });

  it('rejects contradictory geometry or unknown-prefix metadata even alongside a coherent local entry', () => {
    for (const geometryName of ['name', 'menorca:name', 'unknown:name']) {
      const metadata = native();
      metadata.geometries!.push({ name: geometryName });
      expect(fields(metadata).find((field) => field.name === 'menorca:name')?.editable).not.toBe(true);
    }
    const metadata = native();
    metadata.attributes!.push({ name: 'unknown:name', originalType: 'string' });
    expect(fields(metadata).find((field) => field.name === 'menorca:name')!.editable).toBe(false);
  });

  it('does not expand support to absent or unqualified ambiguous data, or pick one of simultaneous representations', () => {
    for (const values of [{}, { name: 'unqualified' }, { ...data, name: 'ambiguous' },
      { 'unknown:name': 'unknown' }, { 'gml:name': 'infrastructure' }]) {
      const result = fields(native(), values);
      expect(result.filter((field) => field.schema?.name === 'name').every((field) => !field.editable)).toBe(true);
      expect(new Set(result.map((field) => field.name)).size).toBe(result.length);
    }
    expect(fields(native(), { ...data, name: 'ambiguous' }).find((field) => field.name === 'menorca:name')!
      .reasons).toContain('featureAttribute.ambiguousField');
  });

  it('preserves aliases, distinct explicit GML metadata, identifier/geometry flags and duplicate protection', () => {
    const parsed = { ...corrected, namespaces: { ...corrected.namespaces, alias: 'http://menorca' } };
    const metadata = native();
    metadata.attributes!.push({ name: 'gml:name', originalType: 'string' });
    expect(fields(metadata, { 'alias:name': 'value', 'gml:name': 'native GML' }, parsed)
      .find((field) => field.name === 'alias:name')).toMatchObject({ editable: true, value: 'value' });
    const identifier = native();
    identifier.attributes![0].isId = true;
    expect(fields(identifier).find((field) => field.name === 'menorca:name')!.editable).toBe(true);
    const geometry = native();
    geometry.attributes![0].isGeometry = true;
    expect(fields(geometry).some((field) => field.name === 'menorca:name')).toBe(false);
    metadata.attributes!.push({ name: 'menorca:name', originalType: 'string' });
    expect(fields(metadata).find((field) => field.name === 'menorca:name')!.reasons).toContain('featureAttribute.ambiguousField');
    expect(fields(native(), { 'menorca:name': {} })
      .find((field) => field.name === 'menorca:name')).toMatchObject({ editable: true, schema: { type: 'complex' } });
  });
});
describe('schema/native attribute field mapping', () => {
  it('maps equivalent prefixes by URI, preserves the actual key and never modifies the feature data', () => {
    const data = Object.freeze({ 'alias:category': 'food' });
    const fields = attributeFormFields(schema(), data, { attributes: [{ name: 'category' }] }, false, text);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: 'alias:category', value: 'food', editable: true, present: true });
    expect(data).toEqual({ 'alias:category': 'food' });
  });

  it('supports unique JSON local keys without confusing two namespaces with the same local name', () => {
    expect(attributeFormFields(schema(), { category: 'food' }, { attributes: [{ name: 'category' }] }, false, text)[0].editable).toBe(true);
    const collision = schema([definition(), definition('category', { namespace: 'urn:other' })]);
    const fields = attributeFormFields(collision, { 'app:category': 'one', 'other:category': 'two', category: 'unknown' },
      { attributes: [{ name: 'app:category' }, { name: 'other:category' }] }, false, text);
    expect(fields.filter((field) => field.editable).map((field) => field.name)).toEqual(['app:category', 'other:category']);
    expect(fields.find((field) => field.name === 'category')).toMatchObject({ schema: null, editable: false });
  });

  it('does not pick one of multiple representations or use an unknown prefix', () => {
    const fields = attributeFormFields(schema(), { category: 'one', 'app:category': 'two', 'unknown:category': 'three' },
      { attributes: [{ name: 'category' }] }, false, text);
    expect(fields).toHaveLength(3);
    expect(new Set(fields.map((field) => field.name)).size).toBe(fields.length);
    expect(fields.every((field) => !field.editable)).toBe(true);
    expect(fields[0].reasons).toContain('featureAttribute.ambiguousField');
  });

  it('keeps valid lexemes unchanged and allows correcting invalid existing values', () => {
    const typed = schema([definition('count', { type: 'int' }), definition('active', { type: 'boolean' })]);
    const native = { attributes: [{ name: 'count' }, { name: 'active' }] };
    const fields = attributeFormFields(typed, { 'app:count': '007', 'app:active': '1' }, native, false, text);
    expect(fields.map((field) => field.editable)).toEqual([true, true]);
    expect(fields.map((field) => field.value)).toEqual(['007', '1']);
    const invalid = attributeFormFields(typed, { count: '2147483648', active: {} }, native, false, text);
    expect(invalid.every((field) => field.editable)).toBe(true);
  });

  it('retains schema safety checks, omits external geometry and does not impose identifier permissions', () => {
    const fields = attributeFormFields(schema([definition('id'), definition('geom')]), { id: '1', extra: 'x' },
      { attributes: [{ name: 'id', isId: true }], geometries: [{ name: 'geom' }] }, true, text);
    expect(fields.some((field) => field.schema?.name === 'geom')).toBe(false);
    expect(fields[0].reasons).toContain('featureAttribute.schemaIncomplete');
    expect(fields.find((field) => field.name === 'extra')?.reasons).toEqual(['featureAttribute.unknownField']);
    expect(fields.every((field) => !field.editable)).toBe(true);
    expect(attributeFormFields(schema([definition('id')]), { id: '1' },
      { attributes: [{ name: 'id', isId: true }] }, false, text)[0].editable).toBe(true);
  });

  it('hides declared and undeclared GML fields, including aliases, without deleting any native data', () => {
    const parsed = schema([definition('name'), definition('name', { namespace: 'http://www.opengis.net/gml/3.2', inherited: true })]);
    parsed.namespaces!['infra'] = 'http://www.opengis.net/gml/3.2';
    const data = Object.freeze({ 'app:name': 'local', 'gml:boundedBy': [1, 2, 3, 4], 'infra:name': 'GML', 'gml:unknown': 'hidden' });
    const fields = attributeFormFields(parsed, data, { attributes: [{ name: 'app:name' }] }, false, text);
    expect(fields.map((field) => field.name)).toEqual(['app:name']);
    expect(data['infra:name']).toBe('GML');
    expect(data['gml:boundedBy']).toEqual([1, 2, 3, 4]);
  });

  it.each(['date', 'decimal', 'long', 'list', 'complex', 'union', null])('does not block the %s type', (type) => {
    const fields = attributeFormFields(schema([definition('value', { type })]), {},
      { attributes: [{ name: 'value' }] }, false, text);
    expect(fields[0].editable).toBe(true);
  });

  it('prepares defaults only for provisional features, never inventing a second property name', () => {
    const typed = schema([definition('count', { type: 'int', defaultValue: '2' })]);
    const native = { attributes: [{ name: 'app:count' }] };
    const ordinary = attributeFormFields(typed, {}, native, false, text);
    expect(ordinary[0]).toMatchObject({ name: 'app:count', present: false, initialInput: undefined });
    expect(attributeFormFields(typed, {}, native, false, text, true)[0].initialInput).toEqual({ presence: 'value', text: '2' });
  });

  it('recognizes only the auxiliary bounds key excluded by the existing transaction patch', () => {
    expect(isAuxiliaryGmlBounds(schema(), 'gml:boundedBy', [1, 2, 3, 4])).toBe(true);
    for (const key of ['app:boundedBy', 'boundedBy', 'gml:location']) {
      expect(isAuxiliaryGmlBounds(schema(), key, [1, 2, 3, 4])).toBe(false);
    }
    expect(isAuxiliaryGmlBounds(schema(), 'gml:boundedBy', [1, 2, NaN, 4])).toBe(false);
    expect(isAuxiliaryGmlBounds({ ...schema(), namespaces: { gml: 'urn:other' } }, 'gml:boundedBy', [1, 2, 3, 4])).toBe(false);
  });
});
