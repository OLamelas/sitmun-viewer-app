import { DebugElement, getDebugNode } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { Subject } from 'rxjs';

import { LayerCatalogControlHandler } from './layer-catalog-control.handler';
import { AppConfigService } from '../../services/app-config.service';
import { CatalogLayerSelectionService } from '../../services/catalog-layer-selection.service';
import { CatalogSwitchingService } from '../../services/catalog-switching.service';
import { ConfigLookupService } from '../../services/config-lookup.service';
import { FeatureAttributeEditingService } from '../../services/feature-attribute-editing.service';
import { LayerInfoService } from '../../services/layer-info.service';
import { MapFeaturePanelService } from '../../services/map-feature-panel.service';
import { RasterLayerService } from '../../services/raster-layer.service';
import { SitnaApiService } from '../../services/sitna-api.service';
import { SitnaCapabilitiesInterceptor } from '../../services/sitna-capabilities-interceptor.service';
import { VirtualWmsCapabilitiesService } from '../../services/virtual-wms-capabilities.service';
import { FeatureAttributeFormComponent } from '../../ui/components/feature-attribute-form/feature-attribute-form.component';
import { MessageBoxService } from '../../../util/message-box-service';

describe('catalog removal with the attribute coordinator', () => {
  let handler: LayerCatalogControlHandler;
  let editing: FeatureAttributeEditingService;
  let claims: CatalogLayerSelectionService;
  let host: HTMLElement;
  let map: any;
  let layer: any;
  let feature: any;
  let wfs: any;
  let edit: any;
  let selection: any;
  let catalog: any;
  let answer: Subject<boolean>;
  let confirm: jest.Mock;
  let nativeRemove: jest.Mock;
  let setLayer: jest.Mock;
  let wlm: any;
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const form = () => (getDebugNode(host.querySelector('app-feature-attribute-form')!) as DebugElement)
    .componentInstance as FeatureAttributeFormComponent;

  beforeEach(async () => {
    answer = new Subject<boolean>();
    confirm = jest.fn(() => answer);
    host = document.createElement('div');
    document.body.append(host);
    const lookup = { findNode: (id: string) => ({ id, resource: id === 'alias' ? 'a' : id }),
      getRadioGroupParent: () => undefined, isRadioFolder: () => false, collectDescendantLeafIds: () => [] };
    class WorkLayerManager {}
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [LayerCatalogControlHandler, FeatureAttributeEditingService, CatalogLayerSelectionService,
        MapFeaturePanelService,
        { provide: ConfigLookupService, useValue: lookup },
        { provide: MessageBoxService, useValue: { confirm } },
        { provide: AppConfigService, useValue: {} },
        { provide: SitnaApiService, useValue: { getTC: () => ({ control: { WorkLayerManager } }) } },
        ...[CatalogSwitchingService, LayerInfoService, RasterLayerService,
          SitnaCapabilitiesInterceptor, VirtualWmsCapabilitiesService].map((provide) => ({ provide, useValue: {} }))]
    });
    handler = TestBed.inject(LayerCatalogControlHandler);
    editing = TestBed.inject(FeatureAttributeEditingService);
    claims = TestBed.inject(CatalogLayerSelectionService);
    const schema = new DOMParser().parseFromString(`<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema"
      xmlns:a="urn:a" targetNamespace="urn:a"><x:element name="items"><x:complexType><x:sequence>
      <x:element name="label" type="x:string"/></x:sequence></x:complexType></x:element></x:schema>`, 'text/xml');
    layer = { id: 'a', options: { nodeId: 'a', featureNS: 'a' }, featureType: ['items'],
      getVisibility: () => true, getCapabilitiesPromise: async () => ({}),
      getDescribeFeatureTypeUrl: () => 'https://wfs.test/schema', proxificationTool: { fetchXML: async () => schema },
      getFeatureTypeMetadata: async () => ({ attributes: [{ name: 'label' }], geometries: [] }) };
    feature = { id: 'feature-a', layer, getData: () => ({ label: 'A' }) };
    let active = true;
    selection = { on: jest.fn(), un: jest.fn(), getActive: () => active,
      setActive: (value: boolean) => { active = value; } };
    const modify = { layer, activate: jest.fn(), wrap: { selectInteraction: selection } };
    edit = { layer, mode: 'modify', getModifyControl: async () => modify,
      getModifyControlAttributeEditor: async () => ({ style: {} }), setSelectedFeatures: jest.fn(),
      on: jest.fn(), off: jest.fn(), history: { setData: jest.fn() } };
    setLayer = jest.fn(async (next: any) => { wfs.layer = next; edit.layer = next; return next; });
    wfs = { layer, getEditControl: async () => edit, setLayer,
      getLayerEditData: () => ({ modifiedFeaturesLayer: { features: [] } }) };
    wlm = { div: document.createElement('div'), removeLayer: jest.fn() };
    wlm.div.innerHTML = '<ul><li class="tc-ctl-wlm-elm" data-layer-id="a">A</li></ul>';
    nativeRemove = jest.fn(async (target: any) => {
      map.workLayers = map.workLayers.filter((item: any) => item !== target);
      return target;
    });
    map = { div: host, workLayers: [layer], on: jest.fn(), off: jest.fn(), toast: jest.fn(),
      removeLayer: nativeRemove, getLayer: (id: string) => map.workLayers.find((item: any) => item.id === id),
      getControlsByClass: () => [wlm] };
    catalog = { map, div: document.createElement('div') };
    catalog.div.innerHTML = '<li data-layer-name="a"><input class="sitmun-lcat-radio" data-layer-name="a" checked></li>';
    claims.commitSelection(map, 'a', 'a', true);
    claims.clearAwaitingWlmUi(map, 'a');
    await editing.connect(wfs, map);
    selection.on.mock.calls[0][1]({ selected: [{ _wrap: { parent: feature } }], deselected: [],
      mapBrowserEvent: { type: 'singleclick', originalEvent: new MouseEvent('click') } });
    await settle();
  });

  afterEach(() => {
    handler.cleanup();
    TestBed.inject(MapFeaturePanelService).destroyAll();
    editing.ngOnDestroy();
    host.remove();
  });

  it('cancels a leaf with draft without changing claims, checkbox, row, selection or form', async () => {
    form().rows[0].group.controls.text.setValue('draft');
    const removal = (handler as any).removeLayerClaims(map, ['a'], catalog);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(claims.getResourceRefCount(map, 'a')).toBe(1);
    answer.next(false);
    await removal;
    expect(nativeRemove).not.toHaveBeenCalled();
    expect(setLayer).not.toHaveBeenCalled();
    expect(map.workLayers).toEqual([layer]);
    expect(claims.isNodeSelected(map, 'a')).toBe(true);
    expect(claims.getResourceRefCount(map, 'a')).toBe(1);
    expect(catalog.div.querySelector('input').checked).toBe(true);
    expect(wlm.div.querySelector('[data-layer-id="a"]')).not.toBeNull();
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    expect(edit.setSelectedFeatures).toHaveBeenLastCalledWith([feature]);
  });

  it('accepts once, closes the native session before removal, and only then releases the claim', async () => {
    form().rows[0].group.controls.text.setValue('draft');
    nativeRemove.mockImplementation(async (target: any) => {
      expect(wfs.layer).toBeNull();
      expect(claims.isNodeSelected(map, 'a')).toBe(true);
      map.workLayers = map.workLayers.filter((item: any) => item !== target);
      return target;
    });
    const removal = (handler as any).removeLayerClaims(map, ['a'], catalog);
    await settle();
    answer.next(true);
    await removal;
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(nativeRemove).toHaveBeenCalledTimes(1);
    expect(setLayer.mock.invocationCallOrder[0]).toBeLessThan(nativeRemove.mock.invocationCallOrder[0]);
    expect(claims.isNodeSelected(map, 'a')).toBe(false);
    expect(claims.getResourceRefCount(map, 'a')).toBe(0);
    expect(catalog.div.querySelector('input').checked).toBe(false);
    expect(wlm.div.querySelector('[data-layer-id="a"]')).toBeNull();
  });

  it('preflights a folder before removing even an earlier, unrelated layer', async () => {
    const other = { id: 'b', options: { nodeId: 'b' } };
    map.workLayers.unshift(other);
    claims.commitSelection(map, 'b', 'b', true);
    form().rows[0].group.controls.text.setValue('draft');
    const removal = (handler as any).removeLayerClaims(map, ['b', 'a'], catalog);
    await settle();
    expect(nativeRemove).not.toHaveBeenCalled();
    answer.next(false);
    await removal;
    expect(nativeRemove).not.toHaveBeenCalled();
    expect(claims.isNodeSelected(map, 'b')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('preserves surviving claims and rows after physical removal fails, without retrying', async () => {
    nativeRemove.mockRejectedValue(new Error('native removal failed'));
    await (handler as any).removeLayerClaims(map, ['a'], catalog);
    expect(nativeRemove).toHaveBeenCalledTimes(1);
    expect(claims.isNodeSelected(map, 'a')).toBe(true);
    expect(wlm.removeLayer).not.toHaveBeenCalled();
    expect(catalog.div.querySelector('input').checked).toBe(true);
  });

  it('retains the original claim if closing WFSEdit fails', async () => {
    setLayer.mockRejectedValue(new Error('session close failed'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect((handler as any).removeLayerClaims(map, ['a'], catalog)).rejects.toThrow('session close failed');
    expect(nativeRemove).not.toHaveBeenCalled();
    expect(claims.getResourceRefCount(map, 'a')).toBe(1);
    expect(wlm.removeLayer).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps a shared resource loaded when another alias still owns a claim', async () => {
    claims.commitSelection(map, 'alias', 'a', true);
    await (handler as any).removeLayerClaims(map, ['a'], catalog);
    expect(nativeRemove).not.toHaveBeenCalled();
    expect(claims.isNodeSelected(map, 'a')).toBe(false);
    expect(claims.isNodeSelected(map, 'alias')).toBe(true);
    expect(claims.getResourceRefCount(map, 'a')).toBe(1);
  });

  it('asks once for native-only pending edits and releases all shared aliases after one physical removal', async () => {
    claims.commitSelection(map, 'alias', 'a', true);
    wfs.getLayerEditData = () => ({ modifiedFeaturesLayer: { features: [feature] } });
    const removal = (handler as any).removeLayerClaims(map, ['a', 'alias'], catalog);
    for (let attempt = 0; attempt < 20 && !confirm.mock.calls.length; attempt++) await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    answer.next(true);
    await removal;
    expect(nativeRemove).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(claims.getResourceRefCount(map, 'a')).toBe(0);
  });

  it('does not add a radio replacement or change either claim when consent is cancelled', async () => {
    form().rows[0].group.controls.text.setValue('draft');
    const replace = jest.fn(async () => (handler as any).commitCatalogSelection(map, 'b', 'b', ['a']));
    const replacement = editing.withLayerRemovalConsent(map, (handler as any).removalLayers(map, ['a']), replace);
    await settle();
    answer.next(false);
    await replacement;
    expect(replace).not.toHaveBeenCalled();
    expect(nativeRemove).not.toHaveBeenCalled();
    expect(claims.isNodeSelected(map, 'a')).toBe(true);
    expect(claims.isNodeSelected(map, 'b')).toBe(false);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
  });

  it('reconciles a partial radio failure to both physically present resources', async () => {
    const replacement = { id: 'b', options: { nodeId: 'b' } };
    map.workLayers.push(replacement);
    nativeRemove.mockRejectedValue(new Error('cannot remove A'));
    await (handler as any).commitCatalogSelection(map, 'b', 'b', ['a']);
    expect(claims.isNodeSelected(map, 'a')).toBe(true);
    expect(claims.isNodeSelected(map, 'b')).toBe(true);
    expect(claims.getResourceRefCount(map, 'a')).toBe(1);
    expect(claims.getResourceRefCount(map, 'b')).toBe(1);
    expect(wlm.removeLayer).not.toHaveBeenCalled();
  });
});
