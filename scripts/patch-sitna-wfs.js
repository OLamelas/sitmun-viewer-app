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

// Permission hooks are intentionally independent of the optional attribute adapter.
// Every replacement is compatibility-checked and idempotent by patchFile.
patchFile('TC/control/WFSEdit.js', [
  {
    done: 'sitmunPermissionHooksVersion =',
    before: `    #discardBtn;`,
    after: `    #discardBtn;
    sitmunPermissionHooksVersion = 1;`
  },
  {
    before: `        self.editControl.importFeatures = function (features) {
            const featuresToImport`,
    after: `        self.editControl.importFeatures = function (features) {
            if (self.sitmunCanMutate?.() === false) return;
            const featuresToImport`
  },
  {
    before: `        self.editControl = await self.#editPromise;`,
    after: `        self.editControl = await self.#editPromise;
        await self.sitmunProtectEditControl?.(self.editControl);`
  },
  {
    before: `        self.#layerSelect.addEventListener('change', function (_e) {
            self.#setEditState(false);`,
    after: `        self.#layerSelect.addEventListener('change', function (_e) {
            if (self.sitmunChangeEditingLayer) {
                const target = this.value;
                this.value = self.layer?.id || '';
                void self.sitmunChangeEditingLayer(target);
                return;
            }
            self.#setEditState(false);`
  },
  {
    before: `                    actionFn: function () {
                        const checkbox = this;
                        const layer = map.getLayer(checkbox.dataset.layerId);`,
    after: `                    actionFn: function () {
                        const checkbox = this;
                        const layer = map.getLayer(checkbox.dataset.layerId);
                        if (self.sitmunChangeEditingLayer) {
                            checkbox.checked = self.layer === layer;
                            void self.sitmunChangeEditingLayer(layer);
                            return;
                        }`
  },
  {
    before: `                        checkbox.disabled = !layer || layer.isRaster() && layer.names.length !== 1;`,
    after: `                        checkbox.hidden = self.sitmunCanEditLayer?.(layer) === false;
                        checkbox.disabled = !layer || self.sitmunCanEditLayer?.(layer) === false || layer.isRaster() && layer.names.length !== 1;`
  },
  {
    before: `                            if (layer.type === Consts.layerType.WMS) {`,
    after: `                            checkbox.hidden = self.sitmunCanEditLayer?.(layer) === false;
                            if (layer.type === Consts.layerType.WMS && self.sitmunCanEditLayer?.(layer) !== false) {`
  },
  {
    before: `                if (wl.type === Consts.layerType.WFS && !wl.options.stealth) {`,
    after: `                if (wl.type === Consts.layerType.WFS && !wl.options.stealth && self.sitmunCanEditLayer?.(wl) !== false) {`
  },
  {
    done: 'if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }\n                                self.layer = mapLayer;',
    before: `                            const endProcess = function () {
                                self.layer = mapLayer;`,
    after: `                            const endProcess = function () {
                                if (self.sitmunLayerAttemptCurrent?.(mapLayer) === false) { resolve(null); return; }
                                self.layer = mapLayer;`
  },
  {
    done: 'if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }\n                                            selector.value = self.layer.id;',
    before: `                                        self.getEditControl().then(c => {
                                            selector.value = self.layer.id;`,
    after: `                                        self.getEditControl().then(c => {
                                            if (self.sitmunLayerAttemptCurrent?.(mapLayer) === false) { resolve(null); return; }
                                            selector.value = self.layer.id;`
  },
  {
    done: 'if (sitmunAttemptCurrent?.() === false) return;\n        editControl.setLayer(editableLayer);',
    before: `        const editControl = await self.getEditControl();
        const editableLayer = await self.getEditableLayer(self.layer);
        editControl.setLayer(editableLayer);`,
    after: `        const editControl = await self.getEditControl();
        const editableLayer = await self.getEditableLayer(self.layer);
        if (self.sitmunLayerAttemptCurrent?.(self.layer) === false) return;
        editControl.setLayer(editableLayer);`
  },
  {
    done: 'if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }\n                        const layerEditData = self.getLayerEditData(layer);',
    before: `                    const endProcess = function () {
                        const layerEditData = self.getLayerEditData(layer);`,
    after: `                    const endProcess = function () {
                        if (self.sitmunLayerAttemptCurrent?.(layer) === false) { resolve(null); return; }
                        const layerEditData = self.getLayerEditData(layer);`
  },
  {
    done: 'if (sitmunAttemptCurrent?.() === false) { res(null); return; }',
    before: `                                                readFeature(key).then(function (obj) {
                                                    var id;`,
    after: `                                                readFeature(key).then(function (obj) {
                                                    if (self.sitmunLayerAttemptCurrent?.(layer) === false) { res(null); return; }
                                                    var id;`
  },
  {
    done: 'Promise.resolve(self.sitmunMigrateLegacyDrafts?.(localforage,',
    before: `                            localforage.keys().then(function (keys) {
                                if (keys) {`,
    after: `                            Promise.resolve(self.sitmunMigrateLegacyDrafts?.(localforage,
                                self.LOCAL_STORAGE_KEY_PREFIX + getLayerStoreID(editableLayer), storagePrefix,
                                editableLayer.sitmunLegacyUrl ? self.LOCAL_STORAGE_KEY_PREFIX + getLayerStoreID({
                                    options: { ...editableLayer.options, url: editableLayer.sitmunLegacyUrl }
                                }) : undefined))
                            .then(function (allowed) {
                                if (allowed === false) { resolve(null); return null; }
                                return localforage.keys();
                            }).then(function (keys) {
                                if (self.sitmunLayerAttemptCurrent?.(layer) === false) { resolve(null); return; }
                                if (keys) {`
  },
  {
    before: `        return self.LOCAL_STORAGE_KEY_PREFIX + getLayerStoreID(layer || self.layer.wfsLayer || self.layer);`,
    after: `        return self.LOCAL_STORAGE_KEY_PREFIX + (self.sitmunStorageContext || '') + getLayerStoreID(layer || self.layer.wfsLayer || self.layer);`
  },
  {
    before: `                        TC.error(self.getLocaleString('errorSyncingChanges', { code: obj.code, reason: obj.reason }),`,
    after: `                        self.sitmunPermissionFailure?.(obj);
                        TC.error(self.getLocaleString('errorSyncingChanges', { code: obj.code, reason: obj.reason }),`
  }
]);

// Upgrade v1 installations as well as clean dependencies. Capture the actual
// attempt, not a later same-layer opening, at every native asynchronous boundary.
patchFile('TC/control/WFSEdit.js', [
  {
    before: `    async #addAuxLayersToMap(layer) {
        const self = this;`,
    after: `    async #addAuxLayersToMap(layer) {
        const self = this;
        const sitmunAttemptCurrent = self.sitmunCaptureLayerAttempt?.(layer || self.layer);`
  },
  {
    before: `                map.addLayer(rfLayer)
            ]);
            const editableLayer = await self.getEditableLayer(layer);`,
    after: `                map.addLayer(rfLayer)
            ]);
            if (sitmunAttemptCurrent?.() === false) {
                await Promise.all([beLayer, afLayer, mfLayer, rfLayer]
                    .filter(aux => map.workLayers.includes(aux)).map(aux => map.removeLayer(aux)));
                return;
            }
            const editableLayer = await self.getEditableLayer(layer);
            if (sitmunAttemptCurrent?.() === false) return;`
  },
  {
    before: `            await map.insertLayer(beLayer, ++idx);
            const newIdx`,
    after: `            await map.insertLayer(beLayer, ++idx);
            if (sitmunAttemptCurrent?.() === false) return;
            const newIdx`
  },
  {
    before: `        self.getEditControl().then(c => c.deactivate());`,
    after: `        const editControl = await self.getEditControl();
        editControl.deactivate();`
  },
  {
    before: `                                self.#removingLayer = null;
                            });
                    });`,
    after: `                                self.#removingLayer = null;
                            }).catch(reject);
                    }).catch(reject);`
  },
  {
    before: `    setLayer(layer) {
        const self = this;`,
    after: `    setLayer(layer) {
        const self = this;
        const sitmunAttemptCurrent = self.sitmunCaptureLayerAttempt?.(layer);`
  },
  {
    before: `            const setNewLayer = function () {
                if (mapLayer) {`,
    after: `            const setNewLayer = function () {
                if (mapLayer && sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                if (mapLayer) {`
  },
  {
    before: `if (self.sitmunLayerAttemptCurrent?.(mapLayer) === false) { resolve(null); return; }
                                self.layer = mapLayer;`,
    after: `if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                                self.layer = mapLayer;`
  },
  {
    before: `if (self.sitmunLayerAttemptCurrent?.(mapLayer) === false) { resolve(null); return; }
                                            selector.value = self.layer.id;`,
    after: `if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                                            selector.value = self.layer.id;`
  },
  {
    before: `                                            resolve(self.layer);
                                        });`,
    after: `                                            resolve(self.layer);
                                        }).catch(reject);`
  },
  {
    before: `                                    .catch((err) => {
                                        self.setLayer(null);`,
    after: `                                    .catch((err) => {
                                        if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                                        if (self.sitmunStorageContext) { reject(err); return; }
                                        self.setLayer(null);`
  },
  {
    before: `                        .catch(() => {
                            self.setLayer(null);`,
    after: `                        .catch(() => {
                            if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                            if (self.sitmunStorageContext) { reject(new Error('WFS layer preparation failed')); return; }
                            self.setLayer(null);`
  },
  {
    before: `                            if (map.workLayers.indexOf(editableLayer) >= 0) {`,
    after: `                            if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                            if (map.workLayers.indexOf(editableLayer) >= 0) {`
  },
  {
    before: `                self.closeEditSession().then(() => {
                    if (mapLayer) {
                        setNewLayer();
                    }
                });`,
    after: `                const close = self.sitmunCloseLayerTransition
                    ? self.sitmunCloseLayerTransition(mapLayer, sitmunAttemptCurrent)
                    : self.closeEditSession();
                close.then(() => {
                    if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                    if (mapLayer) setNewLayer();
                }).catch(reject);`
  },
  {
    before: `    async openEditSession() {
        const self = this;`,
    after: `    async openEditSession() {
        const self = this;
        const sitmunAttemptCurrent = self.sitmunCaptureLayerAttempt?.(self.layer);`
  },
  {
    before: `if (self.sitmunLayerAttemptCurrent?.(self.layer) === false) return;
        editControl.setLayer(editableLayer);`,
    after: `if (sitmunAttemptCurrent?.() === false) return;
        editControl.setLayer(editableLayer);`
  },
  {
    before: `    #enableEditSerialization(layer) {
        const self = this;
        return new Promise(function (resolve, _reject) {`,
    after: `    #enableEditSerialization(layer) {
        const self = this;
        const sitmunAttemptCurrent = self.sitmunCaptureLayerAttempt?.(layer);
        return new Promise(function (resolve, reject) {`
  },
  {
    before: `if (self.sitmunLayerAttemptCurrent?.(layer) === false) { resolve(null); return; }
                        const layerEditData = self.getLayerEditData(layer);`,
    after: `if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                        const layerEditData = self.getLayerEditData(layer);`
  },
  {
    before: `if (self.sitmunLayerAttemptCurrent?.(layer) === false) { res(null); return; }
                                                    var id;`,
    after: `if (sitmunAttemptCurrent?.() === false) { res(null); return; }
                                                    var id;`
  },
  {
    before: `if (self.sitmunLayerAttemptCurrent?.(layer) === false) { resolve(null); return; }
                                if (keys) {`,
    after: `if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                                if (keys) {`
  },
  {
    before: `                                        .filter(key => key.indexOf(storagePrefix) === 0)`,
    after: `                                        .filter(key => {
                                            if (!self.sitmunStorageContext) return key.indexOf(storagePrefix) === 0;
                                            const recognized = [addedStoragePrefix, modifiedStoragePrefix, removedStoragePrefix]
                                                .some(prefix => key.startsWith(prefix) && key.length > prefix.length);
                                            if (!recognized && key.startsWith(storagePrefix)) {
                                                console.warn('SITMUN: unrecognized scoped WFS draft key ignored');
                                            }
                                            return recognized;
                                        })`
  },
  {
    before: `featurePromises.push(new Promise(function (res, _rej) {`,
    after: `featurePromises.push(new Promise(function (res, rej) {`
  },
  {
    before: `removedFeaturesLayer.addFeature(feature).then(() => res(feature));`,
    after: `removedFeaturesLayer.addFeature(feature).then(() => res(feature), rej);`
  },
  {
    before: `modifiedFeaturesLayer.addFeature(newFeature).then(() => res(feature));`,
    after: `modifiedFeaturesLayer.addFeature(newFeature).then(() => res(feature), rej);`
  },
  {
    before: `addedFeaturesLayer.addFeature(newFeat).then(() => res(newFeat));`,
    after: `addedFeaturesLayer.addFeature(newFeat).then(() => res(newFeat), rej);`
  },
  {
    before: `                                                        addPromise.then(function (feat) {
                                                            //feat.setStyle`,
    after: `                                                        addPromise.then(function (feat) {
                                                            if (sitmunAttemptCurrent?.() === false) { res(null); return; }
                                                            //feat.setStyle`
  },
  {
    before: `                                                            //li && li.removeWait(uid);
                                                        });
                                                    }
                                                });`,
    after: `                                                            //li && li.removeWait(uid);
                                                        }).catch(rej);
                                                    }
                                                    else if (self.sitmunStorageContext) {
                                                        console.warn('SITMUN: unrecognized scoped WFS draft operation ignored');
                                                        res(null);
                                                    }
                                                }).catch(rej);`
  },
  {
    before: `                                Promise.all(featurePromises).then(() => {
                                    layerEditData.serializable = true;
                                    resolve(editableLayer);
                                });
                            });`,
    after: `                                return Promise.all(featurePromises).then(() => {
                                    if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                                    layerEditData.serializable = true;
                                    resolve(editableLayer);
                                });
                            }).catch(reject);`
  },
  {
    before: `                            Promise.all(featurePromises).then(() => {
                                layerEditData.serializable = true;
                                resolve(editableLayer);
                            });`,
    after: `                            Promise.all(featurePromises).then(() => {
                                if (sitmunAttemptCurrent?.() === false) { resolve(null); return; }
                                layerEditData.serializable = true;
                                resolve(editableLayer);
                            }).catch(reject);`
  },
  {
    before: `                    else {
                        resolve(editableLayer);
                    }
                });
        });
    }

    async applyEdits()`,
    after: `                    else {
                        resolve(editableLayer);
                    }
                }).catch(reject);
        });
    }

    async applyEdits()`
  }
]);

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
    done: 'sitmunAttributeRegistrationVersion = 1;',
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

// Native wrappers create interactions after asynchronous map/layer resolution.
// A permission captured before that wait cannot outlive its opening attempt.
patchFile('TC/ol/ol.js', [
  {
    before: `TC.wrap.control.Draw.prototype.activate = function (mode) {
    var self = this;`,
    after: `TC.wrap.control.Draw.prototype.activate = function (mode) {
    var self = this;
    const sitmunPermissionCurrent = self.parent.sitmunCaptureEditingPermission?.();`
  },
  {
    before: `            const layer = objects[1];
            if (self.parent.map.on3DView) {`,
    after: `            const layer = objects[1];
            if (sitmunPermissionCurrent?.() === false) return;
            if (self.parent.map.on3DView) {`
  },
  {
    before: `                layer.wrap.getLayer().then(function (olLayer) {

                    if (!self.viewport)`,
    after: `                layer.wrap.getLayer().then(function (olLayer) {
                    if (sitmunPermissionCurrent?.() === false) return;

                    if (!self.viewport)`
  },
  {
    before: `TC.wrap.control.Modify.prototype.activate = function () {
    const self = this;`,
    after: `TC.wrap.control.Modify.prototype.activate = function () {
    const self = this;
    const sitmunPermissionCurrent = self.parent.sitmunCaptureEditingPermission?.();`
  },
  {
    before: `            const olLayer = olObjects[1];
            const deleteMode`,
    after: `            const olLayer = olObjects[1];
            if (sitmunPermissionCurrent?.() === false) return;
            const deleteMode`
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

// Advertise the new mandatory capabilities only after every upgrade succeeded.
patchFile('TC/control/WFSEdit.js', [
  { before: 'sitmunPermissionHooksVersion = 1;', after: 'sitmunPermissionHooksVersion = 2;' }
]);
