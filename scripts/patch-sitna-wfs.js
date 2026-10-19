const fs = require('fs');
const path = require('path');

function patchFile(file, replacements) {
  const filePath = path.join(__dirname, '../node_modules/api-sitna', file);
  const original = fs.readFileSync(filePath, 'utf8');
  let source = original.replace(/\r\n/g, '\n');
  for (const { before, after } of replacements) {
    if (source.includes(after)) continue;
    if (!source.includes(before)) {
      throw new Error(`SITNA ${file} changed; review the WFS fix.`);
    }
    source = source.split(before).join(after);
  }
  const updated = original.includes('\r\n') ? source.replace(/\n/g, '\r\n') : source;
  if (updated !== original) fs.writeFileSync(filePath, updated, 'utf8');
}

patchFile('TC/control/WFSEdit.js', [
  {
    before: `    return layer.getPath ? layer.getPath().join(' • ') : layer.title || layer.id;`,
    after: `    const layerPath = layer.getPath ? layer.getPath().join(' • ') : '';
    return layerPath || layer.title || layer.id;`
  }
]);

// GeoServer advertises internal schema URLs; known GML schemas are already bundled.
patchFile('TC/tool/FeatureTypeParser.js', [
  {
    before: `        if (xsdDictionary.has(url)) {`,
    after: String.raw`        const gmlPath = new URL(url).pathname.match(/\/schemas\/(gml\/.+)$/)?.[1];
        const schema = xsdDictionary.get(url) ?? (gmlPath && xsdDictionary.get('http://schemas.opengis.net/' + gmlPath));
        if (schema) {`
  },
  {
    before: `                xml: xsdDictionary.get(url)`,
    after: `                xml: schema`
  }
]);

// Selection can change while the attribute editor waits for schema metadata.
patchFile('TC/control/AttributesEdit.js', [
  {
    before: `            if (layer) {
                layerAttributeMetadata = [];`,
    after: `            if (layer) {
                const feature = this.#feature;
                layerAttributeMetadata = [];`
  },
  {
    before: `                const featuresToCheck = layer.features;`,
    after: `                if (this.#feature !== feature) return;
                const featuresToCheck = layer.features;`
  }
]);

// Serialize copies with schema geometry names, qualified types and no GML bounds attribute.
patchFile('TC/ol/ol.js', [
  {
    before: `self.getLayer().then(function () {
                var format = new ol.format.WFS();
                var options = self.parent.options;
                var transaction = format.writeTransaction(olInserts, olUpdates, olDeletes, {
                    featurePrefix: options.featurePrefix,
                    featureNS: options.featureNS,
                    featureType: options.featureType[0]
                });`,
    after: `self.getLayer().then(async function () {
                var format = new ol.format.WFS();
                let geometryName;
                if (olInserts.length) {
                    try {
                        const metadata = await self.parent.getFeatureTypeMetadata();
                        geometryName = metadata?.geometries?.[0]?.name;
                        if (!geometryName) throw new Error('WFS geometry is missing from DescribeFeatureType');
                    } catch (error) {
                        reject({ code: '', reason: error.message });
                        return;
                    }
                }
                const withoutGmlBounds = function (feature) {
                    const copy = feature.clone();
                    copy.setId(feature.getId());
                    copy.unset('gml:boundedBy', true);
                    return copy;
                };
                const transactionInserts = olInserts.map(function (feature) {
                    const copy = withoutGmlBounds(feature);
                    const geometry = copy.getGeometry();
                    const oldName = copy.getGeometryName();
                    copy.setGeometryName(geometryName);
                    if (oldName !== geometryName) copy.unset(oldName, true);
                    copy.setGeometry(geometry);
                    return copy;
                });
                var options = self.parent.options;
                var configuredFeatureType = Array.isArray(options.featureType) ? options.featureType[0] : options.featureType;
                var namespaceSeparator = configuredFeatureType.indexOf(':');
                var featurePrefix = options.featurePrefix || (namespaceSeparator < 0 ? undefined : configuredFeatureType.substring(0, namespaceSeparator));
                var featureNS = options.featureNS || (featurePrefix && self.parent.capabilities && self.parent.capabilities['xmlns:' + featurePrefix]);
                var transaction = format.writeTransaction(transactionInserts, olUpdates.map(withoutGmlBounds), olDeletes, {
                    featurePrefix: featurePrefix,
                    featureNS: featureNS,
                    featureType: namespaceSeparator < 0 && featurePrefix ? featurePrefix + ':' + configuredFeatureType : configuredFeatureType
                });`
  }
]);
