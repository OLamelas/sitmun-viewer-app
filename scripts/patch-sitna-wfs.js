const fs = require('fs');
const path = require('path');

function patchFile(file, replacements) {
  const filePath = path.join(__dirname, '../node_modules/api-sitna', file);
  const original = fs.readFileSync(filePath, 'utf8');
  let source = original.replace(/\r\n/g, '\n');
  for (const { before, after, done } of replacements) {
    if (done && source.includes(done)) continue;
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
  },
  {
    done: 'sitmunAttributeRegistrationVersion = 1;',
    before: `                    else {
                        storedFeature = layerEditData.modifiedFeaturesLayer.getFeatureById(fid);
                        if (storedFeature) {`,
    after: `                    else {
                        storedFeature = layerEditData.modifiedFeaturesLayer.getFeatureById(fid);
                        const originalFeature = layerEditData.beforeEditLayer?.getFeatureById(fid);
                        if (storedFeature && originalFeature &&
                            JSON.stringify(feat.geometry) === JSON.stringify(originalFeature.geometry) &&
                            JSON.stringify(feat.getData()) === JSON.stringify(originalFeature.getData())) {
                            layerEditData.modifiedFeaturesLayer.removeFeature(storedFeature);
                            deleteFeature(self.#getModifiedStoragePrefix() + fid).then(storeSuccess, storeFailure);
                            return;
                        }
                        if (storedFeature) {`
  }
]);

// Attribute-only edits need an acknowledgement of the existing session write,
// not merely a synchronous FEATUREMODIFY notification. Keep the native listener.
patchFile('TC/control/WFSEdit.js', [
  {
    before: `                const feat = e.feature;
                const fid = feat.provId || feat.id;`,
    after: `                const feat = e.feature;
                const fid = feat.provId || feat.id;
                const auxiliaryWrites = [];
                const acknowledge = function (operation) {
                    const registration = operation.then(storeSuccess, function (error) {
                        storeFailure();
                        throw error;
                    });
                    e.sitmunRegister?.(registration);
                    registration.catch(function () {});
                };`
  },
  {
    before: `                        storedFeature.setData(feat.getData());
                        storeFeature(self.#getAddedStoragePrefix() + fid, feat).then(storeSuccess, storeFailure);`,
    after: `                        for (const key of Object.keys(storedFeature.getData())) {
                            if (!Object.hasOwn(feat.getData(), key)) storedFeature.unsetData(key);
                        }
                        storedFeature.setData(feat.getData());
                        acknowledge(storeFeature(self.#getAddedStoragePrefix() + fid, feat));`
  },
  {
    before: `                            deleteFeature(self.#getModifiedStoragePrefix() + fid).then(storeSuccess, storeFailure);`,
    after: `                            acknowledge(deleteFeature(self.#getModifiedStoragePrefix() + fid));`
  },
  {
    before: `                        if (storedFeature) {
                            storedFeature.setCoords(feat.geometry);
                            storedFeature.setData(feat.getData());
                        }
                        else {
                            layerEditData.modifiedFeaturesLayer.addFeature(self.#createAuxFeature(feat));
                        }
                        storeFeature(self.#getModifiedStoragePrefix() + fid, feat).then(storeSuccess, storeFailure);`,
    after: `                        if (storedFeature) {
                            storedFeature.setCoords(feat.geometry);
                            for (const key of Object.keys(storedFeature.getData())) {
                                if (!Object.hasOwn(feat.getData(), key)) storedFeature.unsetData(key);
                            }
                            storedFeature.setData(feat.getData());
                        }
                        else {
                            auxiliaryWrites.push(layerEditData.modifiedFeaturesLayer.addFeature(self.#createAuxFeature(feat)));
                        }
                        acknowledge(Promise.all([...auxiliaryWrites, storeFeature(self.#getModifiedStoragePrefix() + fid, feat)]));`
  },
  {
    before: `    #discardBtn;`,
    after: `    #discardBtn;
    sitmunAttributeRegistrationVersion = 1;`
  },
  {
    before: `        self.#saveBtn.addEventListener(Consts.event.CLICK, function () {
            TC.confirm`,
    after: `        self.#saveBtn.addEventListener(Consts.event.CLICK, function () {
            if (self.sitmunCanSaveAttributes?.() === false) return;
            TC.confirm`
  },
  {
    before: `    async applyEdits() {
        const self = this;`,
    after: `    async applyEdits() {
        const self = this;
        if (self.sitmunCanSaveAttributes?.() === false) return;`
  },
  {
    before: `        self.#discardBtn.addEventListener(Consts.event.CLICK, function () {
            TC.confirm`,
    after: `        self.#discardBtn.addEventListener(Consts.event.CLICK, function () {
            if (self.sitmunDiscardAttributes?.() === true) return;
            TC.confirm`
  }
]);

// Report real transaction completion, not the early return of WFSEdit.applyEdits.
patchFile('TC/control/WFSEdit.js', [
  {
    before: `                                if (key !== 'id') {`,
    after: `                                if (key !== 'id' || self.editControl.layer?.sitmunHasDataId === true) {`
  },
  {
    before: `                self.isSyncing = true;
                self.#setSyncState();`,
    after: `                self.isSyncing = true;
                self.sitmunAttributeSyncState?.('saving');
                self.#setSyncState();`
  },
  {
    before: `                    const modified = layerEditData.modifiedFeaturesLayer.features.map(function (feature) {`,
    after: `                    let serverAccepted = false;
                    try {
                    const modified = layerEditData.modifiedFeaturesLayer.features.map(function (feature) {`
  },
  {
    before: `                    const editableLayer = await self.getEditableLayer(self.layer);
                    try {
                        await editableLayer.applyEdits(layerEditData.addedFeaturesLayer.features, modified, layerEditData.removedFeaturesLayer.features);`,
    after: `                    const editableLayer = await self.getEditableLayer(self.layer);
                        await editableLayer.applyEdits(layerEditData.addedFeaturesLayer.features, modified, layerEditData.removedFeaturesLayer.features);
                        serverAccepted = true;`
  },
  {
    before: `                            self.isSyncing = false;
                            // Las acciones a realizar a partir de este punto son las mismas que al descartar una edición`,
    after: `                            self.isSyncing = false;
                            self.sitmunAttributeSyncState?.('success');
                            // Las acciones a realizar a partir de este punto son las mismas que al descartar una edición`
  },
  {
    before: `                    catch (obj) {
                        self.isSyncing = false;
                        self.#setSyncState();`,
    after: `                    catch (obj) {
                        self.isSyncing = false;
                        self.sitmunAttributeSyncState?.(serverAccepted ? 'reconcileError' : 'error');
                        self.#setSyncState();`
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
  },
  {
    before: `    #feature;`,
    after: `    #feature;
    #sitmunRenderRevision = 0;
    sitmunAttributeIsolationVersion = 1;
    sitmunAttributesSuspended = false;`
  },
  {
    before: `    async render(callback) {
        const renderObject = {};`,
    after: `    async render(callback) {
        if (this.sitmunAttributesSuspended) return;
        const sitmunRenderRevision = this.#sitmunRenderRevision;
        const renderObject = {};`
  },
  {
    before: `                const featuresToCheck = layer.features;`,
    after: `                const featuresToCheck = layer.features;
                if (this.sitmunAttributesSuspended ||
                    this.#sitmunRenderRevision !== sitmunRenderRevision) return;`
  },
  {
    before: `    set feature(value) {
        if (this.#feature !== value) {`,
    after: `    set feature(value) {
        if (this.sitmunAttributesSuspended && value) return;
        this.#sitmunRenderRevision++;
        if (this.#feature !== value) {`
  },
  {
    before: `    set clientControl(value) {
        // Quitamos los listener del control previo`,
    after: `    set clientControl(value) {
        this.#sitmunRenderRevision++;
        // Quitamos los listener del control previo`
  },
  {
    before: `            const onDrawEnd = (e) => {
                setTimeout(() => {
                    this.feature = e.detail?.feature;`,
    after: `            const onDrawEnd = (e) => {
                const sitmunRenderRevision = this.#sitmunRenderRevision;
                setTimeout(() => {
                    if (signal.aborted || this.sitmunAttributesSuspended ||
                        this.#sitmunRenderRevision !== sitmunRenderRevision) return;
                    this.feature = e.detail?.feature;`
  }
]);

// Forward geometry edits from Modify to WFSEdit without duplicating elevation updates.
patchFile('TC/control/Edit.js', [
  {
    before: `        self.history = self.modifyControl.history;`,
    after: `        self.history = self.modifyControl.history;
        self.history.addEventListener('undo', function (e) {
            if (e.action.type === 'geometryChange') {
                self.trigger(Consts.event.FEATUREMODIFY, {
                    feature: e.feature,
                    layer: e.feature.layer,
                    geometryChanged: true,
                    oldData: e.action.newData,
                    newData: e.action.oldData,
                    historyAction: 'undo'
                });
            }
        });
        self.history.addEventListener('redo', function (e) {
            if (e.action.type === 'geometryChange') {
                self.trigger(Consts.event.FEATUREMODIFY, {
                    feature: e.feature,
                    layer: e.feature.layer,
                    geometryChanged: true,
                    oldData: e.action.oldData,
                    newData: e.action.newData,
                    historyAction: 'redo'
                });
            }
        });`
  },
  {
    before: `                let changed = false;
                let elevationTool;`,
    after: `                let changed = false;
                let elevationTool;
                let emittedChange = false;`
  },
  {
    before: `                        self.setFeatureCoordinates(feature, geometry);
                    }
                }
            }
        };`,
    after: `                        self.setFeatureCoordinates(feature, geometry);
                        emittedChange = true;
                    }
                }
                return emittedChange;
            }
            return false;
        };`
  },
  {
    before: `                await addElevation(e.feature);
            })`,
    after: `                const elevationChangeEmitted = await addElevation(e.feature);
                if (!elevationChangeEmitted) {
                    self.trigger(Consts.event.FEATUREMODIFY, { ...e });
                }
            })`
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

// Keep structured attribute serialization in the viewer adapter, not in a second
// transaction engine. The hook sees copies and runs before the existing POST.
patchFile('TC/ol/ol.js', [
  {
    before: `TC.wrap.layer.Vector.prototype.sendTransaction = function (inserts, updates, deletes) {`,
    after: `TC.wrap.layer.Vector.prototype.sitmunAttributeTransactionVersion = 1;
TC.wrap.layer.Vector.prototype.sendTransaction = function (inserts, updates, deletes) {`
  },
  {
    before: `                var ajaxOptions = {
                    url: self.parent.url,`,
    after: `                try {
                    self.parent.sitmunSerializeAttributeTransaction?.(transaction, transactionInserts, olUpdates);
                } catch (error) {
                    reject({ code: '', reason: error.message });
                    return;
                }
                var ajaxOptions = {
                    url: self.parent.url,`
  }
]);
