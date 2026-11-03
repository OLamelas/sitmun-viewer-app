import Feature from 'ol/Feature';
import WFS from 'ol/format/WFS';
import Point from 'ol/geom/Point';
import { assertWfsAttributeValue, serializeWfsAttributeTransaction } from './wfs-attribute-transaction';
import { WfsAttributeField, WfsAttributeSchema } from './wfs-attribute-schema';

const field = (name: string, type: string, extra: Partial<WfsAttributeField> = {}): WfsAttributeField => ({
  name, type, namespace: 'urn:app', minOccurs: '0', maxOccurs: '1', nillable: true,
  defaultValue: null, fixedValue: null, facets: [], reasons: [], ...extra
});
const schema: WfsAttributeSchema = { featureType: '{urn:app}items', issues: [], namespaces: { app: 'urn:app', nested: 'urn:nested' },
  fields: [field('details', 'complex'), field('numbers', 'list', { itemType: 'integer' }),
    field('tags', 'string', { maxOccurs: 'unbounded' })] };

describe('structured WFS attribute serialization', () => {
  function transaction(properties: Record<string, unknown>, inserting: boolean, definition = schema) {
    const feature = new Feature(new Point([1, 2]));
    feature.setId('items.1');
    feature.setProperties(properties);
    const node = new WFS().writeTransaction(inserting ? [feature] : [], inserting ? [] : [feature], [], {
      featurePrefix: 'app', featureNS: 'urn:app', featureType: 'items', nativeElements: []
    });
    if (!(node instanceof Element)) throw new Error('Expected a WFS transaction element');
    const before = JSON.stringify(properties);
    serializeWfsAttributeTransaction(node, inserting ? [feature] : [], inserting ? [] : [feature], definition);
    expect(JSON.stringify(properties)).toBe(before);
    expect(feature.getGeometry()?.getCoordinates()).toEqual([1, 2]);
    expect(feature.getId()).toBe('items.1');
    return node;
  }

  it.each([true, false])('preserves nested objects, repeated children, null, false and zero (insert=%s)', (inserting) => {
    const node = transaction({ details: { '@code': 0, 'nested:name': '<b>text & more</b>',
      count: 0, enabled: false, empty: null, children: ['one', 'two'] } }, inserting);
    const detail = inserting ? node.getElementsByTagNameNS('urn:app', 'details')[0]
      : Array.from(node.getElementsByTagNameNS('http://www.opengis.net/wfs', 'Property'))
        .find((item) => item.children[0].textContent === 'details')!.children[1];
    expect(detail.getAttribute('code')).toBe('0');
    expect(detail.getElementsByTagNameNS('urn:nested', 'name')[0].textContent).toBe('<b>text & more</b>');
    expect(detail.getElementsByTagNameNS('urn:app', 'count')[0].textContent).toBe('0');
    expect(detail.getElementsByTagNameNS('urn:app', 'enabled')[0].textContent).toBe('false');
    expect(detail.getElementsByTagNameNS('urn:app', 'empty')[0].getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil')).toBe('true');
    expect(detail.getElementsByTagNameNS('urn:app', 'children')).toHaveLength(2);
    expect(node.outerHTML).not.toContain('[object Object]');
    expect(new DOMParser().parseFromString(node.outerHTML, 'text/xml').getElementsByTagName('parsererror')).toHaveLength(0);
  });

  it.each([true, false])('distinguishes an XSD list from repeated XML elements (insert=%s)', (inserting) => {
    const node = transaction({ numbers: ['9007199254740993', '2'], tags: ['a', 'b'] }, inserting);
    if (inserting) {
      expect(node.getElementsByTagNameNS('urn:app', 'numbers')[0].textContent).toBe('9007199254740993 2');
      expect(Array.from(node.getElementsByTagNameNS('urn:app', 'tags')).map((tag) => tag.textContent)).toEqual(['a', 'b']);
    } else {
      const properties = Array.from(node.getElementsByTagNameNS('http://www.opengis.net/wfs', 'Property'));
      const property = (name: string) => properties.find((item) => item.children[0].textContent === name)!;
      expect(property('numbers').children[1].textContent).toBe('9007199254740993 2');
      expect(property('tags').getElementsByTagNameNS('urn:app', 'tags')).toHaveLength(2);
    }
  });

  it('inserts explicit nulls in schema order, without inventing absent fields or changing empty/false/zero', () => {
    const nullable = { ...schema, fields: [field('first', 'string'), field('geometry', 'complex'),
      field('middle', 'string'), field('empty', 'string'), field('enabled', 'boolean'), field('count', 'int'),
      field('last', 'string'), field('absent', 'string')] };
    const node = transaction({ count: 0, last: null, empty: '', enabled: false, first: null, middle: null }, true, nullable);
    const inserted = node.getElementsByTagNameNS('urn:app', 'items')[0];
    expect(Array.from(inserted.children).map((child) => child.localName))
      .toEqual(['first', 'geometry', 'middle', 'empty', 'enabled', 'count', 'last']);
    for (const name of ['first', 'middle', 'last']) {
      expect(inserted.getElementsByTagNameNS('urn:app', name)[0]
        .getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil')).toBe('true');
    }
    expect(inserted.getElementsByTagNameNS('urn:app', 'empty')[0].textContent).toBe('');
    expect(inserted.getElementsByTagNameNS('urn:app', 'enabled')[0].textContent).toBe('false');
    expect(inserted.getElementsByTagNameNS('urn:app', 'count')[0].textContent).toBe('0');
    expect(inserted.getElementsByTagNameNS('urn:app', 'absent')).toHaveLength(0);
    expect(inserted.getElementsByTagNameNS('http://www.opengis.net/gml', 'Point')).toHaveLength(1);
  });

  it('replaces native nodes for unqualified structured fields and preserves the geometry element intact', () => {
    const unqualified = { ...schema, fields: [field('details', 'complex', { namespace: '' }),
      field('geometry', 'complex'), field('tags', 'string', { namespace: '', maxOccurs: 'unbounded' }),
      field('nullable', 'string', { namespace: '' })] };
    const feature = new Feature(new Point([1, 2]));
    feature.setId('items.1');
    feature.setProperties({ nullable: null, tags: ['a', 'b'], details: { label: 'text' } });
    const node = new WFS().writeTransaction([feature], [], [], {
      featurePrefix: 'app', featureNS: 'urn:app', featureType: 'items', nativeElements: []
    }) as Element;
    const inserted = node.getElementsByTagNameNS('urn:app', 'items')[0];
    const geometry = inserted.getElementsByTagNameNS('urn:app', 'geometry')[0];
    const geometryXml = geometry.outerHTML;
    serializeWfsAttributeTransaction(node, [feature], [], unqualified);
    expect(inserted.getElementsByTagNameNS('urn:app', 'details')).toHaveLength(0);
    expect(inserted.getElementsByTagNameNS('urn:app', 'tags')).toHaveLength(0);
    expect(inserted.getElementsByTagNameNS('', 'details')).toHaveLength(1);
    expect(inserted.getElementsByTagNameNS('', 'label')[0].textContent).toBe('text');
    expect(Array.from(inserted.children).map((child) => child.localName))
      .toEqual(['details', 'geometry', 'tags', 'tags', 'nullable']);
    expect(inserted.getElementsByTagNameNS('urn:app', 'geometry')[0]).toBe(geometry);
    expect(geometry.outerHTML).toBe(geometryXml);
    const reparsed = new DOMParser().parseFromString(node.outerHTML, 'text/xml');
    expect(reparsed.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(reparsed.getElementsByTagNameNS('', 'nullable')[0]
      .getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil')).toBe('true');
  });

  it('keeps equally named properties in distinct namespaces instead of removing an alias sibling', () => {
    const qualified = { ...schema, fields: [field('details', 'complex'),
      field('details', 'complex', { namespace: 'urn:nested' })] };
    const feature = new Feature(new Point([1, 2]));
    feature.setId('items.1');
    feature.setProperties({ 'nested:details': { label: 'other' }, 'app:details': { label: 'local' } });
    const node = new DOMParser().parseFromString(`<wfs:Transaction xmlns:wfs="http://www.opengis.net/wfs"
      xmlns:app="urn:app" xmlns:nested="urn:nested"><wfs:Insert><app:items>
      <nested:details/><app:details/></app:items></wfs:Insert></wfs:Transaction>`, 'application/xml').documentElement;
    serializeWfsAttributeTransaction(node, [feature], [], qualified);
    expect(node.getElementsByTagNameNS('urn:app', 'details')).toHaveLength(1);
    expect(node.getElementsByTagNameNS('urn:nested', 'details')).toHaveLength(1);
    expect(node.getElementsByTagNameNS('urn:app', 'details')[0].textContent).toBe('local');
    expect(node.getElementsByTagNameNS('urn:nested', 'details')[0].textContent).toBe('other');
  });

  it('preserves native Update null semantics and keeps the external fid separate from the data id', () => {
    const node = transaction({ id: 'new-data-id', details: null }, false);
    const properties = Array.from(node.getElementsByTagNameNS('http://www.opengis.net/wfs', 'Property'));
    expect(properties.find((property) => property.children[0].textContent === 'id')?.children[1].textContent).toBe('new-data-id');
    expect(properties.find((property) => property.children[0].textContent === 'details')?.children).toHaveLength(1);
    expect(node.getElementsByTagNameNS('http://www.opengis.net/ogc', 'FeatureId')[0].getAttribute('fid')).toBe('items.1');
  });

  it('rejects unsafe XML names, unknown namespaces and non-scalar XML attributes before history', () => {
    for (const value of [{ 'bad key': 'x' }, { 'unknown:child': 'x' }, { '@code': [] }, { '#text': {} }, { values: [[1], [2]] }, { value: '\u0000' }]) {
      expect(() => assertWfsAttributeValue(value, schema)).toThrow();
    }
    expect(() => assertWfsAttributeValue({ '@code': false, '#text': '' }, schema)).not.toThrow();
  });
});
