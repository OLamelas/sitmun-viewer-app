import { bundledWfsSchema } from './bundled-wfs-schemas';

describe('bundled standard WFS schemas', () => {
  it('maps an internal GeoServer GML alias to the exact local standard document', async () => {
    const result = await bundledWfsSchema(new URL('http://geoserver.local:8080/geoserver/schemas/gml/3.2.1/gml.xsd'));
    expect(result?.url).toBe('http://schemas.opengis.net/gml/3.2.1/gml.xsd');
    expect(result?.xml).toContain('http://www.opengis.net/gml/3.2');
  });

  it.each([
    'https://other.test/types.xsd', 'https://schemas.opengis.net.attacker.test/gml/3.2.1/gml.xsd',
    'http://user:secret@geoserver.local/schemas/gml/3.2.1/gml.xsd',
    'http://geoserver.local/schemas/gml/3.2.1/gml.xsd?different=true',
    'http://geoserver.local/schemas/gml/unknown/gml.xsd', 'file:///schemas/gml/3.2.1/gml.xsd'
  ])('does not authorize an unknown or unsafe schema URL: %s', async (url) => {
    expect(await bundledWfsSchema(new URL(url))).toBeUndefined();
  });
});
