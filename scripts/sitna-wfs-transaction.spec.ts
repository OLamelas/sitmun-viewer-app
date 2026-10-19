import { readFileSync } from 'fs';
import { join } from 'path';
import Feature from 'ol/Feature';
import WFS from 'ol/format/WFS';
import Point from 'ol/geom/Point';

function transactionWriter(ajax: jest.Mock): (...args: unknown[]) => Promise<unknown> {
  const source = readFileSync(join(__dirname, '../node_modules/api-sitna/TC/ol/ol.js'), 'utf8');
  const start = source.indexOf('TC.wrap.layer.Vector.prototype.sendTransaction = ') + 'TC.wrap.layer.Vector.prototype.sendTransaction = '.length;
  const end = source.indexOf('\nTC.wrap.layer.Vector.prototype.setDraggable', start);
  return new Function('ol', 'TC', 'Consts', 'return ' + source.slice(start, end))(
    { format: { WFS } }, { ajax }, { mimeType: { XML: 'text/xml' } }
  );
}

describe('SITNA WFS transactions', () => {
  it.each([
    { featureType: ['menorca:shops'] },
    { featureType: 'menorca:shops' },
    { featureType: ['shops'], featurePrefix: 'menorca' }
  ])('uses the schema geometry and qualified layer name: %j', async (options) => {
    const feature = new Feature(new Point([587581, 4419497]));
    feature.setId('shops.408');
    feature.set('gml:boundedBy', [587581, 4419497, 587581, 4419497]);
    feature.set('category', 'shop');
    const ajax = jest.fn().mockResolvedValue({ data: new DOMParser().parseFromString(
      '<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs" version="1.1.0"><wfs:TransactionSummary><wfs:totalInserted>1</wfs:totalInserted></wfs:TransactionSummary></wfs:TransactionResponse>', 'text/xml'
    ) });
    const wrapped = { wrap: { feature } };
    await transactionWriter(ajax).call({ getLayer: async () => {}, parent: {
      options,
      getFeatureTypeMetadata: async () => ({ geometries: [{ name: 'shape' }] }),
      capabilities: { 'xmlns:menorca': 'http://menorca' }
    } }, [wrapped], [wrapped], [wrapped]);
    const transaction = new DOMParser().parseFromString(ajax.mock.calls[0][0].data, 'text/xml').documentElement;

    const inserted = transaction.getElementsByTagNameNS('http://menorca', 'shops')[0];
    expect(inserted.tagName).toBe('menorca:shops');
    expect(inserted.getElementsByTagNameNS('http://menorca', 'shape')).toHaveLength(1);
    expect(inserted.getElementsByTagNameNS('http://menorca', 'geometry')).toHaveLength(0);
    expect(feature.getGeometryName()).toBe('geometry');
    expect(feature.getGeometry()).toBeInstanceOf(Point);
    expect(feature.get('gml:boundedBy')).toEqual([587581, 4419497, 587581, 4419497]);
    expect(inserted.getElementsByTagNameNS('http://menorca', 'category')[0].textContent).toBe('shop');
    expect(transaction.outerHTML).not.toContain('boundedBy');
    for (const operation of ['Update', 'Delete']) {
      const node = transaction.getElementsByTagNameNS('http://www.opengis.net/wfs', operation)[0];
      expect(node.getAttribute('typeName')).toBe('menorca:shops');
      expect(node.getAttribute('xmlns:menorca')).toBe('http://menorca');
      expect(node.getElementsByTagNameNS('http://www.opengis.net/ogc', 'FeatureId')[0].getAttribute('fid')).toBe('shops.408');
    }
  });

  it('rejects inserts without schema geometry instead of sending an invalid transaction', async () => {
    const ajax = jest.fn();
    const send = transactionWriter(ajax);
    const request = send.call({ getLayer: async () => {}, parent: {
      getFeatureTypeMetadata: async () => ({ geometries: [] })
    } }, [{ wrap: { feature: new Feature(new Point([0, 0])) } }], [], []);

    await expect(request).rejects.toMatchObject({ reason: 'WFS geometry is missing from DescribeFeatureType' });
    expect(ajax).not.toHaveBeenCalled();
  });
});
